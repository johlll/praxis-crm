/**
 * @vitest-environment node
 *
 * B3.2d-2b2b1 — efeito atômico de mensagem de SAÍDA OBSERVADA (eco do
 * WhatsApp Business App), no servidor.
 *
 *  - só o claim emitido pelo servidor aplica o efeito; o banco recebe o id
 *    da inbox, o token do claim e só os dados do eco — nunca workspace,
 *    canal, ambiente, provedor, id do evento, origem, classificação ou autor;
 *  - destinatário: telefone, BSUID ou os dois, nunca nenhum; o BSUID vai só
 *    como índices cegos e cifra (o mesmo caminho da 2b2a); nenhum telefone
 *    é derivado do BSUID;
 *  - o id do provedor e o wamid vão como vieram; o wamid é opcional;
 *  - entrada inválida não chega ao banco; o resultado é conferido campo a
 *    campo; erros saem só como código;
 *  - nada envia mensagem nem chama o provedor; o consumidor da B3.2d-2a
 *    ainda NÃO chama este efeito (B3.2d-2b3).
 *
 * Escritos ANTES da implementação, contra a main 740f0f8. O banco é
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
const loadEffect = () => import("@/server/whatsapp/effects/outbound-observed");
const { encryptWhatsAppInboxBody } = await import("@/server/whatsapp/inbox-crypto");
const { decryptWhatsAppBsuid, whatsappBsuidBlindIndexes } = await import("@/server/whatsapp/identity-crypto");

const WS = "10000000-0000-0000-0000-000000000001";
const CHANNEL = "35000000-0000-0000-0000-000000000002";
const INBOX_ID = "45000000-0000-4000-8000-000000000002";
const TOKEN = "6f1d2c3b-4a59-4e8f-9a1b-2c3d4e5f6a7c";
const MESSAGE_ID = "46000000-0000-4000-8000-000000000002";
const CONVERSATION_ID = "47000000-0000-4000-8000-000000000002";
const EVENT_ID = "evt-eco-1";
const PHONE = "+5511988886666";
const BSUID = "BR.1234567890";
const TEXT = "Bom dia, segue o documento — mensagem fictícia";
const PROVIDER_ID = "63f0a1b2c3d4e5f6a7b8c9d0";
const WAMID = "wamid.HBgNNTUxMTk4ODg4NjY2NhUCABEYEjFDQUZFQ0FGRUNBRkVDQUZF";
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

const applied = { outcome: "applied", message_id: MESSAGE_ID, conversation_id: CONVERSATION_ID };

beforeEach(() => {
  configure();
  handlers = { whatsapp_effect_outbound_observed: () => ({ data: applied, error: null }) };
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

const RAW = new TextEncoder().encode(`{"version":1,"events":[{"type":"message.outbound_observed","id":"${EVENT_ID}"}]}`);

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
    claimed_at: "2026-10-30T12:00:00.000000+00:00",
    lease_until: "2026-10-30T12:05:00.000000+00:00",
    environment: "preview",
    workspace_id: WS,
    channel_id: CHANNEL,
    channel_status: "active",
    provider: "simulated",
    routing_key: "sim-eco-1",
    provider_event_id: EVENT_ID,
    provider_event_type: "whatsapp.smb.message.echoes",
    body_sha256: createHash("sha256").update(RAW).digest("hex"),
    received_at: "2026-10-30T11:59:59.000000+00:00",
    retain_until: "2026-10-30T12:59:59.000000+00:00",
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
    providerMessageId: PROVIDER_ID,
    waMessageId: WAMID,
    contentKind: "text",
    text: TEXT,
    occurredAt: "2026-10-30T11:59:58.000Z",
    recipient: { phoneE164: PHONE, bsuid: null },
    ...overrides,
  };
}

const effectCalls = () => rpcMock.mock.calls.filter(([n]) => n === "whatsapp_effect_outbound_observed") as [string, Record<string, unknown>][];

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

describe("1. o banco recebe a inbox, o token e só os dados do eco", () => {
  it("argumentos exatos; nenhum contexto, origem, classificação ou autor do chamador", async () => {
    const claim = await claimed();
    const { applyWhatsAppOutboundObserved } = await loadEffect();
    await applyWhatsAppOutboundObserved(claim, input());
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
        "p_provider_message_id",
        "p_wa_message_id",
      ].sort(),
    );
    expect(args).toMatchObject({
      p_inbox_id: INBOX_ID,
      p_claim_token: TOKEN,
      p_provider_message_id: PROVIDER_ID,
      p_wa_message_id: WAMID,
      p_content_kind: "text",
      p_body_text: TEXT,
      p_occurred_at: "2026-10-30T11:59:58.000Z",
      p_phone_e164: PHONE,
      p_bsuid_lookup: null,
      p_bsuid_ciphertext: null,
      p_bsuid_key_version: null,
    });
    const json = JSON.stringify(args);
    for (const forbidden of [WS, CHANNEL, EVENT_ID, "preview", "simulated", "business_app", "internal", "chatbot"]) {
      expect(json).not.toContain(forbidden);
    }
  });

  for (const size of [128, 129, 518]) {
    it(`wamid com ${size} caracteres: aceito e repassado inteiro`, async () => {
      const claim = await claimed();
      const { applyWhatsAppOutboundObserved } = await loadEffect();
      const waMessageId = `wamid.${"A".repeat(size - 6)}`;
      await applyWhatsAppOutboundObserved(claim, input({ waMessageId }));
      expect(effectCalls()[0]![1].p_wa_message_id).toBe(waMessageId);
      expect(waMessageId).toHaveLength(size);
    });
  }

  it("sem wamid: nulo", async () => {
    const claim = await claimed();
    const { applyWhatsAppOutboundObserved } = await loadEffect();
    await applyWhatsAppOutboundObserved(claim, input({ waMessageId: null }));
    expect(effectCalls()[0]![1].p_wa_message_id).toBeNull();
  });

  it("mídia sem texto: texto nulo; legenda vazia vira nulo", async () => {
    const claim = await claimed();
    const { applyWhatsAppOutboundObserved } = await loadEffect();
    await applyWhatsAppOutboundObserved(claim, input({ contentKind: "image", text: null }));
    await applyWhatsAppOutboundObserved(claim, input({ contentKind: "audio", text: "   " }));
    expect(effectCalls().map(([, a]) => [a.p_content_kind, a.p_body_text])).toEqual([
      ["image", null],
      ["audio", null],
    ]);
  });
});

// ---------------------------------------------------------------------
// 2. Destinatário: telefone, BSUID ou os dois
// ---------------------------------------------------------------------

describe("2. destinatário", () => {
  it("só BSUID: índice de cada versão de chave, cifra na ativa, no escopo do claim; nenhum telefone", async () => {
    configure({ "1": ID_KEY_1, "2": ID_KEY_2 }, "2");
    const claim = await claimed();
    const { applyWhatsAppOutboundObserved } = await loadEffect();
    await applyWhatsAppOutboundObserved(claim, input({ recipient: { phoneE164: null, bsuid: BSUID } }));
    const args = effectCalls()[0]![1];
    const scope = { environment: "preview" as const, workspaceId: WS, channelId: CHANNEL };
    const expected = Object.fromEntries(whatsappBsuidBlindIndexes(scope, BSUID).map((i) => [i.keyVersion, i.blindIndexBase64]));
    expect(args.p_phone_e164).toBeNull();
    expect(args.p_bsuid_lookup).toEqual(expected);
    expect(args.p_bsuid_key_version).toBe("2");
    expect(decryptWhatsAppBsuid(scope, { ciphertextBase64: args.p_bsuid_ciphertext as string, keyVersion: "2" })).toBe(BSUID);
    expect(JSON.stringify(args)).not.toContain(BSUID);
  });

  it("telefone e BSUID juntos", async () => {
    const claim = await claimed();
    const { applyWhatsAppOutboundObserved } = await loadEffect();
    await applyWhatsAppOutboundObserved(claim, input({ recipient: { phoneE164: PHONE, bsuid: BSUID } }));
    const args = effectCalls()[0]![1];
    expect(args.p_phone_e164).toBe(PHONE);
    expect(Object.keys(args.p_bsuid_lookup as object)).toEqual(["1"]);
    expect(JSON.stringify(args)).not.toContain(BSUID);
  });

  it("BSUID com cara de telefone continua BSUID: nenhum telefone é derivado dele", async () => {
    const claim = await claimed();
    const { applyWhatsAppOutboundObserved } = await loadEffect();
    await applyWhatsAppOutboundObserved(claim, input({ recipient: { phoneE164: null, bsuid: "5511988886666" } }));
    const args = effectCalls()[0]![1];
    expect(args.p_phone_e164).toBeNull();
    expect(JSON.stringify(args)).not.toContain("5511988886666");
  });

  it("BSUID sem as chaves de identidade: recusa antes do banco", async () => {
    const claim = await claimed();
    vi.stubEnv("WHATSAPP_IDENTITY_KEY_VERSIONS", "");
    const { applyWhatsAppOutboundObserved } = await loadEffect();
    await expectCode(applyWhatsAppOutboundObserved(claim, input({ recipient: { phoneE164: null, bsuid: BSUID } })), "identity_keys_not_configured");
    expect(effectCalls()).toHaveLength(0);
  });

  it("os mesmos argumentos de identidade que a 2b2a calcula para o mesmo contato", async () => {
    const claim = await claimed();
    const { whatsappEffectIdentityArgs } = await import("@/server/whatsapp/effects/identity-args");
    const { applyWhatsAppOutboundObserved } = await loadEffect();
    await applyWhatsAppOutboundObserved(claim, input({ recipient: { phoneE164: PHONE, bsuid: BSUID } }));
    const args = effectCalls()[0]![1];
    const shared = whatsappEffectIdentityArgs(claim, { phoneE164: PHONE, bsuid: BSUID });
    expect({ ...shared, p_bsuid_ciphertext: "-" }).toEqual({
      p_phone_e164: args.p_phone_e164,
      p_bsuid_lookup: args.p_bsuid_lookup,
      p_bsuid_key_version: args.p_bsuid_key_version,
      p_bsuid_ciphertext: "-",
    });
  });
});

// ---------------------------------------------------------------------
// 3. Entrada inválida não chega ao banco
// ---------------------------------------------------------------------

describe("3. entrada inválida", () => {
  const invalid: [string, Record<string, unknown>][] = [
    ["sem telefone nem BSUID", { recipient: { phoneE164: null, bsuid: null } }],
    ["telefone fora do E.164", { recipient: { phoneE164: "11988886666", bsuid: null } }],
    ["BSUID malformado", { recipient: { phoneE164: null, bsuid: "bsuid com espaço" } }],
    ["telefone válido e BSUID malformado (o BSUID não é descartado)", { recipient: { phoneE164: PHONE, bsuid: "bsuid com espaço" } }],
    ["BSUID válido e telefone malformado (o telefone não é descartado)", { recipient: { phoneE164: "11988886666", bsuid: BSUID } }],
    ["texto sem corpo", { contentKind: "text", text: "  " }],
    ["tipo desconhecido", { contentKind: "holograma" }],
    ["texto longo demais", { text: "x".repeat(4097) }],
    ["id do provedor com espaço", { providerMessageId: "id com espaço" }],
    ["id do provedor vazio", { providerMessageId: "" }],
    ["wamid sem o prefixo", { waMessageId: "HBgNNTUxMTk4ODg4NjY2NhUCABEYEj" }],
    ["wamid com 519 caracteres (acima do limite do normalizador)", { waMessageId: `wamid.${"A".repeat(513)}` }],
    ["data inválida", { occurredAt: "ontem" }],
    ["campo extra (autor do chamador)", { sentBy: "20000000-0000-0000-0000-000000000001" }],
    ["campo extra (origem do chamador)", { origin: "chatbot" }],
    ["campo extra no destinatário", { recipient: { phoneE164: PHONE, bsuid: null, internal: true } }],
  ];
  for (const [label, overrides] of invalid) {
    it(`${label}: invalid_outbound_message, nada pedido ao banco`, async () => {
      const claim = await claimed();
      const { applyWhatsAppOutboundObserved } = await loadEffect();
      await expectCode(applyWhatsAppOutboundObserved(claim, input(overrides)), "invalid_outbound_message");
      expect(effectCalls()).toHaveLength(0);
    });
  }

  it("claim montado à mão ou copiado: recusado, nada pedido ao banco", async () => {
    const claim = await claimed();
    const { applyWhatsAppOutboundObserved } = await loadEffect();
    await expectCode(applyWhatsAppOutboundObserved({ ...claim } as never, input()), "inbox_claim_untrusted");
    await expectCode(applyWhatsAppOutboundObserved({ inboxId: INBOX_ID } as never, input()), "inbox_claim_untrusted");
    expect(effectCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// 4. Resultado conferido campo a campo
// ---------------------------------------------------------------------

describe("4. resultado", () => {
  it("applied: ids, em camelCase", async () => {
    const claim = await claimed();
    const { applyWhatsAppOutboundObserved } = await loadEffect();
    await expect(applyWhatsAppOutboundObserved(claim, input())).resolves.toEqual({
      outcome: "applied",
      messageId: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
    });
  });

  for (const outcome of [
    "duplicate",
    "already_processed",
    "terminal_failed",
    "claim_lost",
    "not_found",
    "identity_conflict",
    "message_conflict",
    "effect_conflict",
    "channel_paused",
    "channel_disconnected",
    "channel_disabled",
  ]) {
    it(`${outcome}: repassado como veio`, async () => {
      handlers.whatsapp_effect_outbound_observed = () => ({ data: { outcome }, error: null });
      const claim = await claimed();
      const { applyWhatsAppOutboundObserved } = await loadEffect();
      await expect(applyWhatsAppOutboundObserved(claim, input())).resolves.toEqual({ outcome });
    });
  }

  const bad: [string, unknown][] = [
    ["campo a mais", { ...applied, phone_e164: PHONE }],
    ["campo de lead (nada comercial nesta etapa)", { ...applied, lead_created: true }],
    ["id inválido", { ...applied, message_id: "nao-e-uuid" }],
    ["resultado desconhecido", { outcome: "talvez" }],
    ["nulo", null],
  ];
  for (const [label, data] of bad) {
    it(`resposta inesperada (${label}): invalid_response`, async () => {
      handlers.whatsapp_effect_outbound_observed = () => ({ data, error: null });
      const claim = await claimed();
      const { applyWhatsAppOutboundObserved } = await loadEffect();
      await expectCode(applyWhatsAppOutboundObserved(claim, input()), "invalid_response");
    });
  }
});

// ---------------------------------------------------------------------
// 5. Erros sanitizados
// ---------------------------------------------------------------------

describe("5. erros", () => {
  for (const code of ["invalid_outbound_message", "whatsapp_environment_required"]) {
    it(`${code} do banco: o mesmo código`, async () => {
      handlers.whatsapp_effect_outbound_observed = () => ({ data: null, error: { message: code } });
      const claim = await claimed();
      const { applyWhatsAppOutboundObserved } = await loadEffect();
      await expectCode(applyWhatsAppOutboundObserved(claim, input()), code);
    });
  }

  it("erro cru do banco (com telefone, BSUID, wamid e texto): unknown, sem nenhum valor", async () => {
    const raw = `duplicate key (wa_message_id)=(${WAMID}) phone=${PHONE} bsuid=${BSUID} body=${TEXT}`;
    handlers.whatsapp_effect_outbound_observed = () => ({ data: null, error: { message: raw } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const claim = await claimed();
    const { applyWhatsAppOutboundObserved } = await loadEffect();
    const error = await expectCode(applyWhatsAppOutboundObserved(claim, input({ recipient: { phoneE164: PHONE, bsuid: BSUID } })), "unknown");
    const seen = [error.message, String(error.stack), JSON.stringify(error), ...[errorSpy, warnSpy, logSpy].flatMap((s) => s.mock.calls.flat().map(String))].join("\n");
    for (const leaked of [PHONE, BSUID, TEXT, WAMID, TOKEN]) expect(seen).not.toContain(leaked);
  });

  it("erro de transporte: unknown", async () => {
    handlers.whatsapp_effect_outbound_observed = () => {
      throw new Error(`falha de rede ${PHONE}`);
    };
    const claim = await claimed();
    const { applyWhatsAppOutboundObserved } = await loadEffect();
    const error = await expectCode(applyWhatsAppOutboundObserved(claim, input()), "unknown");
    expect(error.message).not.toContain(PHONE);
  });
});

// ---------------------------------------------------------------------
// 6. Estático: nada de envio, inferência ou ligação do consumidor
// ---------------------------------------------------------------------

describe("6. estático", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("o efeito não envia, não chama o provedor e não decide origem ou autoria pelo texto", () => {
    const src = read("src/server/whatsapp/effects/outbound-observed.ts");
    expect(src).not.toMatch(/provider\/ycloud|sendText|sendTemplate|fetch\(|send_message/);
    expect(src).not.toMatch(/["'](business_app|chatbot|automation)["']/);
    expect(src).not.toMatch(/\.(text|waMessageId|providerMessageId)\s*\.\s*(match|test|includes|startsWith|search)\(/);
    expect(src).not.toMatch(/console\./);
  });

  it("o limite do wamid é o mesmo no normalizador da YCloud, no servidor e na RPC", () => {
    const normalizer = read("src/server/whatsapp/provider/ycloud.ts").match(/const WAMID = (\/.*\/);/)?.[1];
    expect(normalizer).toBe(String.raw`/^wamid\.[A-Za-z0-9._:=+/-]{1,512}$/`);
    expect(read("src/server/whatsapp/effects/outbound-observed.ts")).toContain(`.regex(${normalizer})`);
    const migration = read("supabase/migrations/20261030120000_b3_2d2b2b1_outbound_observed_effect.sql");
    expect(migration).toContain(String.raw`p_wa_message_id !~ '^wamid\.[A-Za-z0-9._:=+/-]{1,512}$'`);
    expect(migration).toMatch(/char_length\(btrim\(wa_message_id\)\) between 1 and 518/);
  });

  it("a criptografia do destinatário é a mesma da 2b2a, sem cópia", () => {
    for (const p of ["src/server/whatsapp/effects/outbound-observed.ts", "src/server/whatsapp/effects/inbound-message.ts"]) {
      const src = read(p);
      expect(src).toMatch(/whatsappEffectIdentityArgs/);
      expect(src).not.toMatch(/encryptWhatsAppBsuid|whatsappBsuidBlindIndexes|inbox-crypto/);
    }
  });

  it("o consumidor da B3.2d-2a ainda não chama o efeito (B3.2d-2b3)", () => {
    for (const p of ["src/server/whatsapp/consumer.ts", "src/server/whatsapp/inngest-consumer.ts", "src/server/whatsapp/inngest.ts"]) {
      const src = read(p);
      expect(src).not.toMatch(/effects\/outbound-observed|applyWhatsAppOutboundObserved|whatsapp_effect_outbound_observed/);
    }
  });
});
