/**
 * @vitest-environment node
 *
 * B3.2d-2b3 — ligação do consumidor da inbox aos cinco efeitos do domínio
 * (docs/decisoes/b3-whatsapp-real.md §27). Aqui os EFEITOS são espiões: o que
 * se prova é a orquestração — qual efeito cada tipo chama, com quais dados,
 * com qual claim, e o que o consumidor faz com cada resultado (finalizar,
 * liberar, falhar, repetir ou não tocar em nada).
 *
 * A integração com os efeitos reais (RPCs simuladas) está em
 * `b3-2d2b3-consumidor-efeitos-integrado.test.ts`.
 *
 * Regra de ouro: os efeitos atômicos já marcam a entrada como `processed`
 * quando concluem; para esses resultados o consumidor NÃO finaliza de novo.
 *
 * Escritos ANTES da implementação, contra a main 8cd9191. Tudo fictício.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as InboundModule from "@/server/whatsapp/effects/inbound-message";
import type * as OutboundModule from "@/server/whatsapp/effects/outbound-observed";
import type * as StatusModule from "@/server/whatsapp/effects/message-status";
import type * as IdentityModule from "@/server/whatsapp/effects/identity-change";
import type * as AccountModule from "@/server/whatsapp/effects/account-event";
import type * as InboxModule from "@/server/whatsapp/inbox";
import type * as ProviderModule from "@/server/whatsapp/provider";
import type { WhatsAppProvider } from "@/server/whatsapp/provider/contract";
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
  OCCURRED,
  PHONE,
  PHONE_2,
  rawTypeOf,
  ROUTING,
  TEXT,
  TOKEN,
  WABA_REF,
  WS,
} from "../support/whatsapp-consumer-harness";

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  resolve: vi.fn(),
  from: vi.fn(),
  inbound: vi.fn(),
  outbound: vi.fn(),
  status: vi.fn(),
  identity: vi.fn(),
  account: vi.fn(),
  claimed: [] as unknown[],
}));

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
// O claim emitido pela inbox é guardado para a conferência de identidade.
vi.mock("@/server/whatsapp/inbox", async (importOriginal) => {
  const actual = await importOriginal<typeof InboxModule>();
  return {
    ...actual,
    claimWhatsAppInboxEntry: async (params: { inboxId: string; leaseSeconds?: number }) => {
      const result = await actual.claimWhatsAppInboxEntry(params);
      if (result.outcome === "claimed") h.claimed.push(result.claim);
      return result;
    },
  };
});
vi.mock("@/server/whatsapp/effects/inbound-message", async (importOriginal) => ({
  ...(await importOriginal<typeof InboundModule>()),
  applyWhatsAppInboundMessage: h.inbound,
}));
vi.mock("@/server/whatsapp/effects/outbound-observed", async (importOriginal) => ({
  ...(await importOriginal<typeof OutboundModule>()),
  applyWhatsAppOutboundObserved: h.outbound,
}));
vi.mock("@/server/whatsapp/effects/message-status", async (importOriginal) => ({
  ...(await importOriginal<typeof StatusModule>()),
  applyWhatsAppMessageStatus: h.status,
}));
vi.mock("@/server/whatsapp/effects/identity-change", async (importOriginal) => ({
  ...(await importOriginal<typeof IdentityModule>()),
  applyWhatsAppIdentityChange: h.identity,
}));
vi.mock("@/server/whatsapp/effects/account-event", async (importOriginal) => ({
  ...(await importOriginal<typeof AccountModule>()),
  applyWhatsAppAccountEvent: h.account,
}));

const loadConsumer = () => import("@/server/whatsapp/consumer");
const loadHandler = () => import("@/server/whatsapp/inngest-consumer");
const loadInboundModule = () => import("@/server/whatsapp/effects/inbound-message");
const loadOutboundModule = () => import("@/server/whatsapp/effects/outbound-observed");
const loadStatusModule = () => import("@/server/whatsapp/effects/message-status");
const loadIdentityModule = () => import("@/server/whatsapp/effects/identity-change");
const loadAccountModule = () => import("@/server/whatsapp/effects/account-event");

function configure() {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("WHATSAPP_PROVIDER", "simulated");
  vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "chave-de-teste-b3-whatsapp-0123456789");
  vi.stubEnv("WHATSAPP_INBOX_KEY_VERSIONS", JSON.stringify({ "1": INBOX_KEY }));
  vi.stubEnv("WHATSAPP_INBOX_ACTIVE_KEY_VERSION", "1");
}

type RpcHandler = (args: Record<string, unknown>) => { data: unknown; error: unknown };
let handlers: Record<string, RpcHandler> = {};
let rpcLog: { name: string; args: Record<string, unknown>; insideStep: boolean }[] = [];
/** Ordem dos acontecimentos: claim, normalização, efeito, finalização. */
let order: string[] = [];
let insideStep = false;

const FINALIZERS = ["whatsapp_inbox_complete", "whatsapp_inbox_fail", "whatsapp_inbox_release", "whatsapp_inbox_dispose"];
const finalizations = () => rpcLog.filter((c) => FINALIZERS.includes(c.name));

type Kind = "inbound" | "outbound" | "status" | "identity" | "account";
const EFFECT: Record<Kind, typeof h.inbound> = { inbound: h.inbound, outbound: h.outbound, status: h.status, identity: h.identity, account: h.account };
const effectCalls = () => Object.fromEntries((Object.keys(EFFECT) as Kind[]).map((k) => [k, EFFECT[k].mock.calls.length])) as Record<Kind, number>;
const noEffects = { inbound: 0, outbound: 0, status: 0, identity: 0, account: 0 };
const only = (kind: Kind) => ({ ...noEffects, [kind]: 1 });

beforeEach(async () => {
  configure();
  handlers = {
    whatsapp_inbox_claim: () => ({ data: claimRow(), error: null }),
    whatsapp_inbox_fail: () => ({ data: { outcome: "failed" }, error: null }),
    whatsapp_inbox_release: () => ({ data: { outcome: "released" }, error: null }),
    whatsapp_inbox_dispose: () => ({ data: { outcome: "completed" }, error: null }),
  };
  rpcLog = [];
  order = [];
  insideStep = false;
  h.claimed.length = 0;
  h.rpc.mockReset();
  h.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    rpcLog.push({ name, args, insideStep });
    order.push(name.replace("whatsapp_inbox_", ""));
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
  for (const kind of Object.keys(EFFECT) as Kind[]) {
    EFFECT[kind].mockReset();
    EFFECT[kind].mockImplementation(async () => {
      order.push("effect");
      return { outcome: "duplicate" };
    });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type Case = { label: string; kind: Kind; event: object };
const CASES: Case[] = [
  { label: "message.inbound", kind: "inbound", event: EVENTS.inbound },
  { label: "message.outbound_observed", kind: "outbound", event: EVENTS.outbound },
  { label: "message.status", kind: "status", event: EVENTS.status },
  { label: "contact.identity_changed", kind: "identity", event: EVENTS.identity },
  { label: "account (conta)", kind: "account", event: EVENTS.accountWaba },
  { label: "account (número)", kind: "account", event: EVENTS.accountPhone },
];

/** Prepara o claim e o adaptador para UM evento normalizado. */
function arrange(event: object, opts: { channelStatus?: string; claim?: Record<string, unknown>; adapter?: Parameters<typeof fakeAdapter>[0] } = {}) {
  const rawType = rawTypeOf(event);
  handlers.whatsapp_inbox_claim = () => ({
    data: claimRow({ provider_event_type: rawType, channel_status: opts.channelStatus ?? "active", ...opts.claim }),
    error: null,
  });
  h.resolve.mockReturnValue({
    status: "enabled",
    provider: fakeAdapter({ events: [ev(event)], envelopeType: rawType, onNormalize: () => order.push("normalize"), ...opts.adapter }),
  });
}

async function run(inboxId: string = INBOX_ID) {
  const { processWhatsAppInboxEntry } = await loadConsumer();
  return processWhatsAppInboxEntry({ inboxId });
}

const effectResultFor = (kind: Kind, outcome: string): Record<string, unknown> => {
  if (outcome !== "applied" && outcome !== "review_required") return { outcome };
  switch (kind) {
    case "inbound":
      return { outcome, messageId: MESSAGE_ID, conversationId: CONVERSATION_ID, senderClassification: "external", contactCreated: true, leadCreated: true };
    case "outbound":
      return { outcome, messageId: MESSAGE_ID, conversationId: CONVERSATION_ID };
    case "status":
      return { outcome, messageId: MESSAGE_ID };
    case "identity":
      return { outcome, identityId: IDENTITY_ID };
    default:
      return { outcome };
  }
};

// ---------------------------------------------------------------------
// 1. Cada tipo chama SÓ o seu efeito, uma vez
// ---------------------------------------------------------------------

describe("1. cada tipo normalizado chama exatamente o seu efeito", () => {
  it.each(CASES)("$label → só o efeito $kind, uma vez, depois do claim e da normalização", async ({ kind, event }) => {
    arrange(event);
    await expect(run()).resolves.toEqual({ outcome: "processed", code: "duplicate" });
    expect(effectCalls()).toEqual(only(kind));
    expect(order).toEqual(["claim", "normalize", "effect"]);
    expect(finalizations()).toEqual([]);
  });

  it("o efeito de cada tipo é o do seu nome (nenhum efeito trocado)", async () => {
    const wanted: Record<string, Kind> = {
      "message.inbound": "inbound",
      "message.outbound_observed": "outbound",
      "message.status": "status",
      "contact.identity_changed": "identity",
      account: "account",
    };
    for (const event of [EVENTS.inbound, EVENTS.outbound, EVENTS.status, EVENTS.identity, EVENTS.accountWaba, EVENTS.accountPhone]) {
      for (const k of Object.keys(EFFECT) as Kind[]) EFFECT[k].mockClear();
      arrange(event);
      await run();
      expect(effectCalls()).toEqual(only(wanted[(event as { kind: string }).kind]!));
    }
  });
});

// ---------------------------------------------------------------------
// 2. Conversão do evento normalizado para o contrato de cada efeito
// ---------------------------------------------------------------------

describe("2. dados normalizados convertidos para o contrato do efeito", () => {
  it("mensagem recebida: id, conteúdo, horário em ISO, remetente e nome do perfil", async () => {
    arrange(EVENTS.inbound);
    await run();
    expect(h.inbound.mock.calls[0]![1]).toEqual({
      providerMessageId: "m-in-1",
      contentKind: "text",
      text: TEXT,
      occurredAt: OCCURRED,
      sender: { phoneE164: PHONE, bsuid: null },
      profileName: "Cliente Fictício",
    });
  });

  it("mensagem recebida só com BSUID: o telefone vai nulo, o BSUID vai como veio", async () => {
    arrange(EVENTS.inbound, { adapter: { events: [ev(EVENTS.inbound, { sender: { kind: "bsuid", phoneE164: null, bsuid: BSUID }, senderProfileName: null })] } });
    await run();
    expect(h.inbound.mock.calls[0]![1]).toMatchObject({ sender: { phoneE164: null, bsuid: BSUID }, profileName: null });
  });

  it("eco do aplicativo: id, wamid, conteúdo, horário em ISO e destinatário", async () => {
    arrange(EVENTS.outbound);
    await run();
    expect(h.outbound.mock.calls[0]![1]).toEqual({
      providerMessageId: "m-out-1",
      waMessageId: "wamid.OUT1",
      contentKind: "text",
      text: TEXT,
      occurredAt: OCCURRED,
      recipient: { phoneE164: PHONE, bsuid: null },
    });
  });

  it("status: id, wamid, correlação, status, erro, horário, destinatário e custo do provedor", async () => {
    arrange(EVENTS.status);
    await run();
    expect(h.status.mock.calls[0]![1]).toEqual({
      providerMessageId: "m-out-1",
      waMessageId: "wamid.OUT1",
      externalId: "ext-1",
      status: "delivered",
      errorCode: null,
      occurredAt: OCCURRED,
      recipient: { phoneE164: PHONE, bsuid: null },
      providerCost: { source: "provider", category: "service", amount: 0.0125, currency: "USD", finality: "final" },
    });
  });

  it("status sem destinatário e sem custo: ambos nulos; falha com código opaco do provedor", async () => {
    arrange(EVENTS.status, { adapter: { events: [ev(EVENTS.status, { recipient: null, providerCost: null, status: "failed", errorCode: "131026" })] } });
    await run();
    expect(h.status.mock.calls[0]![1]).toMatchObject({ recipient: null, providerCost: null, status: "failed", errorCode: "131026" });
  });

  it("troca de número: tipo da mudança, horário em ISO, identidade anterior e nova", async () => {
    arrange(EVENTS.identity);
    await run();
    expect(h.identity.mock.calls[0]![1]).toEqual({
      change: "phone_number",
      occurredAt: OCCURRED,
      previous: { phoneE164: PHONE, bsuid: null },
      next: { phoneE164: PHONE_2, bsuid: null },
    });
  });

  it("mudança de identidade sem a nova: next nulo", async () => {
    arrange(EVENTS.identity, {
      adapter: { events: [ev(EVENTS.identity, { change: "identity", previous: { kind: "bsuid", phoneE164: null, bsuid: BSUID }, next: null })] },
    });
    await run();
    expect(h.identity.mock.calls[0]![1]).toEqual({
      change: "identity",
      occurredAt: OCCURRED,
      previous: { phoneE164: null, bsuid: BSUID },
      next: null,
    });
  });

  it.each([
    ["conta", EVENTS.accountWaba],
    ["número", EVENTS.accountPhone],
  ])("evento da %s: o evento normalizado vai como veio (mesma Date, sem correção de horário)", async (_n, event) => {
    arrange(event);
    const normalized = ev(event);
    arrange(event, { adapter: { events: [normalized] } });
    await run();
    expect(h.account.mock.calls[0]![1]).toBe(normalized);
    expect((h.account.mock.calls[0]![1] as { occurredAt: Date }).occurredAt.toISOString()).toBe(OCCURRED);
  });

  it("horário muito no futuro NÃO é corrigido nem recusado pelo consumidor: quem julga é o banco", async () => {
    const future = new Date("2099-01-01T00:00:00.000Z");
    arrange(EVENTS.accountWaba, { adapter: { events: [ev(EVENTS.accountWaba, { occurredAt: future })] } });
    await run();
    expect((h.account.mock.calls[0]![1] as { occurredAt: Date }).occurredAt).toBe(future);
    arrange(EVENTS.inbound, { adapter: { events: [ev(EVENTS.inbound, { occurredAt: future })] } });
    await run();
    expect((h.inbound.mock.calls[0]![1] as { occurredAt: string }).occurredAt).toBe("2099-01-01T00:00:00.000Z");
  });

  it("nada do evento do Inngest nem da linha extra vai ao efeito: só o claim e os dados normalizados", async () => {
    arrange(EVENTS.inbound);
    await run();
    expect(h.inbound.mock.calls[0]).toHaveLength(2);
    const dump = JSON.stringify(h.inbound.mock.calls[0]![1]);
    for (const secret of [WS, CHANNEL, INBOX_ID, TOKEN, ROUTING, "praxis/whatsapp"]) expect(dump).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------
// 3. Estado do canal
// ---------------------------------------------------------------------

describe("3. estado do canal", () => {
  it.each(["active", "paused", "disconnected", "disabled"])("account chega ao efeito com o canal %s", async (status) => {
    for (const event of [EVENTS.accountWaba, EVENTS.accountPhone]) {
      for (const k of Object.keys(EFFECT) as Kind[]) EFFECT[k].mockClear();
      rpcLog = [];
      arrange(event, { channelStatus: status });
      await expect(run()).resolves.toEqual({ outcome: "processed", code: "duplicate" });
      expect(effectCalls()).toEqual(only("account"));
      expect(finalizations()).toEqual([]);
    }
  });

  it.each([
    ["paused", "channel_paused"],
    ["disconnected", "channel_disconnected"],
    ["disabled", "channel_disabled"],
  ])("canal %s: mensagem, eco, status e identidade são liberados com %s, sem chamar o efeito", async (status, code) => {
    for (const event of [EVENTS.inbound, EVENTS.outbound, EVENTS.status, EVENTS.identity]) {
      rpcLog = [];
      arrange(event, { channelStatus: status });
      await expect(run()).resolves.toEqual({ outcome: "released", code });
      expect(effectCalls()).toEqual(noEffects);
      expect(finalizations().map((c) => [c.name, c.args.p_error_code])).toEqual([["whatsapp_inbox_release", code]]);
    }
  });

  it.each([
    ["paused", "channel_paused"],
    ["disconnected", "channel_disconnected"],
    ["disabled", "channel_disabled"],
  ])("canal %s: ignorado e não suportado continuam liberados como antes (%s)", async (status, code) => {
    for (const event of [EVENTS.ignoredHistory, EVENTS.unsupported]) {
      rpcLog = [];
      arrange(event, { channelStatus: status });
      await expect(run()).resolves.toEqual({ outcome: "released", code });
      expect(effectCalls()).toEqual(noEffects);
      expect(finalizations().map((c) => c.name)).toEqual(["whatsapp_inbox_release"]);
    }
  });

  it("canal ativo: ignorado e não suportado continuam finalizados com a disposição, sem efeito", async () => {
    for (const [event, disposition] of [
      [EVENTS.ignoredHistory, "ignored_history"],
      [EVENTS.ignoredGroup, "ignored_group_message"],
      [EVENTS.ignoredProduct, "ignored_non_whatsapp_product"],
      [EVENTS.unsupported, "unsupported_event"],
    ] as const) {
      rpcLog = [];
      arrange(event);
      await expect(run()).resolves.toEqual({ outcome: "processed", code: disposition });
      expect(effectCalls()).toEqual(noEffects);
      expect(finalizations().map((c) => [c.name, c.args.p_disposition])).toEqual([["whatsapp_inbox_dispose", disposition]]);
    }
  });

  it("a função pura de decisão: account passa em qualquer estado; o resto só com o canal ativo", async () => {
    const { decideWhatsAppInboxEvent } = await loadConsumer();
    for (const status of ["active", "paused", "disconnected", "disabled"] as const) {
      for (const event of [EVENTS.accountWaba, EVENTS.accountPhone]) {
        expect(decideWhatsAppInboxEvent({ channelRoutingKey: ROUTING, channelStatus: status, event: ev(event) })).toMatchObject({ action: "apply" });
      }
    }
    for (const status of ["paused", "disconnected", "disabled"] as const) {
      for (const event of [EVENTS.inbound, EVENTS.outbound, EVENTS.status, EVENTS.identity]) {
        expect(decideWhatsAppInboxEvent({ channelRoutingKey: ROUTING, channelStatus: status, event: ev(event) })).toEqual({
          action: "release",
          code: `channel_${status}`,
        });
      }
    }
    for (const event of [EVENTS.inbound, EVENTS.outbound, EVENTS.status, EVENTS.identity]) {
      expect(decideWhatsAppInboxEvent({ channelRoutingKey: ROUTING, channelStatus: "active", event: ev(event) })).toMatchObject({ action: "apply" });
    }
  });
});

// ---------------------------------------------------------------------
// 4. Resultados do efeito → finalização
// ---------------------------------------------------------------------

const CHANNEL_RESULTS = ["channel_paused", "channel_disconnected", "channel_disabled"];
const NO_OWNERSHIP = ["already_processed", "terminal_failed", "claim_lost", "not_found"];

const PROCESSED: Record<Kind, string[]> = {
  inbound: ["applied", "duplicate"],
  outbound: ["applied", "duplicate"],
  status: ["applied", "duplicate"],
  identity: ["applied", "review_required", "duplicate"],
  account: ["applied", "recorded", "stale_event", "duplicate"],
};
const FAIL: Record<Kind, string[]> = {
  inbound: ["identity_conflict", "effect_conflict"],
  outbound: ["identity_conflict", "message_conflict", "effect_conflict"],
  status: ["message_conflict", "cost_conflict", "effect_conflict"],
  identity: ["identity_conflict", "effect_conflict"],
  account: ["routing_mismatch", "account_reference_mismatch", "effect_conflict"],
};
const RELEASE: Record<Kind, string[]> = {
  inbound: CHANNEL_RESULTS,
  outbound: CHANNEL_RESULTS,
  status: [...CHANNEL_RESULTS, "message_not_found"],
  identity: [...CHANNEL_RESULTS, "identity_not_found"],
  account: ["account_reference_unverified"],
};
const CASE_OF: Record<Kind, object> = {
  inbound: EVENTS.inbound,
  outbound: EVENTS.outbound,
  status: EVENTS.status,
  identity: EVENTS.identity,
  account: EVENTS.accountPhone,
};
const KINDS = Object.keys(CASE_OF) as Kind[];

function allRows(table: Record<Kind, string[]>) {
  return KINDS.flatMap((kind) => table[kind].map((outcome) => [kind, outcome] as const));
}

describe("4. resultado do efeito → finalização", () => {
  it.each(allRows(PROCESSED))("%s / %s: concluído pelo efeito — processed, e NENHUMA segunda finalização", async (kind, outcome) => {
    arrange(CASE_OF[kind]);
    EFFECT[kind].mockImplementation(async () => {
      order.push("effect");
      return effectResultFor(kind, outcome);
    });
    await expect(run()).resolves.toEqual({ outcome: "processed", code: outcome });
    expect(finalizations()).toEqual([]);
    expect(order).toEqual(["claim", "normalize", "effect"]);
  });

  it.each(KINDS.flatMap((kind) => NO_OWNERSHIP.map((outcome) => [kind, outcome] as const)))(
    "%s / %s: sem posse ou já terminal — resultado equivalente, sem nenhuma finalização",
    async (kind, outcome) => {
      arrange(CASE_OF[kind]);
      EFFECT[kind].mockResolvedValue({ outcome });
      await expect(run()).resolves.toEqual({ outcome, code: null });
      expect(finalizations()).toEqual([]);
    },
  );

  it.each(allRows(RELEASE))("%s / %s: o claim continua — release exatamente uma vez, com o código", async (kind, outcome) => {
    arrange(CASE_OF[kind]);
    EFFECT[kind].mockResolvedValue({ outcome });
    await expect(run()).resolves.toEqual({ outcome: "released", code: outcome });
    expect(finalizations().map((c) => [c.name, c.args])).toEqual([
      ["whatsapp_inbox_release", { p_inbox_id: INBOX_ID, p_claim_token: TOKEN, p_error_code: outcome }],
    ]);
    expect(order).toEqual(["claim", "normalize", "effect", "release"]);
  });

  it.each(allRows(FAIL))("%s / %s: conflito permanente — fail exatamente uma vez, com o código", async (kind, outcome) => {
    arrange(CASE_OF[kind]);
    EFFECT[kind].mockResolvedValue({ outcome });
    await expect(run()).resolves.toEqual({ outcome: "failed", code: outcome });
    expect(finalizations().map((c) => [c.name, c.args])).toEqual([
      ["whatsapp_inbox_fail", { p_inbox_id: INBOX_ID, p_claim_token: TOKEN, p_error_code: outcome }],
    ]);
  });

  it("a lease vencer entre o efeito e a finalização (claim_lost no release): uma só chamada, sem repetir", async () => {
    arrange(EVENTS.status);
    h.status.mockResolvedValue({ outcome: "message_not_found" });
    handlers.whatsapp_inbox_release = () => ({ data: { outcome: "claim_lost" }, error: null });
    await expect(run()).resolves.toEqual({ outcome: "claim_lost", code: "message_not_found" });
    expect(finalizations().map((c) => c.name)).toEqual(["whatsapp_inbox_release"]);
    expect(effectCalls()).toEqual(only("status"));
  });

  it("o banco indisponível na finalização: erro de nova tentativa, sem segunda finalização e sem o efeito repetido", async () => {
    arrange(EVENTS.identity);
    h.identity.mockResolvedValue({ outcome: "identity_not_found" });
    handlers.whatsapp_inbox_release = () => ({ data: null, error: { message: `timeout ${PHONE}` } });
    const { WhatsAppConsumerRetryableError } = await loadConsumer();
    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WhatsAppConsumerRetryableError);
    expect(error).toMatchObject({ code: "inbox_finalize_unavailable" });
    expect(finalizations().map((c) => c.name)).toEqual(["whatsapp_inbox_release"]);
    expect(effectCalls()).toEqual(only("identity"));
  });

  it.each(["complete", "dispose"])("nenhum resultado de efeito jamais chama whatsapp_inbox_%s", async (rpcName) => {
    for (const kind of KINDS) {
      for (const outcome of [...PROCESSED[kind], ...NO_OWNERSHIP, ...FAIL[kind], ...RELEASE[kind]]) {
        rpcLog = [];
        arrange(CASE_OF[kind]);
        EFFECT[kind].mockResolvedValue(effectResultFor(kind, outcome));
        await run();
        expect(rpcLog.map((c) => c.name)).not.toContain(`whatsapp_inbox_${rpcName}`);
        expect(finalizations().length).toBeLessThanOrEqual(1);
      }
    }
  });

  it("resultado que o efeito daquele tipo nunca devolve falha fechado: nova tentativa, sem finalizar", async () => {
    const { WhatsAppConsumerRetryableError } = await loadConsumer();
    for (const [kind, outcome] of [
      ["account", "channel_paused"],
      ["account", "message_conflict"],
      ["inbound", "recorded"],
      ["inbound", "message_not_found"],
      ["status", "identity_conflict"],
      ["identity", "cost_conflict"],
      ["outbound", "identity_not_found"],
      ["inbound", "banana"],
      ["inbound", ""],
    ] as const) {
      rpcLog = [];
      arrange(CASE_OF[kind]);
      EFFECT[kind].mockResolvedValue({ outcome });
      const error = await run().catch((e: unknown) => e);
      expect(error, `${kind}/${outcome}`).toBeInstanceOf(WhatsAppConsumerRetryableError);
      expect(finalizations()).toEqual([]);
    }
  });

  it.each([undefined, null, "applied", 42, {}, { outcome: 7 }, []])("resposta do efeito em formato inesperado (%j): nova tentativa, sem finalizar", async (value) => {
    arrange(EVENTS.inbound);
    h.inbound.mockResolvedValue(value);
    const { WhatsAppConsumerRetryableError } = await loadConsumer();
    await expect(run()).rejects.toBeInstanceOf(WhatsAppConsumerRetryableError);
    expect(finalizations()).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// 5. Erros lançados pelo efeito
// ---------------------------------------------------------------------

describe("5. erros do efeito", () => {
  it("invalid_inbound_message / invalid_outbound_message / invalid_status_update / invalid_identity_change / invalid_account_event: falha terminal da entrada, uma vez", async () => {
    const mods = {
      inbound: (await loadInboundModule()).WhatsAppInboundEffectError,
      outbound: (await loadOutboundModule()).WhatsAppOutboundObservedError,
      status: (await loadStatusModule()).WhatsAppMessageStatusError,
      identity: (await loadIdentityModule()).WhatsAppIdentityChangeError,
      account: (await loadAccountModule()).WhatsAppAccountEventError,
    };
    const code: Record<Kind, string> = {
      inbound: "invalid_inbound_message",
      outbound: "invalid_outbound_message",
      status: "invalid_status_update",
      identity: "invalid_identity_change",
      account: "invalid_account_event",
    };
    for (const kind of KINDS) {
      rpcLog = [];
      arrange(CASE_OF[kind]);
      EFFECT[kind].mockRejectedValue(new (mods[kind] as new (c: string) => Error)(code[kind]));
      await expect(run()).resolves.toEqual({ outcome: "failed", code: code[kind] });
      expect(finalizations().map((c) => [c.name, c.args.p_error_code])).toEqual([["whatsapp_inbox_fail", code[kind]]]);
    }
  });

  it("invalid_account_event inclui o horário do provedor acima da tolerância: fail terminal, sem release e sem nova tentativa", async () => {
    const { WhatsAppAccountEventError } = await loadAccountModule();
    arrange(EVENTS.accountPhone, { adapter: { events: [ev(EVENTS.accountPhone, { occurredAt: new Date("2099-01-01T00:00:00Z") })] } });
    h.account.mockRejectedValue(new WhatsAppAccountEventError("invalid_account_event"));
    await expect(run()).resolves.toEqual({ outcome: "failed", code: "invalid_account_event" });
    expect(finalizations().map((c) => c.name)).toEqual(["whatsapp_inbox_fail"]);
    expect(h.account).toHaveBeenCalledTimes(1);
  });

  it("identity_keys_not_configured: a entrada é liberada (release) para quando as chaves existirem", async () => {
    const mods = {
      inbound: (await loadInboundModule()).WhatsAppInboundEffectError,
      outbound: (await loadOutboundModule()).WhatsAppOutboundObservedError,
      status: (await loadStatusModule()).WhatsAppMessageStatusError,
      identity: (await loadIdentityModule()).WhatsAppIdentityChangeError,
    };
    for (const kind of ["inbound", "outbound", "status", "identity"] as const) {
      rpcLog = [];
      arrange(CASE_OF[kind]);
      EFFECT[kind].mockRejectedValue(new (mods[kind] as new (c: string) => Error)("identity_keys_not_configured"));
      await expect(run()).resolves.toEqual({ outcome: "released", code: "identity_keys_not_configured" });
      expect(finalizations().map((c) => [c.name, c.args.p_error_code])).toEqual([["whatsapp_inbox_release", "identity_keys_not_configured"]]);
    }
  });

  it("unknown, invalid_response, whatsapp_environment_required, inbox_claim_untrusted: infraestrutura — nova tentativa do Inngest, nenhuma finalização", async () => {
    const { WhatsAppConsumerRetryableError } = await loadConsumer();
    const mods = {
      inbound: (await loadInboundModule()).WhatsAppInboundEffectError,
      outbound: (await loadOutboundModule()).WhatsAppOutboundObservedError,
      status: (await loadStatusModule()).WhatsAppMessageStatusError,
      identity: (await loadIdentityModule()).WhatsAppIdentityChangeError,
      account: (await loadAccountModule()).WhatsAppAccountEventError,
    };
    for (const kind of KINDS) {
      for (const code of ["unknown", "invalid_response", "whatsapp_environment_required", "inbox_claim_untrusted"]) {
        rpcLog = [];
        arrange(CASE_OF[kind]);
        EFFECT[kind].mockRejectedValue(new (mods[kind] as new (c: string) => Error)(code));
        const error = await run().catch((e: unknown) => e);
        expect(error, `${kind}/${code}`).toBeInstanceOf(WhatsAppConsumerRetryableError);
        expect(error).toMatchObject({ code: "effect_unavailable", message: "effect_unavailable" });
        expect(finalizations(), `${kind}/${code}`).toEqual([]);
      }
    }
  });

  it("erro qualquer (rede, TypeError, texto com dados): nova tentativa só com o código fixo — nada do erro original", async () => {
    const { WhatsAppConsumerRetryableError } = await loadConsumer();
    for (const thrown of [
      new Error(`connection refused 10.0.0.1 ${PHONE} ${TEXT}`),
      new TypeError(`Cannot read ${BSUID}`),
      `texto solto com ${ROUTING}`,
      { message: `objeto com ${WABA_REF}` },
      null,
      undefined,
    ]) {
      rpcLog = [];
      arrange(EVENTS.accountWaba);
      h.account.mockRejectedValue(thrown);
      const error = await run().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WhatsAppConsumerRetryableError);
      const dump = `${(error as Error).message}|${(error as Error).stack}|${JSON.stringify(error)}|${String((error as { cause?: unknown }).cause)}`;
      for (const secret of ["10.0.0.1", PHONE, TEXT, BSUID, ROUTING, WABA_REF, "connection", "TypeError"]) expect(dump).not.toContain(secret);
      expect(finalizations()).toEqual([]);
    }
  });

  it("a falha de infraestrutura chega ao Inngest: o step.run propaga o erro (nova tentativa), sem resultado", async () => {
    arrange(EVENTS.status);
    h.status.mockRejectedValue(new Error("rede"));
    const { handleWhatsAppInboxReceived } = await loadHandler();
    const { WhatsAppConsumerRetryableError } = await loadConsumer();
    const step = { run: async (_id: string, fn: () => Promise<unknown>) => fn() };
    await expect(handleWhatsAppInboxReceived({ event: { name: "praxis/whatsapp.inbox.received", data: { inboxId: INBOX_ID } }, step })).rejects.toBeInstanceOf(
      WhatsAppConsumerRetryableError,
    );
    expect(finalizations()).toEqual([]);
  });

  it("nova execução depois da falha começa de novo pelo claim; se o efeito já tinha sido confirmado, vê a entrada processada", async () => {
    arrange(EVENTS.status);
    h.status.mockRejectedValueOnce(new Error("rede"));
    await run().catch(() => undefined);
    rpcLog = [];
    handlers.whatsapp_inbox_claim = () => ({ data: { outcome: "already_processed" }, error: null });
    await expect(run()).resolves.toEqual({ outcome: "already_processed", code: null });
    expect(rpcLog.map((c) => c.name)).toEqual(["whatsapp_inbox_claim"]);
    expect(h.status).toHaveBeenCalledTimes(1);
  });

  it("claim_lost do efeito não é repetido: resultado claim_lost, uma chamada ao efeito, nenhuma finalização", async () => {
    arrange(EVENTS.inbound);
    h.inbound.mockResolvedValue({ outcome: "claim_lost" });
    await expect(run()).resolves.toEqual({ outcome: "claim_lost", code: null });
    expect(h.inbound).toHaveBeenCalledTimes(1);
    expect(finalizations()).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// 6. O claim: o mesmo objeto, só em memória
// ---------------------------------------------------------------------

describe("6. o claim que o efeito recebe é o objeto original", () => {
  it.each(CASES)("$label: o efeito recebe exatamente o objeto devolvido pelo claim (mesma referência, congelado, autêntico)", async ({ kind, event }) => {
    arrange(event);
    await run();
    expect(h.claimed).toHaveLength(1);
    const passed = EFFECT[kind].mock.calls[0]![0];
    expect(passed).toBe(h.claimed[0]);
    expect(Object.isFrozen(passed)).toBe(true);
    // Autêntico: só o objeto emitido pela inbox finaliza com o token dele.
    const inbox = await import("@/server/whatsapp/inbox");
    rpcLog = [];
    await inbox.releaseWhatsAppInboxClaim(passed, "teste_de_posse");
    expect(rpcLog.map((c) => [c.name, c.args.p_claim_token])).toEqual([["whatsapp_inbox_release", TOKEN]]);
  });

  it("uma cópia ou o claim serializado não finalizam nada (inbox_claim_untrusted), e o consumidor nunca entrega cópia ao efeito", async () => {
    arrange(EVENTS.accountWaba);
    await run();
    const original = h.account.mock.calls[0]![0] as object;
    const inbox = await import("@/server/whatsapp/inbox");
    rpcLog = [];
    for (const forged of [{ ...original }, JSON.parse(JSON.stringify(original)) as object, Object.assign({}, original), structuredClone({ inboxId: INBOX_ID })]) {
      await expect(inbox.releaseWhatsAppInboxClaim(forged as never, "teste")).rejects.toMatchObject({ code: "inbox_claim_untrusted" });
    }
    expect(rpcLog).toEqual([]);
  });

  it("o resultado do step é só { outcome, code }: serializável, sem claim, token, ids, contexto ou conteúdo", async () => {
    for (const kind of KINDS) {
      arrange(CASE_OF[kind]);
      EFFECT[kind].mockResolvedValue(effectResultFor(kind, "applied"));
      const result = await run();
      expect(Object.keys(result).sort()).toEqual(["code", "outcome"]);
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
      const dump = JSON.stringify(result);
      for (const secret of [MESSAGE_ID, CONVERSATION_ID, IDENTITY_ID, TOKEN, INBOX_ID, WS, CHANNEL, PHONE, BSUID, TEXT, ROUTING, WABA_REF, INBOX_KEY]) {
        expect(dump).not.toContain(secret);
      }
    }
  });

  it("todo o ciclo — claim, efeito e finalização — acontece dentro de UM step.run, que devolve só { outcome, code }", async () => {
    arrange(EVENTS.identity);
    h.identity.mockResolvedValue({ outcome: "identity_not_found" });
    const { handleWhatsAppInboxReceived } = await loadHandler();
    let steps = 0;
    const step = {
      run: async (_id: string, fn: () => Promise<unknown>) => {
        steps += 1;
        insideStep = true;
        try {
          return await fn();
        } finally {
          insideStep = false;
        }
      },
    };
    const result = await handleWhatsAppInboxReceived({ event: { name: "praxis/whatsapp.inbox.received", data: { inboxId: INBOX_ID } }, step });
    expect(steps).toBe(1);
    expect(result).toEqual({ outcome: "released", code: "identity_not_found" });
    expect(rpcLog.map((c) => [c.name, c.insideStep])).toEqual([
      ["whatsapp_inbox_claim", true],
      ["whatsapp_inbox_release", true],
    ]);
    expect(h.identity).toHaveBeenCalledTimes(1);
  });

  it("evento do Inngest com workspace, canal, ambiente, provedor ou routing key é recusado: nem claim nem efeito", async () => {
    const { handleWhatsAppInboxReceived } = await loadHandler();
    const step = { run: vi.fn() };
    for (const data of [
      { inboxId: INBOX_ID, workspaceId: WS },
      { inboxId: INBOX_ID, channelId: CHANNEL },
      { inboxId: INBOX_ID, environment: "production" },
      { inboxId: INBOX_ID, provider: "ycloud" },
      { inboxId: INBOX_ID, routingKey: ROUTING },
    ]) {
      await expect(handleWhatsAppInboxReceived({ event: { name: "praxis/whatsapp.inbox.received", data }, step })).resolves.toEqual({ outcome: "invalid_event", code: null });
    }
    expect(step.run).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
    expect(effectCalls()).toEqual(noEffects);
  });
});

// ---------------------------------------------------------------------
// 7. Roteamento e correspondência antes do efeito
// ---------------------------------------------------------------------

describe("7. roteamento e correspondência antes do efeito", () => {
  it.each(CASES.filter((c) => c.kind !== "account" || c.label === "account (número)"))("$label com a routing key de outro canal: fail routing_mismatch, sem efeito", async ({ event }) => {
    arrange(event, { adapter: { events: [ev(event, { routingKey: "sim-outro-canal" })] } });
    await expect(run()).resolves.toEqual({ outcome: "failed", code: "routing_mismatch" });
    expect(effectCalls()).toEqual(noEffects);
    expect(finalizations().map((c) => [c.name, c.args.p_error_code])).toEqual([["whatsapp_inbox_fail", "routing_mismatch"]]);
  });

  it("a routing key do evento nunca localiza outro canal: nenhuma consulta além do claim e da finalização", async () => {
    arrange(EVENTS.inbound, { adapter: { events: [ev(EVENTS.inbound, { routingKey: "sim-outro-canal" })] } });
    await run();
    expect(rpcLog.map((c) => c.name)).toEqual(["whatsapp_inbox_claim", "whatsapp_inbox_fail"]);
    expect(h.from).not.toHaveBeenCalled();
  });

  it("evento da conta (WABA) sem routing key chega ao efeito; do número sem routing key é event_impossible", async () => {
    arrange(EVENTS.accountWaba);
    await expect(run()).resolves.toEqual({ outcome: "processed", code: "duplicate" });
    expect(h.account).toHaveBeenCalledTimes(1);
    h.account.mockClear();
    rpcLog = [];
    arrange(EVENTS.accountPhone, { adapter: { events: [ev(EVENTS.accountPhone, { routingKey: null })] } });
    await expect(run()).resolves.toEqual({ outcome: "failed", code: "event_impossible" });
    expect(h.account).not.toHaveBeenCalled();
  });

  it.each(["message.inbound", "message.outbound_observed", "message.status", "contact.identity_changed"])(
    "%s sem routing key: event_impossible, sem efeito",
    async (kind) => {
      const event = [EVENTS.inbound, EVENTS.outbound, EVENTS.status, EVENTS.identity].find((e) => e.kind === kind)!;
      arrange(event, { adapter: { events: [ev(event, { routingKey: null })] } });
      await expect(run()).resolves.toEqual({ outcome: "failed", code: "event_impossible" });
      expect(effectCalls()).toEqual(noEffects);
    },
  );

  it.each([
    ["eco", EVENTS.outbound],
    ["conta", EVENTS.accountWaba],
    ["número", EVENTS.accountPhone],
  ])("%s com providerType diferente do tipo gravado na linha: fail event_mismatch, sem efeito", async (_n, event) => {
    arrange(event, { claim: { provider_event_type: "whatsapp.outro.tipo" }, adapter: { envelopeType: "whatsapp.outro.tipo" } });
    await expect(run()).resolves.toEqual({ outcome: "failed", code: "event_mismatch" });
    expect(effectCalls()).toEqual(noEffects);
  });

  it.each(CASES)("$label com providerEventId diferente do claim: fail event_mismatch, sem efeito", async ({ event }) => {
    arrange(event, { adapter: { events: [ev(event, { providerEventId: "evt-de-outra-entrada" })] } });
    await expect(run()).resolves.toEqual({ outcome: "failed", code: "event_mismatch" });
    expect(effectCalls()).toEqual(noEffects);
  });

  it("falha de conteúdo prevalece sobre o estado do canal: routing divergente com canal pausado é falha terminal", async () => {
    arrange(EVENTS.inbound, { channelStatus: "paused", adapter: { events: [ev(EVENTS.inbound, { routingKey: "sim-outro" })] } });
    await expect(run()).resolves.toEqual({ outcome: "failed", code: "routing_mismatch" });
  });

  it("tipo normalizado impossível falha fechado (event_impossible), sem efeito e sem liberar", async () => {
    for (const event of [
      ev({ ...EVENTS.inbound, kind: "contact.deleted" }),
      ev({ ...EVENTS.inbound, kind: undefined }),
      ev({ ...EVENTS.inbound, kind: 42 }),
      ev({ ...EVENTS.accountWaba, scope: "outro_escopo" }),
      ev({ ...EVENTS.accountWaba, scope: undefined }),
    ]) {
      rpcLog = [];
      arrange(EVENTS.inbound, { adapter: { events: [event] } });
      await expect(run()).resolves.toEqual({ outcome: "failed", code: "event_impossible" });
      expect(effectCalls()).toEqual(noEffects);
      expect(finalizations().map((c) => [c.name, c.args.p_error_code])).toEqual([["whatsapp_inbox_fail", "event_impossible"]]);
    }
  });

  it("mais de um evento normalizado: event_count_invalid, nenhum efeito (nunca dois)", async () => {
    arrange(EVENTS.inbound, { adapter: { events: [ev(EVENTS.inbound), ev(EVENTS.status)] } });
    await expect(run()).resolves.toEqual({ outcome: "failed", code: "event_count_invalid" });
    expect(effectCalls()).toEqual(noEffects);
  });
});

// ---------------------------------------------------------------------
// 8. Nada acontece antes do claim, da decifração e do hash
// ---------------------------------------------------------------------

describe("8. a normalização e os efeitos só depois do claim, da decifração e do hash", () => {
  it("hash gravado divergente: falha terminal, o adaptador nem é resolvido e nenhum efeito roda", async () => {
    arrange(EVENTS.inbound, { claim: { body_sha256: "b".repeat(64) } });
    await expect(run()).resolves.toEqual({ outcome: "failed", code: "inbox_integrity_failed" });
    expect(h.resolve).not.toHaveBeenCalled();
    expect(effectCalls()).toEqual(noEffects);
  });

  it("claim sem posse (busy, already_processed, terminal_failed, expired, not_found): nem adaptador nem efeito", async () => {
    for (const outcome of ["busy", "already_processed", "terminal_failed", "expired", "not_found"]) {
      handlers.whatsapp_inbox_claim = () => ({ data: { outcome }, error: null });
      await expect(run()).resolves.toEqual({ outcome, code: null });
    }
    expect(h.resolve).not.toHaveBeenCalled();
    expect(effectCalls()).toEqual(noEffects);
  });

  it("provedor indisponível ou inválido: nenhuma normalização e nenhum efeito", async () => {
    arrange(EVENTS.inbound);
    h.resolve.mockReturnValue({ status: "disabled", reason: "provider_not_enabled" });
    await expect(run()).resolves.toEqual({ outcome: "released", code: "provider_unavailable" });
    h.resolve.mockReturnValue({ status: "disabled", reason: "provider_mismatch" });
    await expect(run()).resolves.toEqual({ outcome: "failed", code: "provider_invalid" });
    expect(effectCalls()).toEqual(noEffects);
  });

  it("normalização que falha por dentro: release consumer_transient_error, sem efeito (o efeito não é coberto por esse atalho)", async () => {
    const adapter = fakeAdapter({ events: [ev(EVENTS.inbound)] });
    h.resolve.mockReturnValue({
      status: "enabled",
      provider: { ...adapter, normalizeEvents: () => { throw new Error(`falha ${PHONE}`); } } satisfies WhatsAppProvider,
    });
    handlers.whatsapp_inbox_claim = () => ({ data: claimRow(), error: null });
    await expect(run()).resolves.toEqual({ outcome: "released", code: "consumer_transient_error" });
    expect(effectCalls()).toEqual(noEffects);
  });

  it("um erro do efeito NUNCA vira release consumer_transient_error (isso reaplicaria um efeito possivelmente confirmado)", async () => {
    arrange(EVENTS.inbound);
    h.inbound.mockRejectedValue(new Error("qualquer coisa"));
    await run().catch(() => undefined);
    expect(finalizations()).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// 9. Sem log e sem dado sensível
// ---------------------------------------------------------------------

describe("9. sem log, sem dado sensível", () => {
  it("nenhum console é chamado em nenhum caminho; resultados e argumentos de finalização só com códigos", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    for (const kind of KINDS) {
      for (const outcome of [...PROCESSED[kind], ...FAIL[kind], ...RELEASE[kind], ...NO_OWNERSHIP]) {
        rpcLog = [];
        arrange(CASE_OF[kind]);
        EFFECT[kind].mockResolvedValue(effectResultFor(kind, outcome));
        const result = await run();
        const dump = JSON.stringify({ result, calls: finalizations() });
        for (const secret of [MESSAGE_ID, CONVERSATION_ID, IDENTITY_ID, PHONE, PHONE_2, BSUID, TEXT, ROUTING, WABA_REF, WS, CHANNEL, INBOX_KEY]) {
          expect(dump, `${kind}/${outcome}`).not.toContain(secret);
        }
        for (const call of finalizations()) {
          expect(Object.keys(call.args).sort()).toEqual(["p_claim_token", "p_error_code", "p_inbox_id"]);
        }
      }
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(h.from).not.toHaveBeenCalled();
  });

  it("o consumidor só chama RPCs da inbox; as do domínio são chamadas pelos efeitos", async () => {
    arrange(EVENTS.status);
    await run();
    for (const call of rpcLog) expect(call.name).toMatch(/^whatsapp_inbox_/);
  });
});

// ---------------------------------------------------------------------
// 10. Listas de códigos do consumidor
// ---------------------------------------------------------------------

describe("10. códigos do consumidor", () => {
  it("terminais e recuperáveis são disjuntos, bem formados, e cobrem o que o consumidor usa", async () => {
    const { WHATSAPP_CONSUMER_TERMINAL_CODES, WHATSAPP_CONSUMER_RECOVERABLE_CODES } = await loadConsumer();
    const terminal = new Set<string>(WHATSAPP_CONSUMER_TERMINAL_CODES);
    const recoverable = new Set<string>(WHATSAPP_CONSUMER_RECOVERABLE_CODES);
    expect([...terminal].filter((c) => recoverable.has(c))).toEqual([]);
    for (const code of [
      "identity_conflict",
      "message_conflict",
      "cost_conflict",
      "effect_conflict",
      "routing_mismatch",
      "account_reference_mismatch",
      "invalid_inbound_message",
      "invalid_outbound_message",
      "invalid_status_update",
      "invalid_identity_change",
      "invalid_account_event",
    ]) {
      expect(terminal.has(code), code).toBe(true);
    }
    for (const code of [
      "channel_paused",
      "channel_disconnected",
      "channel_disabled",
      "identity_not_found",
      "message_not_found",
      "account_reference_unverified",
      "identity_keys_not_configured",
      "provider_unavailable",
    ]) {
      expect(recoverable.has(code), code).toBe(true);
    }
    // O marcador provisório da B3.2d-2a deixou de existir: nenhum efeito é "não implementado".
    expect(terminal.has("domain_effect_not_implemented")).toBe(false);
    expect(recoverable.has("domain_effect_not_implemented")).toBe(false);
    for (const code of [...terminal, ...recoverable]) expect(code).toMatch(/^[a-z0-9_]{1,64}$/);
  });
});

