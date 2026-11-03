/**
 * @vitest-environment node
 *
 * B3.2e — política de `id` do evento interno do WhatsApp (§28.8).
 *
 * O Inngest guarda, sem disparar nada, um evento com `id` repetido em 24 horas.
 * Por isso:
 *  - a publicação inicial (rota do webhook) usa `id = inboxId`;
 *  - cada reserva do reconciliador usa `id = inboxId:r<tentativa>`, com a
 *    tentativa atribuída atomicamente pelo banco;
 *  - a mesma reserva sempre produz o mesmo `id`; uma reserva nova, um `id` novo;
 *  - o `data` continua exatamente `{ inboxId }`;
 *  - o consumidor só aceita os dois formatos, presos ao `inboxId` do `data`.
 *
 * O `id` é só deduplicação de transporte: a autoridade contra efeito duplicado
 * continua sendo o claim da inbox, o ledger e os efeitos idempotentes.
 *
 * Escritos ANTES da implementação. Tudo fictício: nenhum evento sai daqui.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as InngestModule from "@/server/whatsapp/inngest";

const h = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), send: vi.fn(), realSend: false }));

vi.mock("@/server/whatsapp/admin/supabase", () => ({
  createWhatsAppAdminSupabaseClient: () => ({ rpc: h.rpc, from: h.from }),
}));
vi.mock("@/server/whatsapp/inngest", async (importOriginal) => {
  const actual = await importOriginal<typeof InngestModule>();
  return {
    ...actual,
    whatsappInngestClient: () => {
      const client = actual.whatsappInngestClient();
      return h.realSend ? client : Object.assign(client, { send: h.send });
    },
  };
});

const NAME = "praxis/whatsapp.inbox.received";
const ID_1 = "47000000-0000-4000-8000-000000000001";
const ID_2 = "47000000-0000-4000-8000-000000000002";
const TOK_1 = "6a000000-0000-4000-8000-00000000000a";
const TOK_2 = "6a000000-0000-4000-8000-00000000000b";
const TOK_3 = "6a000000-0000-4000-8000-00000000000c";
const MAX_ATTEMPT = 2147483647;
/** Um número que não aparece em mais nada: se vazar, é a tentativa. */
const SENTINEL = 7654321;

type Rpc = (args: Record<string, unknown>) => { data: unknown; error: unknown };
let handlers: Record<string, Rpc> = {};
let log: { name: string; args: Record<string, unknown> }[] = [];
let spies: ReturnType<typeof vi.spyOn>[] = [];
let fetchSpy: ReturnType<typeof vi.fn>;

const entry = (inbox_id: string, reservation_token: string, reconcile_attempt: unknown) => ({ inbox_id, reservation_token, reconcile_attempt });
const reserves = (...entries: unknown[]): Rpc => () => ({ data: { candidates: entries.length, entries }, error: null });
const sentIds = () => h.send.mock.calls.map((call) => (call[0] as { id: string }).id);
const named = (name: string) => log.filter((c) => c.name === name);

beforeEach(() => {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "chave-de-teste-b3-whatsapp-0123456789");
  vi.stubEnv("WHATSAPP_INNGEST_EVENT_KEY", "chave-de-evento-do-whatsapp-ficticia");
  vi.stubEnv("INNGEST_DEV", "");
  log = [];
  handlers = {
    whatsapp_inbox_reconcile_reserve: reserves(),
    whatsapp_inbox_reconcile_confirm: () => ({ data: { outcome: "confirmed" }, error: null }),
    whatsapp_inbox_reconcile_fail: () => ({ data: { outcome: "failed" }, error: null }),
    whatsapp_reconciler_record_run: () => ({ data: { outcome: "recorded" }, error: null }),
  };
  h.realSend = false;
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
  // Qualquer ida à rede reprova: nada aqui publica de verdade.
  fetchSpy = vi.fn(async () => {
    throw new Error("rede_nao_permitida");
  });
  vi.stubGlobal("fetch", fetchSpy);
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});

afterEach(() => {
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const loadEvents = () => import("@/server/whatsapp/inbox-events");
const loadConsumer = () => import("@/server/whatsapp/consumer");

async function round() {
  const { runWhatsAppInboxReconcilerRound } = await import("@/server/whatsapp/reconciler");
  return runWhatsAppInboxReconcilerRound("inngest");
}

// ---------------------------------------------------------------------
// 1. O publicador constrói o id: o chamador nunca o fornece
// ---------------------------------------------------------------------

describe("1. o publicador constrói o id", () => {
  it("sem tentativa: id = inboxId, como a publicação inicial da rota do webhook", async () => {
    const { publishWhatsAppInboxReceived } = await loadEvents();
    await publishWhatsAppInboxReceived({ inboxId: ID_1 });
    await publishWhatsAppInboxReceived({ inboxId: ID_1, reconciliationAttempt: undefined });
    expect(h.send.mock.calls).toEqual([
      [{ id: ID_1, name: NAME, data: { inboxId: ID_1 } }],
      [{ id: ID_1, name: NAME, data: { inboxId: ID_1 } }],
    ]);
  });

  it("com tentativa: id = inboxId:r<tentativa> e o data continua exatamente { inboxId }", async () => {
    const { publishWhatsAppInboxReceived } = await loadEvents();
    await publishWhatsAppInboxReceived({ inboxId: ID_1, reconciliationAttempt: 1 });
    await publishWhatsAppInboxReceived({ inboxId: ID_1, reconciliationAttempt: 2 });
    await publishWhatsAppInboxReceived({ inboxId: ID_1, reconciliationAttempt: MAX_ATTEMPT });
    expect(h.send.mock.calls).toEqual([
      [{ id: `${ID_1}:r1`, name: NAME, data: { inboxId: ID_1 } }],
      [{ id: `${ID_1}:r2`, name: NAME, data: { inboxId: ID_1 } }],
      [{ id: `${ID_1}:r${MAX_ATTEMPT}`, name: NAME, data: { inboxId: ID_1 } }],
    ]);
  });

  it("a mesma tentativa sempre gera exatamente o mesmo evento", async () => {
    const { publishWhatsAppInboxReceived } = await loadEvents();
    vi.useFakeTimers();
    await publishWhatsAppInboxReceived({ inboxId: ID_1, reconciliationAttempt: 3 });
    vi.advanceTimersByTime(60_000);
    await publishWhatsAppInboxReceived({ inboxId: ID_1, reconciliationAttempt: 3 });
    expect(h.send.mock.calls[1]).toEqual(h.send.mock.calls[0]);
  });

  it("um id arbitrário do chamador nunca entra no evento", async () => {
    const { publishWhatsAppInboxReceived } = await loadEvents();
    await publishWhatsAppInboxReceived({ inboxId: ID_1, eventId: "arbitrario", id: "arbitrario" } as never);
    await publishWhatsAppInboxReceived({ inboxId: ID_1, reconciliationAttempt: 2, eventId: "arbitrario", id: "arbitrario" } as never);
    expect(h.send.mock.calls).toEqual([
      [{ id: ID_1, name: NAME, data: { inboxId: ID_1 } }],
      [{ id: `${ID_1}:r2`, name: NAME, data: { inboxId: ID_1 } }],
    ]);
  });

  it.each([
    ["zero", 0],
    ["negativa", -1],
    ["decimal", 1.5],
    ["NaN", Number.NaN],
    ["infinita", Number.POSITIVE_INFINITY],
    ["acima do máximo", MAX_ATTEMPT + 1],
    ["texto", "1"],
    ["nula", null],
    ["booleana", true],
    ["lista", [1]],
  ])("tentativa %s é recusada: nada é enviado e o erro leva só o código", async (_name, attempt) => {
    const { publishWhatsAppInboxReceived } = await loadEvents();
    const error = (await publishWhatsAppInboxReceived({ inboxId: ID_1, reconciliationAttempt: attempt } as never).catch((e: unknown) => e)) as Error & { code: string };
    expect(error.code).toBe("invalid_reconciliation_attempt");
    expect(error.message).toBe("invalid_reconciliation_attempt");
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a repetição interna do SDK reenvia exatamente o mesmo id (cliente real, rede simulada)", async () => {
    h.realSend = true;
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ids: [], status: 500, error: "indisponivel" }), { status: 500 }));
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ids: ["ok"], status: 200 }), { status: 200 }));
    const { publishWhatsAppInboxReceived } = await loadEvents();
    await publishWhatsAppInboxReceived({ inboxId: ID_1, reconciliationAttempt: 4 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const bodies = fetchSpy.mock.calls.map((call) => JSON.parse((call[1] as { body: string }).body) as { id: string; name: string; data: unknown }[]);
    expect(bodies.map((b) => b[0]!.id)).toEqual([`${ID_1}:r4`, `${ID_1}:r4`]);
    expect(bodies[0]![0]!.data).toEqual({ inboxId: ID_1 });
  });
});

// ---------------------------------------------------------------------
// 2. O reconciliador: um id por reserva, vindo do banco
// ---------------------------------------------------------------------

describe("2. um id por reserva, com a tentativa do banco", () => {
  it("primeira reserva usa :r1", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves(entry(ID_1, TOK_1, 1));
    await round();
    expect(h.send.mock.calls).toEqual([[{ id: `${ID_1}:r1`, name: NAME, data: { inboxId: ID_1 } }]]);
  });

  it("reserva seguinte usa :r2, e nunca o id anterior", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves(entry(ID_1, TOK_1, 1));
    await round();
    handlers.whatsapp_inbox_reconcile_reserve = reserves(entry(ID_1, TOK_2, 2));
    await round();
    expect(sentIds()).toEqual([`${ID_1}:r1`, `${ID_1}:r2`]);
  });

  it("nunca usa o inboxId puro, que é o da publicação inicial", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves(entry(ID_1, TOK_1, 1), entry(ID_2, TOK_2, 5));
    await round();
    expect(sentIds()).not.toContain(ID_1);
    expect(sentIds()).not.toContain(ID_2);
  });

  it("a mesma reserva reutilizada produz o mesmo id, sem contador local", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves(entry(ID_1, TOK_1, 7));
    await round();
    await round();
    await round();
    expect(sentIds()).toEqual([`${ID_1}:r7`, `${ID_1}:r7`, `${ID_1}:r7`]);
  });

  it("a tentativa é a devolvida pelo banco, mesmo que não comece em 1 nem seja seguida", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves(entry(ID_1, TOK_1, 42));
    await round();
    handlers.whatsapp_inbox_reconcile_reserve = reserves(entry(ID_1, TOK_2, 45));
    await round();
    expect(sentIds()).toEqual([`${ID_1}:r42`, `${ID_1}:r45`]);
  });

  it("cada entrada do lote usa a própria tentativa; duas inboxes nunca compartilham id", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves(entry(ID_1, TOK_1, 3), entry(ID_2, TOK_2, 3));
    await round();
    expect(sentIds()).toEqual([`${ID_1}:r3`, `${ID_2}:r3`]);
    expect(new Set(sentIds()).size).toBe(2);
    handlers.whatsapp_inbox_reconcile_reserve = reserves(entry(ID_1, TOK_1, 8), entry(ID_2, TOK_2, 2));
    h.send.mockClear();
    await round();
    expect(sentIds()).toEqual([`${ID_1}:r8`, `${ID_2}:r2`]);
  });

  it("publicação recusada: esta reserva teve um id só; a reserva seguinte, um id novo", async () => {
    h.send.mockRejectedValueOnce(new Error("indisponivel"));
    handlers.whatsapp_inbox_reconcile_reserve = reserves(entry(ID_1, TOK_1, 3), entry(ID_2, TOK_2, 1));
    await round();
    expect(sentIds()).toEqual([`${ID_1}:r3`, `${ID_2}:r1`]);
    handlers.whatsapp_inbox_reconcile_reserve = reserves(entry(ID_1, TOK_3, 4));
    await round();
    expect(sentIds()).toEqual([`${ID_1}:r3`, `${ID_2}:r1`, `${ID_1}:r4`]);
  });

  it("tempo limite (resultado incerto): nenhuma segunda publicação na mesma reserva; a seguinte usa outro id", async () => {
    vi.useFakeTimers();
    const { WHATSAPP_RECONCILER_PUBLISH_TIMEOUT_MS } = await import("@/server/whatsapp/reconciler");
    h.send.mockImplementationOnce(() => new Promise(() => {}));
    handlers.whatsapp_inbox_reconcile_reserve = reserves(entry(ID_1, TOK_1, 3), entry(ID_2, TOK_2, 1));
    const pending = round();
    await vi.advanceTimersByTimeAsync(WHATSAPP_RECONCILER_PUBLISH_TIMEOUT_MS + 1);
    await expect(pending).resolves.toMatchObject({ outcome: "partial", published: 1, failures: 1 });
    expect(sentIds()).toEqual([`${ID_1}:r3`, `${ID_2}:r1`]);
    handlers.whatsapp_inbox_reconcile_reserve = reserves(entry(ID_1, TOK_3, 4));
    await round();
    expect(sentIds()).toEqual([`${ID_1}:r3`, `${ID_2}:r1`, `${ID_1}:r4`]);
  });

  it.each([
    ["ausente", undefined],
    ["nula", null],
    ["zero", 0],
    ["negativa", -1],
    ["decimal", 1.5],
    ["em texto", "1"],
    ["acima do máximo", MAX_ATTEMPT + 1],
  ])("tentativa %s na resposta da reserva: nada é publicado e a execução falha", async (_name, attempt) => {
    const bad = attempt === undefined ? { inbox_id: ID_1, reservation_token: TOK_1 } : entry(ID_1, TOK_1, attempt);
    handlers.whatsapp_inbox_reconcile_reserve = reserves(bad);
    await expect(round().catch((e: unknown) => e)).resolves.toMatchObject({ code: "reconciler_reserve_failed" });
    expect(h.send).not.toHaveBeenCalled();
    expect(named("whatsapp_inbox_reconcile_confirm")).toEqual([]);
  });

  it("a tentativa máxima é aceita", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves(entry(ID_1, TOK_1, MAX_ATTEMPT));
    await round();
    expect(sentIds()).toEqual([`${ID_1}:r${MAX_ATTEMPT}`]);
  });
});

// ---------------------------------------------------------------------
// 3. A tentativa só existe no id
// ---------------------------------------------------------------------

describe("3. a tentativa não aparece em mais nenhum lugar", () => {
  const SENT = String(SENTINEL);

  it("evento: só no id; o data é exatamente { inboxId }", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves(entry(ID_1, TOK_1, SENTINEL));
    await round();
    const event = h.send.mock.calls[0]![0] as { id: string; data: Record<string, unknown> };
    expect(event.id).toBe(`${ID_1}:r${SENT}`);
    expect(Object.keys(event).sort()).toEqual(["data", "id", "name"]);
    expect(event.data).toEqual({ inboxId: ID_1 });
    expect(JSON.stringify(event.data)).not.toContain(SENT);
  });

  it("retorno da rodada e do step, batimento e confirmação: sem a tentativa", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves(entry(ID_1, TOK_1, SENTINEL));
    const summary = await round();
    expect(Object.keys(summary).sort()).toEqual(["candidates", "failures", "outcome", "published", "reserved", "skipped"]);
    expect(JSON.stringify(summary)).not.toContain(SENT);
    const run = named("whatsapp_reconciler_record_run")[0]!.args;
    expect(Object.keys(run).sort()).toEqual(["p_candidates", "p_failures", "p_origin", "p_outcome", "p_published", "p_reserved", "p_skipped", "p_started_at"]);
    expect(JSON.stringify(run)).not.toContain(SENT);
    expect(named("whatsapp_inbox_reconcile_confirm").map((c) => c.args)).toEqual([{ p_inbox_id: ID_1, p_reservation_token: TOK_1 }]);
  });

  it("falha de publicação: código e erro da execução sem a tentativa", async () => {
    h.send.mockRejectedValue(new Error(`recusado ${ID_1}:r${SENT}`));
    handlers.whatsapp_inbox_reconcile_reserve = reserves(entry(ID_1, TOK_1, SENTINEL));
    const error = (await round().catch((e: unknown) => e)) as Error & { code: string };
    expect(error.code).toBe("reconciler_round_failed");
    expect(`${error.message}|${error.stack}|${String(error.cause ?? "")}`).not.toContain(SENT);
    expect(named("whatsapp_inbox_reconcile_fail").map((c) => c.args)).toEqual([
      { p_inbox_id: ID_1, p_reservation_token: TOK_1, p_code: "inbox_event_publish_failed" },
    ]);
    expect(JSON.stringify(named("whatsapp_reconciler_record_run")[0]!.args)).not.toContain(SENT);
  });

  it("o consumidor devolve só o inboxId: a tentativa não segue adiante", async () => {
    const { parseWhatsAppInboxReceivedEvent } = await loadConsumer();
    expect(parseWhatsAppInboxReceivedEvent({ id: `${ID_1}:r${SENT}`, name: NAME, data: { inboxId: ID_1 } })).toStrictEqual({ ok: true, inboxId: ID_1 });
  });

  it("a rota do webhook e a função agendada nem conhecem a tentativa", () => {
    const code = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
    for (const file of ["src/server/whatsapp/webhook-route.ts", "src/server/whatsapp/inngest-reconciler.ts", "src/server/whatsapp/inngest-consumer.ts"]) {
      expect(code(file)).not.toMatch(/reconciliationAttempt|reconcile_attempt|reconcileAttempt/);
    }
  });

  it("o publicador não tem parâmetro de id: nada de eventId vindo de fora", () => {
    const src = readFileSync(join(process.cwd(), "src/server/whatsapp/inbox-events.ts"), "utf8");
    expect(src).not.toMatch(/eventId|params\??\.id\b/);
  });
});

// ---------------------------------------------------------------------
// 4. O consumidor: só os dois formatos, presos ao inboxId do data
// ---------------------------------------------------------------------

describe("4. o consumidor só aceita id compatível com o inboxId do data", () => {
  it.each([
    ["o inboxId puro (publicação inicial)", ID_1],
    ["tentativa 1", `${ID_1}:r1`],
    ["tentativa 2", `${ID_1}:r2`],
    ["tentativa com vários dígitos", `${ID_1}:r10`],
    ["tentativa máxima", `${ID_1}:r${MAX_ATTEMPT}`],
  ])("aceita %s", async (_name, id) => {
    const { parseWhatsAppInboxReceivedEvent } = await loadConsumer();
    expect(parseWhatsAppInboxReceivedEvent({ id, name: NAME, data: { inboxId: ID_1 }, ts: 1 })).toStrictEqual({ ok: true, inboxId: ID_1 });
  });

  it.each<[string, unknown]>([
    ["UUID de outra inbox", ID_2],
    ["UUID de outra inbox, com tentativa", `${ID_2}:r1`],
    ["tentativa zero", `${ID_1}:r0`],
    ["tentativa negativa", `${ID_1}:r-1`],
    ["sinal de mais", `${ID_1}:r+1`],
    ["decimal", `${ID_1}:r1.5`],
    ["decimal inteiro", `${ID_1}:r1.0`],
    ["expoente", `${ID_1}:r1e3`],
    ["hexadecimal", `${ID_1}:r0x10`],
    ["espaço no fim", `${ID_1}:r1 `],
    ["espaço antes do número", `${ID_1}:r 1`],
    ["espaço antes do separador", `${ID_1} :r1`],
    ["espaço no início", ` ${ID_1}:r1`],
    ["espaço no início do id puro", ` ${ID_1}`],
    ["espaço no fim do id puro", `${ID_1} `],
    ["quebra de linha no fim", `${ID_1}:r1\n`],
    ["quebra de linha no id puro", `${ID_1}\n`],
    ["zero à esquerda", `${ID_1}:r01`],
    ["vários zeros à esquerda", `${ID_1}:r0001`],
    ["texto depois da tentativa", `${ID_1}:r1x`],
    ["segunda tentativa colada", `${ID_1}:r1:r2`],
    ["separador sem número", `${ID_1}:r`],
    ["prefixo maiúsculo", `${ID_1}:R1`],
    ["prefixo diferente", `${ID_1}:a1`],
    ["sem prefixo", `${ID_1}:1`],
    ["separador hífen", `${ID_1}-r1`],
    ["separador sublinhado", `${ID_1}_r1`],
    ["separador ponto", `${ID_1}.r1`],
    ["sem separador", `${ID_1}r1`],
    ["dois separadores", `${ID_1}::r1`],
    ["dígito de outro alfabeto", `${ID_1}:r١`],
    ["acima do máximo", `${ID_1}:r2147483648`],
    ["muito acima do máximo", `${ID_1}:r99999999999999999999`],
    ["tentativa antes do id", `r1:${ID_1}`],
    ["id gerado pelo servidor quando falta o do envio", "01M6FC7XC2BC4CA9352TQC4ETJ"],
    ["vazio", ""],
    ["número", 1],
    ["nulo", null],
    ["ausente", undefined],
  ])("recusa %s", async (_name, id) => {
    const { parseWhatsAppInboxReceivedEvent } = await loadConsumer();
    const event = id === undefined ? { name: NAME, data: { inboxId: ID_1 } } : { id, name: NAME, data: { inboxId: ID_1 } };
    expect(parseWhatsAppInboxReceivedEvent(event)).toEqual({ ok: false });
  });

  it("a comparação é exata: o id e o data têm de trazer o mesmo texto", async () => {
    const { parseWhatsAppInboxReceivedEvent } = await loadConsumer();
    const upper = "47ABCDEF-0000-4000-8000-000000000001";
    const lower = upper.toLowerCase();
    expect(parseWhatsAppInboxReceivedEvent({ id: `${upper}:r1`, name: NAME, data: { inboxId: upper } })).toEqual({ ok: true, inboxId: lower });
    expect(parseWhatsAppInboxReceivedEvent({ id: `${lower}:r1`, name: NAME, data: { inboxId: upper } })).toEqual({ ok: false });
    expect(parseWhatsAppInboxReceivedEvent({ id: upper, name: NAME, data: { inboxId: lower } })).toEqual({ ok: false });
  });

  it("id recusado: nenhum step.run e nenhuma chamada ao banco", async () => {
    const { handleWhatsAppInboxReceived } = await import("@/server/whatsapp/inngest-consumer");
    const step = { run: vi.fn() };
    const result = await handleWhatsAppInboxReceived({ event: { id: `${ID_2}:r1`, name: NAME, data: { inboxId: ID_1 } }, step } as never);
    expect(result).toEqual({ outcome: "invalid_event", code: null });
    expect(step.run).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// 5. Sem nenhum evento real
// ---------------------------------------------------------------------

describe("5. nada sai de verdade", () => {
  it("uma rodada inteira não usa a rede: o send é simulado e o fetch nem é chamado", async () => {
    handlers.whatsapp_inbox_reconcile_reserve = reserves(entry(ID_1, TOK_1, 1));
    await round();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sem configuração externa nenhuma além das chaves fictícias deste teste: a política é pura", async () => {
    const { publishWhatsAppInboxReceived } = await loadEvents();
    vi.stubEnv("WHATSAPP_RECONCILER_ENABLED", "");
    await publishWhatsAppInboxReceived({ inboxId: ID_1, reconciliationAttempt: 1 });
    expect(sentIds()).toEqual([`${ID_1}:r1`]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
