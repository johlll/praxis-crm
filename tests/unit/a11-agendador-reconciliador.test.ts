/**
 * @vitest-environment node
 *
 * A11 — agendador periódico do reconciliador da outbox no app geral do Inngest (`praxis-crm`,
 * `/api/inngest`), em função PRÓPRIA (`a11-reconciler-scheduler`), a cada 10 minutos. Prepara a troca do
 * `schedule` do GitHub Actions (instável: intervalos de 3,4 a 10,6 h) sem ativar nada: o workflow atual e a rota
 * `/api/cron/outbox` continuam como estão. Só as proteções essenciais:
 *
 *  A. a rota `/api/cron/outbox` (usada pelo workflow) se comporta como antes da extração da operação
 *     compartilhada: mesmos limites, mesma ordem de chamadas, mesmas respostas e mesmos códigos fechados;
 *  B. o payload real da sincronização (SDK real, sem rede) tem EXATAMENTE cinco funções; a nova leva só o cron
 *     de 10 em 10 minutos, concorrência 1 e 0 retries; A11 (evento), C1 e C3b ficam iguais;
 *  C. a função chama a MESMA operação da rota (uma vez), com os mesmos limites, e devolve só contagens;
 *  D. configuração ausente falha antes do banco; erro do banco ou resposta inválida falham com código fechado,
 *     sem mensagem original, payload, dado pessoal, segredo ou log;
 *  E. execução simultânea com a rota existente não duplica nenhuma publicação (as garantias do banco são
 *     reaproveitadas; a prova no banco real fica em scripts/a11-schedulers-concurrency-check.mjs, no CI);
 *  F. nenhum módulo da agenda, do WhatsApp ou da Vitória, e nenhuma chamada externa própria.
 *
 * Chaves fictícias. O banco é simulado no cliente do Supabase (claim atômico, como o `skip locked`).
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ createClient: vi.fn(), publish: vi.fn() }));

vi.mock("@supabase/supabase-js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createClient: h.createClient,
}));

const SIGNING_KEY = `signkey-prod-${"c3".repeat(32)}`;
const BASE = "https://praxis-crm-exemplo.vercel.app";
const URL_ROTA = `${BASE}/api/inngest`;
const URL_OUTBOX = `${BASE}/api/cron/outbox`;
const CRON_SECRET = "cron-secret-ficticio-0001";
const FN_A11 = "praxis-crm-a11-process-form-submission";
const FN_C1 = "praxis-crm-c1-automations-scheduler";
const FN_C3B = "praxis-crm-c3b-privacy-retention-scheduler";
const FN_RECONCILIADOR = "praxis-crm-a11-reconciler-scheduler";
const FN_RETENCAO = "praxis-crm-a11-retention-scheduler";
const SEGREDO_NO_ERRO = "senha=segredo-ficticio +5511999990000 maria@exemplo.com payload={cpf:123}";
const RAIZ = process.cwd();
const A11_ENV = [
  "A11_PAYLOAD_ACTIVE_KEY_VERSION",
  "A11_PAYLOAD_KEY_VERSIONS",
  "A11_IP_HMAC_KEY",
  "TURNSTILE_SECRET_KEY",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "INNGEST_EVENT_KEY",
  "CRON_SECRET",
];

let spies: ReturnType<typeof vi.spyOn>[] = [];
const fetchFalso = vi.fn();
// O próprio SDK registra a falha da etapa em console.error (nome do erro + o erro já sanitizado). Esse é o
// único log permitido, e o conteúdo dele é conferido no teste.
let logDoSdk = false;

beforeEach(() => {
  vi.resetModules();
  logDoSdk = false;
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("INNGEST_SIGNING_KEY", SIGNING_KEY);
  vi.stubEnv("INNGEST_DEV", "");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://projeto-ficticio.supabase.co");
  vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_ficticia");
  h.createClient.mockReset();
  h.publish.mockReset();
  fetchFalso.mockReset();
  fetchFalso.mockImplementation(async () => Response.json({ ok: true, modified: true }));
  vi.stubGlobal("fetch", fetchFalso);
});

afterEach(() => {
  for (const spy of spies) {
    if (logDoSdk && spy === spies[3]) continue;
    expect(spy).not.toHaveBeenCalled();
  }
  vi.doUnmock("@/server/ingest/config");
  vi.doUnmock("@/server/ingest/publisher");
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A11 "configurada": o validador é trocado, as demais camadas são as reais; o publicador é um espião. */
function withIngestConfig() {
  vi.doMock("@/server/ingest/config", () => ({
    IngestConfigError: class extends Error {},
    getIngestConfig: () => ({
      NEXT_PUBLIC_SUPABASE_URL: "https://projeto-ficticio.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_ficticia",
      CRON_SECRET,
    }),
  }));
  vi.doMock("@/server/ingest/publisher", async (importOriginal) => ({
    ...(await importOriginal<object>()),
    inngestPublisher: h.publish,
  }));
}

type Linha = { outbox_id: string; webhook_event_id: string; workspace_id: string };
const linha = (n: number): Linha => ({
  outbox_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  webhook_event_id: `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  workspace_id: "20000000-0000-4000-8000-000000000001",
});

type Chamada = { fn: string; args: Record<string, unknown> };

/**
 * Banco simulado: a escolha das linhas e a trava são atômicas (nada aguarda entre escolher e travar), como o
 * `for update skip locked` da `claim_outbox_batch`. Só as RPCs do reconciliador existem.
 */
function bancoFalso(linhas: Linha[], opcoes: { resolvidas?: number } = {}) {
  const estado = new Map(linhas.map((l) => [l.outbox_id, { ...l, state: "pending" as string }]));
  const chamadas: Chamada[] = [];
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> => {
    chamadas.push({ fn, args });
    if (fn === "resolve_stale_outbox_batch") {
      return { data: Array.from({ length: opcoes.resolvidas ?? 0 }, (_, i) => ({ outbox_id: `resolvida-${i}` })), error: null };
    }
    if (fn === "claim_outbox_batch") {
      const escolhidas = [...estado.values()].filter((l) => l.state === "pending").slice(0, args.p_limit as number);
      for (const l of escolhidas) l.state = "publishing";
      return {
        data: escolhidas.map((l) => ({
          outbox_id: l.outbox_id,
          webhook_event_id: l.webhook_event_id,
          workspace_id: l.workspace_id,
          event_type: "form.submission",
          attempts: 1,
        })),
        error: null,
      };
    }
    if (fn === "mark_outbox_published" || fn === "mark_outbox_failed") {
      const l = estado.get(String(args.p_outbox_id));
      if (l) l.state = fn === "mark_outbox_published" ? "published" : "failed";
      return { data: null, error: null };
    }
    return { data: null, error: { message: "rpc inesperada" } };
  });
  h.createClient.mockImplementation(() => ({ rpc }));
  return { rpc, chamadas, estado };
}

/** Publicador simulado: demora um instante (abre a janela de corrida) e registra o que foi publicado. */
function publicadorFalso(falhaEm: string[] = []) {
  const publicados: { webhookEventId: string; workspaceId: string }[] = [];
  h.publish.mockImplementation(async (entrada: { webhookEventId: string; workspaceId: string }) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (falhaEm.includes(entrada.webhookEventId)) throw new Error(SEGREDO_NO_ERRO);
    publicados.push(entrada);
  });
  return publicados;
}

const pedidoOutbox = (autorizacao?: string, metodo = "POST") =>
  new Request(URL_OUTBOX, { method: metodo, headers: autorizacao ? { authorization: autorizacao } : {} });

const step = { run: async (_id: string, fn: () => Promise<unknown>) => fn() };

type SyncedFunction = { id: string; concurrency?: unknown; triggers: unknown[]; steps: Record<string, { retries?: unknown }> };

async function funcoesSincronizadas(): Promise<SyncedFunction[]> {
  withIngestConfig();
  const route = await import("@/app/api/inngest/route");
  const response = await route.PUT(new NextRequest(URL_ROTA, { method: "PUT" }), undefined);
  expect(response.status).toBe(200);
  expect(fetchFalso).toHaveBeenCalledTimes(1);
  const [, init] = fetchFalso.mock.calls[0] as unknown as [unknown, { body: string }];
  return (JSON.parse(init.body) as { functions: SyncedFunction[] }).functions;
}

/** Executa a função com o SDK real (assinatura válida, sem rede). */
async function executarNoSdk(eventId: string, runId: string) {
  const route = await import("@/app/api/inngest/route");
  const ev = { name: "inngest/scheduled.timer", data: { cron: "*/10 * * * *" }, id: eventId, ts: Date.now() };
  const body = JSON.stringify({
    event: ev,
    events: [ev],
    steps: {},
    ctx: { run_id: runId, attempt: 0, disable_immediate_execution: false, use_api: false, stack: { stack: [], current: 0 }, fn_id: FN_RECONCILIADOR },
    version: 1,
  });
  return route.POST(
    new NextRequest(`${URL_ROTA}?fnId=${FN_RECONCILIADOR}&stepId=step`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-inngest-signature": signature(body) },
      body,
    }),
    undefined,
  );
}

const lerFonte = (caminho: string) => readFileSync(join(RAIZ, caminho), "utf8");
/** Código sem comentários, para conferir o que o arquivo FAZ e não o que ele explica. */
const semComentarios = (texto: string) => texto.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ---------------------------------------------------------------------------------------------------------
describe("A. a rota /api/cron/outbox (usada pelo workflow) continua como estava", () => {
  it("sem segredo ou com segredo errado: 401 e o banco nem é tocado", async () => {
    withIngestConfig();
    const { POST } = await import("@/app/api/cron/outbox/route");
    for (const autorizacao of [undefined, "Bearer errado", `Basic ${CRON_SECRET}`]) {
      const res = await POST(pedidoOutbox(autorizacao));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("sem lote: responde só as quatro contagens, com os limites de sempre (200 / 20 / 120 s)", async () => {
    withIngestConfig();
    const db = bancoFalso([]);
    const { POST } = await import("@/app/api/cron/outbox/route");
    const res = await POST(pedidoOutbox(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resolved: 0, claimed: 0, published: 0, failed: 0 });
    expect(db.chamadas).toEqual([
      { fn: "resolve_stale_outbox_batch", args: { p_limit: 200 } },
      { fn: "claim_outbox_batch", args: { p_limit: 20, p_lock_seconds: 120 } },
    ]);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("com lote: resolve, reivindica, publica o MESMO id e marca; falha de publicação vira publish_failed em 60 s", async () => {
    withIngestConfig();
    const db = bancoFalso([linha(1), linha(2), linha(3)], { resolvidas: 1 });
    const publicados = publicadorFalso([linha(2).webhook_event_id]);
    const { POST } = await import("@/app/api/cron/outbox/route");
    const res = await POST(pedidoOutbox(`Bearer ${CRON_SECRET}`));
    const texto = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(texto)).toEqual({ resolved: 1, claimed: 3, published: 2, failed: 1 });
    expect(texto).not.toMatch(/segredo|maria|\+55|payload|cpf/);
    expect(db.chamadas.map((c) => c.fn)).toEqual([
      "resolve_stale_outbox_batch",
      "claim_outbox_batch",
      "mark_outbox_published",
      "mark_outbox_failed",
      "mark_outbox_published",
    ]);
    expect(db.chamadas[2]?.args).toEqual({ p_outbox_id: linha(1).outbox_id });
    expect(db.chamadas[3]?.args).toEqual({ p_outbox_id: linha(2).outbox_id, p_error_code: "publish_failed", p_retry_in_seconds: 60 });
    expect(h.publish.mock.calls.map((c) => c[0])).toEqual([1, 2, 3].map((n) => ({ webhookEventId: linha(n).webhook_event_id, workspaceId: linha(n).workspace_id })));
    expect(publicados.map((p) => p.webhookEventId)).toEqual([linha(1).webhook_event_id, linha(3).webhook_event_id]);
  });

  it("erro ao convergir: 503 resolve_failed, sem reivindicar nem publicar", async () => {
    withIngestConfig();
    const db = bancoFalso([linha(1)]);
    db.rpc.mockImplementationOnce(async () => ({ data: null, error: { message: SEGREDO_NO_ERRO } }));
    const { POST } = await import("@/app/api/cron/outbox/route");
    const res = await POST(pedidoOutbox(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "resolve_failed" });
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("erro ao reivindicar: 503 claim_failed, sem publicar", async () => {
    withIngestConfig();
    const db = bancoFalso([linha(1)]);
    db.rpc.mockImplementationOnce(async () => ({ data: [], error: null }));
    db.rpc.mockImplementationOnce(async () => ({ data: null, error: { message: SEGREDO_NO_ERRO } }));
    const { POST } = await import("@/app/api/cron/outbox/route");
    const res = await POST(pedidoOutbox(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "claim_failed" });
    expect(db.rpc).toHaveBeenCalledTimes(2);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("o GET (agendador da Vercel) é o mesmo manipulador do POST", async () => {
    withIngestConfig();
    bancoFalso([]);
    const rota = await import("@/app/api/cron/outbox/route");
    expect(rota.GET).toBe(rota.POST);
    const res = await rota.GET(pedidoOutbox(`Bearer ${CRON_SECRET}`, "GET"));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe("B. o payload real da sincronização", () => {
  it("1/15. serve EXATAMENTE cinco funções: A11 (evento), C1, C3b, o reconciliador novo e a retenção da A11", async () => {
    const functions = await funcoesSincronizadas();
    expect(functions.map((fn) => fn.id).sort()).toEqual([FN_A11, FN_C1, FN_C3B, FN_RECONCILIADOR, FN_RETENCAO].sort());
    expect(functions).toHaveLength(5);
  });

  it("2–3. cron exatamente `*/10 * * * *` e nenhum outro gatilho (nenhum evento)", async () => {
    const fn = (await funcoesSincronizadas()).find((f) => f.id === FN_RECONCILIADOR);
    expect(fn?.triggers).toEqual([{ cron: "*/10 * * * *" }]);
  });

  it("4. concorrência exatamente 1", async () => {
    const fn = (await funcoesSincronizadas()).find((f) => f.id === FN_RECONCILIADOR);
    expect(fn?.concurrency).toEqual({ limit: 1 });
  });

  it("5. retries exatamente 0 e um único passo", async () => {
    const fn = (await funcoesSincronizadas()).find((f) => f.id === FN_RECONCILIADOR);
    expect(Object.values(fn?.steps ?? {}).map((s) => s.retries)).toEqual([{ attempts: 0 }]);
  });

  it("13. a função da A11 orientada a evento permanece igual", async () => {
    const fn = (await funcoesSincronizadas()).find((f) => f.id === FN_A11);
    expect(fn?.triggers).toEqual([{ event: "praxis/form.submission.received" }]);
    expect(fn?.concurrency).toEqual({ limit: 5 });
    expect(Object.values(fn?.steps ?? {}).map((s) => s.retries)).toEqual([{ attempts: 9 }]);
  });

  it("14. a C1 e a C3b permanecem iguais", async () => {
    const functions = await funcoesSincronizadas();
    const c1 = functions.find((f) => f.id === FN_C1);
    const c3b = functions.find((f) => f.id === FN_C3B);
    expect(c1?.triggers).toEqual([{ cron: "*/2 * * * *" }]);
    expect(c1?.concurrency).toEqual({ limit: 1 });
    expect(Object.values(c1?.steps ?? {}).map((s) => s.retries)).toEqual([{ attempts: 0 }]);
    expect(c3b?.triggers).toEqual([{ cron: "17 6 * * *" }]);
    expect(c3b?.concurrency).toEqual({ limit: 1 });
    expect(Object.values(c3b?.steps ?? {}).map((s) => s.retries)).toEqual([{ attempts: 0 }]);
  });

  it("a configuração do arquivo: id claro, gatilho só de relógio, sem evento", () => {
    const fonte = semComentarios(lerFonte("src/app/api/inngest/a11-reconciler-scheduler.ts"));
    expect(fonte).toContain('id: "a11-reconciler-scheduler" as const');
    expect(fonte).toContain('triggers: [{ cron: "*/10 * * * *" }]');
    expect(fonte).toContain("concurrency: { limit: 1 }");
    expect(fonte).toContain("retries: 0 as const");
    expect(fonte).not.toMatch(/event:\s*["'`A-Z]|\.send\(|inngestClient\(/);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe("C. a execução reutiliza a operação existente", () => {
  it("6. chama a operação UMA vez: resolve, reivindica e publica cada item uma única vez, nessa ordem", async () => {
    withIngestConfig();
    const db = bancoFalso([linha(1), linha(2)], { resolvidas: 3 });
    const publicados = publicadorFalso();
    const { handleA11ReconcilerScheduler } = await import("@/app/api/inngest/a11-reconciler-scheduler");
    const resultado = await handleA11ReconcilerScheduler({ step });
    expect(resultado).toEqual({ resolved: 3, claimed: 2, published: 2, failed: 0 });
    expect(db.chamadas.map((c) => c.fn)).toEqual([
      "resolve_stale_outbox_batch",
      "claim_outbox_batch",
      "mark_outbox_published",
      "mark_outbox_published",
    ]);
    expect(h.createClient).toHaveBeenCalledTimes(1);
    expect(publicados.map((p) => p.webhookEventId)).toEqual([linha(1).webhook_event_id, linha(2).webhook_event_id]);
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("7. mesmos limites e mesmo comportamento da rota: as duas chamam o banco e o publicador de forma idêntica", async () => {
    withIngestConfig();
    const falhas = [linha(2).webhook_event_id];
    const linhas = [linha(1), linha(2), linha(3)];

    const dbRota = bancoFalso(linhas, { resolvidas: 2 });
    publicadorFalso(falhas);
    const { POST } = await import("@/app/api/cron/outbox/route");
    const resposta = await (await POST(pedidoOutbox(`Bearer ${CRON_SECRET}`))).json();
    const publicacoesRota = h.publish.mock.calls.map((c) => c[0]);

    h.publish.mockReset();
    const dbAgendador = bancoFalso(linhas, { resolvidas: 2 });
    publicadorFalso(falhas);
    const { handleA11ReconcilerScheduler } = await import("@/app/api/inngest/a11-reconciler-scheduler");
    const resultado = await handleA11ReconcilerScheduler({ step });
    const publicacoesAgendador = h.publish.mock.calls.map((c) => c[0]);

    expect(dbAgendador.chamadas).toEqual(dbRota.chamadas);
    expect(publicacoesAgendador).toEqual(publicacoesRota);
    expect(resultado).toEqual(resposta);
    expect(dbAgendador.chamadas[0]?.args).toEqual({ p_limit: 200 });
    expect(dbAgendador.chamadas[1]?.args).toEqual({ p_limit: 20, p_lock_seconds: 120 });
  });

  it("não escreve a própria lógica: rota e agendador chamam reconcileOutbox, e só ela conhece as RPCs", () => {
    const compartilhada = lerFonte("src/server/ingest/outbox-reconciler.ts");
    const rota = lerFonte("src/app/api/cron/outbox/route.ts");
    const agendador = lerFonte("src/app/api/inngest/a11-reconciler-scheduler.ts");
    expect(rota).toContain("reconcileOutbox(");
    expect(agendador).toContain("reconcileOutbox(");
    for (const rpc of ["resolve_stale_outbox_batch", "claim_outbox_batch", "mark_outbox_published", "mark_outbox_failed"]) {
      expect(semComentarios(compartilhada), rpc).toContain(`"${rpc}"`);
      expect(semComentarios(rota), rpc).not.toContain(rpc);
      expect(semComentarios(agendador), rpc).not.toContain(rpc);
    }
    expect(semComentarios(compartilhada)).not.toMatch(/\.from\(/);
  });

  it("8. devolve só as quatro contagens, mesmo que o banco mande outros campos", async () => {
    withIngestConfig();
    const db = bancoFalso([linha(1)]);
    publicadorFalso();
    const original = db.rpc.getMockImplementation()!;
    db.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      const r = (await original(fn, args)) as { data: unknown; error: unknown };
      if (fn === "claim_outbox_batch") {
        const lote = r.data as Record<string, unknown>[];
        return { ...r, data: lote.map((item) => ({ ...item, payload: SEGREDO_NO_ERRO, contato: "maria@exemplo.com" })) };
      }
      return r;
    });
    const { handleA11ReconcilerScheduler } = await import("@/app/api/inngest/a11-reconciler-scheduler");
    const resultado = await handleA11ReconcilerScheduler({ step });
    expect(Object.keys(resultado as object).sort()).toEqual(["claimed", "failed", "published", "resolved"]);
    expect(JSON.stringify(resultado)).not.toMatch(/segredo|maria|payload|contato|\+55/);
  });

  it("falha de publicação de um item não derruba a rodada: vira contagem, como na rota", async () => {
    withIngestConfig();
    bancoFalso([linha(1), linha(2)]);
    publicadorFalso([linha(1).webhook_event_id]);
    const { handleA11ReconcilerScheduler } = await import("@/app/api/inngest/a11-reconciler-scheduler");
    expect(await handleA11ReconcilerScheduler({ step })).toEqual({ resolved: 0, claimed: 2, published: 1, failed: 1 });
  });

  it("falha ao marcar a publicação conta como falha do item e cai em mark_outbox_failed (mesma regra da rota)", async () => {
    withIngestConfig();
    const db = bancoFalso([linha(1)]);
    const original = db.rpc.getMockImplementation()!;
    db.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      if (fn === "mark_outbox_published") throw new Error(SEGREDO_NO_ERRO);
      return original(fn, args);
    });
    publicadorFalso();
    const { handleA11ReconcilerScheduler } = await import("@/app/api/inngest/a11-reconciler-scheduler");
    expect(await handleA11ReconcilerScheduler({ step })).toEqual({ resolved: 0, claimed: 1, published: 0, failed: 1 });
    expect(db.chamadas.map((c) => c.fn)).toEqual(["resolve_stale_outbox_batch", "claim_outbox_batch", "mark_outbox_failed"]);
    expect(db.chamadas[2]?.args).toEqual({ p_outbox_id: linha(1).outbox_id, p_error_code: "publish_failed", p_retry_in_seconds: 60 });
  });
});

// ---------------------------------------------------------------------------------------------------------
describe("D. falhas com código fechado", () => {
  it("9. configuração ausente: falha ANTES do banco, com código próprio e sem citar variável", async () => {
    vi.doMock("@/server/ingest/config", () => ({
      IngestConfigError: class extends Error {},
      getIngestConfig: () => {
        throw new Error("Configuração de ingestão ausente: SUPABASE_SECRET_KEY, TURNSTILE_SECRET_KEY");
      },
    }));
    const { handleA11ReconcilerScheduler } = await import("@/app/api/inngest/a11-reconciler-scheduler");
    const erro = (await handleA11ReconcilerScheduler({ step }).catch((e: unknown) => e)) as Error & { code: string };
    expect(erro.code).toBe("a11_reconciler_not_configured");
    expect(erro.message).toBe("a11_reconciler_not_configured");
    expect(`${erro.message}${erro.stack}`).not.toMatch(/SUPABASE|TURNSTILE|ingestão/);
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  type Preparar = () => ReturnType<typeof bancoFalso>;
  const casos: [string, string, Preparar][] = [
    [
      "10. erro do banco ao convergir",
      "a11_reconciler_resolve_failed",
      () => {
        const db = bancoFalso([linha(1)]);
        db.rpc.mockImplementationOnce(async () => ({ data: null, error: { message: SEGREDO_NO_ERRO } }));
        return db;
      },
    ],
    [
      "10. erro do banco ao reivindicar",
      "a11_reconciler_claim_failed",
      () => {
        const db = bancoFalso([linha(1)]);
        db.rpc.mockImplementationOnce(async () => ({ data: [], error: null }));
        db.rpc.mockImplementationOnce(async () => ({ data: null, error: { message: SEGREDO_NO_ERRO } }));
        return db;
      },
    ],
    [
      "10. banco não responde",
      "a11_reconciler_failed",
      () => {
        const db = bancoFalso([linha(1)]);
        db.rpc.mockRejectedValueOnce(new TypeError(`fetch failed ${SEGREDO_NO_ERRO}`));
        return db;
      },
    ],
    [
      "11. resposta inválida da convergência (não é lista)",
      "a11_reconciler_resolve_failed",
      () => {
        const db = bancoFalso([linha(1)]);
        db.rpc.mockImplementationOnce(async () => ({ data: { outbox_id: SEGREDO_NO_ERRO }, error: null }));
        return db;
      },
    ],
    [
      "11. resposta inválida da reivindicação (não é lista)",
      "a11_reconciler_claim_failed",
      () => {
        const db = bancoFalso([linha(1)]);
        db.rpc.mockImplementationOnce(async () => ({ data: [], error: null }));
        db.rpc.mockImplementationOnce(async () => ({ data: "texto", error: null }));
        return db;
      },
    ],
    [
      "11. resposta inválida da reivindicação (item sem identificador)",
      "a11_reconciler_claim_failed",
      () => {
        const db = bancoFalso([linha(1)]);
        db.rpc.mockImplementationOnce(async () => ({ data: [], error: null }));
        db.rpc.mockImplementationOnce(async () => ({ data: [{ outbox_id: "x", webhook_event_id: 7, workspace_id: null }], error: null }));
        return db;
      },
    ],
    [
      "erro inesperado ao registrar a falha de publicação do item",
      "a11_reconciler_failed",
      () => {
        const db = bancoFalso([linha(1)]);
        const original = db.rpc.getMockImplementation()!;
        db.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
          if (fn === "mark_outbox_failed") throw new Error(SEGREDO_NO_ERRO);
          return original(fn, args);
        });
        h.publish.mockRejectedValue(new Error(SEGREDO_NO_ERRO));
        return db;
      },
    ],
  ];

  it.each(casos)("%s: a execução FALHA só com o código %s, sem mensagem, pilha, PII nem log", async (_nome, codigo, preparar) => {
    withIngestConfig();
    publicadorFalso();
    preparar();
    const { handleA11ReconcilerScheduler, A11ReconcilerSchedulerFailed } = await import("@/app/api/inngest/a11-reconciler-scheduler");
    const erro = await handleA11ReconcilerScheduler({ step }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(A11ReconcilerSchedulerFailed);
    const falha = erro as InstanceType<typeof A11ReconcilerSchedulerFailed>;
    expect(falha.code).toBe(codigo);
    expect(falha.message).toBe(codigo);
    expect(falha.stack).toBe(`A11ReconcilerSchedulerFailed: ${codigo}`);
    expect(`${falha.message}${falha.stack}${JSON.stringify(falha)}`).not.toMatch(/segredo|maria|\+55|payload|cpf|fetch failed/);
  });

  it("na falha do banco, nada é publicado e nenhum item é marcado", async () => {
    withIngestConfig();
    const db = bancoFalso([linha(1)]);
    db.rpc.mockImplementationOnce(async () => ({ data: [], error: null }));
    db.rpc.mockImplementationOnce(async () => ({ data: null, error: { message: SEGREDO_NO_ERRO } }));
    publicadorFalso();
    const { handleA11ReconcilerScheduler } = await import("@/app/api/inngest/a11-reconciler-scheduler");
    await handleA11ReconcilerScheduler({ step }).catch(() => undefined);
    expect(h.publish).not.toHaveBeenCalled();
    expect(db.rpc.mock.calls.map((c) => c[0])).toEqual(["resolve_stale_outbox_batch", "claim_outbox_batch"]);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe("na execução real do SDK", () => {
  it("12. o erro do banco vira StepFailed sem nova tentativa e sem vazar nada", async () => {
    withIngestConfig();
    const db = bancoFalso([linha(1)]);
    db.rpc.mockImplementationOnce(async () => ({ data: [], error: null }));
    db.rpc.mockImplementationOnce(async () => ({ data: null, error: { message: SEGREDO_NO_ERRO } }));
    publicadorFalso();
    const res = await executarNoSdk("evt-1", "run-1");
    const text = await res.text();
    logDoSdk = true;
    const logs = JSON.stringify(spies[3]?.mock.calls.map((call: unknown[]) => call.map(String)));
    expect(logs).toContain("a11_reconciler_claim_failed");
    expect(logs).not.toMatch(/segredo|maria|\+55|payload|cpf|sb_secret|SUPABASE/);
    expect(res.status).toBe(206);
    expect(res.headers.get("x-inngest-no-retry")).toBe("true");
    expect(JSON.parse(text)[0]).toMatchObject({
      op: "StepFailed",
      error: { name: "A11ReconcilerSchedulerFailed", message: "a11_reconciler_claim_failed" },
    });
    expect(text).not.toMatch(/segredo|maria|\+55|payload|cpf|sb_secret|praxis-crm\/src/);
    expect(h.publish).not.toHaveBeenCalled();
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("o sucesso devolve só as contagens", async () => {
    withIngestConfig();
    bancoFalso([linha(1), linha(2)], { resolvidas: 1 });
    publicadorFalso();
    const res = await executarNoSdk("evt-2", "run-2");
    const text = await res.text();
    expect(res.status).toBeLessThan(300);
    expect(JSON.parse(text)[0]).toMatchObject({ op: "StepRun", data: { resolved: 1, claimed: 2, published: 2, failed: 0 } });
    expect(text).not.toMatch(/webhook_event_id|outbox_id|workspace_id|10000000-0000/);
  });

  it("sem a configuração obrigatória a rota continua falhando fechada (503) e o banco não é tocado", async () => {
    for (const nome of A11_ENV) vi.stubEnv(nome, "");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    const route = await import("@/app/api/inngest/route");
    for (const metodo of ["GET", "POST", "PUT"] as const) {
      const res = await route[metodo](new NextRequest(URL_ROTA, { method: metodo }), undefined);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "service_unavailable" });
    }
    expect(h.createClient).not.toHaveBeenCalled();
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------
describe("17. execução simultânea com o reconciliador existente", () => {
  it("rota e agendador ao mesmo tempo, com mais itens do que cabe num lote: cada item é publicado UMA vez", async () => {
    withIngestConfig();
    const linhas = Array.from({ length: 30 }, (_, i) => linha(i + 1));
    const db = bancoFalso(linhas);
    const publicados = publicadorFalso();
    const { POST } = await import("@/app/api/cron/outbox/route");
    const { handleA11ReconcilerScheduler } = await import("@/app/api/inngest/a11-reconciler-scheduler");

    const [resposta, resultado] = await Promise.all([
      POST(pedidoOutbox(`Bearer ${CRON_SECRET}`)).then((r) => r.json()),
      handleA11ReconcilerScheduler({ step }) as Promise<{ claimed: number; published: number }>,
    ]);

    const ids = publicados.map((p) => p.webhookEventId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice().sort()).toEqual(linhas.map((l) => l.webhook_event_id).sort());
    expect(resposta.claimed + resultado.claimed).toBe(30);
    expect(resposta.published + resultado.published).toBe(30);
    expect([...db.estado.values()].every((l) => l.state === "published")).toBe(true);
    const marcadas = db.chamadas.filter((c) => c.fn === "mark_outbox_published").map((c) => c.args.p_outbox_id);
    expect(new Set(marcadas).size).toBe(30);
  });

  it("no banco real (CI): o teste de concorrência usa a MESMA operação, duas execuções simultâneas e nenhum segredo", () => {
    const script = lerFonte("scripts/a11-schedulers-concurrency-check.mjs");
    const ci = lerFonte(".github/workflows/ci.yml");
    expect(script).toContain('import { reconcileOutbox } from "../src/server/ingest/outbox-reconciler.ts";');
    expect(script).toContain("Promise.allSettled([");
    expect(script).toMatch(/reconcileOutbox\(admin, publisher\("workflow"\)\)/);
    expect(script).toMatch(/reconcileOutbox\(admin, publisher\("inngest"\)\)/);
    expect(script).not.toMatch(/inngestPublisher|INNGEST_|sb_secret|eyJ[A-Za-z0-9_-]{20,}/);
    expect(ci).toContain("node scripts/a11-schedulers-concurrency-check.mjs");
    // o passo vem DEPOIS de o Supabase local subir e usa só a chave do Supabase local
    expect(ci.indexOf("node scripts/a11-schedulers-concurrency-check.mjs")).toBeGreaterThan(ci.indexOf("supabase start"));
  });

  it("a segunda rodada seguinte não republica o que já foi publicado", async () => {
    withIngestConfig();
    bancoFalso([linha(1), linha(2)]);
    const publicados = publicadorFalso();
    const { handleA11ReconcilerScheduler } = await import("@/app/api/inngest/a11-reconciler-scheduler");
    await handleA11ReconcilerScheduler({ step });
    expect(await handleA11ReconcilerScheduler({ step })).toEqual({ resolved: 0, claimed: 0, published: 0, failed: 0 });
    expect(publicados).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe("16. isolamento: nada da agenda, do WhatsApp ou da Vitória, e nenhuma chamada externa própria", () => {
  const importsDe = (caminho: string) => [...lerFonte(caminho).matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);

  it("o agendador importa só o SDK, o cliente administrativo, a operação compartilhada e o publicador existente", () => {
    const imports = importsDe("src/app/api/inngest/a11-reconciler-scheduler.ts");
    expect(imports).toEqual(["inngest", "@/server/supabase/admin", "@/server/ingest/outbox-reconciler", "@/server/ingest/publisher"]);
    expect(imports.join(" ")).not.toMatch(/calendar|whatsapp|vitoria|ycloud/i);
  });

  it("a operação compartilhada só importa tipos (sem agenda, WhatsApp, Vitória nem cliente administrativo)", () => {
    const fonte = lerFonte("src/server/ingest/outbox-reconciler.ts");
    const linhasDeImport = fonte.split("\n").filter((l) => /^import\b/.test(l));
    expect(linhasDeImport.length).toBeGreaterThan(0);
    for (const l of linhasDeImport) expect(l, l).toMatch(/^import type /);
    expect(linhasDeImport.join(" ")).not.toMatch(/calendar|whatsapp|vitoria|ycloud|supabase\/admin/i);
  });

  it("sem fetch, HTTP, log, variável de ambiente nem leitura direta de tabela", () => {
    for (const caminho of ["src/app/api/inngest/a11-reconciler-scheduler.ts", "src/server/ingest/outbox-reconciler.ts"]) {
      expect(semComentarios(lerFonte(caminho)), caminho).not.toMatch(/\bfetch\(|https?:|console\.|process\.env|\.from\(|whatsapp|vitoria|calendar/i);
    }
  });

  it("a rota geral soma o reconciliador e mantém A11, C1 e C3b exatamente como estavam", () => {
    const rota = lerFonte("src/app/api/inngest/route.ts");
    expect(rota).not.toMatch(/whatsapp/i);
    expect(rota).toContain(
      "functions: [processFormSubmission, automationsScheduler, privacyRetentionScheduler, a11ReconcilerScheduler, a11RetentionScheduler]",
    );
    expect(rota).toContain("concurrency: { limit: 5 }");
    expect(rota).toContain("retries: A11_INGEST_MAX_RETRIES");
    expect(rota).toContain("triggers: [{ event: FORM_EVENT_NAME }]");
    expect(rota).toContain("export const A11_INGEST_MAX_RETRIES = 9;");
    const c1 = lerFonte("src/app/api/inngest/automations-scheduler.ts");
    expect(c1).toContain('triggers: [{ cron: "*/2 * * * *" }]');
    const c3b = lerFonte("src/app/api/inngest/privacy-retention-scheduler.ts");
    expect(c3b).toContain('triggers: [{ cron: "17 6 * * *" }]');
  });

  it("o workflow atual da A11 continua com o schedule e os dois endpoints (nada foi retirado nesta PR)", () => {
    const workflow = lerFonte(".github/workflows/a11-reconcile.yml");
    expect(workflow).toContain('- cron: "*/10 * * * *"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("/api/cron/outbox");
    expect(workflow).toContain("/api/cron/retention");
  });

  it("o reconciliador não toca a retenção da A11 (/api/cron/retention segue só no workflow)", () => {
    expect(semComentarios(lerFonte("src/app/api/inngest/a11-reconciler-scheduler.ts"))).not.toMatch(/retention|flag_stuck|purge_expired/);
  });
});

// ---- assinatura como o Inngest assina (JSON canônico + timestamp) ----
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function signature(body: string, key = SIGNING_KEY, ts = Math.floor(Date.now() / 1000)) {
  const raw = key.replace(/^signkey-[\w]+-/, "");
  const data = body === "" ? "" : canonical(JSON.parse(body));
  return `t=${ts}&s=${createHmac("sha256", raw).update(data + ts).digest("hex")}`;
}
