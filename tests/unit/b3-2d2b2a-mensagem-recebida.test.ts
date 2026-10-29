/**
 * @vitest-environment node
 *
 * B3.2d-2b2a — efeito atômico de mensagem RECEBIDA, no servidor.
 *
 *  - só o claim emitido pelo servidor aplica o efeito; o banco recebe o id
 *    da inbox, o token do claim e só os dados do efeito — nunca workspace,
 *    canal, ambiente, provedor ou id do evento como contexto confiável;
 *  - identidade: telefone, BSUID ou os dois, nunca nenhum; o BSUID vai só
 *    como índices cegos (todas as versões de chave, para busca) e o texto
 *    cifrado na versão ativa, no escopo do claim; nunca em claro;
 *  - a classificação é do banco: o texto e o nome do perfil não entram em
 *    nenhuma decisão aqui;
 *  - entrada inválida não chega ao banco; o resultado é conferido campo a
 *    campo; erros saem só como código, sem telefone, BSUID ou texto;
 *  - o consumidor da B3.2d-2a ainda NÃO chama este efeito (B3.2d-2b3).
 *
 * Escritos ANTES da implementação, contra a main 5ba35c4. O banco é
 * simulado. Tudo fictício.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/server/whatsapp/admin/supabase", () => ({
  createWhatsAppAdminSupabaseClient: () => ({ rpc: rpcMock }),
}));

const loadInbox = () => import("@/server/whatsapp/inbox");
const loadEffect = () => import("@/server/whatsapp/effects/inbound-message");
const { encryptWhatsAppInboxBody } = await import("@/server/whatsapp/inbox-crypto");
const { decryptWhatsAppBsuid, whatsappBsuidBlindIndexes } = await import("@/server/whatsapp/identity-crypto");

const WS = "10000000-0000-0000-0000-000000000001";
const CHANNEL = "35000000-0000-0000-0000-000000000001";
const INBOX_ID = "45000000-0000-4000-8000-000000000001";
const TOKEN = "6f1d2c3b-4a59-4e8f-9a1b-2c3d4e5f6a7b";
const MESSAGE_ID = "46000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "47000000-0000-4000-8000-000000000001";
const EVENT_ID = "evt-efeito-1";
const PHONE = "+5511988887777";
const BSUID = "BR.9876543210";
const TEXT = "Olá, preciso de ajuda — mensagem fictícia";
const PROFILE = "Pessoa Fictícia";
const INBOX_KEY = Buffer.alloc(32, 9).toString("base64");
const ID_KEY_1 = Buffer.alloc(32, 44).toString("base64");
const ID_KEY_2 = Buffer.alloc(32, 45).toString("base64");

function configure(versions: Record<string, string> = { "1": ID_KEY_1 }, active = "1") {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "chave-de-teste-b3-whatsapp-0123456789");
  vi.stubEnv("WHATSAPP_INBOX_KEY_VERSIONS", JSON.stringify({ "1": INBOX_KEY }));
  vi.stubEnv("WHATSAPP_INBOX_ACTIVE_KEY_VERSION", "1");
  vi.stubEnv("WHATSAPP_IDENTITY_KEY_VERSIONS", JSON.stringify(versions));
  vi.stubEnv("WHATSAPP_IDENTITY_ACTIVE_KEY_VERSION", active);
}

type RpcHandler = (args: Record<string, unknown>) => { data: unknown; error: unknown };
let handlers: Record<string, RpcHandler> = {};

const applied = {
  outcome: "applied",
  message_id: MESSAGE_ID,
  conversation_id: CONVERSATION_ID,
  sender_classification: "external",
  contact_created: true,
  lead_created: true,
};

beforeEach(() => {
  configure();
  handlers = { whatsapp_effect_inbound_message: () => ({ data: applied, error: null }) };
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

const RAW = new TextEncoder().encode(`{"version":1,"events":[{"type":"message.inbound","id":"${EVENT_ID}"}]}`);

function claimRow() {
  const enc = encryptWhatsAppInboxBody(RAW, {
    environment: "preview",
    workspaceId: WS,
    channelId: CHANNEL,
    provider: "simulated",
    providerEventId: EVENT_ID,
  } as never);
  return {
    outcome: "claimed",
    inbox_id: INBOX_ID,
    claim_token: TOKEN,
    claim_count: 1,
    claimed_at: "2026-10-29T12:00:00.000000+00:00",
    lease_until: "2026-10-29T12:05:00.000000+00:00",
    environment: "preview",
    workspace_id: WS,
    channel_id: CHANNEL,
    channel_status: "active",
    provider: "simulated",
    routing_key: "sim-efeito-1",
    provider_event_id: EVENT_ID,
    provider_event_type: "message.inbound",
    body_sha256: createHash("sha256").update(RAW).digest("hex"),
    received_at: "2026-10-29T11:59:59.000000+00:00",
    retain_until: "2026-10-29T12:59:59.000000+00:00",
    key_version: enc.keyVersion,
    nonce: enc.nonce,
    ciphertext: enc.ciphertext,
    auth_tag: enc.authTag,
  };
}

async function claimed() {
  const inbox = await loadInbox();
  handlers.whatsapp_inbox_claim = () => ({ data: claimRow(), error: null });
  const result = await inbox.claimWhatsAppInboxEntry({ inboxId: INBOX_ID });
  if (result.outcome !== "claimed") throw new Error(`claim não obtido no teste: ${result.outcome}`);
  return result.claim;
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    providerMessageId: "wamid.ficticio.1",
    contentKind: "text",
    text: TEXT,
    occurredAt: "2026-10-29T11:59:58.000Z",
    sender: { phoneE164: PHONE, bsuid: null },
    profileName: PROFILE,
    ...overrides,
  };
}

const effectCalls = () => rpcMock.mock.calls.filter(([n]) => n === "whatsapp_effect_inbound_message") as [string, Record<string, unknown>][];

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

describe("1. o banco recebe a inbox, o token e só os dados do efeito", () => {
  it("argumentos exatos; inbox e token do claim; nenhum contexto do chamador", async () => {
    const claim = await claimed();
    const { applyWhatsAppInboundMessage } = await loadEffect();
    await applyWhatsAppInboundMessage(claim, input());
    const args = effectCalls()[0]![1];
    expect(Object.keys(args).sort()).toEqual(
      [
        "p_bsuid_ciphertext",
        "p_bsuid_key_version",
        "p_bsuid_lookup",
        "p_body_text",
        "p_claim_token",
        "p_content_kind",
        "p_inbox_id",
        "p_occurred_at",
        "p_phone_e164",
        "p_profile_name",
        "p_provider_message_id",
      ].sort(),
    );
    expect(args).toMatchObject({
      p_inbox_id: INBOX_ID,
      p_claim_token: TOKEN,
      p_provider_message_id: "wamid.ficticio.1",
      p_content_kind: "text",
      p_body_text: TEXT,
      p_occurred_at: "2026-10-29T11:59:58.000Z",
      p_phone_e164: PHONE,
      p_bsuid_lookup: null,
      p_bsuid_ciphertext: null,
      p_bsuid_key_version: null,
      p_profile_name: PROFILE,
    });
    const json = JSON.stringify(args);
    for (const forbidden of [WS, CHANNEL, EVENT_ID, "preview", "simulated"]) expect(json).not.toContain(forbidden);
  });

  it("mídia sem texto: texto nulo; legenda vazia vira nulo", async () => {
    const claim = await claimed();
    const { applyWhatsAppInboundMessage } = await loadEffect();
    await applyWhatsAppInboundMessage(claim, input({ contentKind: "image", text: null }));
    await applyWhatsAppInboundMessage(claim, input({ contentKind: "document", text: "   " }));
    expect(effectCalls().map(([, a]) => [a.p_content_kind, a.p_body_text])).toEqual([
      ["image", null],
      ["document", null],
    ]);
  });

  it("sem nome de perfil: nulo", async () => {
    const claim = await claimed();
    const { applyWhatsAppInboundMessage } = await loadEffect();
    await applyWhatsAppInboundMessage(claim, input({ profileName: undefined }));
    expect(effectCalls()[0]![1].p_profile_name).toBeNull();
  });
});

// ---------------------------------------------------------------------
// 2. BSUID: índices cegos e cifra, nunca em claro
// ---------------------------------------------------------------------

describe("2. BSUID", () => {
  it("só BSUID: índice de cada versão de chave, cifra na ativa, no escopo do claim", async () => {
    configure({ "1": ID_KEY_1, "2": ID_KEY_2 }, "2");
    const claim = await claimed();
    const { applyWhatsAppInboundMessage } = await loadEffect();
    await applyWhatsAppInboundMessage(claim, input({ sender: { phoneE164: null, bsuid: BSUID } }));
    const args = effectCalls()[0]![1];
    const scope = { environment: "preview" as const, workspaceId: WS, channelId: CHANNEL };
    const expected = Object.fromEntries(whatsappBsuidBlindIndexes(scope, BSUID).map((i) => [i.keyVersion, i.blindIndexBase64]));
    expect(args.p_phone_e164).toBeNull();
    expect(args.p_bsuid_lookup).toEqual(expected);
    expect(Object.keys(args.p_bsuid_lookup as object).sort()).toEqual(["1", "2"]);
    expect(args.p_bsuid_key_version).toBe("2");
    expect(decryptWhatsAppBsuid(scope, { ciphertextBase64: args.p_bsuid_ciphertext as string, keyVersion: "2" })).toBe(BSUID);
    expect(JSON.stringify(args)).not.toContain(BSUID);
  });

  it("telefone e BSUID juntos", async () => {
    const claim = await claimed();
    const { applyWhatsAppInboundMessage } = await loadEffect();
    await applyWhatsAppInboundMessage(claim, input({ sender: { phoneE164: PHONE, bsuid: BSUID } }));
    const args = effectCalls()[0]![1];
    expect(args.p_phone_e164).toBe(PHONE);
    expect(Object.keys(args.p_bsuid_lookup as object)).toEqual(["1"]);
    expect(JSON.stringify(args)).not.toContain(BSUID);
  });

  it("BSUID com cara de telefone continua BSUID: nenhum telefone é derivado dele", async () => {
    const claim = await claimed();
    const { applyWhatsAppInboundMessage } = await loadEffect();
    await applyWhatsAppInboundMessage(claim, input({ sender: { phoneE164: null, bsuid: "5511988887777" } }));
    const args = effectCalls()[0]![1];
    expect(args.p_phone_e164).toBeNull();
    expect(JSON.stringify(args)).not.toContain("5511988887777");
  });

  it("BSUID sem as chaves de identidade: recusa antes do banco", async () => {
    const claim = await claimed();
    vi.stubEnv("WHATSAPP_IDENTITY_KEY_VERSIONS", "");
    const { applyWhatsAppInboundMessage } = await loadEffect();
    await expectCode(applyWhatsAppInboundMessage(claim, input({ sender: { phoneE164: null, bsuid: BSUID } })), "identity_keys_not_configured");
    expect(effectCalls()).toHaveLength(0);
  });

  it("só telefone não precisa das chaves de identidade", async () => {
    const claim = await claimed();
    vi.stubEnv("WHATSAPP_IDENTITY_KEY_VERSIONS", "");
    const { applyWhatsAppInboundMessage } = await loadEffect();
    await expect(applyWhatsAppInboundMessage(claim, input())).resolves.toMatchObject({ outcome: "applied" });
  });
});

// ---------------------------------------------------------------------
// 3. Entrada inválida não chega ao banco
// ---------------------------------------------------------------------

describe("3. entrada inválida", () => {
  const invalid: [string, Record<string, unknown>][] = [
    ["sem telefone nem BSUID", { sender: { phoneE164: null, bsuid: null } }],
    ["telefone fora do E.164", { sender: { phoneE164: "11988887777", bsuid: null } }],
    ["BSUID malformado", { sender: { phoneE164: null, bsuid: "bsuid com espaço" } }],
    ["texto sem corpo", { contentKind: "text", text: "  " }],
    ["tipo desconhecido", { contentKind: "holograma" }],
    ["texto longo demais", { text: "x".repeat(4097) }],
    ["id do provedor com espaço", { providerMessageId: "wamid com espaço" }],
    ["id do provedor vazio", { providerMessageId: "" }],
    ["data inválida", { occurredAt: "ontem" }],
    ["nome de perfil longo demais", { profileName: "n".repeat(161) }],
    ["campo extra (workspace do chamador)", { workspaceId: WS }],
    ["campo extra no remetente", { sender: { phoneE164: PHONE, bsuid: null, internal: true } }],
  ];
  for (const [label, overrides] of invalid) {
    it(`${label}: invalid_inbound_message, nada pedido ao banco`, async () => {
      const claim = await claimed();
      const { applyWhatsAppInboundMessage } = await loadEffect();
      await expectCode(applyWhatsAppInboundMessage(claim, input(overrides)), "invalid_inbound_message");
      expect(effectCalls()).toHaveLength(0);
    });
  }

  it("claim montado à mão ou copiado: recusado, nada pedido ao banco", async () => {
    const claim = await claimed();
    const { applyWhatsAppInboundMessage } = await loadEffect();
    await expectCode(applyWhatsAppInboundMessage({ ...claim } as never, input()), "inbox_claim_untrusted");
    await expectCode(applyWhatsAppInboundMessage({ inboxId: INBOX_ID } as never, input()), "inbox_claim_untrusted");
    expect(effectCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// 4. Resultado conferido campo a campo
// ---------------------------------------------------------------------

describe("4. resultado", () => {
  it("applied: ids e indicadores, em camelCase", async () => {
    const claim = await claimed();
    const { applyWhatsAppInboundMessage } = await loadEffect();
    await expect(applyWhatsAppInboundMessage(claim, input())).resolves.toEqual({
      outcome: "applied",
      messageId: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      senderClassification: "external",
      contactCreated: true,
      leadCreated: true,
    });
  });

  for (const outcome of ["duplicate", "already_processed", "terminal_failed", "claim_lost", "not_found", "identity_conflict", "effect_conflict",
    "channel_paused", "channel_disconnected", "channel_disabled"]) {
    it(`${outcome}: repassado como veio`, async () => {
      handlers.whatsapp_effect_inbound_message = () => ({ data: { outcome }, error: null });
      const claim = await claimed();
      const { applyWhatsAppInboundMessage } = await loadEffect();
      await expect(applyWhatsAppInboundMessage(claim, input())).resolves.toEqual({ outcome });
    });
  }

  it("canal não ativo no momento do efeito: os mesmos códigos que o consumidor libera (B3.2d-2b3)", async () => {
    const { WHATSAPP_CONSUMER_RECOVERABLE_CODES } = await import("@/server/whatsapp/consumer");
    for (const outcome of ["channel_paused", "channel_disconnected", "channel_disabled"]) {
      expect(WHATSAPP_CONSUMER_RECOVERABLE_CODES).toContain(outcome);
    }
  });

  const bad: [string, unknown][] = [
    ["campo a mais", { ...applied, phone_e164: PHONE }],
    ["id inválido", { ...applied, message_id: "nao-e-uuid" }],
    ["classificação fora da lista", { ...applied, sender_classification: "automation" }],
    ["resultado desconhecido", { outcome: "talvez" }],
    ["nulo", null],
  ];
  for (const [label, data] of bad) {
    it(`resposta inesperada (${label}): invalid_response`, async () => {
      handlers.whatsapp_effect_inbound_message = () => ({ data, error: null });
      const claim = await claimed();
      const { applyWhatsAppInboundMessage } = await loadEffect();
      await expectCode(applyWhatsAppInboundMessage(claim, input()), "invalid_response");
    });
  }
});

// ---------------------------------------------------------------------
// 5. Erros sanitizados
// ---------------------------------------------------------------------

describe("5. erros", () => {
  for (const code of ["invalid_inbound_message", "whatsapp_environment_required"]) {
    it(`${code} do banco: o mesmo código`, async () => {
      handlers.whatsapp_effect_inbound_message = () => ({ data: null, error: { message: code } });
      const claim = await claimed();
      const { applyWhatsAppInboundMessage } = await loadEffect();
      await expectCode(applyWhatsAppInboundMessage(claim, input()), code);
    });
  }

  it("erro cru do banco (com telefone, BSUID e texto): unknown, sem nenhum valor", async () => {
    const raw = `duplicate key value violates unique constraint (phone_e164)=(${PHONE}) bsuid=${BSUID} body=${TEXT}`;
    handlers.whatsapp_effect_inbound_message = () => ({ data: null, error: { message: raw } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const claim = await claimed();
    const { applyWhatsAppInboundMessage } = await loadEffect();
    const error = await expectCode(applyWhatsAppInboundMessage(claim, input({ sender: { phoneE164: PHONE, bsuid: BSUID } })), "unknown");
    const seen = [error.message, String(error.stack), JSON.stringify(error), ...[errorSpy, warnSpy, logSpy].flatMap((s) => s.mock.calls.flat().map(String))].join("\n");
    for (const leaked of [PHONE, BSUID, TEXT, PROFILE, TOKEN]) expect(seen).not.toContain(leaked);
  });

  it("erro de transporte: unknown", async () => {
    handlers.whatsapp_effect_inbound_message = () => {
      throw new Error(`falha de rede ${PHONE}`);
    };
    const claim = await claimed();
    const { applyWhatsAppInboundMessage } = await loadEffect();
    const error = await expectCode(applyWhatsAppInboundMessage(claim, input()), "unknown");
    expect(error.message).not.toContain(PHONE);
  });
});

// ---------------------------------------------------------------------
// 6. Estático: nada de texto na decisão; consumidor ainda não ligado
// ---------------------------------------------------------------------

describe("6. estático", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("o efeito não classifica nem decide pelo texto ou pelo nome: só repassa ao banco", () => {
    const src = read("src/server/whatsapp/effects/inbound-message.ts");
    expect(src).not.toMatch(/classifyWhatsAppMessage|whatsappMayCreateLead|senderClassification\s*[:=]\s*["'](external|internal|unresolved)["']\s*[,;}]/);
    expect(src).not.toMatch(/\.(text|profileName|body)\s*\.\s*(match|test|includes|startsWith|search)\(/);
    expect(src).not.toMatch(/console\./);
  });

  it("o consumidor da B3.2d-2a ainda não chama o efeito (B3.2d-2b3)", () => {
    for (const p of ["src/server/whatsapp/consumer.ts", "src/server/whatsapp/inngest-consumer.ts", "src/server/whatsapp/inngest.ts"]) {
      const src = read(p);
      expect(src).not.toMatch(/effects\/inbound-message|applyWhatsAppInboundMessage|whatsapp_effect_inbound_message/);
    }
  });
});
