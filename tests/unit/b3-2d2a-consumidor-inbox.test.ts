/**
 * @vitest-environment node
 *
 * B3.2d-2a — consumidor da inbox do WhatsApp, de ponta a ponta no servidor
 * (banco simulado, adaptador simulado real).
 *
 * Do evento do Inngest só sai o `inboxId`, validado de forma estrita. Todo
 * o ciclo — claim, decifração, conferência do hash, normalização,
 * roteamento, estado do canal, decisão e UMA finalização — acontece dentro
 * de UM `step.run`, que devolve só `{ outcome, code }`. Nada é escrito no
 * domínio: eventos que um dia terão efeito são liberados com
 * `domain_effect_not_implemented`; `ignored` e `unsupported` são
 * finalizados com uma disposição de lista fechada, cercada pelo claim.
 *
 * Escritos ANTES da implementação, contra a main 10e617f. Tudo fictício.
 */
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ProviderModule from "@/server/whatsapp/provider";
import type { NormalizedWhatsAppEvent, WhatsAppProvider } from "@/server/whatsapp/provider/contract";

const { rpcMock, resolveMock, fromMock } = vi.hoisted(() => ({ rpcMock: vi.fn(), resolveMock: vi.fn(), fromMock: vi.fn() }));

vi.mock("@/server/whatsapp/admin/supabase", () => ({
  createWhatsAppAdminSupabaseClient: () => ({ rpc: rpcMock, from: fromMock }),
}));
// Nenhum cliente do domínio pode ser criado pelo consumidor.
vi.mock("@/server/supabase/admin", () => ({
  createAdminSupabaseClient: () => {
    throw new Error("cliente_do_dominio_usado");
  },
}));
vi.mock("@/server/whatsapp/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderModule>();
  return { ...actual, resolveWhatsAppProvider: resolveMock };
});

const loadConsumer = () => import("@/server/whatsapp/consumer");
const loadInbox = () => import("@/server/whatsapp/inbox");
const loadHandler = () => import("@/server/whatsapp/inngest-consumer");
const { encryptWhatsAppInboxBody } = await import("@/server/whatsapp/inbox-crypto");

const WS = "10000000-0000-0000-0000-000000000001";
const OTHER_WS = "10000000-0000-0000-0000-000000000002";
const CHANNEL = "36000000-0000-0000-0000-000000000001";
const INBOX_ID = "46000000-0000-4000-8000-000000000001";
const TOKEN = "6f1d2c3b-4a59-4e8f-9a1b-2c3d4e5f6a7b";
const TOKEN_2 = "7a2e3d4c-5b6a-4f90-8b2c-3d4e5f6a7b8c";
const ROUTING = "sim-consumidor-1";
const INBOX_KEY = Buffer.alloc(32, 7).toString("base64");
const PHONE = "+5511999990000";
const BSUID = "BR.1234567890";
const TEXT = "Olá, quero falar sobre a ação — mensagem fictícia";
const EVENT_ID = "evt-consumidor-1";
const OCCURRED = "2026-10-21T12:00:00Z";

function configure() {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("WHATSAPP_PROVIDER", "simulated");
  vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "chave-de-teste-b3-whatsapp-0123456789");
  vi.stubEnv("WHATSAPP_INBOX_KEY_VERSIONS", JSON.stringify({ "1": INBOX_KEY }));
  vi.stubEnv("WHATSAPP_INBOX_ACTIVE_KEY_VERSION", "1");
}

type RpcHandler = (args: Record<string, unknown>) => { data: unknown; error: unknown };
let handlers: Record<string, RpcHandler> = {};
/** Cada chamada ao banco, e se ela aconteceu dentro de um step.run. */
let rpcLog: { name: string; args: Record<string, unknown>; insideStep: boolean }[] = [];
let insideStep = false;

beforeEach(async () => {
  configure();
  handlers = {
    whatsapp_inbox_fail: () => ({ data: { outcome: "failed" }, error: null }),
    whatsapp_inbox_release: () => ({ data: { outcome: "released" }, error: null }),
    whatsapp_inbox_dispose: () => ({ data: { outcome: "completed" }, error: null }),
  };
  rpcLog = [];
  insideStep = false;
  rpcMock.mockReset();
  rpcMock.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    rpcLog.push({ name, args, insideStep });
    const handler = handlers[name];
    if (!handler) return { data: null, error: { message: `rpc_nao_esperada:${name}` } };
    return handler(args);
  });
  fromMock.mockReset();
  fromMock.mockImplementation(() => {
    throw new Error("acesso_direto_a_tabela");
  });
  const actual = await vi.importActual<typeof ProviderModule>("@/server/whatsapp/provider");
  resolveMock.mockReset();
  resolveMock.mockImplementation(actual.resolveWhatsAppProvider);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const bytesOf = (text: string) => new TextEncoder().encode(text);
const sha256 = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex");

const INBOUND = { type: "message.inbound", id: EVENT_ID, routingKey: ROUTING, messageId: "msg-1", occurredAt: OCCURRED, from: PHONE, text: TEXT };
const STATUS = { type: "message.status", id: EVENT_ID, routingKey: ROUTING, messageId: "msg-1", occurredAt: OCCURRED, status: "delivered" };
const OTHER = { type: "other", id: EVENT_ID, routingKey: ROUTING, occurredAt: OCCURRED, providerType: "account_update" };

const simPayload = (event: Record<string, unknown>) => bytesOf(JSON.stringify({ version: 1, events: [event] }));

type Aad = Partial<{ environment: string; workspaceId: string; channelId: string; provider: string; providerEventId: string }>;

/** Linha que o banco devolve num claim bem-sucedido, cifrada com a AAD da
 * própria linha (salvo `aad`). */
function claimRow(event: Record<string, unknown> = INBOUND, overrides: Record<string, unknown> = {}, aad: Aad = {}, raw?: Uint8Array) {
  const bytes = raw ?? simPayload(event);
  const enc = encryptWhatsAppInboxBody(bytes, {
    environment: "preview",
    workspaceId: WS,
    channelId: CHANNEL,
    provider: "simulated",
    providerEventId: EVENT_ID,
    ...aad,
  } as never);
  return {
    outcome: "claimed",
    inbox_id: INBOX_ID,
    claim_token: TOKEN,
    claim_count: 1,
    claimed_at: "2026-10-21T12:00:00.000000+00:00",
    lease_until: "2026-10-21T12:05:00.000000+00:00",
    environment: "preview",
    workspace_id: WS,
    channel_id: CHANNEL,
    channel_status: "active",
    provider: "simulated",
    routing_key: ROUTING,
    provider_event_id: EVENT_ID,
    provider_event_type: String(event.type),
    body_sha256: sha256(bytes),
    received_at: "2026-10-21T11:59:59.000000+00:00",
    retain_until: "2026-10-21T12:59:59.000000+00:00",
    key_version: enc.keyVersion,
    nonce: enc.nonce,
    ciphertext: enc.ciphertext,
    auth_tag: enc.authTag,
    ...overrides,
  };
}

function claimReturns(...rows: unknown[]) {
  const queue = [...rows];
  handlers.whatsapp_inbox_claim = () => ({ data: queue.length > 1 ? queue.shift() : queue[0], error: null });
}

const names = () => rpcLog.map((c) => c.name);
const finalizations = () => rpcLog.filter((c) => c.name !== "whatsapp_inbox_claim");

async function run(inboxId: string = INBOX_ID) {
  const { processWhatsAppInboxEntry } = await loadConsumer();
  return processWhatsAppInboxEntry({ inboxId });
}

// ---------------------------------------------------------------------
// Adaptador fictício (tipos que o simulador não produz)
// ---------------------------------------------------------------------

const BASE = { providerEventId: EVENT_ID, occurredAt: new Date(OCCURRED) };
const PHONE_ID = { kind: "phone", phoneE164: PHONE, bsuid: null } as const;
const EVENTS = {
  inbound: { ...BASE, kind: "message.inbound", originCandidate: "inbound", routingKey: ROUTING, providerMessageId: "m-1", waMessageId: null, sender: PHONE_ID, senderProfileName: null, contentKind: "text", text: TEXT },
  outbound: { ...BASE, kind: "message.outbound_observed", originCandidate: "business_app", providerType: "smb_message_echoes", routingKey: ROUTING, providerMessageId: "m-2", waMessageId: null, recipient: PHONE_ID, contentKind: "text", text: TEXT },
  status: { ...BASE, kind: "message.status", originCandidate: "external_api", routingKey: ROUTING, providerMessageId: "m-1", waMessageId: null, externalId: null, status: "accepted", errorCode: null, recipient: null, providerCost: null },
  identity: { ...BASE, kind: "contact.identity_changed", change: "identity", routingKey: ROUTING, previous: { kind: "bsuid", phoneE164: null, bsuid: BSUID }, next: null },
  accountWaba: { ...BASE, kind: "account", scope: "business_account", providerType: "account_update", providerAccountRef: "waba-1", businessPhoneE164: null, routingKey: null, code: null },
  accountPhone: { ...BASE, kind: "account", scope: "phone_number", providerType: "phone_number_quality_update", providerAccountRef: "waba-1", businessPhoneE164: null, routingKey: ROUTING, code: null },
  ignoredHistory: { ...BASE, kind: "ignored", reason: "history", providerType: "history", routingKey: ROUTING },
  ignoredGroup: { ...BASE, kind: "ignored", reason: "group_message", providerType: "group", routingKey: null },
  ignoredProduct: { ...BASE, kind: "ignored", reason: "non_whatsapp_product", providerType: "instagram", routingKey: null },
  unsupported: { ...BASE, kind: "unsupported", routingKey: null, providerType: "flows" },
  unsupportedRouted: { ...BASE, kind: "unsupported", routingKey: ROUTING, providerType: "flows" },
} as const;

const ev = (event: object, patch: Record<string, unknown> = {}) => ({ ...event, ...patch }) as unknown as NormalizedWhatsAppEvent;

function fakeAdapter(opts: {
  events?: NormalizedWhatsAppEvent[];
  normalized?: ReturnType<WhatsAppProvider["normalizeEvents"]>;
  envelope?: ReturnType<WhatsAppProvider["inspectEnvelope"]>;
  normalizeEvents?: boolean;
  throwOn?: "inspect" | "normalize";
}): WhatsAppProvider {
  return {
    kind: "simulated",
    describeCapabilities: () => ({ verifyWebhook: true, normalizeEvents: opts.normalizeEvents ?? true, sendText: false, sendTemplate: false, lookupMessage: false, fetchMedia: false }),
    verifyWebhook: () => ({ ok: false, reason: "invalid_body" }),
    inspectEnvelope: () => {
      if (opts.throwOn === "inspect") throw new Error(`falha interna com ${PHONE}`);
      return opts.envelope ?? { ok: true, envelope: { providerEventId: EVENT_ID, providerEventType: "message.inbound", envelopeVersion: "1", eventCount: 1 } };
    },
    normalizeEvents: () => {
      if (opts.throwOn === "normalize") throw new Error(`falha interna com ${PHONE}`);
      return opts.normalized ?? { ok: true, events: opts.events ?? [ev(EVENTS.inbound)] };
    },
    sendText: async () => ({ ok: false, reason: "unsupported", capability: "sendText" }),
    sendTemplate: async () => ({ ok: false, reason: "unsupported", capability: "sendTemplate" }),
    lookupMessage: async () => ({ ok: false, reason: "unsupported", capability: "lookupMessage" }),
    fetchMedia: async () => ({ ok: false, reason: "unsupported", capability: "fetchMedia" }),
  };
}

function withAdapter(adapter: WhatsAppProvider) {
  resolveMock.mockReturnValue({ status: "enabled", provider: adapter });
}

// ---------------------------------------------------------------------
// 1. Evento do Inngest: só { name, data: { inboxId } }
// ---------------------------------------------------------------------

describe("1. evento interno validado de forma estrita", () => {
  const NAME = "praxis/whatsapp.inbox.received";

  it("aceita exatamente { name, data: { inboxId } }, com ou sem id igual ao inboxId", async () => {
    const { parseWhatsAppInboxReceivedEvent } = await loadConsumer();
    expect(parseWhatsAppInboxReceivedEvent({ name: NAME, data: { inboxId: INBOX_ID } })).toEqual({ ok: true, inboxId: INBOX_ID });
    expect(parseWhatsAppInboxReceivedEvent({ id: INBOX_ID, name: NAME, data: { inboxId: INBOX_ID }, ts: 1 })).toEqual({ ok: true, inboxId: INBOX_ID });
    expect(parseWhatsAppInboxReceivedEvent({ id: INBOX_ID.toUpperCase(), name: NAME, data: { inboxId: INBOX_ID.toUpperCase() } })).toEqual({
      ok: true,
      inboxId: INBOX_ID,
    });
  });

  it.each([
    ["data com workspace", { name: NAME, data: { inboxId: INBOX_ID, workspaceId: WS } }],
    ["data com canal e routing key", { name: NAME, data: { inboxId: INBOX_ID, channelId: CHANNEL, routingKey: ROUTING } }],
    ["data com provedor e ambiente", { name: NAME, data: { inboxId: INBOX_ID, provider: "ycloud", environment: "production" } }],
    ["inboxId que não é UUID", { name: NAME, data: { inboxId: "1; drop table" } }],
    ["inboxId numérico", { name: NAME, data: { inboxId: 42 } }],
    ["sem inboxId", { name: NAME, data: {} }],
    ["data nulo", { name: NAME, data: null }],
    ["data em lista", { name: NAME, data: [INBOX_ID] }],
    ["outro nome", { name: "praxis/form.submitted", data: { inboxId: INBOX_ID } }],
    ["id diferente do inboxId", { id: "46000000-0000-4000-8000-000000000099", name: NAME, data: { inboxId: INBOX_ID } }],
    ["evento nulo", null],
    ["texto", "praxis/whatsapp.inbox.received"],
  ])("recusa %s", async (_name, event) => {
    const { parseWhatsAppInboxReceivedEvent } = await loadConsumer();
    expect(parseWhatsAppInboxReceivedEvent(event)).toEqual({ ok: false });
  });
});

// ---------------------------------------------------------------------
// 2. Um único step.run: o claim não sai dele
// ---------------------------------------------------------------------

function fakeStep() {
  const run = vi.fn(async (_id: string, fn: () => unknown) => {
    insideStep = true;
    try {
      const result = await fn();
      // O Inngest serializa o retorno do step: só dado puro sobrevive.
      return JSON.parse(JSON.stringify(result)) as unknown;
    } finally {
      insideStep = false;
    }
  });
  return { run };
}

describe("2. claim, decisão e finalização no mesmo step.run", () => {
  it("um step.run, com o id fixo; claim e finalização acontecem dentro dele", async () => {
    const { handleWhatsAppInboxReceived } = await loadHandler();
    const { WHATSAPP_INBOX_CONSUMER_STEP_ID } = await loadConsumer();
    claimReturns(claimRow(OTHER));
    const step = fakeStep();
    const result = await handleWhatsAppInboxReceived({ event: { name: "praxis/whatsapp.inbox.received", data: { inboxId: INBOX_ID } }, step } as never);
    expect(step.run).toHaveBeenCalledTimes(1);
    expect(step.run.mock.calls[0]?.[0]).toBe(WHATSAPP_INBOX_CONSUMER_STEP_ID);
    expect(names()).toEqual(["whatsapp_inbox_claim", "whatsapp_inbox_dispose"]);
    expect(rpcLog.every((c) => c.insideStep)).toBe(true);
    expect(result).toEqual({ outcome: "processed", code: "unsupported_event" });
  });

  it("o retorno do step é só { outcome, code }: sem claim, token, contexto, corpo ou identidade", async () => {
    const { processWhatsAppInboxEntry } = await loadConsumer();
    claimReturns(claimRow(INBOUND));
    const result = await processWhatsAppInboxEntry({ inboxId: INBOX_ID });
    expect(Object.keys(result).sort()).toEqual(["code", "outcome"]);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    const json = JSON.stringify(result);
    for (const secret of [TOKEN, WS, CHANNEL, ROUTING, PHONE, TEXT, EVENT_ID, INBOX_KEY]) expect(json).not.toContain(secret);
  });

  it("evento inválido: nenhum step.run e nenhuma chamada ao banco", async () => {
    const { handleWhatsAppInboxReceived } = await loadHandler();
    const step = fakeStep();
    const result = await handleWhatsAppInboxReceived({ event: { name: "praxis/whatsapp.inbox.received", data: { inboxId: INBOX_ID, workspaceId: WS } }, step } as never);
    expect(result).toEqual({ outcome: "invalid_event", code: null });
    expect(step.run).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("contexto passado junto com o inboxId é ignorado: o banco decide (canal pausado na linha)", async () => {
    const { processWhatsAppInboxEntry } = await loadConsumer();
    claimReturns(claimRow(INBOUND, { channel_status: "paused" }));
    const result = await processWhatsAppInboxEntry({
      inboxId: INBOX_ID,
      workspaceId: OTHER_WS,
      channelStatus: "active",
      provider: "ycloud",
      routingKey: "outra-routing",
      environment: "production",
    } as never);
    expect(result).toEqual({ outcome: "released", code: "channel_paused" });
    expect(rpcLog[0]?.args).toEqual({ p_inbox_id: INBOX_ID, p_lease_seconds: 300 });
    expect(resolveMock).toHaveBeenCalledWith({ channelProvider: "simulated" });
  });
});

// ---------------------------------------------------------------------
// 3. Resultados do claim sem posse: nenhuma finalização
// ---------------------------------------------------------------------

describe("3. resultados do claim", () => {
  it.each(["busy", "already_processed", "terminal_failed", "expired", "not_found"])("%s: encerra sem finalizar", async (outcome) => {
    claimReturns({ outcome });
    await expect(run()).resolves.toEqual({ outcome, code: null });
    expect(names()).toEqual(["whatsapp_inbox_claim"]);
  });

  it("inboxId inválido: not_found sem banco", async () => {
    await expect(run("nao-e-uuid")).resolves.toEqual({ outcome: "not_found", code: null });
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// 4. Caminho completo com o simulador real
// ---------------------------------------------------------------------

describe("4. decisão com o adaptador do provedor gravado no canal", () => {
  it.each([
    ["message.inbound", INBOUND],
    ["message.status", STATUS],
  ])("%s com canal ativo: release domain_effect_not_implemented (fica pendente)", async (_name, event) => {
    claimReturns(claimRow(event));
    await expect(run()).resolves.toEqual({ outcome: "released", code: "domain_effect_not_implemented" });
    expect(finalizations()).toEqual([
      { name: "whatsapp_inbox_release", args: { p_inbox_id: INBOX_ID, p_claim_token: TOKEN, p_error_code: "domain_effect_not_implemented" }, insideStep: false },
    ]);
  });

  it("evento não suportado: dispose unsupported_event com id, token e disposição", async () => {
    claimReturns(claimRow(OTHER));
    await expect(run()).resolves.toEqual({ outcome: "processed", code: "unsupported_event" });
    expect(finalizations().map((c) => [c.name, c.args])).toEqual([
      ["whatsapp_inbox_dispose", { p_inbox_id: INBOX_ID, p_claim_token: TOKEN, p_disposition: "unsupported_event" }],
    ]);
  });

  it.each(["already_processed", "terminal_failed", "not_found"])("dispose com resultado %s: repassado", async (outcome) => {
    claimReturns(claimRow(OTHER));
    handlers.whatsapp_inbox_dispose = () => ({ data: { outcome }, error: null });
    await expect(run()).resolves.toEqual({ outcome, code: null });
  });

  it.each([
    ["dispose", OTHER, "whatsapp_inbox_dispose", "unsupported_event"],
    ["release", INBOUND, "whatsapp_inbox_release", "domain_effect_not_implemented"],
  ] as const)("%s com claim_lost (lease vencida antes da finalização): uma única chamada, sem repetir nem trocar de finalização", async (_n, event, rpc, code) => {
    claimReturns(claimRow(event));
    handlers[rpc] = () => ({ data: { outcome: "claim_lost" }, error: null });
    await expect(run()).resolves.toEqual({ outcome: "claim_lost", code });
    expect(finalizations().map((c) => c.name)).toEqual([rpc]);
  });

  it("routing key do evento diferente da do canal: fail routing_mismatch, sem procurar outro canal", async () => {
    claimReturns(claimRow({ ...INBOUND, routingKey: "sim-outro-canal" }));
    await expect(run()).resolves.toEqual({ outcome: "failed", code: "routing_mismatch" });
    expect(finalizations().map((c) => [c.name, c.args])).toEqual([
      ["whatsapp_inbox_fail", { p_inbox_id: INBOX_ID, p_claim_token: TOKEN, p_error_code: "routing_mismatch" }],
    ]);
    expect(names().filter((n) => n.includes("channel") || n.includes("resolve"))).toEqual([]);
  });

  it("payload simulado inválido: fail payload_invalid", async () => {
    const raw = bytesOf(JSON.stringify({ version: 1, events: [{ type: "message.inbound", id: EVENT_ID }] }));
    claimReturns(claimRow(INBOUND, {}, {}, raw));
    await expect(run()).resolves.toEqual({ outcome: "failed", code: "payload_invalid" });
  });

  it("versão de envelope não suportada: fail unsupported_version", async () => {
    const raw = bytesOf(JSON.stringify({ version: 2, events: [INBOUND] }));
    claimReturns(claimRow(INBOUND, {}, {}, raw));
    await expect(run()).resolves.toEqual({ outcome: "failed", code: "unsupported_version" });
  });

  it("id do evento no corpo diferente do gravado na linha: fail event_mismatch", async () => {
    claimReturns(claimRow({ ...INBOUND, id: "evt-trocado" }));
    await expect(run()).resolves.toEqual({ outcome: "failed", code: "event_mismatch" });
  });

  it("tipo do evento no corpo diferente do gravado na linha: fail event_mismatch", async () => {
    claimReturns(claimRow(INBOUND, { provider_event_type: "message.status" }));
    await expect(run()).resolves.toEqual({ outcome: "failed", code: "event_mismatch" });
  });

  it("provedor do canal não habilitado neste ambiente: release provider_unavailable", async () => {
    vi.stubEnv("WHATSAPP_PROVIDER", "");
    claimReturns(claimRow(INBOUND));
    await expect(run()).resolves.toEqual({ outcome: "released", code: "provider_unavailable" });
  });

  it("canal YCloud: o adaptador é o do canal (sem adaptador habilitado → release, nunca o simulador)", async () => {
    claimReturns(claimRow(INBOUND, { provider: "ycloud" }, { provider: "ycloud" }));
    await expect(run()).resolves.toEqual({ outcome: "released", code: "provider_unavailable" });
    expect(resolveMock).toHaveBeenCalledWith({ channelProvider: "ycloud" });
  });
});

// ---------------------------------------------------------------------
// 5. Estado atual do canal
// ---------------------------------------------------------------------

describe("5. matriz do estado do canal", () => {
  it.each([
    ["paused", "channel_paused"],
    ["disconnected", "channel_disconnected"],
    ["disabled", "channel_disabled"],
  ])("canal %s: release %s para mensagem e para evento ignorável — a entrada fica pendente, nunca descartada", async (status, code) => {
    for (const event of [INBOUND, OTHER]) {
      rpcLog = [];
      claimReturns(claimRow(event, { channel_status: status }));
      await expect(run()).resolves.toEqual({ outcome: "released", code });
      expect(finalizations().map((c) => c.name)).toEqual(["whatsapp_inbox_release"]);
    }
  });

  it("canal ativo: segue para a decisão do tipo do evento", async () => {
    claimReturns(claimRow(OTHER, { channel_status: "active" }));
    await expect(run()).resolves.toEqual({ outcome: "processed", code: "unsupported_event" });
  });

  it("routing key divergente com canal pausado: a falha terminal prevalece", async () => {
    claimReturns(claimRow({ ...INBOUND, routingKey: "sim-outro-canal" }, { channel_status: "paused" }));
    await expect(run()).resolves.toEqual({ outcome: "failed", code: "routing_mismatch" });
  });
});

// ---------------------------------------------------------------------
// 6. Decisão por tipo (função pura)
// ---------------------------------------------------------------------

describe("6. decisão por tipo de evento e roteamento", () => {
  const cases: [string, NormalizedWhatsAppEvent, string, string][] = [
    ["mensagem recebida", ev(EVENTS.inbound), "release", "domain_effect_not_implemented"],
    ["eco do aplicativo", ev(EVENTS.outbound), "release", "domain_effect_not_implemented"],
    ["status", ev(EVENTS.status), "release", "domain_effect_not_implemented"],
    ["troca de identidade", ev(EVENTS.identity), "release", "domain_effect_not_implemented"],
    ["evento da conta (WABA, sem routing key)", ev(EVENTS.accountWaba), "release", "domain_effect_not_implemented"],
    ["evento do número", ev(EVENTS.accountPhone), "release", "domain_effect_not_implemented"],
    ["evento do número sem routing key", ev(EVENTS.accountPhone, { routingKey: null }), "fail", "event_impossible"],
    ["histórico ignorado", ev(EVENTS.ignoredHistory), "dispose", "ignored_history"],
    ["grupo ignorado, sem routing key", ev(EVENTS.ignoredGroup), "dispose", "ignored_group_message"],
    ["outro produto ignorado", ev(EVENTS.ignoredProduct), "dispose", "ignored_non_whatsapp_product"],
    ["não suportado sem routing key", ev(EVENTS.unsupported), "dispose", "unsupported_event"],
    ["não suportado com a routing key do canal", ev(EVENTS.unsupportedRouted), "dispose", "unsupported_event"],
    ["mensagem de outro canal", ev(EVENTS.inbound, { routingKey: "sim-outro" }), "fail", "routing_mismatch"],
    ["routing key só com caixa diferente", ev(EVENTS.inbound, { routingKey: ROUTING.toUpperCase() }), "fail", "routing_mismatch"],
    ["ignorado de outro canal", ev(EVENTS.ignoredHistory, { routingKey: "sim-outro" }), "fail", "routing_mismatch"],
    ["não suportado de outro canal", ev(EVENTS.unsupported, { routingKey: "sim-outro" }), "fail", "routing_mismatch"],
    ["conta com routing key de outro canal", ev(EVENTS.accountWaba, { routingKey: "sim-outro" }), "fail", "routing_mismatch"],
    ["mensagem sem routing key", ev(EVENTS.inbound, { routingKey: null }), "fail", "event_impossible"],
    ["status com routing key vazia", ev(EVENTS.status, { routingKey: "" }), "fail", "event_impossible"],
    ["troca de identidade sem routing key", ev(EVENTS.identity, { routingKey: undefined }), "fail", "event_impossible"],
    ["tipo desconhecido", ev({ ...BASE, kind: "contact.deleted", routingKey: ROUTING }), "fail", "event_impossible"],
    ["ignorado com motivo desconhecido", ev(EVENTS.ignoredHistory, { reason: "spam" }), "fail", "event_impossible"],
  ];

  it.each(cases)("%s → %s %s", async (_name, event, action, code) => {
    const { decideWhatsAppInboxEvent } = await loadConsumer();
    expect(decideWhatsAppInboxEvent({ channelRoutingKey: ROUTING, channelStatus: "active", event })).toEqual({ action, code });
  });

  it.each(["paused", "disconnected", "disabled"] as const)("canal %s: release com o código do estado para todo tipo válido", async (status) => {
    const { decideWhatsAppInboxEvent } = await loadConsumer();
    for (const event of [EVENTS.inbound, EVENTS.status, EVENTS.ignoredHistory, EVENTS.unsupported, EVENTS.accountWaba]) {
      expect(decideWhatsAppInboxEvent({ channelRoutingKey: ROUTING, channelStatus: status, event: ev(event) })).toEqual({
        action: "release",
        code: `channel_${status}`,
      });
    }
  });

  it("com o adaptador fictício: ignored finaliza com a disposição; account e identidade só liberam", async () => {
    for (const [event, expected] of [
      [EVENTS.ignoredHistory, { outcome: "processed", code: "ignored_history" }],
      [EVENTS.accountWaba, { outcome: "released", code: "domain_effect_not_implemented" }],
      [EVENTS.identity, { outcome: "released", code: "domain_effect_not_implemented" }],
    ] as const) {
      claimReturns(claimRow(INBOUND));
      withAdapter(fakeAdapter({ events: [ev(event)] }));
      await expect(run()).resolves.toEqual(expected);
    }
  });
});

// ---------------------------------------------------------------------
// 7. Falhas terminais × recuperáveis
// ---------------------------------------------------------------------

describe("7. classificação das falhas", () => {
  const ENVELOPE_OK = { ok: true as const, envelope: { providerEventId: EVENT_ID, providerEventType: "message.inbound", envelopeVersion: "1", eventCount: 1 as const } };

  const terminal: [string, Parameters<typeof fakeAdapter>[0], string][] = [
    ["corpo que não é JSON", { envelope: { ok: false, reason: "invalid_json" } }, "payload_invalid"],
    ["envelope inválido", { envelope: { ok: false, reason: "invalid_envelope" } }, "payload_invalid"],
    ["payload inválido na normalização", { normalized: { ok: false, reason: "invalid_payload" } }, "payload_invalid"],
    ["versão não suportada", { envelope: { ok: false, reason: "unsupported_envelope_version" } }, "unsupported_version"],
    ["lote no envelope", { envelope: { ok: false, reason: "batch_not_supported" } }, "event_count_invalid"],
    ["normalização com dois eventos", { events: [ev(EVENTS.inbound), ev(EVENTS.status)] }, "event_count_invalid"],
    ["normalização sem evento", { events: [] }, "event_count_invalid"],
    ["evento normalizado com outro id", { events: [ev(EVENTS.inbound, { providerEventId: "evt-x" })] }, "event_mismatch"],
    ["envelope com outro id", { envelope: { ...ENVELOPE_OK, envelope: { ...ENVELOPE_OK.envelope, providerEventId: "evt-x" } } }, "event_mismatch"],
    ["corpo não verificado (impossível)", { normalized: { ok: false, reason: "unverified_body" } }, "event_impossible"],
    ["routing key de outro canal", { events: [ev(EVENTS.inbound, { routingKey: "sim-outro" })] }, "routing_mismatch"],
    ["mensagem sem routing key", { events: [ev(EVENTS.inbound, { routingKey: null })] }, "event_impossible"],
  ];

  const recoverable: [string, Parameters<typeof fakeAdapter>[0], string][] = [
    ["adaptador sem normalização", { normalizeEvents: false }, "provider_unavailable"],
    ["normalização indisponível no adaptador", { normalized: { ok: false, reason: "unsupported", capability: "normalizeEvents" } }, "provider_unavailable"],
    ["adaptador falhando na inspeção", { throwOn: "inspect" }, "consumer_transient_error"],
    ["adaptador falhando na normalização", { throwOn: "normalize" }, "consumer_transient_error"],
    ["efeito no domínio ainda não implementado", {}, "domain_effect_not_implemented"],
  ];

  it.each(terminal)("terminal — %s: fail %s, uma vez", async (_name, opts, code) => {
    claimReturns(claimRow(INBOUND));
    withAdapter(fakeAdapter(opts));
    await expect(run()).resolves.toEqual({ outcome: "failed", code });
    expect(finalizations().map((c) => [c.name, c.args.p_error_code])).toEqual([["whatsapp_inbox_fail", code]]);
  });

  it.each(recoverable)("recuperável — %s: release %s, uma vez", async (_name, opts, code) => {
    claimReturns(claimRow(INBOUND));
    withAdapter(fakeAdapter(opts));
    await expect(run()).resolves.toEqual({ outcome: "released", code });
    expect(finalizations().map((c) => [c.name, c.args.p_error_code])).toEqual([["whatsapp_inbox_release", code]]);
  });

  it("provedor do canal inconsistente com o adaptador: fail provider_invalid", async () => {
    claimReturns(claimRow(INBOUND));
    resolveMock.mockReturnValue({ status: "disabled", reason: "provider_mismatch" });
    await expect(run()).resolves.toEqual({ outcome: "failed", code: "provider_invalid" });
  });

  it("listas exportadas: terminais e recuperáveis são disjuntas e cobrem todos os códigos usados", async () => {
    const { WHATSAPP_CONSUMER_TERMINAL_CODES, WHATSAPP_CONSUMER_RECOVERABLE_CODES } = await loadConsumer();
    const { WHATSAPP_INBOX_DISPOSITIONS } = await loadInbox();
    const terminalSet = new Set<string>(WHATSAPP_CONSUMER_TERMINAL_CODES);
    const recoverableSet = new Set<string>(WHATSAPP_CONSUMER_RECOVERABLE_CODES);
    expect([...terminalSet].filter((c) => recoverableSet.has(c))).toEqual([]);
    for (const [, , code] of terminal) expect(terminalSet.has(code)).toBe(true);
    for (const [, , code] of recoverable) expect(recoverableSet.has(code)).toBe(true);
    for (const code of ["routing_mismatch", "inbox_decrypt_failed", "inbox_integrity_failed", "provider_invalid"]) expect(terminalSet.has(code)).toBe(true);
    for (const code of ["channel_paused", "channel_disconnected", "channel_disabled", "inbox_crypto_not_configured", "inbox_key_version_unknown"]) {
      expect(recoverableSet.has(code)).toBe(true);
    }
    expect([...WHATSAPP_INBOX_DISPOSITIONS].sort()).toEqual(["ignored_group_message", "ignored_history", "ignored_non_whatsapp_product", "unsupported_event"]);
    for (const code of [...terminalSet, ...recoverableSet, ...WHATSAPP_INBOX_DISPOSITIONS]) expect(code).toMatch(/^[a-z0-9_]{1,64}$/);
  });
});

// ---------------------------------------------------------------------
// 8. Hash e AAD: o corpo só existe com a identidade da linha
// ---------------------------------------------------------------------

describe("8. hash e AAD da linha", () => {
  it("o claim traz o SHA-256 da linha, igual ao dos bytes verificados", async () => {
    const inbox = await loadInbox();
    const row = claimRow(INBOUND);
    claimReturns(row);
    const result = await inbox.claimWhatsAppInboxEntry({ inboxId: INBOX_ID });
    if (result.outcome !== "claimed") throw new Error("sem claim");
    expect(result.claim.bodySha256).toBe(row.body_sha256);
    expect(sha256(result.claim.verified.copyBytes())).toBe(result.claim.bodySha256);
  });

  it.each([
    ["outro workspace", { workspaceId: OTHER_WS }],
    ["outro canal", { channelId: "36000000-0000-0000-0000-000000000099" }],
    ["outro ambiente", { environment: "production" }],
    ["outro evento", { providerEventId: "evt-outro" }],
  ])("cifra com a AAD de %s: falha terminal inbox_decrypt_failed, sem normalizar nem liberar", async (_name, aad) => {
    claimReturns(claimRow(INBOUND, {}, aad));
    await expect(run()).resolves.toEqual({ outcome: "failed", code: "inbox_decrypt_failed" });
    expect(finalizations().map((c) => [c.name, c.args.p_error_code])).toEqual([["whatsapp_inbox_fail", "inbox_decrypt_failed"]]);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("hash gravado divergente: falha terminal inbox_integrity_failed", async () => {
    claimReturns(claimRow(INBOUND, { body_sha256: "b".repeat(64) }));
    await expect(run()).resolves.toEqual({ outcome: "failed", code: "inbox_integrity_failed" });
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("chave da inbox ausente: release inbox_crypto_not_configured", async () => {
    const row = claimRow(INBOUND);
    vi.stubEnv("WHATSAPP_INBOX_KEY_VERSIONS", "");
    claimReturns(row);
    await expect(run()).resolves.toEqual({ outcome: "released", code: "inbox_crypto_not_configured" });
  });

  it("versão de chave desconhecida: release com o código próprio inbox_key_version_unknown", async () => {
    claimReturns(claimRow(INBOUND, { key_version: "9" }));
    await expect(run()).resolves.toEqual({ outcome: "released", code: "inbox_key_version_unknown" });
    expect(finalizations().map((c) => [c.name, c.args.p_error_code])).toEqual([["whatsapp_inbox_release", "inbox_key_version_unknown"]]);
  });
});

// ---------------------------------------------------------------------
// 9. Idempotência e concorrência no servidor
// ---------------------------------------------------------------------

describe("9. idempotência e concorrência", () => {
  it("duas entregas do mesmo evento interno ao mesmo tempo: um claim, um busy, uma finalização", async () => {
    claimReturns(claimRow(OTHER), { outcome: "busy" });
    const { processWhatsAppInboxEntry } = await loadConsumer();
    const results = await Promise.all([processWhatsAppInboxEntry({ inboxId: INBOX_ID }), processWhatsAppInboxEntry({ inboxId: INBOX_ID })]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["busy", "processed"]);
    expect(finalizations().map((c) => c.name)).toEqual(["whatsapp_inbox_dispose"]);
  });

  it("execução que chega depois de processed: already_processed, sem finalização", async () => {
    claimReturns(claimRow(OTHER), { outcome: "already_processed" });
    await run();
    rpcLog = [];
    await expect(run()).resolves.toEqual({ outcome: "already_processed", code: null });
    expect(names()).toEqual(["whatsapp_inbox_claim"]);
  });

  it("reclaim depois da lease vencida: a nova execução finaliza com o token NOVO; o antigo não é reutilizado", async () => {
    claimReturns(claimRow(OTHER), claimRow(OTHER, { claim_token: TOKEN_2, claim_count: 2 }));
    handlers.whatsapp_inbox_dispose = (args) => ({ data: { outcome: args.p_claim_token === TOKEN ? "claim_lost" : "completed" }, error: null });
    await expect(run()).resolves.toEqual({ outcome: "claim_lost", code: "unsupported_event" });
    await expect(run()).resolves.toEqual({ outcome: "processed", code: "unsupported_event" });
    expect(finalizations().map((c) => c.args.p_claim_token)).toEqual([TOKEN, TOKEN_2]);
  });

  it("ignored/unsupported repetido: a segunda execução vê already_processed e não finaliza de novo", async () => {
    let processed = false;
    handlers.whatsapp_inbox_claim = () => ({ data: processed ? { outcome: "already_processed" } : claimRow(OTHER), error: null });
    handlers.whatsapp_inbox_dispose = () => {
      processed = true;
      return { data: { outcome: "completed" }, error: null };
    };
    await run();
    await run();
    expect(finalizations().map((c) => c.name)).toEqual(["whatsapp_inbox_dispose"]);
  });
});

// ---------------------------------------------------------------------
// 10. Infraestrutura: erro sanitizado, nunca segunda finalização
// ---------------------------------------------------------------------

describe("10. falhas de infraestrutura", () => {
  it("claim com o banco indisponível: erro de nova tentativa só com código", async () => {
    handlers.whatsapp_inbox_claim = () => ({ data: null, error: { message: `connection refused 10.0.0.1 ${PHONE}` } });
    const { WhatsAppConsumerRetryableError } = await loadConsumer();
    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WhatsAppConsumerRetryableError);
    expect(error).toMatchObject({ code: "inbox_unavailable", message: "inbox_unavailable" });
    expect(String((error as Error).stack)).not.toMatch(/10\.0\.0\.1|5511|connection/);
  });

  it("finalização com o banco indisponível: erro de nova tentativa, sem segunda finalização", async () => {
    claimReturns(claimRow(OTHER));
    handlers.whatsapp_inbox_dispose = () => ({ data: null, error: { message: `timeout ${TEXT}` } });
    const error = await run().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "inbox_finalize_unavailable", message: "inbox_finalize_unavailable" });
    expect(finalizations().map((c) => c.name)).toEqual(["whatsapp_inbox_dispose"]);
  });
});

// ---------------------------------------------------------------------
// 11. Nenhum efeito no domínio, nenhum log, nenhum conteúdo
// ---------------------------------------------------------------------

describe("11. sem domínio, sem log, sem conteúdo", () => {
  const scenarios: [string, () => void][] = [
    ["mensagem", () => claimReturns(claimRow(INBOUND))],
    ["status", () => claimReturns(claimRow(STATUS))],
    ["não suportado", () => claimReturns(claimRow(OTHER))],
    ["canal pausado", () => claimReturns(claimRow(INBOUND, { channel_status: "paused" }))],
    ["routing divergente", () => claimReturns(claimRow({ ...INBOUND, routingKey: "sim-outro" }))],
    ["AAD errada", () => claimReturns(claimRow(INBOUND, {}, { workspaceId: OTHER_WS }))],
  ];

  it.each(scenarios)("%s: só RPCs da inbox, nenhum acesso a tabela, nenhum log, nada sensível nos argumentos ou no resultado", async (_name, setup) => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    setup();
    const result = await run();
    for (const name of names()) expect(["whatsapp_inbox_claim", "whatsapp_inbox_fail", "whatsapp_inbox_release", "whatsapp_inbox_dispose"]).toContain(name);
    expect(fromMock).not.toHaveBeenCalled();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    for (const call of finalizations()) {
      expect(Object.keys(call.args).sort()).toEqual(
        call.name === "whatsapp_inbox_dispose" ? ["p_claim_token", "p_disposition", "p_inbox_id"] : ["p_claim_token", "p_error_code", "p_inbox_id"],
      );
    }
    const dump = JSON.stringify({ result, finalizations: finalizations() });
    for (const secret of [PHONE, TEXT, ROUTING, WS, CHANNEL, INBOX_KEY, "sim-outro"]) expect(dump).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------
// 12. disposeWhatsAppInboxClaim: só com o claim emitido aqui
// ---------------------------------------------------------------------

describe("12. finalização sem efeito no servidor", () => {
  async function claimed() {
    const inbox = await loadInbox();
    claimReturns(claimRow(OTHER));
    const result = await inbox.claimWhatsAppInboxEntry({ inboxId: INBOX_ID });
    if (result.outcome !== "claimed") throw new Error("sem claim");
    return { inbox, claim: result.claim };
  }

  it("manda só o id, o token e a disposição", async () => {
    const { inbox, claim } = await claimed();
    await expect(inbox.disposeWhatsAppInboxClaim(claim, "ignored_history")).resolves.toEqual({ outcome: "completed" });
    expect(finalizations().map((c) => [c.name, c.args])).toEqual([
      ["whatsapp_inbox_dispose", { p_inbox_id: INBOX_ID, p_claim_token: TOKEN, p_disposition: "ignored_history" }],
    ]);
  });

  it.each(["domain_effect_not_implemented", "Evento ignorado", "", "IGNORED_HISTORY", undefined])("disposição fora da lista (%s): recusada antes do banco", async (code) => {
    const { inbox, claim } = await claimed();
    rpcLog = [];
    await expect(inbox.disposeWhatsAppInboxClaim(claim, code as never)).rejects.toMatchObject({ code: "invalid_disposition" });
    expect(rpcLog).toEqual([]);
  });

  it.each([
    ["cópia", (c: object) => ({ ...c })],
    ["serializado", (c: object) => JSON.parse(JSON.stringify(c)) as object],
    ["só o id", () => ({ inboxId: INBOX_ID })],
  ])("claim %s: inbox_claim_untrusted, sem banco", async (_name, forge) => {
    const { inbox, claim } = await claimed();
    rpcLog = [];
    await expect(inbox.disposeWhatsAppInboxClaim(forge(claim) as never, "unsupported_event")).rejects.toMatchObject({ code: "inbox_claim_untrusted" });
    expect(rpcLog).toEqual([]);
  });

  it.each(["completed", "already_processed", "terminal_failed", "claim_lost", "not_found"])("resultado %s do banco: repassado", async (outcome) => {
    const { inbox, claim } = await claimed();
    handlers.whatsapp_inbox_dispose = () => ({ data: { outcome }, error: null });
    await expect(inbox.disposeWhatsAppInboxClaim(claim, "unsupported_event")).resolves.toEqual({ outcome });
  });

  it("resposta fora do contrato: inbox_claim_invalid", async () => {
    const { inbox, claim } = await claimed();
    handlers.whatsapp_inbox_dispose = () => ({ data: { outcome: "completed", disposition: "unsupported_event" }, error: null });
    await expect(inbox.disposeWhatsAppInboxClaim(claim, "unsupported_event")).rejects.toMatchObject({ code: "inbox_claim_invalid" });
  });
});

