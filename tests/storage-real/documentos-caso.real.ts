/**
 * Documentos por caso contra Storage e Postgres REAIS (ver vitest.storage-real.config.ts). Não é mock: as server
 * actions e o módulo administrativo falam com a API do Storage e com o banco de verdade; só a sessão do usuário é
 * simulada. As intercalações de concorrência são DETERMINÍSTICAS: um gancho na chamada ao banco pausa uma
 * operação no ponto exato e executa a outra inteira antes de deixá-la seguir.
 *
 * Invariantes conferidas em todos os cenários:
 *   I1. nenhum documento `ready` sem o arquivo no Storage;
 *   I2. nenhum objeto do bucket sem rastreamento (linha do documento OU entrada da fila de limpeza);
 *   I3. "Nada foi guardado" / cancelamento concluído só com a confirmação do banco e do Storage.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type * as AdminSupabase from "@/server/case-documents/admin/supabase";

const DB_URL = process.env.CASE_DOCS_REAL_DB_URL ?? "";
const STORAGE_URL = process.env.CASE_DOCS_REAL_STORAGE_URL ?? "";
const PSQL = process.env.CASE_DOCS_REAL_PSQL ?? "psql";
const ANA = "20000000-0000-0000-0000-000000000001"; // owner do Escritório Um (seed)
const WS_UM = "10000000-0000-0000-0000-000000000001";

// --------------------------------------------------------------------------------------------------------
// Ganchos de intercalação: antes/depois de uma chamada RPC (pelo nome), uma única vez.
// --------------------------------------------------------------------------------------------------------
type Hook = () => Promise<void>;
const hooks = { before: new Map<string, Hook>(), after: new Map<string, Hook>() };

function wrapRpc<T>(client: T): T {
  const c = client as unknown as { rpc: (fn: string, args?: unknown, opts?: unknown) => unknown };
  const orig = c.rpc.bind(c);
  c.rpc = (fn: string, args?: unknown, opts?: unknown) =>
    (async () => {
      const b = hooks.before.get(fn);
      if (b) {
        hooks.before.delete(fn);
        await b();
      }
      const r = await (orig(fn, args, opts) as PromiseLike<unknown>);
      const a = hooks.after.get(fn);
      if (a) {
        hooks.after.delete(fn);
        await a();
      }
      return r;
    })();
  return client;
}

let currentUser = ANA;

function fakeUserJwt(sub: string): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  // A API local confere o sub; a sessão é simulada (o banco repete papel, escritório e alcance).
  return [enc({ alg: "HS256", typ: "JWT" }), enc({ sub, role: "authenticated", aud: "authenticated", exp: 4102444800 }), "teste-local"].join(".");
}

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/authz/safe", () => ({
  requirePermissionSafe: async () => ({ ctx: { userId: currentUser } }),
}));
vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () =>
    wrapRpc(
      createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${fakeUserJwt(currentUser)}` } },
      }),
    ),
}));
vi.mock("@/server/case-documents/admin/supabase", async (importOriginal) => {
  const mod = await importOriginal<typeof AdminSupabase>();
  return { createCaseDocumentsAdminSupabaseClient: () => wrapRpc(mod.createCaseDocumentsAdminSupabaseClient()) };
});

const actions = await import("@/modules/case-documents/actions");
const admin = await import("@/server/case-documents/admin/documents");

// --------------------------------------------------------------------------------------------------------
// Banco (psql) e Storage
// --------------------------------------------------------------------------------------------------------
function sql(q: string): string {
  // SQL pela entrada padrão em UTF-8 (no Windows, argumentos de linha de comando passam pela página de código local).
  return execFileSync(PSQL, [DB_URL, "-XAtq", "-v", "ON_ERROR_STOP=1"], {
    input: q,
    encoding: "utf8",
    env: { ...process.env, PGCLIENTENCODING: "UTF8" },
  }).trim();
}
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

function hasColumn(table: string, column: string): boolean {
  return sql(`select count(*) from information_schema.columns where table_schema = 'public' and table_name = ${lit(table)} and column_name = ${lit(column)}`) === "1";
}

function state(path: string) {
  const row = sql(`select coalesce((select status from public.case_documents where storage_path = ${lit(path)}), '-')`);
  const queued = sql(`select count(*) from public.case_document_storage_cleanup where storage_path = ${lit(path)}`) === "1";
  const object = sql(`select count(*) from storage.objects where bucket_id = 'case-documents' and name = ${lit(path)}`) === "1";
  return { row: row === "-" ? null : row, queued, object };
}

/** Caminhos reservados no cenário atual (as invariantes olham só para eles). */
const touched: string[] = [];

/** I1 e I2 nos caminhos do cenário. */
function invariants() {
  if (!touched.length) return { readyWithoutObject: 0, untracked: 0 };
  const paths = touched.map(lit).join(", ");
  const readyWithoutObject = Number(
    sql(`select count(*) from public.case_documents d where d.status = 'ready' and d.storage_path in (${paths})
         and not exists (select 1 from storage.objects o where o.bucket_id = 'case-documents' and o.name = d.storage_path)`),
  );
  const untracked = Number(
    sql(`select count(*) from storage.objects o where o.bucket_id = 'case-documents' and o.name in (${paths})
         and not exists (select 1 from public.case_documents d where d.storage_path = o.name)
         and not exists (select 1 from public.case_document_storage_cleanup q where q.storage_path = o.name)`),
  );
  return { readyWithoutObject, untracked };
}

function pdf(text: string): Uint8Array {
  const content = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}
const HTML_AS_PDF = new Uint8Array(Buffer.from("<!doctype html><html><body><script>alert(1)</script></body></html>"));

function setFaults(storage: Record<string, boolean>) {
  const file = process.env.CASE_DOCS_REAL_FAULTS_FILE;
  if (!file) throw new Error("CASE_DOCS_REAL_FAULTS_FILE ausente: este cenário injeta falha no Storage");
  writeFileSync(file, JSON.stringify({ storage }));
}

let opportunityId = "";

async function begin(bytes: Uint8Array, key = randomUUID(), name = "Documento sintético.pdf") {
  const r = await actions.beginCaseDocumentUploadAction({ opportunityId, name, type: "application/pdf", size: bytes.length, idempotencyKey: key });
  if (!r.ok) throw new Error(`begin recusado: ${r.error}`);
  if (!touched.includes(r.path)) touched.push(r.path);
  return { ...r, key };
}

/** O navegador sobe direto ao Storage com o link de envio (como a tela). */
async function browserUpload(path: string, token: string, bytes: Uint8Array) {
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await anon.storage
    .from("case-documents")
    .uploadToSignedUrl(path, token, new Blob([Buffer.from(bytes)], { type: "application/pdf" }), { contentType: "application/pdf", upsert: false });
  return error;
}

/** Envio EM ANDAMENTO direto na API do Storage: a primeira metade sai já; o resto só depois de `gate`. */
async function streamingUpload(path: string, token: string, bytes: Uint8Array, gate: Promise<void>) {
  const half = Math.floor(bytes.length / 2);
  const body = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      ctrl.enqueue(bytes.subarray(0, half));
      await gate;
      ctrl.enqueue(bytes.subarray(half));
      ctrl.close();
    },
  });
  return fetch(`${STORAGE_URL}/object/upload/sign/case-documents/${path}?token=${encodeURIComponent(token)}`, {
    method: "PUT",
    headers: { "content-type": "application/pdf", "x-upsert": "false" },
    body,
    duplex: "half",
  } as RequestInit);
}

async function finalize(documentId: string) {
  return actions.finalizeCaseDocumentUploadAction({ documentId, declaredType: "application/pdf" });
}

async function cancel(documentId: string) {
  return actions.abandonCaseDocumentUploadAction({ documentId, reason: "upload_interrupted" });
}

const enabled = Boolean(DB_URL && STORAGE_URL && process.env.CASE_DOCS_REAL_SUPABASE_URL);

describe.skipIf(!enabled)("documentos por caso — Storage e banco reais", () => {
  beforeAll(() => {
    sql("update public.case_document_upload_gate set enabled = true, backup_activation_ref = 'teste local descartável — sem backup real'");
    // Caso sintético próprio (contato → lead → oportunidade), criado como a owner do seed.
    const out = sql(`select set_config('request.jwt.claims', json_build_object('sub', ${lit(ANA)}, 'role', 'authenticated')::text, false);
      with c as (select (public.create_contact(${lit(WS_UM)}::uuid, 'pf', 'Contato Sintético Storage', null, null, null)).id as co),
           l as (select public.create_lead(${lit(WS_UM)}::uuid, (select co from c), 'Imobiliário', 'S1', '{}'::text[], 'media', ${lit(ANA)}::uuid) as lo)
      select public.create_opportunity((select lo from l));`);
    opportunityId = out.split(/\r?\n/).pop() ?? "";
    expect(opportunityId).toMatch(/^[0-9a-f-]{36}$/);
  });
  afterAll(() => {
    sql("update public.case_document_upload_gate set enabled = false, backup_activation_ref = null");
  });
  afterEach(() => {
    hooks.before.clear();
    hooks.after.clear();
    if (process.env.CASE_DOCS_REAL_FAULTS_FILE) setFaults({});
    currentUser = ANA;
    const inv = invariants();
    touched.length = 0;
    expect(inv, "invariantes I1/I2 depois do cenário").toEqual({ readyWithoutObject: 0, untracked: 0 });
  });

  it("A1. cancelamento lê pendente → outra chamada finaliza → cancelamento retoma: o documento pronto mantém o arquivo", async () => {
    const bytes = pdf("A1");
    const b = await begin(bytes);
    expect(await browserUpload(b.path, b.token!, bytes)).toBeNull();

    let finalized: Awaited<ReturnType<typeof finalize>> | null = null;
    let fired = false;
    const interleave: Hook = async () => {
      if (fired) return;
      fired = true;
      finalized = await finalize(b.documentId);
    };
    // Código anterior: o cancelamento lia o pendente por get_pending_case_document e depois apagava o objeto.
    hooks.after.set("get_pending_case_document", interleave);
    // Código novo: o cancelamento começa reservando a transição no banco.
    hooks.before.set("begin_case_document_abandon", interleave);

    const cancelled = (await cancel(b.documentId)) as Record<string, unknown>;

    expect(fired).toBe(true);
    expect(finalized).toMatchObject({ ok: true });
    const s = state(b.path);
    expect(s.row).toBe("ready");
    expect(s.object, "documento pronto precisa do arquivo").toBe(true);
    expect(await admin.adminDownloadObject(b.path)).not.toBeNull();
    // A tela não pode ouvir que o cancelamento deu certo.
    expect(cancelled.ok).toBe(false);
  });

  it("A2. ordem inversa: cancelamento reserva primeiro → a finalização em curso perde, sem documento pronto nem órfão", async () => {
    const bytes = pdf("A2");
    const b = await begin(bytes);
    expect(await browserUpload(b.path, b.token!, bytes)).toBeNull();

    let cancelled: Record<string, unknown> | null = null;
    // A finalização já leu o pendente, baixou e conferiu o conteúdo; antes de gravar, o cancelamento roda inteiro.
    hooks.before.set("finalize_case_document", async () => {
      cancelled = (await cancel(b.documentId)) as Record<string, unknown>;
    });
    const fin = await finalize(b.documentId);

    expect(cancelled).toMatchObject({ ok: true });
    expect(fin.ok).toBe(false);
    const s = state(b.path);
    expect(s.row).toBeNull();
    expect(s.object).toBe(false);
  });

  it("A3. falha do Storage ao cancelar: nada é anunciado como concluído; repetição conclui sem duplicar", async () => {
    const bytes = pdf("A3");
    const b = await begin(bytes);
    expect(await browserUpload(b.path, b.token!, bytes)).toBeNull();

    setFaults({ failRemove: true });
    const first = (await cancel(b.documentId)) as Record<string, unknown>;
    expect(first.outcome, "sem confirmação do Storage não há cancelamento concluído").toBe("cleanup_pending");
    let s = state(b.path);
    expect(s.object).toBe(true);
    expect(s.row === "abandoning" || s.queued).toBe(true);
    // Reservado para cancelamento: a finalização não ressuscita o envio, e repetir o begin não emite link novo.
    expect((await finalize(b.documentId)).ok).toBe(false);
    expect(state(b.path).row).not.toBe("ready");
    await expect(begin(bytes, b.key)).rejects.toThrow(/concluído ou cancelado/);

    setFaults({});
    const again = (await cancel(b.documentId)) as Record<string, unknown>;
    expect(again).toMatchObject({ ok: true, outcome: "abandoned" });
    s = state(b.path);
    expect(s.row).toBeNull();
    expect(s.object).toBe(false);

    // Resposta perdida: repetir o cancelamento é inofensivo.
    expect(await cancel(b.documentId)).toMatchObject({ ok: true, outcome: "already_absent" });
  });

  it("A3b. cancelamento interrompido é concluído pela limpeza, que mantém o caminho vigiado enquanto o link vale", async () => {
    const bytes = pdf("A3b");
    const b = await begin(bytes);
    expect(await browserUpload(b.path, b.token!, bytes)).toBeNull();
    setFaults({ failRemove: true });
    expect(await cancel(b.documentId)).toMatchObject({ ok: true, outcome: "cleanup_pending" });
    setFaults({});
    // Passaram-se os 2 minutos de carência da retomada.
    sql(`update public.case_documents set abandoned_at = abandoned_at - interval '3 minutes' where id = ${lit(b.documentId)}`);
    const r = await admin.adminRunCaseDocumentCleanup(50);
    expect(r.abandons).toBeGreaterThanOrEqual(1);
    expect(state(b.path)).toEqual({ row: null, queued: true, object: false });
    await expectCleanupClosesWindow(b.path);
  });

  it("A4. conteúdo inválido com falha do Storage: a mensagem não diz “Nada foi guardado”", async () => {
    const b = await begin(HTML_AS_PDF, randomUUID(), "falso.pdf");
    expect(await browserUpload(b.path, b.token!, HTML_AS_PDF)).toBeNull();
    setFaults({ failRemove: true });
    const fin = await finalize(b.documentId);
    expect(fin.ok).toBe(false);
    if (!fin.ok) expect(fin.error).not.toContain("Nada foi guardado");
    setFaults({});
    await admin.adminRunCaseDocumentCleanup(50);
  });

  it("A5. conteúdo inválido com o Storage respondendo: recusado e confirmado (“Nada foi guardado”)", async () => {
    const b = await begin(HTML_AS_PDF, randomUUID(), "falso.pdf");
    expect(await browserUpload(b.path, b.token!, HTML_AS_PDF)).toBeNull();
    const fin = await finalize(b.documentId);
    expect(fin.ok).toBe(false);
    if (!fin.ok) expect(fin.error).toContain("Nada foi guardado");
    expect(state(b.path)).toEqual({ row: null, queued: expect.any(Boolean), object: false });
  });

  it("B1. token ainda válido depois do cancelamento ANTES do envio: a gravação atrasada fica rastreada e é apagada", async () => {
    const bytes = pdf("B1");
    const b = await begin(bytes);
    expect(await cancel(b.documentId)).toMatchObject({ ok: true });
    expect(state(b.path)).toMatchObject({ row: null, object: false });

    // A API real do Storage aceita: o token continua válido (upsert:false não revoga nada).
    expect(await browserUpload(b.path, b.token!, bytes)).toBeNull();
    const s = state(b.path);
    expect(s.object).toBe(true);
    expect(s.queued, "objeto atrasado precisa de rastreamento").toBe(true);

    await expectCleanupClosesWindow(b.path);
  });

  it("B2. token reutilizado depois de remover um documento já finalizado: rastreado e apagado", async () => {
    const bytes = pdf("B2");
    const b = await begin(bytes);
    expect(await browserUpload(b.path, b.token!, bytes)).toBeNull();
    expect(await finalize(b.documentId)).toMatchObject({ ok: true });
    expect(await actions.removeCaseDocumentAction({ documentId: b.documentId, reason: "duplicado" })).toMatchObject({ ok: true });
    expect(state(b.path)).toMatchObject({ row: null, object: false });

    expect(await browserUpload(b.path, b.token!, bytes)).toBeNull();
    const s = state(b.path);
    expect(s.object).toBe(true);
    expect(s.queued, "objeto regravado com token antigo precisa de rastreamento").toBe(true);

    await expectCleanupClosesWindow(b.path);
  });

  it("B3. envio em andamento durante o cancelamento: termina depois e fica rastreado", async () => {
    const bytes = pdf("B3 envio em andamento");
    const b = await begin(bytes);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const upload = streamingUpload(b.path, b.token!, bytes, gate);
    await new Promise((r) => setTimeout(r, 300));

    expect(await cancel(b.documentId)).toMatchObject({ ok: true });
    release();
    const res = await upload;
    expect(res.status).toBe(200);
    const s = state(b.path);
    expect(s.object).toBe(true);
    expect(s.queued, "envio que terminou depois do cancelamento precisa de rastreamento").toBe(true);

    await expectCleanupClosesWindow(b.path);
  });

  it("B4. renovação do token por repetição do begin: a validade conta do token MAIS RECENTE", async () => {
    const bytes = pdf("B4");
    const key = randomUUID();
    const first = await begin(bytes, key);
    // O envio ficou parado mais de 3 horas desde a criação (e desde o primeiro token).
    const shift = "interval '3 hours 10 minutes'";
    const extra = hasColumn("case_documents", "upload_token_issued_at")
      ? `, upload_token_issued_at = upload_token_issued_at - ${shift}`
      : "";
    sql(`set session_replication_role = replica;
         update public.case_documents set created_at = created_at - ${shift}${extra} where id = ${lit(first.documentId)}`);

    // A tela repete o begin (mesma chave): o servidor emite um token NOVO, válido por mais 2 horas.
    const again = await begin(bytes, key);
    expect(again.documentId).toBe(first.documentId);
    expect(again.token).toBeTruthy();

    // A limpeza roda antes de o arquivo chegar.
    await admin.adminRunCaseDocumentCleanup(50);
    expect(await browserUpload(again.path, again.token!, bytes)).toBeNull();
    const s = state(again.path);
    expect(s.object).toBe(true);
    expect(s.row !== null || s.queued, "o envio com o token renovado não pode virar órfão").toBe(true);
    if (s.row === "pending") expect(await finalize(again.documentId)).toMatchObject({ ok: true });
    else await expectCleanupClosesWindow(again.path);
  });

  it("C1. remoção com falha do Storage fica pendente e a repetição conclui", async () => {
    const bytes = pdf("C1");
    const b = await begin(bytes);
    expect(await browserUpload(b.path, b.token!, bytes)).toBeNull();
    expect(await finalize(b.documentId)).toMatchObject({ ok: true });
    setFaults({ failRemove: true });
    expect(await actions.removeCaseDocumentAction({ documentId: b.documentId, reason: "duplicado" })).toMatchObject({ ok: false, pending: true });
    expect(state(b.path)).toMatchObject({ row: "removing", object: true });
    setFaults({});
    expect(await actions.removeCaseDocumentAction({ documentId: b.documentId, reason: "duplicado" })).toMatchObject({ ok: true });
    expect(state(b.path)).toMatchObject({ row: null, object: false });
  });

  it("C2. repetição da finalização e do begin depois de resposta perdida não duplica", async () => {
    const bytes = pdf("C2");
    const b = await begin(bytes);
    expect(await browserUpload(b.path, b.token!, bytes)).toBeNull();
    expect(await finalize(b.documentId)).toMatchObject({ ok: true });
    const replay = await begin(bytes, b.key);
    expect(replay.documentId).toBe(b.documentId);
    expect(replay.alreadyReady).not.toBeNull();
    expect(replay.token).toBeNull();
    expect(sql(`select count(*) from public.case_documents where idempotency_key = ${lit(b.key)}`)).toBe("1");
    expect(await cancel(b.documentId)).toMatchObject({ ok: false });
    expect(state(b.path)).toMatchObject({ row: "ready", object: true });
  });
});

/**
 * Depois de um objeto atrasado: a limpeza apaga o arquivo e MANTÉM o rastreamento enquanto algum token emitido
 * ainda puder gravar; só encerra quando a janela fecha (simulada aqui recuando o fim da janela no banco).
 */
async function expectCleanupClosesWindow(path: string) {
  // Uma limpeza anterior (a que roda depois de cada escrita) pode ter conferido o caminho ainda vazio e marcado
  // a próxima conferência para até 10 minutos depois: simula a passagem desse intervalo.
  sql(`update public.case_document_storage_cleanup set claimed_until = null where storage_path = ${lit(path)}`);
  await admin.adminRunCaseDocumentCleanup(50);
  let s = state(path);
  expect(s.object, "a limpeza apaga o objeto atrasado").toBe(false);
  expect(s.queued, "o rastreamento continua enquanto a janela do token estiver aberta").toBe(true);
  sql(`update public.case_document_storage_cleanup set watch_until = clock_timestamp() - interval '1 second', claimed_until = null
       where storage_path = ${lit(path)}`);
  await admin.adminRunCaseDocumentCleanup(50);
  s = state(path);
  expect(s).toEqual({ row: null, queued: false, object: false });
}
