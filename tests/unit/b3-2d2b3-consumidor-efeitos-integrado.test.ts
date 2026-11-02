/**
 * @vitest-environment node
 *
 * B3.2d-2b3 — o consumidor da inbox com os cinco efeitos REAIS (só o banco é
 * simulado: as RPCs `whatsapp_effect_*` e `whatsapp_inbox_*` respondem com o
 * que o Postgres responderia). Prova o que os espiões não provam: os
 * argumentos que chegam ao banco, o claim autêntico no efeito, o efeito
 * recusando uma cópia e a ausência de qualquer segunda finalização.
 *
 * Escritos ANTES da implementação, contra a main 8cd9191. Tudo fictício.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ProviderModule from "@/server/whatsapp/provider";
import {
  BSUID,
  CHANNEL,
  claimRow,
  CONVERSATION_ID,
  EVENTS,
  ev,
  fakeAdapter,
  IDENTITY_ID,
  INBOX_ID,
  INBOX_KEY,
  MESSAGE_ID,
  PHONE,
  PHONE_2,
  rawTypeOf,
  ROUTING,
  TEXT,
  TOKEN,
  WABA_REF,
  WS,
} from "../support/whatsapp-consumer-harness";

const h = vi.hoisted(() => ({ rpc: vi.fn(), resolve: vi.fn(), from: vi.fn() }));

vi.mock("@/server/whatsapp/admin/supabase", () => ({
  createWhatsAppAdminSupabaseClient: () => ({ rpc: h.rpc, from: h.from }),
}));
vi.mock("@/server/supabase/admin", () => ({
  createAdminSupabaseClient: () => {
    throw new Error("cliente_do_dominio_usado");
  },
}));
vi.mock("@/server/whatsapp/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderModule>();
  return { ...actual, resolveWhatsAppProvider: h.resolve };
});

const loadConsumer = () => import("@/server/whatsapp/consumer");
const loadInbox = () => import("@/server/whatsapp/inbox");

function configure() {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("WHATSAPP_PROVIDER", "simulated");
  vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "chave-de-teste-b3-whatsapp-0123456789");
  vi.stubEnv("WHATSAPP_INBOX_KEY_VERSIONS", JSON.stringify({ "1": INBOX_KEY }));
  vi.stubEnv("WHATSAPP_INBOX_ACTIVE_KEY_VERSION", "1");
}

type RpcResponse = { data: unknown; error: unknown };
let handlers: Record<string, (args: Record<string, unknown>) => RpcResponse> = {};
let rpcLog: { name: string; args: Record<string, unknown> }[] = [];

const FINALIZERS = ["whatsapp_inbox_complete", "whatsapp_inbox_fail", "whatsapp_inbox_release", "whatsapp_inbox_dispose"];
const finalizations = () => rpcLog.filter((c) => FINALIZERS.includes(c.name));
const effectRpcs = () => rpcLog.filter((c) => c.name.startsWith("whatsapp_effect_"));

const EFFECT_RPC = {
  inbound: "whatsapp_effect_inbound_message",
  outbound: "whatsapp_effect_outbound_observed",
  status: "whatsapp_effect_message_status",
  identity: "whatsapp_effect_identity_change",
  account: "whatsapp_effect_account_event",
} as const;
type Kind = keyof typeof EFFECT_RPC;

beforeEach(async () => {
  configure();
  handlers = {
    whatsapp_inbox_fail: () => ({ data: { outcome: "failed" }, error: null }),
    whatsapp_inbox_release: () => ({ data: { outcome: "released" }, error: null }),
    whatsapp_inbox_dispose: () => ({ data: { outcome: "completed" }, error: null }),
  };
  rpcLog = [];
  h.rpc.mockReset();
  h.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    rpcLog.push({ name, args });
    const handler = handlers[name];
    if (!handler) return { data: null, error: { message: `rpc_nao_esperada:${name}` } };
    return handler(args);
  });
  h.from.mockReset();
  h.from.mockImplementation(() => {
    throw new Error("acesso_direto_a_tabela");
  });
  const actual = await vi.importActual<typeof ProviderModule>("@/server/whatsapp/provider");
  h.resolve.mockReset();
  h.resolve.mockImplementation(actual.resolveWhatsAppProvider);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** O banco responde ao efeito `kind` com `data` (ou com o erro `error`). */
function dbAnswers(kind: Kind, answer: { data?: unknown; error?: { message: string } }) {
  handlers[EFFECT_RPC[kind]] = () => ({ data: answer.data ?? null, error: answer.error ?? null });
}

function arrange(event: object, opts: { channelStatus?: string } = {}) {
  const rawType = rawTypeOf(event);
  handlers.whatsapp_inbox_claim = () => ({ data: claimRow({ provider_event_type: rawType, channel_status: opts.channelStatus ?? "active" }), error: null });
  h.resolve.mockReturnValue({ status: "enabled", provider: fakeAdapter({ events: [ev(event)], envelopeType: rawType }) });
}

async function run() {
  const { processWhatsAppInboxEntry } = await loadConsumer();
  return processWhatsAppInboxEntry({ inboxId: INBOX_ID });
}

const CASE_OF: Record<Kind, object> = {
  inbound: EVENTS.inbound,
  outbound: EVENTS.outbound,
  status: EVENTS.status,
  identity: EVENTS.identity,
  account: EVENTS.accountPhone,
};
const KINDS = Object.keys(CASE_OF) as Kind[];

const APPLIED_BY_DB: Record<Kind, unknown> = {
  inbound: { outcome: "applied", message_id: MESSAGE_ID, conversation_id: CONVERSATION_ID, sender_classification: "external", contact_created: true, lead_created: true },
  outbound: { outcome: "applied", message_id: MESSAGE_ID, conversation_id: CONVERSATION_ID },
  status: { outcome: "applied", message_id: MESSAGE_ID },
  identity: { outcome: "applied", identity_id: IDENTITY_ID },
  account: { outcome: "applied" },
};

// ---------------------------------------------------------------------
// 1. O caminho feliz: um claim, UMA RPC de efeito, nenhuma finalização
// ---------------------------------------------------------------------

describe("1. cada tipo: claim → uma RPC do seu efeito → pronto", () => {
  it.each(KINDS)("%s: só o claim e a RPC do próprio efeito; a inbox já foi finalizada pelo banco", async (kind) => {
    arrange(CASE_OF[kind]);
    dbAnswers(kind, { data: APPLIED_BY_DB[kind] });
    await expect(run()).resolves.toEqual({ outcome: "processed", code: "applied" });
    expect(rpcLog.map((c) => c.name)).toEqual(["whatsapp_inbox_claim", EFFECT_RPC[kind]]);
    expect(finalizations()).toEqual([]);
  });

  it.each(KINDS)("%s: a RPC recebe o id da entrada e o token do claim — e nenhum workspace, canal, ambiente, provedor nem id do evento", async (kind) => {
    arrange(CASE_OF[kind]);
    dbAnswers(kind, { data: APPLIED_BY_DB[kind] });
    await run();
    const args = effectRpcs()[0]!.args;
    expect(args.p_inbox_id).toBe(INBOX_ID);
    expect(args.p_claim_token).toBe(TOKEN);
    for (const key of Object.keys(args)) expect(key).not.toMatch(/workspace|channel|environment|provider_event_id|^p_provider$/);
    const dump = JSON.stringify(args);
    for (const secret of [WS, CHANNEL]) expect(dump).not.toContain(secret);
  });

  it("account: o horário do provedor chega ao banco exatamente como o normalizador entregou", async () => {
    arrange(EVENTS.accountPhone);
    dbAnswers("account", { data: { outcome: "recorded" } });
    await expect(run()).resolves.toEqual({ outcome: "processed", code: "recorded" });
    expect(effectRpcs()[0]!.args).toMatchObject({
      p_scope: "phone_number",
      p_provider_type: "whatsapp.phone_number.deleted",
      p_provider_account_ref: WABA_REF,
      p_routing_key: ROUTING,
      p_occurred_at: "2026-11-02T12:00:00.000Z",
      p_code: "DELETED",
    });
  });

  it.each(["active", "paused", "disconnected", "disabled"])("account com o canal %s chega à RPC do efeito e termina processed", async (status) => {
    for (const event of [EVENTS.accountWaba, EVENTS.accountPhone]) {
      rpcLog = [];
      arrange(event, { channelStatus: status });
      dbAnswers("account", { data: { outcome: status === "active" || status === "paused" ? "applied" : "recorded" } });
      await expect(run()).resolves.toEqual({ outcome: "processed", code: status === "active" || status === "paused" ? "applied" : "recorded" });
      expect(effectRpcs().map((c) => c.name)).toEqual([EFFECT_RPC.account]);
      expect(finalizations()).toEqual([]);
    }
  });

  it.each([
    ["paused", "channel_paused"],
    ["disconnected", "channel_disconnected"],
    ["disabled", "channel_disabled"],
  ])("mensagem, status e identidade com o canal %s: release %s, e a RPC do efeito nem é chamada", async (status, code) => {
    for (const kind of ["inbound", "outbound", "status", "identity"] as const) {
      rpcLog = [];
      arrange(CASE_OF[kind], { channelStatus: status });
      await expect(run()).resolves.toEqual({ outcome: "released", code });
      expect(effectRpcs()).toEqual([]);
      expect(finalizations().map((c) => [c.name, c.args.p_error_code])).toEqual([["whatsapp_inbox_release", code]]);
    }
  });
});

// ---------------------------------------------------------------------
// 2. Resultados do banco → finalização
// ---------------------------------------------------------------------

describe("2. o que o banco responde decide a finalização — uma vez, no máximo", () => {
  it.each([
    ["inbound", "identity_conflict", "failed"],
    ["inbound", "effect_conflict", "failed"],
    ["outbound", "message_conflict", "failed"],
    ["status", "cost_conflict", "failed"],
    ["status", "message_conflict", "failed"],
    ["identity", "identity_conflict", "failed"],
    ["account", "routing_mismatch", "failed"],
    ["account", "account_reference_mismatch", "failed"],
    ["account", "effect_conflict", "failed"],
  ] as const)("%s / %s: fail uma vez, com o código", async (kind, outcome, result) => {
    arrange(CASE_OF[kind]);
    dbAnswers(kind, { data: { outcome } });
    await expect(run()).resolves.toEqual({ outcome: result, code: outcome });
    expect(finalizations().map((c) => [c.name, c.args.p_error_code])).toEqual([["whatsapp_inbox_fail", outcome]]);
  });

  it.each([
    ["status", "message_not_found"],
    ["identity", "identity_not_found"],
    ["account", "account_reference_unverified"],
    ["inbound", "channel_paused"],
    ["outbound", "channel_disconnected"],
    ["status", "channel_disabled"],
    ["identity", "channel_paused"],
  ] as const)("%s / %s: release uma vez, com o código (o claim continua para a reconciliação)", async (kind, outcome) => {
    arrange(CASE_OF[kind]);
    dbAnswers(kind, { data: { outcome } });
    await expect(run()).resolves.toEqual({ outcome: "released", code: outcome });
    expect(finalizations().map((c) => [c.name, c.args])).toEqual([
      ["whatsapp_inbox_release", { p_inbox_id: INBOX_ID, p_claim_token: TOKEN, p_error_code: outcome }],
    ]);
  });

  it.each(KINDS.flatMap((kind) => ["already_processed", "terminal_failed", "claim_lost", "not_found"].map((o) => [kind, o] as const)))(
    "%s / %s: resultado equivalente, sem repetir o efeito e sem nenhuma finalização",
    async (kind, outcome) => {
      arrange(CASE_OF[kind]);
      dbAnswers(kind, { data: { outcome } });
      await expect(run()).resolves.toEqual({ outcome, code: null });
      expect(effectRpcs()).toHaveLength(1);
      expect(finalizations()).toEqual([]);
    },
  );

  it.each([
    ["account", "recorded"],
    ["account", "stale_event"],
    ["account", "duplicate"],
    ["identity", "review_required"],
    ["inbound", "duplicate"],
    ["status", "duplicate"],
  ] as const)("%s / %s: concluído pelo banco — processed, sem finalizar de novo", async (kind, outcome) => {
    arrange(CASE_OF[kind]);
    dbAnswers(kind, { data: outcome === "review_required" ? { outcome, identity_id: IDENTITY_ID } : { outcome } });
    await expect(run()).resolves.toEqual({ outcome: "processed", code: outcome });
    expect(finalizations()).toEqual([]);
  });

  it("applied: o resultado não leva ids do domínio, classificação nem flags de criação", async () => {
    for (const kind of KINDS) {
      arrange(CASE_OF[kind]);
      dbAnswers(kind, { data: APPLIED_BY_DB[kind] });
      const result = await run();
      expect(result).toEqual({ outcome: "processed", code: "applied" });
      expect(JSON.stringify(result)).not.toMatch(/message|conversation|identity|external|created/);
    }
  });
});

// ---------------------------------------------------------------------
// 3. Erros do banco no efeito
// ---------------------------------------------------------------------

describe("3. erros do banco no efeito", () => {
  it.each([
    ["inbound", "invalid_inbound_message"],
    ["outbound", "invalid_outbound_message"],
    ["status", "invalid_status_update"],
    ["identity", "invalid_identity_change"],
    ["account", "invalid_account_event"],
  ] as const)("%s: o banco recusa com %s — falha terminal da entrada, uma vez", async (kind, code) => {
    arrange(CASE_OF[kind]);
    dbAnswers(kind, { error: { message: code } });
    await expect(run()).resolves.toEqual({ outcome: "failed", code });
    expect(finalizations().map((c) => [c.name, c.args.p_error_code])).toEqual([["whatsapp_inbox_fail", code]]);
    expect(effectRpcs()).toHaveLength(1);
  });

  it("account com horário do provedor mais de 5 minutos no futuro: o banco recusa (invalid_account_event) e a entrada falha, sem release nem repetição", async () => {
    arrange(EVENTS.accountWaba);
    const future = new Date(Date.now() + 10 * 60_000);
    arrange(EVENTS.accountWaba);
    h.resolve.mockReturnValue({ status: "enabled", provider: fakeAdapter({ events: [ev(EVENTS.accountWaba, { occurredAt: future })], envelopeType: rawTypeOf(EVENTS.accountWaba) }) });
    dbAnswers("account", { error: { message: "invalid_account_event" } });
    await expect(run()).resolves.toEqual({ outcome: "failed", code: "invalid_account_event" });
    expect(effectRpcs()[0]!.args.p_occurred_at).toBe(future.toISOString());
    expect(finalizations().map((c) => c.name)).toEqual(["whatsapp_inbox_fail"]);
  });

  it.each(KINDS)("%s: whatsapp_environment_required, erro desconhecido e resposta fora do contrato viram nova tentativa — sem finalizar e sem vazar o erro", async (kind) => {
    const { WhatsAppConsumerRetryableError } = await loadConsumer();
    for (const answer of [
      { error: { message: "whatsapp_environment_required" } },
      { error: { message: `connection refused 10.0.0.1 ${PHONE} ${TEXT}` } },
      { error: { message: "" } },
      { data: { outcome: "banana" } },
      { data: { outcome: "applied", message_id: "nao-e-uuid" } },
      { data: { extra: 1 } },
      { data: null },
    ]) {
      rpcLog = [];
      arrange(CASE_OF[kind]);
      dbAnswers(kind, answer);
      const error = await run().catch((e: unknown) => e);
      expect(error, JSON.stringify(answer)).toBeInstanceOf(WhatsAppConsumerRetryableError);
      expect(error).toMatchObject({ code: "effect_unavailable", message: "effect_unavailable" });
      const dump = `${(error as Error).message}|${(error as Error).stack}`;
      for (const secret of ["10.0.0.1", PHONE, TEXT, "connection", MESSAGE_ID]) expect(dump).not.toContain(secret);
      expect(finalizations()).toEqual([]);
      expect(effectRpcs()).toHaveLength(1);
    }
  });

  it("transporte do banco falhando (a RPC lança): nova tentativa, sem finalizar", async () => {
    arrange(EVENTS.status);
    handlers[EFFECT_RPC.status] = () => {
      throw new Error(`socket hang up ${PHONE}`);
    };
    const { WhatsAppConsumerRetryableError } = await loadConsumer();
    await expect(run()).rejects.toBeInstanceOf(WhatsAppConsumerRetryableError);
    expect(finalizations()).toEqual([]);
  });

  it("falha de identidade: BSUID sem chaves configuradas → release identity_keys_not_configured (e a RPC nem é chamada)", async () => {
    vi.stubEnv("WHATSAPP_IDENTITY_KEY_VERSIONS", "");
    arrange(EVENTS.inbound, { channelStatus: "active" });
    h.resolve.mockReturnValue({
      status: "enabled",
      provider: fakeAdapter({
        events: [ev(EVENTS.inbound, { sender: { kind: "bsuid", phoneE164: null, bsuid: BSUID } })],
        envelopeType: rawTypeOf(EVENTS.inbound),
      }),
    });
    await expect(run()).resolves.toEqual({ outcome: "released", code: "identity_keys_not_configured" });
    expect(effectRpcs()).toEqual([]);
    expect(finalizations().map((c) => [c.name, c.args.p_error_code])).toEqual([["whatsapp_inbox_release", "identity_keys_not_configured"]]);
  });

  it("conteúdo inválido para o efeito (texto vazio no tipo texto): invalid_inbound_message, fail uma vez, sem RPC do efeito", async () => {
    arrange(EVENTS.inbound);
    h.resolve.mockReturnValue({
      status: "enabled",
      provider: fakeAdapter({ events: [ev(EVENTS.inbound, { text: null })], envelopeType: rawTypeOf(EVENTS.inbound) }),
    });
    await expect(run()).resolves.toEqual({ outcome: "failed", code: "invalid_inbound_message" });
    expect(effectRpcs()).toEqual([]);
    expect(finalizations().map((c) => c.args.p_error_code)).toEqual(["invalid_inbound_message"]);
  });

  it("horário inválido no evento normalizado: falha terminal do próprio tipo, sem RPC do efeito", async () => {
    for (const [kind, code] of [
      ["inbound", "invalid_inbound_message"],
      ["outbound", "invalid_outbound_message"],
      ["status", "invalid_status_update"],
      ["identity", "invalid_identity_change"],
      ["account", "invalid_account_event"],
    ] as const) {
      rpcLog = [];
      const event = CASE_OF[kind];
      arrange(event);
      h.resolve.mockReturnValue({ status: "enabled", provider: fakeAdapter({ events: [ev(event, { occurredAt: new Date("lixo") })], envelopeType: rawTypeOf(event) }) });
      await expect(run()).resolves.toEqual({ outcome: "failed", code });
      expect(effectRpcs()).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------
// 4. O claim é o autêntico; a cópia é recusada
// ---------------------------------------------------------------------

describe("4. claim autêntico no efeito; cópia ou serialização recusadas", () => {
  async function claimed() {
    const inbox = await loadInbox();
    handlers.whatsapp_inbox_claim = () => ({ data: claimRow({ provider_event_type: rawTypeOf(EVENTS.accountWaba) }), error: null });
    const result = await inbox.claimWhatsAppInboxEntry({ inboxId: INBOX_ID });
    if (result.outcome !== "claimed") throw new Error("sem claim");
    rpcLog = [];
    return result.claim;
  }

  it("um efeito chamado com uma cópia, com o claim serializado ou com um objeto montado à mão é recusado antes do banco (inbox_claim_untrusted)", async () => {
    const claim = await claimed();
    const { applyWhatsAppAccountEvent } = await import("@/server/whatsapp/effects/account-event");
    const { applyWhatsAppInboundMessage } = await import("@/server/whatsapp/effects/inbound-message");
    const { applyWhatsAppMessageStatus } = await import("@/server/whatsapp/effects/message-status");
    const accountEvent = EVENTS.accountWaba as never;
    for (const forged of [{ ...claim }, JSON.parse(JSON.stringify(claim)) as object, Object.assign({}, claim), { inboxId: INBOX_ID, providerEventId: claim.providerEventId, providerEventType: claim.providerEventType }]) {
      await expect(applyWhatsAppAccountEvent(forged as never, accountEvent)).rejects.toMatchObject({ code: "inbox_claim_untrusted" });
      await expect(
        applyWhatsAppInboundMessage(forged as never, {
          providerMessageId: "m-1",
          contentKind: "text",
          text: TEXT,
          occurredAt: "2026-11-02T12:00:00.000Z",
          sender: { phoneE164: PHONE, bsuid: null },
        }),
      ).rejects.toMatchObject({ code: "inbox_claim_untrusted" });
      await expect(
        applyWhatsAppMessageStatus(forged as never, {
          providerMessageId: "m-1",
          waMessageId: null,
          externalId: null,
          status: "sent",
          errorCode: null,
          occurredAt: "2026-11-02T12:00:00.000Z",
          recipient: null,
          providerCost: null,
        }),
      ).rejects.toMatchObject({ code: "inbox_claim_untrusted" });
    }
    expect(rpcLog).toEqual([]);
  });

  it("o consumidor entrega ao efeito o claim autêntico: a RPC leva o token do claim emitido (um claim copiado não teria token)", async () => {
    for (const kind of KINDS) {
      rpcLog = [];
      arrange(CASE_OF[kind]);
      dbAnswers(kind, { data: APPLIED_BY_DB[kind] });
      await run();
      expect(effectRpcs()).toHaveLength(1);
      expect(effectRpcs()[0]!.args.p_claim_token).toBe(TOKEN);
      expect(effectRpcs()[0]!.args.p_inbox_id).toBe(INBOX_ID);
    }
  });

  it("claim_token novo a cada aquisição: depois de uma falha de infraestrutura, a nova execução usa o token novo e nunca reaproveita o antigo", async () => {
    const TOKEN_2 = "7a2e3d4c-5b6a-4f90-8b2c-3d4e5f6a7b8c";
    const rawType = rawTypeOf(EVENTS.status);
    let claims = 0;
    handlers.whatsapp_inbox_claim = () => ({
      data: claimRow({ provider_event_type: rawType, claim_token: claims++ === 0 ? TOKEN : TOKEN_2, claim_count: claims }),
      error: null,
    });
    h.resolve.mockReturnValue({ status: "enabled", provider: fakeAdapter({ events: [ev(EVENTS.status)], envelopeType: rawType }) });
    dbAnswers("status", { error: { message: "connection reset" } });
    await run().catch(() => undefined);
    dbAnswers("status", { data: APPLIED_BY_DB.status });
    await expect(run()).resolves.toEqual({ outcome: "processed", code: "applied" });
    expect(effectRpcs().map((c) => c.args.p_claim_token)).toEqual([TOKEN, TOKEN_2]);
  });
});

// ---------------------------------------------------------------------
// 5. Nada sensível, nenhum log
// ---------------------------------------------------------------------

describe("5. nenhum log, nenhum dado sensível", () => {
  it("em todos os desfechos: sem console, sem acesso a tabela, resultados só com { outcome, code }", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const answers: [Kind, { data?: unknown; error?: { message: string } }][] = [
      ["inbound", { data: APPLIED_BY_DB.inbound }],
      ["outbound", { data: { outcome: "message_conflict" } }],
      ["status", { data: { outcome: "message_not_found" } }],
      ["identity", { data: { outcome: "review_required", identity_id: IDENTITY_ID } }],
      ["account", { data: { outcome: "stale_event" } }],
      ["account", { error: { message: "invalid_account_event" } }],
      ["inbound", { data: { outcome: "claim_lost" } }],
    ];
    for (const [kind, answer] of answers) {
      rpcLog = [];
      arrange(CASE_OF[kind]);
      dbAnswers(kind, answer);
      const result = await run();
      expect(Object.keys(result).sort()).toEqual(["code", "outcome"]);
      const dump = JSON.stringify({ result, finals: finalizations() });
      for (const secret of [MESSAGE_ID, CONVERSATION_ID, IDENTITY_ID, PHONE, PHONE_2, BSUID, TEXT, ROUTING, WABA_REF, WS, CHANNEL, INBOX_KEY]) {
        expect(dump).not.toContain(secret);
      }
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(h.from).not.toHaveBeenCalled();
  });
});
