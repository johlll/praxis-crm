/**
 * @vitest-environment node
 *
 * A11 — agendador periódico da MANUTENÇÃO DE RETENÇÃO no app geral do Inngest (`praxis-crm`, `/api/inngest`), em
 * função PRÓPRIA (`a11-retention-scheduler`), a cada 10 minutos, separada do reconciliador da outbox
 * (`a11-reconciler-scheduler`). Faz tudo o que hoje depende de `/api/cron/retention` e nada além disso: eventos
 * travados, alerta antecipado de vencimento e o vencimento dos 30 dias. Prepara a retirada do `schedule` instável do
 * GitHub Actions sem ativar nada: o workflow e a rota continuam como estão. Só as proteções essenciais:
 *
 *  A. a rota `/api/cron/retention` (usada pelo workflow) se comporta como antes da extração da operação
 *     compartilhada: mesmos limites, mesma ordem, mesmas respostas, mesmos alertas e mesmos códigos;
 *  B. o payload real da sincronização (SDK real, sem rede) tem EXATAMENTE cinco funções; a nova leva só o cron de
 *     10 em 10 minutos, concorrência 1 e 0 retries; A11 (evento), C1, C3b e o reconciliador ficam iguais;
 *  C. a função chama a MESMA operação da rota, com os mesmos limites, e devolve só contagens;
 *  D. configuração ausente falha antes do banco; erro do banco ou resposta inválida falham com código fechado,
 *     sem mensagem original, payload, dado pessoal ou segredo; os alertas saem como sempre (só identificadores);
 *  E. execução simultânea (workflow, reconciliador e retenção do Inngest) não duplica alerta, expiração nem
 *     auditoria — as garantias são do banco (`for update skip locked` + marcador); a prova no banco real fica em
 *     scripts/a11-schedulers-concurrency-check.mjs, no CI;
 *  F. as duas funções do Inngest são independentes: falha de uma não impede a outra;
 *  G. nenhum módulo da agenda, do WhatsApp ou da Vitória, e nenhuma chamada externa própria.
 *
 * Chaves fictícias. O banco é simulado no cliente do Supabase.
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
const URL_RETENCAO = `${BASE}/api/cron/retention`;
const CRON_SECRET = "cron-secret-ficticio-0001";
const FN_A11 = "praxis-crm-a11-process-form-submission";
const FN_C1 = "praxis-crm-c1-automations-scheduler";
const FN_C3B = "praxis-crm-c3b-privacy-retention-scheduler";
const FN_RECONCILIADOR = "praxis-crm-a11-reconciler-scheduler";
const FN_RETENCAO = "praxis-crm-a11-retention-scheduler";
const SEGREDO_NO_ERRO = "senha=segredo-ficticio +5511999990000 maria@exemplo.com payload={cpf:123}";
const WORKSPACE = "20000000-0000-4000-8000-000000000001";
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
// O alerta estruturado da retenção sai em console.warn (comportamento da rota, preservado); o SDK registra a falha da
// etapa em console.error. Esses são os ÚNICOS logs permitidos, e o conteúdo de ambos é conferido nos testes.
let avisosPermitidos = false;
let logDoSdk = false;

beforeEach(() => {
  vi.resetModules();
  avisosPermitidos = false;
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
    if (avisosPermitidos && spy === spies[2]) continue;
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

const uuid = (prefixo: number, n: number) => `${prefixo}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const idEvento = (n: number) => uuid(1, n);

type Alerta = { kind: string; webhook_event_id: string; workspace_id: string } & Record<string, unknown>;
const alerta = (kind: string, n: number, extra: Record<string, unknown> = {}): Alerta => ({
  kind,
  webhook_event_id: idEvento(n),
  workspace_id: WORKSPACE,
  ...extra,
});

/** O que o banco devolve de verdade (campos extras do alerta incluídos: nunca podem ir para o log). */
const RESPOSTAS_PADRAO = {
  stuck: {
    alerts: [
      alerta("stuck", 1, { status: "received", attempts: 2, expires_at: "2026-12-01T00:00:00Z" }),
      alerta("stuck", 2, { status: "failed", attempts: 5, expires_at: "2026-12-02T00:00:00Z" }),
    ],
    count: 2,
  },
  expiring: { alerts: [alerta("expiring_unprocessed", 3, { expires_at: "2026-11-18T00:00:00Z" })], count: 1 },
  purge: { purged: 4, expired_unprocessed: 1, alerts: [alerta("expired_unprocessed", 5, { attempts: 3 })] },
};

type Chamada = { fn: string; args: Record<string, unknown> };
type Respostas = { stuck?: unknown; expiring?: unknown; purge?: unknown };

/** Banco simulado, sem estado: devolve o que for pedido para cada uma das três RPCs e registra as chamadas. */
function bancoRetencao(respostas: Respostas = {}, falhas: ("stuck" | "expiring" | "purge")[] = []) {
  const chamadas: Chamada[] = [];
  const dados = { ...RESPOSTAS_PADRAO, ...respostas };
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> => {
    chamadas.push({ fn, args });
    const chave = fn === "flag_stuck_webhook_events" ? "stuck" : fn === "flag_expiring_webhook_events" ? "expiring" : "purge";
    if (falhas.includes(chave)) return { data: null, error: { message: SEGREDO_NO_ERRO } };
    return { data: dados[chave], error: null };
  });
  h.createClient.mockImplementation(() => ({ rpc }));
  return { rpc, chamadas };
}

const pedido = (autorizacao?: string, metodo = "POST") =>
  new Request(URL_RETENCAO, { method: metodo, headers: autorizacao ? { authorization: autorizacao } : {} });

const step = { run: async (_id: string, fn: () => Promise<unknown>) => fn() };

/** O que a rota sempre registrou em console.warn para cada alerta (só estes cinco campos). */
const linhaDeAlerta = (a: Alerta) =>
  JSON.stringify({ level: "warn", event: "a11.ingest.alert", kind: a.kind, webhook_event_id: a.webhook_event_id, workspace_id: a.workspace_id });
const avisos = (): string[] => (spies[2]?.mock.calls ?? []).map((c: unknown[]) => String(c[0]));

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

/** Executa a função de retenção com o SDK real (assinatura válida, sem rede). */
async function executarNoSdk(eventId: string, runId: string, fnId = FN_RETENCAO) {
  const route = await import("@/app/api/inngest/route");
  const ev = { name: "inngest/scheduled.timer", data: { cron: "*/10 * * * *" }, id: eventId, ts: Date.now() };
  const body = JSON.stringify({
    event: ev,
    events: [ev],
    steps: {},
    ctx: { run_id: runId, attempt: 0, disable_immediate_execution: false, use_api: false, stack: { stack: [], current: 0 }, fn_id: fnId },
    version: 1,
  });
  return route.POST(
    new NextRequest(`${URL_ROTA}?fnId=${fnId}&stepId=step`, {
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
describe("A. a rota /api/cron/retention (usada pelo workflow) continua como estava", () => {
  it("sem segredo ou com segredo errado: 401 e o banco nem é tocado", async () => {
    withIngestConfig();
    const { POST } = await import("@/app/api/cron/retention/route");
    for (const autorizacao of [undefined, "Bearer errado", `Basic ${CRON_SECRET}`]) {
      const res = await POST(pedido(autorizacao));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(h.createClient).not.toHaveBeenCalled();
  });

  it("chama as três RPCs, nesta ordem e com estes limites: travados 100 · a vencer 100 em 7 dias · vencimento 200", async () => {
    withIngestConfig();
    const db = bancoRetencao();
    const { POST } = await import("@/app/api/cron/retention/route");
    avisosPermitidos = true;
    const res = await POST(pedido(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    expect(db.chamadas).toEqual([
      { fn: "flag_stuck_webhook_events", args: { p_limit: 100 } },
      { fn: "flag_expiring_webhook_events", args: { p_limit: 100, p_days_before: 7 } },
      { fn: "purge_expired_webhook_events", args: { p_limit: 200 } },
    ]);
  });

  it("responde só as quatro contagens, tiradas de count / count / purged / expired_unprocessed", async () => {
    withIngestConfig();
    bancoRetencao();
    const { POST } = await import("@/app/api/cron/retention/route");
    avisosPermitidos = true;
    const res = await POST(pedido(`Bearer ${CRON_SECRET}`));
    expect(await res.json()).toEqual({ stuck: 2, expiring: 1, purged: 4, expired_unprocessed: 1 });
  });

  it("registra cada alerta em console.warn, na ordem travados → a vencer → vencidos, SÓ com os cinco campos de sempre", async () => {
    withIngestConfig();
    bancoRetencao();
    const { POST } = await import("@/app/api/cron/retention/route");
    avisosPermitidos = true;
    await POST(pedido(`Bearer ${CRON_SECRET}`));
    const { stuck, expiring, purge } = RESPOSTAS_PADRAO;
    expect(avisos()).toEqual([...stuck.alerts, ...expiring.alerts, ...purge.alerts].map(linhaDeAlerta));
    expect(avisos().join("")).not.toMatch(/status|attempts|expires_at|received|failed/);
  });

  it("sem nada a fazer: 200 com zeros e nenhum alerta", async () => {
    withIngestConfig();
    bancoRetencao({
      stuck: { alerts: [], count: 0 },
      expiring: { alerts: [], count: 0 },
      purge: { purged: 0, expired_unprocessed: 0, alerts: [] },
    });
    const { POST } = await import("@/app/api/cron/retention/route");
    const res = await POST(pedido(`Bearer ${CRON_SECRET}`));
    expect(await res.json()).toEqual({ stuck: 0, expiring: 0, purged: 0, expired_unprocessed: 0 });
    expect(avisos()).toEqual([]);
  });

  it.each(["stuck", "expiring", "purge"] as const)("erro em %s: 503 retention_failed; as TRÊS RPCs ainda rodam e nenhum alerta é registrado", async (qual) => {
    withIngestConfig();
    const db = bancoRetencao({}, [qual]);
    const { POST } = await import("@/app/api/cron/retention/route");
    const res = await POST(pedido(`Bearer ${CRON_SECRET}`));
    const texto = await res.text();
    expect(res.status).toBe(503);
    expect(JSON.parse(texto)).toEqual({ error: "retention_failed" });
    expect(texto).not.toMatch(/segredo|maria|\+55|payload|cpf/);
    expect(db.chamadas.map((c) => c.fn)).toEqual(["flag_stuck_webhook_events", "flag_expiring_webhook_events", "purge_expired_webhook_events"]);
    expect(avisos()).toEqual([]);
  });

  it("banco que não responde (exceção) não é engolido: a rota propaga e as RPCs seguintes não rodam", async () => {
    withIngestConfig();
    const db = bancoRetencao();
    db.rpc.mockRejectedValueOnce(new TypeError(`fetch failed ${SEGREDO_NO_ERRO}`));
    const { POST } = await import("@/app/api/cron/retention/route");
    await expect(POST(pedido(`Bearer ${CRON_SECRET}`))).rejects.toThrow();
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(avisos()).toEqual([]);
  });

  it("o GET (agendador da Vercel) é o mesmo manipulador do POST", async () => {
    withIngestConfig();
    bancoRetencao();
    const rota = await import("@/app/api/cron/retention/route");
    expect(rota.GET).toBe(rota.POST);
    avisosPermitidos = true;
    const res = await rota.GET(pedido(`Bearer ${CRON_SECRET}`, "GET"));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe("B. o payload real da sincronização", () => {
  it("1/15. serve EXATAMENTE cinco funções: A11 (evento), C1, C3b, o reconciliador e a retenção da A11", async () => {
    const functions = await funcoesSincronizadas();
    expect(functions.map((fn) => fn.id).sort()).toEqual([FN_A11, FN_C1, FN_C3B, FN_RECONCILIADOR, FN_RETENCAO].sort());
    expect(functions).toHaveLength(5);
  });

  it("2–3. cron exatamente `*/10 * * * *` e nenhum outro gatilho (nenhum evento)", async () => {
    const fn = (await funcoesSincronizadas()).find((f) => f.id === FN_RETENCAO);
    expect(fn?.triggers).toEqual([{ cron: "*/10 * * * *" }]);
  });

  it("4. concorrência exatamente 1", async () => {
    const fn = (await funcoesSincronizadas()).find((f) => f.id === FN_RETENCAO);
    expect(fn?.concurrency).toEqual({ limit: 1 });
  });

  it("5. retries exatamente 0 e um único passo", async () => {
    const fn = (await funcoesSincronizadas()).find((f) => f.id === FN_RETENCAO);
    expect(Object.values(fn?.steps ?? {}).map((s) => s.retries)).toEqual([{ attempts: 0 }]);
  });

  it("a retenção e o reconciliador são funções DISTINTAS, cada uma com a própria concorrência 1", async () => {
    const functions = await funcoesSincronizadas();
    const retencao = functions.find((f) => f.id === FN_RETENCAO);
    const reconciliador = functions.find((f) => f.id === FN_RECONCILIADOR);
    expect(retencao).toBeDefined();
    expect(reconciliador).toBeDefined();
    expect(retencao?.id).not.toBe(reconciliador?.id);
    expect(retencao?.concurrency).toEqual({ limit: 1 });
    expect(reconciliador?.concurrency).toEqual({ limit: 1 });
    expect(reconciliador?.triggers).toEqual([{ cron: "*/10 * * * *" }]);
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
    const fonte = semComentarios(lerFonte("src/app/api/inngest/a11-retention-scheduler.ts"));
    expect(fonte).toContain('id: "a11-retention-scheduler" as const');
    expect(fonte).toContain('triggers: [{ cron: "*/10 * * * *" }]');
    expect(fonte).toContain("concurrency: { limit: 1 }");
    expect(fonte).toContain("retries: 0 as const");
    expect(fonte).not.toMatch(/event:\s*["'`A-Z]|\.send\(|inngestClient\(|inngestPublisher/);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe("C. a execução reutiliza a operação existente", () => {
  it("6–7. chama a operação UMA vez, com as mesmas três RPCs, ordem e limites da rota", async () => {
    withIngestConfig();
    const db = bancoRetencao();
    const { handleA11RetentionScheduler } = await import("@/app/api/inngest/a11-retention-scheduler");
    avisosPermitidos = true;
    await handleA11RetentionScheduler({ step });
    expect(h.createClient).toHaveBeenCalledTimes(1);
    expect(db.chamadas).toEqual([
      { fn: "flag_stuck_webhook_events", args: { p_limit: 100 } },
      { fn: "flag_expiring_webhook_events", args: { p_limit: 100, p_days_before: 7 } },
      { fn: "purge_expired_webhook_events", args: { p_limit: 200 } },
    ]);
    expect(fetchFalso).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("rota e função fazem EXATAMENTE o mesmo: mesmas chamadas, mesmo resultado e os mesmos alertas no log", async () => {
    withIngestConfig();
    const dbRota = bancoRetencao();
    const { POST } = await import("@/app/api/cron/retention/route");
    avisosPermitidos = true;
    const resposta = await (await POST(pedido(`Bearer ${CRON_SECRET}`))).json();
    const avisosRota = avisos();

    spies[2]?.mockClear();
    const dbFuncao = bancoRetencao();
    const { handleA11RetentionScheduler } = await import("@/app/api/inngest/a11-retention-scheduler");
    const resultado = await handleA11RetentionScheduler({ step });

    expect(dbFuncao.chamadas).toEqual(dbRota.chamadas);
    expect(resultado).toEqual(resposta);
    expect(avisos()).toEqual(avisosRota);
    expect(avisosRota).toHaveLength(4);
  });

  it("não escreve a própria lógica: rota e função chamam runRetentionMaintenance, e só ela conhece as RPCs", () => {
    const compartilhada = lerFonte("src/server/ingest/retention-maintenance.ts");
    const rota = lerFonte("src/app/api/cron/retention/route.ts");
    const agendador = lerFonte("src/app/api/inngest/a11-retention-scheduler.ts");
    expect(rota).toContain("runRetentionMaintenance(");
    expect(agendador).toContain("runRetentionMaintenance(");
    for (const rpc of ["flag_stuck_webhook_events", "flag_expiring_webhook_events", "purge_expired_webhook_events"]) {
      expect(semComentarios(compartilhada), rpc).toContain(`"${rpc}"`);
      expect(semComentarios(rota), rpc).not.toContain(rpc);
      expect(semComentarios(agendador), rpc).not.toContain(rpc);
    }
    expect(semComentarios(compartilhada)).not.toMatch(/\.from\(/);
  });

  it("8. devolve só as quatro contagens, mesmo que o banco mande outros campos", async () => {
    withIngestConfig();
    bancoRetencao({
      stuck: { alerts: [], count: 1, payload: SEGREDO_NO_ERRO, contato: "maria@exemplo.com" },
      expiring: { alerts: [], count: 2 },
      purge: { purged: 3, expired_unprocessed: 4, alerts: [], lead_id: "x" },
    });
    const { handleA11RetentionScheduler } = await import("@/app/api/inngest/a11-retention-scheduler");
    const resultado = await handleA11RetentionScheduler({ step });
    expect(resultado).toEqual({ stuck: 1, expiring: 2, purged: 3, expired_unprocessed: 4 });
    expect(JSON.stringify(resultado)).not.toMatch(/segredo|maria|payload|contato|lead_id|\+55/);
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
    const { handleA11RetentionScheduler } = await import("@/app/api/inngest/a11-retention-scheduler");
    const erro = (await handleA11RetentionScheduler({ step }).catch((e: unknown) => e)) as Error & { code: string };
    expect(erro.code).toBe("a11_retention_not_configured");
    expect(erro.message).toBe("a11_retention_not_configured");
    expect(`${erro.message}${erro.stack}`).not.toMatch(/SUPABASE|TURNSTILE|ingestão/);
    expect(h.createClient).not.toHaveBeenCalled();
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  const casos: [string, () => ReturnType<typeof bancoRetencao>][] = [
    ["10. erro do banco em flag_stuck_webhook_events", () => bancoRetencao({}, ["stuck"])],
    ["10. erro do banco em flag_expiring_webhook_events", () => bancoRetencao({}, ["expiring"])],
    ["10. erro do banco em purge_expired_webhook_events", () => bancoRetencao({}, ["purge"])],
    [
      "10. banco não responde",
      () => {
        const db = bancoRetencao();
        db.rpc.mockRejectedValueOnce(new TypeError(`fetch failed ${SEGREDO_NO_ERRO}`));
        return db;
      },
    ],
    ["11. resposta vazia (null)", () => bancoRetencao({ stuck: null })],
    ["11. resposta que não é objeto", () => bancoRetencao({ expiring: "texto" })],
    ["11. contagem inválida (negativa)", () => bancoRetencao({ stuck: { alerts: [], count: -1 } })],
    ["11. contagem inválida (texto)", () => bancoRetencao({ purge: { purged: "3", expired_unprocessed: 0, alerts: [] } })],
    ["11. contagem inválida (fracionária)", () => bancoRetencao({ expiring: { alerts: [], count: 1.5 } })],
    ["11. alertas que não são lista", () => bancoRetencao({ stuck: { alerts: { kind: "stuck" }, count: 0 } })],
    ["11. alerta sem identificador", () => bancoRetencao({ expiring: { alerts: [{ kind: "x", webhook_event_id: 7 }], count: 1 } })],
  ];

  it.each(casos)("%s: a execução FALHA só com o código a11_retention_failed, sem mensagem, pilha, PII nem log", async (_nome, preparar) => {
    withIngestConfig();
    preparar();
    const { handleA11RetentionScheduler, A11RetentionSchedulerFailed } = await import("@/app/api/inngest/a11-retention-scheduler");
    const erro = await handleA11RetentionScheduler({ step }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(A11RetentionSchedulerFailed);
    const falha = erro as InstanceType<typeof A11RetentionSchedulerFailed>;
    expect(falha.code).toBe("a11_retention_failed");
    expect(falha.message).toBe("a11_retention_failed");
    expect(falha.stack).toBe("A11RetentionSchedulerFailed: a11_retention_failed");
    expect(`${falha.message}${falha.stack}${JSON.stringify(falha)}`).not.toMatch(/segredo|maria|\+55|payload|cpf|fetch failed/);
  });

  it("a mesma resposta inválida também derruba a rota (503), sem registrar alertas", async () => {
    withIngestConfig();
    bancoRetencao({ stuck: { alerts: [alerta("stuck", 1)], count: -1 } });
    const { POST } = await import("@/app/api/cron/retention/route");
    const res = await POST(pedido(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "retention_failed" });
    expect(avisos()).toEqual([]);
  });

  it("12. o alerta no log leva só os cinco campos de sempre — nunca o que o banco mandar a mais", async () => {
    withIngestConfig();
    bancoRetencao({
      stuck: {
        alerts: [alerta("stuck", 1, { payload: SEGREDO_NO_ERRO, contato: "maria@exemplo.com", telefone: "+5511999990000", last_error_code: "x" })],
        count: 1,
      },
      expiring: { alerts: [], count: 0 },
      purge: { purged: 0, expired_unprocessed: 0, alerts: [] },
    });
    const { handleA11RetentionScheduler } = await import("@/app/api/inngest/a11-retention-scheduler");
    avisosPermitidos = true;
    await handleA11RetentionScheduler({ step });
    expect(avisos()).toEqual([linhaDeAlerta(alerta("stuck", 1))]);
    expect(avisos().join("")).not.toMatch(/segredo|maria|\+55|payload|contato|telefone|last_error/);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe("na execução real do SDK", () => {
  it("12. o erro do banco vira StepFailed sem nova tentativa e sem vazar nada", async () => {
    withIngestConfig();
    bancoRetencao({}, ["purge"]);
    const res = await executarNoSdk("evt-1", "run-1");
    const text = await res.text();
    logDoSdk = true;
    const logs = JSON.stringify(spies[3]?.mock.calls.map((call: unknown[]) => call.map(String)));
    expect(logs).toContain("a11_retention_failed");
    expect(logs).not.toMatch(/segredo|maria|\+55|payload|cpf|sb_secret|SUPABASE/);
    expect(res.status).toBe(206);
    expect(res.headers.get("x-inngest-no-retry")).toBe("true");
    expect(JSON.parse(text)[0]).toMatchObject({
      op: "StepFailed",
      error: { name: "A11RetentionSchedulerFailed", message: "a11_retention_failed" },
    });
    expect(text).not.toMatch(/segredo|maria|\+55|payload|cpf|sb_secret|praxis-crm\/src/);
    expect(avisos()).toEqual([]);
    expect(h.publish).not.toHaveBeenCalled();
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("o sucesso devolve só as contagens (os alertas ficam no log do servidor, só com identificadores)", async () => {
    withIngestConfig();
    bancoRetencao();
    avisosPermitidos = true;
    const res = await executarNoSdk("evt-2", "run-2");
    const text = await res.text();
    expect(res.status).toBeLessThan(300);
    expect(JSON.parse(text)[0]).toMatchObject({ op: "StepRun", data: { stuck: 2, expiring: 1, purged: 4, expired_unprocessed: 1 } });
    expect(text).not.toMatch(/webhook_event_id|workspace_id|alerts|10000000-0000/);
    expect(avisos()).toHaveLength(4);
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
describe("E. execução simultânea: workflow antigo, reconciliador e retenção do Inngest", () => {
  type Evento = { id: string; stuckAlertado: boolean; vencendoAlertado: boolean; purgado: boolean; categoria: "travado" | "vencendo" | "vencido" };

  /**
   * Banco com estado. Cada RPC escolhe e marca as linhas de forma ATÔMICA (nada aguarda entre escolher e marcar),
   * como o `for update skip locked` + marcador do banco; a auditoria é gravada junto, na mesma operação.
   */
  function bancoComEstado(quantidade: number) {
    const eventos: Evento[] = [];
    for (const categoria of ["travado", "vencendo", "vencido"] as const) {
      for (let i = 0; i < quantidade; i += 1) {
        eventos.push({ id: idEvento(eventos.length + 1), stuckAlertado: false, vencendoAlertado: false, purgado: false, categoria });
      }
    }
    const auditoria: { acao: string; evento: string }[] = [];
    const rpc = vi.fn(async (fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> => {
      const limite = args.p_limit as number;
      if (fn === "flag_stuck_webhook_events") {
        const escolhidos = eventos.filter((e) => e.categoria === "travado" && !e.stuckAlertado && !e.purgado).slice(0, limite);
        for (const e of escolhidos) {
          e.stuckAlertado = true;
          auditoria.push({ acao: "webhook_event.stuck", evento: e.id });
        }
        return { data: { alerts: escolhidos.map((e) => alerta("stuck", Number(e.id.slice(-12)))), count: escolhidos.length }, error: null };
      }
      if (fn === "flag_expiring_webhook_events") {
        const escolhidos = eventos.filter((e) => e.categoria !== "travado" && !e.vencendoAlertado && !e.purgado).slice(0, limite);
        for (const e of escolhidos) {
          e.vencendoAlertado = true;
          auditoria.push({ acao: "webhook_event.expiring_unprocessed", evento: e.id });
        }
        return {
          data: { alerts: escolhidos.map((e) => alerta("expiring_unprocessed", Number(e.id.slice(-12)))), count: escolhidos.length },
          error: null,
        };
      }
      if (fn === "purge_expired_webhook_events") {
        const escolhidos = eventos.filter((e) => e.categoria === "vencido" && !e.purgado).slice(0, limite);
        for (const e of escolhidos) {
          e.purgado = true;
          auditoria.push({ acao: "webhook_event.expired_unprocessed", evento: e.id });
        }
        return {
          data: {
            purged: 0,
            expired_unprocessed: escolhidos.length,
            alerts: escolhidos.map((e) => alerta("expired_unprocessed", Number(e.id.slice(-12)))),
          },
          error: null,
        };
      }
      return { data: [], error: null };
    });
    h.createClient.mockImplementation(() => ({ rpc }));
    return { eventos, auditoria, rpc };
  }

  const contagem = (itens: string[]) => {
    const m = new Map<string, number>();
    for (const i of itens) m.set(i, (m.get(i) ?? 0) + 1);
    return m;
  };

  it("rota (workflow) e função do Inngest ao mesmo tempo: cada alerta, expiração e auditoria acontece UMA vez", async () => {
    withIngestConfig();
    const db = bancoComEstado(150); // mais que o limite de 100 por chamada: as duas precisam dividir o trabalho
    const { POST } = await import("@/app/api/cron/retention/route");
    const { handleA11RetentionScheduler } = await import("@/app/api/inngest/a11-retention-scheduler");
    avisosPermitidos = true;

    await Promise.all([
      POST(pedido(`Bearer ${CRON_SECRET}`)).then((r) => r.json()),
      handleA11RetentionScheduler({ step }),
      handleA11RetentionScheduler({ step }),
    ]);
    // segunda leva (sobra do limite): ainda simultânea
    await Promise.all([POST(pedido(`Bearer ${CRON_SECRET}`)), handleA11RetentionScheduler({ step })]);

    const porEvento = contagem(db.auditoria.map((a) => `${a.acao}|${a.evento}`));
    expect([...porEvento.values()].every((n) => n === 1)).toBe(true);
    const total = (acao: string) => db.auditoria.filter((a) => a.acao === acao).length;
    expect(total("webhook_event.stuck")).toBe(150);
    expect(total("webhook_event.expiring_unprocessed")).toBe(300);
    expect(total("webhook_event.expired_unprocessed")).toBe(150);

    const alertasNoLog = contagem(avisos().map((linha) => {
      const a = JSON.parse(linha) as { kind: string; webhook_event_id: string };
      return `${a.kind}|${a.webhook_event_id}`;
    }));
    expect([...alertasNoLog.values()].every((n) => n === 1)).toBe(true);
    expect(alertasNoLog.size).toBe(600);
  });

  it("a rodada seguinte não repete nenhum efeito já concluído", async () => {
    withIngestConfig();
    const db = bancoComEstado(5);
    const { handleA11RetentionScheduler } = await import("@/app/api/inngest/a11-retention-scheduler");
    avisosPermitidos = true;
    await handleA11RetentionScheduler({ step });
    const antes = db.auditoria.length;
    const avisosAntes = avisos().length;
    expect(await handleA11RetentionScheduler({ step })).toEqual({ stuck: 0, expiring: 0, purged: 0, expired_unprocessed: 0 });
    expect(db.auditoria).toHaveLength(antes);
    expect(avisos()).toHaveLength(avisosAntes);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe("F. as duas funções do Inngest são independentes", () => {
  it("falha do reconciliador da outbox não impede a retenção", async () => {
    withIngestConfig();
    const db = bancoRetencao();
    const reconciliador = await import("@/app/api/inngest/a11-reconciler-scheduler");
    const retencao = await import("@/app/api/inngest/a11-retention-scheduler");
    // o reconciliador usa o MESMO cliente simulado; para ele, a reivindicação falha
    db.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      if (fn === "resolve_stale_outbox_batch") return { data: [], error: null };
      if (fn === "claim_outbox_batch") return { data: null, error: { message: SEGREDO_NO_ERRO } };
      db.chamadas.push({ fn, args });
      const chave = fn === "flag_stuck_webhook_events" ? "stuck" : fn === "flag_expiring_webhook_events" ? "expiring" : "purge";
      return { data: RESPOSTAS_PADRAO[chave], error: null };
    });
    avisosPermitidos = true;
    await expect(reconciliador.handleA11ReconcilerScheduler({ step })).rejects.toMatchObject({ code: "a11_reconciler_claim_failed" });
    expect(await retencao.handleA11RetentionScheduler({ step })).toEqual({ stuck: 2, expiring: 1, purged: 4, expired_unprocessed: 1 });
  });

  it("falha da retenção não impede o reconciliador da outbox", async () => {
    withIngestConfig();
    const db = bancoRetencao({}, ["stuck"]);
    const reconciliador = await import("@/app/api/inngest/a11-reconciler-scheduler");
    const retencao = await import("@/app/api/inngest/a11-retention-scheduler");
    const original = db.rpc.getMockImplementation()!;
    db.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      if (fn === "resolve_stale_outbox_batch") return { data: [], error: null };
      if (fn === "claim_outbox_batch") return { data: [], error: null };
      return original(fn, args);
    });
    await expect(retencao.handleA11RetentionScheduler({ step })).rejects.toMatchObject({ code: "a11_retention_failed" });
    expect(await reconciliador.handleA11ReconcilerScheduler({ step })).toEqual({ resolved: 0, claimed: 0, published: 0, failed: 0 });
  });

  it("os arquivos não dependem um do outro", () => {
    const retencao = lerFonte("src/app/api/inngest/a11-retention-scheduler.ts");
    const reconciliador = lerFonte("src/app/api/inngest/a11-reconciler-scheduler.ts");
    expect(retencao).not.toMatch(/from "[^"]*(reconciler|outbox)[^"]*"/);
    expect(reconciliador).not.toMatch(/from "[^"]*retention[^"]*"/);
    expect(lerFonte("src/server/ingest/retention-maintenance.ts")).not.toMatch(/from "[^"]*(outbox|reconciler)[^"]*"/);
    expect(lerFonte("src/server/ingest/outbox-reconciler.ts")).not.toMatch(/from "[^"]*retention[^"]*"/);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe("G. isolamento: nada da agenda, do WhatsApp ou da Vitória, e nenhuma chamada externa própria", () => {
  const importsDe = (caminho: string) => [...lerFonte(caminho).matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);

  it("a função importa só o SDK, o cliente administrativo e a operação compartilhada", () => {
    const imports = importsDe("src/app/api/inngest/a11-retention-scheduler.ts");
    expect(imports).toEqual(["inngest", "@/server/supabase/admin", "@/server/ingest/retention-maintenance"]);
    expect(imports.join(" ")).not.toMatch(/calendar|whatsapp|vitoria|ycloud|publisher/i);
  });

  it("a operação compartilhada só importa tipos (sem agenda, WhatsApp, Vitória nem cliente administrativo)", () => {
    const fonte = lerFonte("src/server/ingest/retention-maintenance.ts");
    const linhasDeImport = fonte.split("\n").filter((l) => /^import\b/.test(l));
    expect(linhasDeImport.length).toBeGreaterThan(0);
    for (const l of linhasDeImport) expect(l, l).toMatch(/^import type /);
    expect(linhasDeImport.join(" ")).not.toMatch(/calendar|whatsapp|vitoria|ycloud|supabase\/admin/i);
  });

  it("sem fetch, HTTP, variável de ambiente nem leitura direta de tabela; só a operação compartilhada registra o alerta", () => {
    for (const caminho of ["src/app/api/inngest/a11-retention-scheduler.ts", "src/server/ingest/retention-maintenance.ts"]) {
      expect(semComentarios(lerFonte(caminho)), caminho).not.toMatch(/\bfetch\(|https?:|process\.env|\.from\(|whatsapp|vitoria|calendar/i);
    }
    expect(semComentarios(lerFonte("src/app/api/inngest/a11-retention-scheduler.ts"))).not.toMatch(/console\./);
    expect(semComentarios(lerFonte("src/app/api/cron/retention/route.ts"))).not.toMatch(/console\./);
    expect(semComentarios(lerFonte("src/server/ingest/retention-maintenance.ts")).match(/console\.\w+/g)).toEqual(["console.warn"]);
  });

  it("a rota geral soma as duas funções novas e mantém A11, C1 e C3b exatamente como estavam", () => {
    const rota = lerFonte("src/app/api/inngest/route.ts");
    expect(rota).not.toMatch(/whatsapp/i);
    expect(rota).toContain(
      "functions: [processFormSubmission, automationsScheduler, privacyRetentionScheduler, a11ReconcilerScheduler, a11RetentionScheduler]",
    );
    expect(rota).toContain("concurrency: { limit: 5 }");
    expect(rota).toContain("retries: A11_INGEST_MAX_RETRIES");
    expect(rota).toContain("triggers: [{ event: FORM_EVENT_NAME }]");
    expect(rota).toContain("export const A11_INGEST_MAX_RETRIES = 9;");
    expect(lerFonte("src/app/api/inngest/automations-scheduler.ts")).toContain('triggers: [{ cron: "*/2 * * * *" }]');
    expect(lerFonte("src/app/api/inngest/privacy-retention-scheduler.ts")).toContain('triggers: [{ cron: "17 6 * * *" }]');
  });

  it("o workflow atual da A11 continua intacto: schedule, workflow_dispatch e os DOIS endpoints", () => {
    const workflow = lerFonte(".github/workflows/a11-reconcile.yml");
    expect(workflow).toContain('- cron: "*/10 * * * *"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("/api/cron/outbox");
    expect(workflow).toContain("/api/cron/retention");
  });

  it("no banco real (CI): o teste de concorrência usa as MESMAS operações, os quatro atores e nenhum segredo", () => {
    const script = lerFonte("scripts/a11-schedulers-concurrency-check.mjs");
    const ci = lerFonte(".github/workflows/ci.yml");
    expect(script).toContain('import { reconcileOutbox } from "../src/server/ingest/outbox-reconciler.ts";');
    expect(script).toContain('import { runRetentionMaintenance } from "../src/server/ingest/retention-maintenance.ts";');
    expect(script).toContain("Promise.allSettled([");
    for (const ator of ["workflow", "inngest"]) expect(script, ator).toContain(`"${ator}"`);
    // as três pontas largam juntas: o workflow (outbox e depois retenção), o reconciliador e a retenção do Inngest
    expect(script).toMatch(/reconcileOutbox\(admin, publisher\("workflow"\)\)[\s\S]*runRetentionMaintenance\(admin\)/);
    expect(script).toMatch(/reconcileOutbox\(admin, publisher\("inngest"\)\)/);
    // a retenção também nasce só pelas RPCs oficiais: nenhuma tabela é editada pelo teste
    expect(script).not.toMatch(/\.update\(|\.delete\(|\.insert\(/);
    expect(script).not.toMatch(/inngestPublisher|INNGEST_|sb_secret|eyJ[A-Za-z0-9_-]{20,}/);
    expect(ci).toContain("node scripts/a11-schedulers-concurrency-check.mjs");
    expect(ci.indexOf("node scripts/a11-schedulers-concurrency-check.mjs")).toBeGreaterThan(ci.indexOf("supabase start"));
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
