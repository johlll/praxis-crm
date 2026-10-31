/**
 * @vitest-environment node
 *
 * B3.2d-2b2b3b — eventos operacionais da CONTA e do NÚMERO
 * (NormalizedAccountEvent), no servidor.
 *
 *  - só o claim emitido pelo servidor aplica o efeito; o banco recebe o id
 *    da inbox, o token do claim e só os dados do evento da conta — nunca
 *    workspace, canal, ambiente, provedor, id do evento, telefone do
 *    escritório, usuário ou origem;
 *  - o telefone do escritório (businessPhoneE164) é só validado aqui: não
 *    vai ao banco;
 *  - o módulo conhece apenas o contrato neutro do provedor (nunca o adaptador
 *    YCloud) e não deduz a conta dividindo a routing key;
 *  - entrada inválida não chega ao banco; o resultado é um contrato fechado
 *    conferido campo a campo; erros saem só como código;
 *  - nada envia mensagem nem chama o provedor; o consumidor da B3.2d-2a
 *    ainda NÃO chama este efeito (B3.2d-2b3).
 *
 * Escritos ANTES da implementação, contra a main ff13405. O banco é
 * simulado. Tudo fictício.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  body,
  bytes,
  businessAccountDeleted,
  businessAccountUpdated,
  FICT,
  NOW_MS,
  phoneNumberQuality,
  signedHeaders,
} from "../support/ycloud-fixtures";

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/server/whatsapp/admin/supabase", () => ({
  createWhatsAppAdminSupabaseClient: () => ({ rpc: rpcMock }),
}));

const loadInbox = () => import("@/server/whatsapp/inbox");
const loadEffect = () => import("@/server/whatsapp/effects/account-event");
const { encryptWhatsAppInboxBody } = await import("@/server/whatsapp/inbox-crypto");

const WS = "10000000-0000-0000-0000-000000000001";
const CHANNEL = "35000000-0000-0000-0000-000000000006";
const INBOX_ID = "45000000-0000-4000-8000-000000000006";
const TOKEN = "6f1d2c3b-4a59-4e8f-9a1b-2c3d4e5f6a80";
const EVENT_ID = "evt-conta-1";
const WABA = "WABA-A1";
const BUSINESS_PHONE = "+5511988887777";
const ROUTING = `${WABA}:${BUSINESS_PHONE}`;
const INBOX_KEY = Buffer.alloc(32, 9).toString("base64");

function configure() {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "chave-de-teste-b3-whatsapp-0123456789");
  vi.stubEnv("WHATSAPP_INBOX_KEY_VERSIONS", JSON.stringify({ "1": INBOX_KEY }));
  vi.stubEnv("WHATSAPP_INBOX_ACTIVE_KEY_VERSION", "1");
}

type RpcHandler = (args: Record<string, unknown>) => { data: unknown; error: unknown };
let handlers: Record<string, RpcHandler> = {};

beforeEach(() => {
  configure();
  handlers = { whatsapp_effect_account_event: () => ({ data: { outcome: "recorded" }, error: null }) };
  rpcMock.mockReset();
  rpcMock.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    const handler = handlers[name];
    if (!handler) return { data: null, error: { message: `rpc_nao_esperada:${name}` } };
    return handler(args);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const RAW = new TextEncoder().encode(`{"version":1,"events":[{"type":"whatsapp.phone_number.quality_updated","id":"${EVENT_ID}"}]}`);

function claimRow(over: { eventId?: string; eventType?: string; provider?: string } = {}) {
  const eventId = over.eventId ?? EVENT_ID;
  const provider = over.provider ?? "ycloud";
  const enc = encryptWhatsAppInboxBody(RAW, {
    environment: "preview",
    workspaceId: WS,
    channelId: CHANNEL,
    provider,
    providerEventId: eventId,
  } as never);
  return {
    outcome: "claimed",
    inbox_id: INBOX_ID,
    claim_token: TOKEN,
    claim_count: 1,
    claimed_at: "2026-10-30T12:00:00.000000+00:00",
    lease_until: "2026-10-30T12:05:00.000000+00:00",
    environment: "preview",
    workspace_id: WS,
    channel_id: CHANNEL,
    channel_status: "active",
    provider,
    routing_key: ROUTING,
    provider_event_id: eventId,
    provider_event_type: over.eventType ?? "whatsapp.phone_number.quality_updated",
    body_sha256: createHash("sha256").update(RAW).digest("hex"),
    received_at: "2026-10-30T11:59:59.000000+00:00",
    retain_until: "2026-10-30T12:59:59.000000+00:00",
    key_version: enc.keyVersion,
    nonce: enc.nonce,
    ciphertext: enc.ciphertext,
    auth_tag: enc.authTag,
  };
}

async function claimed(over: Parameters<typeof claimRow>[0] = {}) {
  const inbox = await loadInbox();
  handlers.whatsapp_inbox_claim = () => ({ data: claimRow(over), error: null });
  const result = await inbox.claimWhatsAppInboxEntry({ inboxId: INBOX_ID });
  if (result.outcome !== "claimed") throw new Error(`claim não obtido no teste: ${result.outcome}`);
  return result.claim;
}

function phoneEvent(overrides: Record<string, unknown> = {}) {
  return {
    kind: "account",
    scope: "phone_number",
    providerType: "whatsapp.phone_number.quality_updated",
    providerEventId: EVENT_ID,
    providerAccountRef: WABA,
    businessPhoneE164: BUSINESS_PHONE,
    routingKey: ROUTING,
    occurredAt: new Date("2026-10-30T11:59:58.000Z"),
    code: "YELLOW",
    ...overrides,
  };
}

function accountEvent(overrides: Record<string, unknown> = {}) {
  return {
    kind: "account",
    scope: "business_account",
    providerType: "whatsapp.business_account.deleted",
    providerEventId: EVENT_ID,
    providerAccountRef: WABA,
    businessPhoneE164: null,
    routingKey: null,
    occurredAt: new Date("2026-10-30T11:59:58.000Z"),
    code: "ACCOUNT_DISCONNECTED",
    ...overrides,
  };
}

const effectCalls = () => rpcMock.mock.calls.filter(([n]) => n === "whatsapp_effect_account_event") as [string, Record<string, unknown>][];
const lastArgs = () => effectCalls().at(-1)![1];

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as { code?: string }).code).toBe(code);
  return error as Error;
}

// ---------------------------------------------------------------------
// 1. O que vai ao banco
// ---------------------------------------------------------------------

describe("1. o banco recebe a inbox, o token e só os dados do evento da conta", () => {
  it("evento do número: argumentos exatos; nenhum contexto, telefone do escritório, usuário ou origem do chamador", async () => {
    const claim = await claimed();
    const { applyWhatsAppAccountEvent } = await loadEffect();
    await applyWhatsAppAccountEvent(claim, phoneEvent() as never);
    const args = lastArgs();
    expect(Object.keys(args).sort()).toEqual(
      ["p_claim_token", "p_code", "p_inbox_id", "p_occurred_at", "p_provider_account_ref", "p_provider_type", "p_routing_key", "p_scope"].sort(),
    );
    expect(args).toEqual({
      p_inbox_id: INBOX_ID,
      p_claim_token: TOKEN,
      p_scope: "phone_number",
      p_provider_type: "whatsapp.phone_number.quality_updated",
      p_provider_account_ref: WABA,
      p_routing_key: ROUTING,
      p_occurred_at: "2026-10-30T11:59:58.000Z",
      p_code: "YELLOW",
    });
    const json = JSON.stringify(args);
    for (const forbidden of [WS, CHANNEL, EVENT_ID, "preview", "ycloud", "simulated", "contact", "lead", "whatsapp_webhook"]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it("o telefone do escritório (businessPhoneE164) é só validado: nunca vai ao banco; a routing key vai inteira, sem ser dividida", async () => {
    const claim = await claimed();
    const { applyWhatsAppAccountEvent } = await loadEffect();
    await applyWhatsAppAccountEvent(claim, phoneEvent() as never);
    const args = lastArgs();
    expect(Object.keys(args)).not.toContain("p_business_phone_e164");
    expect(Object.values(args)).not.toContain(BUSINESS_PHONE);
    expect(args.p_routing_key).toBe(ROUTING);
    expect(args.p_provider_account_ref).toBe(WABA);
  });

  it("evento da conta: sem routing key (nula); a referência da conta vai como veio", async () => {
    const claim = await claimed({ eventType: "whatsapp.business_account.deleted" });
    const { applyWhatsAppAccountEvent } = await loadEffect();
    await applyWhatsAppAccountEvent(claim, accountEvent() as never);
    expect(lastArgs()).toEqual({
      p_inbox_id: INBOX_ID,
      p_claim_token: TOKEN,
      p_scope: "business_account",
      p_provider_type: "whatsapp.business_account.deleted",
      p_provider_account_ref: WABA,
      p_routing_key: null,
      p_occurred_at: "2026-10-30T11:59:58.000Z",
      p_code: "ACCOUNT_DISCONNECTED",
    });
  });

  it("código ausente vai nulo", async () => {
    const claim = await claimed();
    const { applyWhatsAppAccountEvent } = await loadEffect();
    await applyWhatsAppAccountEvent(claim, phoneEvent({ code: null }) as never);
    expect(lastArgs().p_code).toBeNull();
  });
});

// ---------------------------------------------------------------------
// 2. Compatível com o que o adaptador YCloud entrega (só neste teste)
// ---------------------------------------------------------------------

describe("2. eventos reais normalizados pelo adaptador YCloud passam pelo contrato neutro", () => {
  async function normalized(fixture: { id: string; type: string }) {
    const { YCloudWhatsAppProvider } = await import("@/server/whatsapp/provider/ycloud");
    const provider = new YCloudWhatsAppProvider();
    const raw = bytes(body(fixture));
    const verified = provider.verifyWebhook({ rawBody: raw, headers: signedHeaders(raw), secret: FICT.secret, nowMs: NOW_MS });
    if (!verified.ok) throw new Error(`assinatura recusada no teste: ${verified.reason}`);
    const result = provider.normalizeEvents(verified.verified);
    if (!result.ok) throw new Error(result.reason);
    expect(result.events).toHaveLength(1);
    return result.events[0];
  }

  for (const [label, fixture] of [
    ["business_account.deleted", businessAccountDeleted],
    ["business_account.updated", businessAccountUpdated],
    ["phone_number.quality_updated", phoneNumberQuality],
  ] as const) {
    it(`${label}: aceito, com a conta e a routing key como o adaptador as entrega`, async () => {
      const event = await normalized(fixture);
      expect(event.kind).toBe("account");
      const claim = await claimed({ eventId: fixture.id, eventType: fixture.type });
      const { applyWhatsAppAccountEvent } = await loadEffect();
      await expect(applyWhatsAppAccountEvent(claim, event as never)).resolves.toEqual({ outcome: "recorded" });
      const args = lastArgs();
      expect(args.p_provider_account_ref).toBe(FICT.wabaId);
      expect(args.p_provider_type).toBe(fixture.type);
      // O telefone do escritório só aparece dentro da routing key, que vai inteira.
      const others = Object.entries(args).filter(([k]) => k !== "p_routing_key");
      expect(JSON.stringify(others)).not.toContain(FICT.businessPhone.slice(1));
      if (event.kind === "account" && event.scope === "phone_number") {
        expect(args.p_routing_key).toBe(`${FICT.wabaId}:${FICT.businessPhone}`);
      } else {
        expect(args.p_routing_key).toBeNull();
      }
    });
  }
});

// ---------------------------------------------------------------------
// 3. Validação fechada: nada chega ao banco
// ---------------------------------------------------------------------

describe("3. entrada inválida", () => {
  const invalid: [string, Record<string, unknown>][] = [
    ["tipo de evento diferente de account", { kind: "message.status" }],
    ["escopo desconhecido", { scope: "account" }],
    ["escopo ausente", { scope: undefined }],
    ["tipo do provedor em maiúsculas", { providerType: "WhatsApp.Phone_Number.Quality_Updated" }],
    ["tipo do provedor com espaço", { providerType: "whatsapp.phone_number.quality updated" }],
    ["tipo do provedor com mais de 128 caracteres", { providerType: `whatsapp.phone_number.${"a".repeat(107)}` }],
    ["tipo do provedor com caractere de controle", { providerType: "whatsapp.phone_number.quality\tupdated" }],
    ["tipo diferente do gravado na inbox", { providerType: "whatsapp.phone_number.name_updated" }],
    ["tipo de outro escopo", { providerType: "whatsapp.business_account.deleted" }],
    ["id do evento diferente do da inbox", { providerEventId: "evt-de-outra-entrada" }],
    ["id do evento fora do formato", { providerEventId: "evento com espaço" }],
    ["conta ausente", { providerAccountRef: null }],
    ["conta vazia", { providerAccountRef: "" }],
    ["conta com espaço", { providerAccountRef: "WABA A1" }],
    ["conta começando por hífen", { providerAccountRef: "-WABA" }],
    ["conta com mais de 64 caracteres", { providerAccountRef: "a".repeat(65) }],
    ["conta com quebra de linha", { providerAccountRef: "WABA\nA1" }],
    ["número do escritório ausente no escopo do número", { businessPhoneE164: null }],
    ["número do escritório fora do E.164", { businessPhoneE164: "11988887777" }],
    ["routing key ausente no escopo do número", { routingKey: null }],
    ["routing key vazia", { routingKey: "" }],
    ["routing key com mais de 128 caracteres", { routingKey: "r".repeat(129) }],
    ["routing key com caractere de controle", { routingKey: `${WABA}:+5511\t988887777` }],
    ["data inválida", { occurredAt: new Date("ontem") }],
    ["data como texto", { occurredAt: "2026-10-30T11:59:58.000Z" }],
    ["código vazio", { code: "" }],
    ["código com mais de 64 caracteres", { code: "c".repeat(65) }],
    ["código com caractere de controle", { code: "GREEN\nRED" }],
    ["código que não é texto", { code: 5 }],
    ["campo extra (texto da mensagem)", { text: "Mensagem fictícia" }],
    ["campo extra (payload)", { payload: { a: 1 } }],
    ["campo extra (usuário do chamador)", { userId: "20000000-0000-0000-0000-000000000001" }],
  ];
  for (const [label, overrides] of invalid) {
    it(`${label}: invalid_account_event, nada pedido ao banco`, async () => {
      const claim = await claimed();
      const { applyWhatsAppAccountEvent } = await loadEffect();
      await expectCode(applyWhatsAppAccountEvent(claim, phoneEvent(overrides) as never), "invalid_account_event");
      expect(effectCalls()).toHaveLength(0);
    });
  }

  const invalidAccount: [string, Record<string, unknown>][] = [
    ["número do escritório informado no escopo da conta", { businessPhoneE164: BUSINESS_PHONE }],
    ["routing key informada no escopo da conta", { routingKey: ROUTING }],
    ["tipo de outro escopo", { providerType: "whatsapp.phone_number.deleted" }],
  ];
  for (const [label, overrides] of invalidAccount) {
    it(`escopo da conta, ${label}: invalid_account_event, nada pedido ao banco`, async () => {
      const claim = await claimed({ eventType: "whatsapp.business_account.deleted" });
      const { applyWhatsAppAccountEvent } = await loadEffect();
      await expectCode(applyWhatsAppAccountEvent(claim, accountEvent(overrides) as never), "invalid_account_event");
      expect(effectCalls()).toHaveLength(0);
    });
  }

  it("divergência de roteamento ou de conta NÃO é recusada aqui: quem decide é o banco (routing_mismatch / account_reference_*)", async () => {
    const claim = await claimed();
    const { applyWhatsAppAccountEvent } = await loadEffect();
    await applyWhatsAppAccountEvent(claim, phoneEvent({ routingKey: "OUTRA-CONTA:+5511900000000", providerAccountRef: "WABA-X9" }) as never);
    expect(effectCalls()).toHaveLength(1);
  });

  it("claim montado à mão ou copiado: recusado, nada pedido ao banco", async () => {
    const claim = await claimed();
    const { applyWhatsAppAccountEvent } = await loadEffect();
    await expectCode(applyWhatsAppAccountEvent({ ...claim } as never, phoneEvent() as never), "inbox_claim_untrusted");
    expect(effectCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// 4. Resultado: contrato fechado, conferido campo a campo
// ---------------------------------------------------------------------

describe("4. resultado", () => {
  const OUTCOMES = [
    "applied",
    "recorded",
    "stale_event",
    "duplicate",
    "routing_mismatch",
    "account_reference_mismatch",
    "account_reference_unverified",
    "effect_conflict",
    "already_processed",
    "terminal_failed",
    "claim_lost",
    "not_found",
  ];

  it("a lista de resultados exportada é exatamente o contrato fechado", async () => {
    const mod = await loadEffect();
    expect([...mod.WHATSAPP_ACCOUNT_EVENT_OUTCOMES].sort()).toEqual([...OUTCOMES].sort());
  });

  for (const outcome of OUTCOMES) {
    it(`${outcome}: repassado como veio`, async () => {
      handlers.whatsapp_effect_account_event = () => ({ data: { outcome }, error: null });
      const claim = await claimed();
      const { applyWhatsAppAccountEvent } = await loadEffect();
      await expect(applyWhatsAppAccountEvent(claim, phoneEvent() as never)).resolves.toEqual({ outcome });
    });
  }

  const bad: [string, unknown][] = [
    ["campo a mais (telefone)", { outcome: "applied", phone: BUSINESS_PHONE }],
    ["campo a mais (routing key)", { outcome: "applied", routing_key: ROUTING }],
    ["campo a mais (conta)", { outcome: "recorded", provider_account_ref: WABA }],
    ["campo a mais (código)", { outcome: "recorded", code: "RED" }],
    ["campo a mais (status do canal)", { outcome: "applied", channel_status: "disconnected" }],
    ["channel_paused (este efeito não é bloqueado pelo estado do canal)", { outcome: "channel_paused" }],
    ["channel_disabled", { outcome: "channel_disabled" }],
    ["identity_conflict (não é resultado deste efeito)", { outcome: "identity_conflict" }],
    ["resultado desconhecido", { outcome: "talvez" }],
    ["sem outcome", {}],
    ["nulo", null],
  ];
  for (const [label, data] of bad) {
    it(`resposta inesperada (${label}): invalid_response`, async () => {
      handlers.whatsapp_effect_account_event = () => ({ data, error: null });
      const claim = await claimed();
      const { applyWhatsAppAccountEvent } = await loadEffect();
      await expectCode(applyWhatsAppAccountEvent(claim, phoneEvent() as never), "invalid_response");
    });
  }
});

// ---------------------------------------------------------------------
// 5. Erros sanitizados
// ---------------------------------------------------------------------

describe("5. erros", () => {
  for (const code of ["invalid_account_event", "whatsapp_environment_required"]) {
    it(`${code} do banco: o mesmo código`, async () => {
      handlers.whatsapp_effect_account_event = () => ({ data: null, error: { message: code } });
      const claim = await claimed();
      const { applyWhatsAppAccountEvent } = await loadEffect();
      await expectCode(applyWhatsAppAccountEvent(claim, phoneEvent() as never), code);
    });
  }

  it("erro cru do banco (com conta, routing key, telefone e código): unknown, sem nenhum valor", async () => {
    const raw = `duplicate key (provider_account_ref)=(${WABA}) routing=${ROUTING} phone=${BUSINESS_PHONE} code=YELLOW token=${TOKEN}`;
    handlers.whatsapp_effect_account_event = () => ({ data: null, error: { message: raw } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const claim = await claimed();
    const { applyWhatsAppAccountEvent } = await loadEffect();
    const error = await expectCode(applyWhatsAppAccountEvent(claim, phoneEvent() as never), "unknown");
    const seen = [error.message, String(error.stack), JSON.stringify(error), ...[errorSpy, warnSpy, logSpy].flatMap((s) => s.mock.calls.flat().map(String))].join("\n");
    for (const leaked of [WABA, ROUTING, BUSINESS_PHONE, "YELLOW", TOKEN]) expect(seen).not.toContain(leaked);
  });

  it("erro de transporte: unknown, sem valor", async () => {
    handlers.whatsapp_effect_account_event = () => {
      throw new Error(`falha de rede ${ROUTING}`);
    };
    const claim = await claimed();
    const { applyWhatsAppAccountEvent } = await loadEffect();
    const error = await expectCode(applyWhatsAppAccountEvent(claim, phoneEvent() as never), "unknown");
    expect(error.message).not.toContain(ROUTING);
  });

  it("entrada inválida: o erro leva só o código, nunca o valor recusado", async () => {
    const claim = await claimed();
    const { applyWhatsAppAccountEvent } = await loadEffect();
    const error = await expectCode(applyWhatsAppAccountEvent(claim, phoneEvent({ code: `GREEN\n${WABA}` }) as never), "invalid_account_event");
    expect(error.message).toBe("invalid_account_event");
    expect(String(error.stack)).not.toContain(WABA);
  });
});

// ---------------------------------------------------------------------
// 6. Estático
// ---------------------------------------------------------------------

describe("6. estático", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("o efeito conhece só o contrato neutro: não importa o adaptador YCloud, não envia, não registra log, não divide a routing key", () => {
    const src = read("src/server/whatsapp/effects/account-event.ts");
    expect(src).not.toMatch(/provider\/ycloud|provider\/simulated|ycloud/i);
    expect(src).not.toMatch(/sendText|sendTemplate|fetch\(|send_message/);
    expect(src).not.toMatch(/console\./);
    expect(src).not.toMatch(/\.split\(|split_part|indexOf\(":"\)|routingKey\.slice|routingKey\.substring/);
    expect(src).not.toMatch(/createCipheriv|createHmac|identity-crypto|inbox-crypto|calendar|google/i);
    expect(src).toMatch(/provider\/contract/);
  });

  it("a migration só mexe no canal: guarda, colunas e tabela operacional; não toca dado comercial nem edita função anterior além da guarda", () => {
    const sql = read("supabase/migrations/20261030180000_b3_2d2b2b3b_account_events_effect.sql")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(/insert into public\.(contacts|contact_phones|contact_identifiers|leads|opportunities|activities|whatsapp_identities|conversations|messages)\b/);
    expect(sql).not.toMatch(/(update|delete from) public\.(contacts|contact_phones|contact_identifiers|leads|opportunities|activities|whatsapp_identities|conversations|messages)\b/);
    expect(sql).not.toMatch(/alter table public\.(?!whatsapp_channels\b|whatsapp_channel_events\b)/);
    const replaced = [...sql.matchAll(/create or replace function ([a-z_.]+)/g)].map((m) => m[1]);
    expect(replaced).toEqual(["private.whatsapp_channels_guard"]);
    expect(sql).not.toMatch(/drop (table|function|policy|column)/i);
  });

  it("o consumidor da B3.2d-2a, a rota do webhook e o chatbot ainda não chamam o efeito (B3.2d-2b3)", () => {
    for (const p of [
      "src/server/whatsapp/consumer.ts",
      "src/server/whatsapp/inngest-consumer.ts",
      "src/server/whatsapp/inngest.ts",
      "src/server/whatsapp/webhook-route.ts",
      "src/server/whatsapp/webhook.ts",
    ]) {
      expect(read(p)).not.toMatch(/effects\/account-event|applyWhatsAppAccountEvent|whatsapp_effect_account_event/);
    }
  });

  it("a RPC do efeito está entre as que o servidor sabe chamar com o claim", () => {
    expect(read("src/server/whatsapp/inbox.ts")).toMatch(/\|\s*"whatsapp_effect_account_event"/);
  });

  it("o CI roda a concorrência real e a atualização desta etapa", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("scripts/b3-2d2b2b3b-account-event-concurrency-check.sh");
    expect(ci).toContain("scripts/check-upgrade-b3-2d2b2b3b-eventos-conta.sh");
  });
});
