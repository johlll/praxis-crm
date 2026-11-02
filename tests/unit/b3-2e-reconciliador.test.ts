/**
 * @vitest-environment node
 *
 * B3.2e — reconciliador da inbox do WhatsApp, no servidor (banco simulado,
 * cliente do Inngest com o `send` espiado; a chave continua lida de verdade).
 *
 * O reconciliador não processa conteúdo e não chama efeitos: reserva, republica
 * o MESMO evento interno `{ id: inboxId, name, data: { inboxId } }` e registra
 * só o resultado técnico. O token da reserva existe só na memória, dentro do
 * mesmo `step.run`. Ativação só com `WHATSAPP_RECONCILER_ENABLED=true`.
 *
 * Escritos ANTES da implementação, contra a main ea1fafd. Tudo fictício.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as InngestModule from "@/server/whatsapp/inngest";

const h = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), send: vi.fn() }));

vi.mock("@/server/whatsapp/admin/supabase", () => ({
  createWhatsAppAdminSupabaseClient: () => ({ rpc: h.rpc, from: h.from }),
}));
// O cliente real (que exige a chave própria), só com o `send` espiado.
vi.mock("@/server/whatsapp/inngest", async (importOriginal) => {
  const actual = await importOriginal<typeof InngestModule>();
  return {
    ...actual,
    whatsappInngestClient: () => {
      const client = actual.whatsappInngestClient();
      return Object.assign(client, { send: h.send });
    },
  };
});

const EVENT_KEY = "chave-de-evento-do-whatsapp-ficticia";
const A11_EVENT_KEY = "chave-de-evento-da-a11-ficticia";
const ID_1 = "47000000-0000-4000-8000-000000000001";
const ID_2 = "47000000-0000-4000-8000-000000000002";
const ID_3 = "47000000-0000-4000-8000-000000000003";
const TOK_1 = "6a000000-0000-4000-8000-00000000000a";
const TOK_2 = "6a000000-0000-4000-8000-00000000000b";
const TOK_3 = "6a000000-0000-4000-8000-00000000000c";
const PHONE = "+5511999990000";
const ENTRY_1 = { inbox_id: ID_1, reservation_token: TOK_1 };
const ENTRY_2 = { inbox_id: ID_2, reservation_token: TOK_2 };
const ENTRY_3 = { inbox_id: ID_3, reservation_token: TOK_3 };

type Rpc = (args: Record<string, unknown>) => { data: unknown; error: unknown };
let handlers: Record<string, Rpc> = {};
let log: { name: string; args: Record<string, unknown> }[] = [];
let spies: ReturnType<typeof vi.spyOn>[] = [];

const reserves = (entries: unknown[], candidates = entries.length): Rpc => () => ({ data: { candidates, entries }, error: null });
const named = (name: string) => log.filter((c) => c.name === name);
const names = () => log.map((c) => c.name);

beforeEach(() => {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "chave-de-teste-b3-whatsapp-0123456789");
  vi.stubEnv("WHATSAPP_INNGEST_EVENT_KEY", EVENT_KEY);
  log = [];
  handlers = {
    whatsapp_inbox_reconcile_reserve: reserves([]),
    whatsapp_inbox_reconcile_confirm: () => ({ data: { outcome: "confirmed" }, error: null }),
    whatsapp_inbox_reconcile_fail: () => ({ data: { outcome: "failed" }, error: null }),
    whatsapp_reconciler_record_run: () => ({ data: { outcome: "recorded" }, error: null }),
  };
  h.rpc.mockReset();
  h.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    log.push({ name, args });
    const handler = handlers[name];
    if (!handler) return { data: null, error: { message: `rpc_nao_esperada:${name}` } };
    return handler(args);
  });
  h.from.mockReset();
  h.from.mockImplementation(() => {
    throw new Error("acesso_direto_a_tabela");
  });
  h.send.mockReset();
  h.send.mockResolvedValue({ ids: ["ok"] });
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});

afterEach(() => {
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const loadRound = () => import("@/server/whatsapp/reconciler");
const loadFn = () => import("@/server/whatsapp/inngest-reconciler");
const loadConsumerFn = () => import("@/server/whatsapp/inngest-consumer");

async function round() {
  const { runWhatsAppInboxReconcilerRound } = await loadRound();
  return runWhatsAppInboxReconcilerRound("inngest");
}

const lastRun = () => named("whatsapp_reconciler_record_run").at(-1)?.args;

// ---------------------------------------------------------------------
// 1. O evento republicado
// ---------------------------------------------------------------------

describe("1. o evento republicado é exatamente o evento interno", () => {
  it("id = inboxId, nome fixo e data exatamente { inboxId }, um por entrada", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves([ENTRY_1, ENTRY_2]);
    await round();
    expect(h.send.mock.calls).toEqual([
      [{ id: ID_1, name: "praxis/whatsapp.inbox.received", data: { inboxId: ID_1 } }],
      [{ id: ID_2, name: "praxis/whatsapp.inbox.received", data: { inboxId: ID_2 } }],
    ]);
  });

  it("nada além disso entra no evento: nem token, nem workspace, canal, ambiente, provedor ou routing key", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves([ENTRY_1]);
    await round();
    const event = h.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(event).sort()).toEqual(["data", "id", "name"]);
    expect(Object.keys(event.data as object)).toEqual(["inboxId"]);
    expect(JSON.stringify(event)).not.toContain(TOK_1);
  });

  it("o evento republicado é o mesmo que a rota do webhook publica", async () => {
    const { publishWhatsAppInboxReceived } = await import("@/server/whatsapp/inbox-events");
    await publishWhatsAppInboxReceived({ inboxId: ID_1 });
    const fromRoute = h.send.mock.calls[0]![0];
    h.send.mockClear();
    handlers.whatsapp_inbox_reconcile_reserve = reserves([ENTRY_1]);
    await round();
    expect(h.send.mock.calls[0]![0]).toEqual(fromRoute);
  });
});

// ---------------------------------------------------------------------
// 2. Fluxo: reserva → publicação → confirmação
// ---------------------------------------------------------------------

describe("2. reserva, publicação e confirmação", () => {
  it("pede no máximo 25 entradas, com o vencimento curto da reserva", async () => {
    const { WHATSAPP_RECONCILER_BATCH_LIMIT, WHATSAPP_RECONCILER_RESERVATION_SECONDS } = await loadRound();
    expect(WHATSAPP_RECONCILER_BATCH_LIMIT).toBe(25);
    expect(WHATSAPP_RECONCILER_RESERVATION_SECONDS).toBe(120);
    await round();
    expect(named("whatsapp_inbox_reconcile_reserve")).toEqual([
      { name: "whatsapp_inbox_reconcile_reserve", args: { p_limit: 25, p_reservation_seconds: 120 } },
    ]);
  });

  it("publicação aceita: confirma com o token daquela entrada; contagens verdadeiras; desfecho ok", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves([ENTRY_1, ENTRY_2], 7);
    await expect(round()).resolves.toEqual({ outcome: "ok", candidates: 7, reserved: 2, published: 2, skipped: 5, failures: 0 });
    expect(named("whatsapp_inbox_reconcile_confirm").map((c) => c.args)).toEqual([
      { p_inbox_id: ID_1, p_reservation_token: TOK_1 },
      { p_inbox_id: ID_2, p_reservation_token: TOK_2 },
    ]);
    expect(named("whatsapp_inbox_reconcile_fail")).toEqual([]);
  });

  it("a ordem de cada entrada é publicar e só então confirmar", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves([ENTRY_1]);
    const order: string[] = [];
    h.send.mockImplementation(async () => {
      order.push(`send:${log.length}`);
      return { ids: [] };
    });
    await round();
    expect(order).toEqual(["send:1"]);
    expect(names()).toEqual(["whatsapp_inbox_reconcile_reserve", "whatsapp_inbox_reconcile_confirm", "whatsapp_reconciler_record_run"]);
  });

  it("sem candidatas: nada é publicado, o batimento registra ok e zero", async () => {
    await expect(round()).resolves.toEqual({ outcome: "ok", candidates: 0, reserved: 0, published: 0, skipped: 0, failures: 0 });
    expect(h.send).not.toHaveBeenCalled();
    expect(lastRun()).toMatchObject({ p_outcome: "ok", p_candidates: 0, p_reserved: 0, p_published: 0, p_skipped: 0, p_failures: 0 });
  });

  it("só fala com as RPCs do reconciliador: nunca claim, finalização, efeito ou tabela", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves([ENTRY_1, ENTRY_2]);
    await round();
    for (const name of names()) expect(["whatsapp_inbox_reconcile_reserve", "whatsapp_inbox_reconcile_confirm", "whatsapp_inbox_reconcile_fail", "whatsapp_reconciler_record_run"]).toContain(name);
    expect(h.from).not.toHaveBeenCalled();
  });

  it("confirmação com a reserva perdida (venceu ou outro worker): o evento já saiu, nada mais muda, e conta como ignorada", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves([ENTRY_1, ENTRY_2]);
    handlers.whatsapp_inbox_reconcile_confirm = (args) => ({ data: { outcome: args.p_inbox_id === ID_1 ? "reservation_lost" : "confirmed" }, error: null });
    await expect(round()).resolves.toEqual({ outcome: "ok", candidates: 2, reserved: 2, published: 2, skipped: 1, failures: 0 });
    expect(named("whatsapp_inbox_reconcile_fail")).toEqual([]);
  });

  it.each(["invalido", 42, null, { outcome: "completed" }])("resposta fora do contrato na confirmação (%j): conta como falha, sem tratar como confirmada", async (data) => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves([ENTRY_1, ENTRY_2]);
    handlers.whatsapp_inbox_reconcile_confirm = (args) => (args.p_inbox_id === ID_1 ? { data, error: null } : { data: { outcome: "confirmed" }, error: null });
    await expect(round()).resolves.toMatchObject({ outcome: "partial", published: 2, failures: 1 });
  });
});

// ---------------------------------------------------------------------
// 3. Falha de publicação
// ---------------------------------------------------------------------

describe("3. falha de publicação", () => {
  it("falha numa entrada: registra só o código fixo com o token dela, continua as outras e o desfecho é parcial", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves([ENTRY_1, ENTRY_2, ENTRY_3]);
    h.send.mockImplementation(async (event: { id: string }) => {
      if (event.id === ID_2) throw new Error(`HTTP 500 https://inn.gs/e/${EVENT_KEY} ${PHONE}`);
      return { ids: [] };
    });
    await expect(round()).resolves.toEqual({ outcome: "partial", candidates: 3, reserved: 3, published: 2, skipped: 0, failures: 1 });
    expect(named("whatsapp_inbox_reconcile_fail").map((c) => c.args)).toEqual([
      { p_inbox_id: ID_2, p_reservation_token: TOK_2, p_code: "inbox_event_publish_failed" },
    ]);
    expect(named("whatsapp_inbox_reconcile_confirm").map((c) => c.args.p_inbox_id)).toEqual([ID_1, ID_3]);
    expect(JSON.stringify(log)).not.toMatch(/HTTP 500|inn\.gs|5511/);
  });

  it("nunca confirma uma publicação que falhou", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves([ENTRY_1, ENTRY_2]);
    h.send.mockImplementation(async (event: { id: string }) => {
      if (event.id === ID_1) throw new Error("rede");
      return { ids: [] };
    });
    await round();
    expect(named("whatsapp_inbox_reconcile_confirm").map((c) => c.args.p_inbox_id)).toEqual([ID_2]);
  });

  it("publicação que não responde: vence no tempo limite e vira a mesma falha técnica, sem travar a rodada", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { WHATSAPP_RECONCILER_PUBLISH_TIMEOUT_MS } = await loadRound();
    handlers.whatsapp_inbox_reconcile_reserve = reserves([ENTRY_1, ENTRY_2]);
    h.send.mockImplementationOnce(() => new Promise(() => {}));
    const pending = round();
    await vi.advanceTimersByTimeAsync(WHATSAPP_RECONCILER_PUBLISH_TIMEOUT_MS + 1);
    await expect(pending).resolves.toEqual({ outcome: "partial", candidates: 2, reserved: 2, published: 1, skipped: 0, failures: 1 });
    expect(named("whatsapp_inbox_reconcile_fail").map((c) => c.args.p_code)).toEqual(["inbox_event_publish_failed"]);
  });

  it("falha ao registrar a falha: conta uma falha só; a reserva vence sozinha", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves([ENTRY_1, ENTRY_2]);
    h.send.mockImplementationOnce(async () => {
      throw new Error("rede");
    });
    handlers.whatsapp_inbox_reconcile_fail = () => ({ data: null, error: { message: `conexão ${PHONE}` } });
    await expect(round()).resolves.toMatchObject({ outcome: "partial", published: 1, failures: 1 });
  });

  it("todas as publicações falham: desfecho failed no batimento e execução com erro, nunca sucesso", async () => {
    const { WhatsAppReconcilerFailed } = await loadRound();
    handlers.whatsapp_inbox_reconcile_reserve = reserves([ENTRY_1, ENTRY_2]);
    h.send.mockRejectedValue(new Error("Inngest fora do ar"));
    await expect(round()).rejects.toBeInstanceOf(WhatsAppReconcilerFailed);
    expect(lastRun()).toMatchObject({ p_outcome: "failed", p_reserved: 2, p_published: 0, p_failures: 2 });
  });

  it("orçamento de tempo da rodada esgotado: o resto fica para a reserva vencer, sem publicar nem confirmar, e o desfecho é parcial", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { WHATSAPP_RECONCILER_ROUND_BUDGET_MS } = await loadRound();
    handlers.whatsapp_inbox_reconcile_reserve = reserves([ENTRY_1, ENTRY_2, ENTRY_3]);
    h.send.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + WHATSAPP_RECONCILER_ROUND_BUDGET_MS + 1);
      return { ids: [] };
    });
    await expect(round()).resolves.toEqual({ outcome: "partial", candidates: 3, reserved: 3, published: 1, skipped: 2, failures: 0 });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(named("whatsapp_inbox_reconcile_fail")).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// 4. Falha geral: execução falha, nunca sucesso falso
// ---------------------------------------------------------------------

describe("4. falha geral da rodada", () => {
  async function failure() {
    return round().then(
      () => {
        throw new Error("devia ter falhado");
      },
      (e: unknown) => e as Error & { code?: string },
    );
  }

  it("banco indisponível na reserva: nada é publicado; erro só com o código; o batimento tenta registrar failed", async () => {
    const { WhatsAppReconcilerFailed } = await loadRound();
    handlers.whatsapp_inbox_reconcile_reserve = () => ({ data: null, error: { message: `connection refused 10.0.0.1 ${PHONE}` } });
    const error = await failure();
    expect(error).toBeInstanceOf(WhatsAppReconcilerFailed);
    expect(error).toMatchObject({ code: "reconciler_reserve_failed", message: "reconciler_reserve_failed" });
    expect(`${error.message}|${error.stack}`).not.toMatch(/10\.0\.0\.1|5511|connection/);
    expect(h.send).not.toHaveBeenCalled();
    expect(lastRun()).toMatchObject({ p_origin: "inngest", p_outcome: "failed", p_candidates: 0, p_reserved: 0, p_published: 0, p_skipped: 0, p_failures: 0 });
  });

  it("banco fora do ar também para o batimento: a execução continua falhando com o código da reserva", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = () => ({ data: null, error: { message: "fora" } });
    handlers.whatsapp_reconciler_record_run = () => ({ data: null, error: { message: "fora" } });
    await expect(failure()).resolves.toMatchObject({ code: "reconciler_reserve_failed" });
  });

  it("o ambiente assinado ausente vira falha da rodada", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = () => ({ data: null, error: { message: "whatsapp_environment_required" } });
    await expect(failure()).resolves.toMatchObject({ code: "reconciler_reserve_failed" });
  });

  it("o cliente do banco lançando (variável ausente) vira a mesma falha sanitizada", async () => {
    h.rpc.mockImplementation(async () => {
      throw new Error(`SUPABASE_SECRET_KEY ausente ${PHONE}`);
    });
    const error = await failure();
    expect(error).toMatchObject({ code: "reconciler_reserve_failed" });
    expect(`${error.message}|${error.stack}`).not.toMatch(/SUPABASE|5511/);
  });

  it.each([
    ["sem entries", { candidates: 1 }],
    ["campo a mais na resposta", { candidates: 1, entries: [], workspace_id: "x" }],
    ["campo a mais na entrada (cifra)", { candidates: 1, entries: [{ ...ENTRY_1, ciphertext: "QUFB" }] }],
    ["id que não é UUID", { candidates: 1, entries: [{ inbox_id: "1; drop table", reservation_token: TOK_1 }] }],
    ["token que não é UUID", { candidates: 1, entries: [{ inbox_id: ID_1, reservation_token: "x" }] }],
    ["candidatas negativas", { candidates: -1, entries: [] }],
    ["mais entradas que o lote", { candidates: 26, entries: Array.from({ length: 26 }, () => ENTRY_1) }],
    ["mais entradas que candidatas", { candidates: 0, entries: [ENTRY_1] }],
  ])("resposta da reserva fora do contrato (%s): nada é publicado e a execução falha", async (_name, data) => {
    handlers.whatsapp_inbox_reconcile_reserve = () => ({ data, error: null });
    await expect(failure()).resolves.toMatchObject({ code: "reconciler_reserve_failed" });
    expect(h.send).not.toHaveBeenCalled();
    expect(named("whatsapp_inbox_reconcile_confirm")).toEqual([]);
  });

  it("sem a chave PRÓPRIA de evento: nada é reservado (a reserva não gastaria tentativas à toa) e a execução falha", async () => {
    vi.stubEnv("WHATSAPP_INNGEST_EVENT_KEY", "");
    await expect(failure()).resolves.toMatchObject({ code: "reconciler_not_configured" });
    expect(named("whatsapp_inbox_reconcile_reserve")).toEqual([]);
    expect(lastRun()).toMatchObject({ p_outcome: "failed" });
  });

  it("nunca cai para a chave da A11: com INNGEST_EVENT_KEY e sem a própria, nada sai", async () => {
    vi.stubEnv("WHATSAPP_INNGEST_EVENT_KEY", "");
    vi.stubEnv("INNGEST_EVENT_KEY", A11_EVENT_KEY);
    await expect(failure()).resolves.toMatchObject({ code: "reconciler_not_configured" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("o batimento que não grava também falha a execução: rodada sem batimento não é sucesso", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves([ENTRY_1]);
    handlers.whatsapp_reconciler_record_run = () => ({ data: null, error: { message: "fora" } });
    await expect(failure()).resolves.toMatchObject({ code: "reconciler_heartbeat_failed" });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it.each([{ outcome: "x" }, null, "recorded"])("batimento com resposta fora do contrato (%j): falha a execução", async (data) => {
    handlers.whatsapp_reconciler_record_run = () => ({ data, error: null });
    await expect(failure()).resolves.toMatchObject({ code: "reconciler_heartbeat_failed" });
  });
});

// ---------------------------------------------------------------------
// 5. Batimento
// ---------------------------------------------------------------------

describe("5. batimento", () => {
  it("registra origem, início, desfecho e contagens verdadeiras — e só isso", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves([ENTRY_1, ENTRY_2], 9);
    h.send.mockImplementationOnce(async () => {
      throw new Error("rede");
    });
    await round();
    const args = lastRun()!;
    expect(Object.keys(args).sort()).toEqual(["p_candidates", "p_failures", "p_origin", "p_outcome", "p_published", "p_reserved", "p_skipped", "p_started_at"]);
    expect(args).toMatchObject({ p_origin: "inngest", p_outcome: "partial", p_candidates: 9, p_reserved: 2, p_published: 1, p_skipped: 7, p_failures: 1 });
    expect(Number.isNaN(Date.parse(args.p_started_at as string))).toBe(false);
    expect(named("whatsapp_reconciler_record_run")).toHaveLength(1);
  });

  it("nenhum batimento leva token, id da inbox, telefone ou erro", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves([ENTRY_1, ENTRY_2]);
    h.send.mockImplementationOnce(async () => {
      throw new Error(`falha ${PHONE}`);
    });
    await round();
    const dump = JSON.stringify(named("whatsapp_reconciler_record_run"));
    for (const secret of [TOK_1, TOK_2, ID_1, ID_2, PHONE, "falha", EVENT_KEY]) expect(dump).not.toContain(secret);
  });

  it("a origem de teste manual fica registrada como tal", async () => {
    const { runWhatsAppInboxReconcilerRound } = await loadRound();
    await runWhatsAppInboxReconcilerRound("manual_test");
    expect(lastRun()).toMatchObject({ p_origin: "manual_test" });
  });
});

// ---------------------------------------------------------------------
// 6. O token não sai da memória
// ---------------------------------------------------------------------

describe("6. o token existe só na memória", () => {
  it("o retorno é só o desfecho e as contagens: serializável, sem token nem ids", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves([ENTRY_1, ENTRY_2]);
    const result = await round();
    expect(Object.keys(result).sort()).toEqual(["candidates", "failures", "outcome", "published", "reserved", "skipped"]);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    for (const secret of [TOK_1, TOK_2, ID_1, ID_2]) expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("o token só vai às RPCs de confirmar e de falhar, e sempre o da própria entrada", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves([ENTRY_1, ENTRY_2]);
    h.send.mockImplementationOnce(async () => {
      throw new Error("rede");
    });
    await round();
    expect(log.filter((c) => JSON.stringify(c.args).includes(TOK_1)).map((c) => c.name)).toEqual(["whatsapp_inbox_reconcile_fail"]);
    expect(log.filter((c) => JSON.stringify(c.args).includes(TOK_2)).map((c) => c.name)).toEqual(["whatsapp_inbox_reconcile_confirm"]);
    expect(JSON.stringify(h.send.mock.calls)).not.toMatch(new RegExp(`${TOK_1}|${TOK_2}`));
  });

  it("a mensagem do erro da rodada não leva token nem id", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves([ENTRY_1]);
    h.send.mockRejectedValue(new Error(`falha ${TOK_1}`));
    const error = await round().catch((e: unknown) => e as Error);
    expect(`${(error as Error).message}|${(error as Error).stack}`).not.toMatch(new RegExp(`${TOK_1}|${ID_1}`));
  });
});

// ---------------------------------------------------------------------
// 7. Função do Inngest
// ---------------------------------------------------------------------

describe("7. função agendada", () => {
  it("cron a cada 5 minutos, concorrência 1, sem nova tentativa, no id próprio", async () => {
    const { WHATSAPP_RECONCILER_FUNCTION_CONFIG } = await loadFn();
    expect(WHATSAPP_RECONCILER_FUNCTION_CONFIG).toMatchObject({
      id: "b3-whatsapp-inbox-reconciler",
      concurrency: { limit: 1 },
      retries: 0,
      triggers: [{ cron: "TZ=UTC */5 * * * *" }],
    });
  });

  it("a rodada inteira acontece num único step.run, que devolve só o resumo", async () => {
    const { handleWhatsAppInboxReconciler } = await loadFn();
    handlers.whatsapp_inbox_reconcile_reserve = reserves([ENTRY_1]);
    const run = vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn());
    await expect(handleWhatsAppInboxReconciler({ step: { run } })).resolves.toEqual({ outcome: "ok", candidates: 1, reserved: 1, published: 1, skipped: 0, failures: 0 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(lastRun()).toMatchObject({ p_origin: "inngest" });
  });

  it("falha geral aparece como falha da execução (não retentável; o próximo ciclo recomeça), não como concluída", async () => {
    const { handleWhatsAppInboxReconciler } = await loadFn();
    const { NonRetriableError } = await import("inngest");
    handlers.whatsapp_inbox_reconcile_reserve = () => ({ data: null, error: { message: "fora" } });
    const step = { run: async (_id: string, fn: () => Promise<unknown>) => fn() };
    await expect(handleWhatsAppInboxReconciler({ step })).rejects.toBeInstanceOf(NonRetriableError);
  });

  it("rodada parcial conclui a execução com o desfecho explícito", async () => {
    const { handleWhatsAppInboxReconciler } = await loadFn();
    handlers.whatsapp_inbox_reconcile_reserve = reserves([ENTRY_1, ENTRY_2]);
    h.send.mockImplementationOnce(async () => {
      throw new Error("rede");
    });
    const step = { run: async (_id: string, fn: () => Promise<unknown>) => fn() };
    await expect(handleWhatsAppInboxReconciler({ step })).resolves.toMatchObject({ outcome: "partial" });
  });
});

// ---------------------------------------------------------------------
// 8. A chave de ativação
// ---------------------------------------------------------------------

describe("8. só WHATSAPP_RECONCILER_ENABLED=true registra o cron", () => {
  const fakeClient = () => ({ createFunction: vi.fn((config: { id: string }) => config.id) });

  async function registered() {
    const { whatsappInngestFunctions } = await loadConsumerFn();
    return whatsappInngestFunctions(fakeClient() as never) as unknown as string[];
  }

  it("sem a variável: só o consumidor continua registrado (o app nunca fica vazio)", async () => {
    vi.stubEnv("WHATSAPP_RECONCILER_ENABLED", "");
    await expect(registered()).resolves.toEqual(["b3-whatsapp-inbox-consumer"]);
  });

  it("com a variável exatamente true: consumidor e reconciliador", async () => {
    vi.stubEnv("WHATSAPP_RECONCILER_ENABLED", "true");
    await expect(registered()).resolves.toEqual(["b3-whatsapp-inbox-consumer", "b3-whatsapp-inbox-reconciler"]);
  });

  it.each(["TRUE", "1", "yes", " true", "true ", "on"])("valor %j não liga", async (value) => {
    vi.stubEnv("WHATSAPP_RECONCILER_ENABLED", value);
    await expect(registered()).resolves.toEqual(["b3-whatsapp-inbox-consumer"]);
  });

  it("nenhuma chave da A11 ou da agenda liga o reconciliador", async () => {
    vi.stubEnv("WHATSAPP_RECONCILER_ENABLED", "");
    vi.stubEnv("INNGEST_EVENT_KEY", A11_EVENT_KEY);
    vi.stubEnv("INNGEST_SIGNING_KEY", "signkey-prod-a11");
    vi.stubEnv("CALENDAR_SCHEDULER_ENABLED", "true");
    vi.stubEnv("A11_RECONCILER_ENABLED", "true");
    await expect(registered()).resolves.toEqual(["b3-whatsapp-inbox-consumer"]);
  });

  it("a variável é lida a cada montagem: desligar não exige novo processo", async () => {
    vi.stubEnv("WHATSAPP_RECONCILER_ENABLED", "true");
    await expect(registered()).resolves.toHaveLength(2);
    vi.stubEnv("WHATSAPP_RECONCILER_ENABLED", "");
    await expect(registered()).resolves.toHaveLength(1);
  });
});

// ---------------------------------------------------------------------
// 9. Conferências estáticas
// ---------------------------------------------------------------------

describe("9. fronteiras do reconciliador", () => {
  const ROOT = process.cwd();
  const RECONCILER = join(ROOT, "src/server/whatsapp/reconciler.ts");
  const FN = join(ROOT, "src/server/whatsapp/inngest-reconciler.ts");
  const code = (path: string) =>
    readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

  it("os dois arquivos existem", () => {
    expect([existsSync(RECONCILER), existsSync(FN)]).toEqual([true, true]);
  });

  it("não processa conteúdo: sem claim, finalização, efeito, adaptador, normalização ou cifra", () => {
    for (const file of [RECONCILER, FN]) {
      expect(code(file)).not.toMatch(/claimWhatsAppInboxEntry|WhatsAppInboxClaim|disposeWhatsAppInboxClaim|failWhatsAppInboxClaim|releaseWhatsAppInboxClaim|completeWhatsAppInboxClaim|effects\/|applyWhatsApp|whatsapp\/provider|normalizeEvents|inbox-crypto|decrypt/);
    }
  });

  it("não importa a A11 nem a agenda; não lê as chaves genéricas do Inngest", () => {
    for (const file of [RECONCILER, FN]) {
      expect(code(file)).not.toMatch(/@\/server\/(ingest|calendar)|(?<![A-Z_])INNGEST_(EVENT_KEY|SIGNING_KEY)|CALENDAR_/);
    }
  });

  it("um único step.run, sem sendEvent: reserva e token ficam no mesmo passo", () => {
    const src = code(FN);
    expect(src.match(/step\.run\(/g) ?? []).toHaveLength(1);
    expect(src).not.toMatch(/step\.sendEvent|reservation_token|reservationToken/);
  });

  it("o reconciliador publica só pelo publicador do evento interno", () => {
    const src = code(RECONCILER);
    expect(src).toMatch(/publishWhatsAppInboxReceived\(/);
    expect(src).not.toMatch(/\.send\(|whatsappInngestClient\(\)\.send|new Inngest/);
  });

  it("nenhum log e nenhuma escrita em tabela", () => {
    for (const file of [RECONCILER, FN]) expect(code(file)).not.toMatch(/console\.|\.from\(/);
  });

  it("a variável de ativação é a única lida pela função", () => {
    expect(code(FN).match(/process\.env\.[A-Z_]+|env\.[A-Z_]+/g) ?? []).toEqual(expect.arrayContaining([expect.stringMatching(/WHATSAPP_RECONCILER_ENABLED$/)]));
    for (const name of code(FN).match(/env\.[A-Z_]+/g) ?? []) expect(name).toMatch(/WHATSAPP_RECONCILER_ENABLED$/);
  });
});
