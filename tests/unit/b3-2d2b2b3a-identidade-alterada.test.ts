/**
 * @vitest-environment node
 *
 * B3.2d-2b2b3a — efeito atômico de IDENTIDADE ALTERADA e TROCA DE NÚMERO
 * (NormalizedIdentityChange), no servidor.
 *
 *  - só o claim emitido pelo servidor aplica o efeito; o banco recebe o id
 *    da inbox, o token do claim e só os dados da mudança — nunca workspace,
 *    canal, ambiente, provedor, evento, contato, lead, usuário ou origem;
 *  - identidade anterior e nova com materiais SEPARADOS, pelo módulo comum
 *    de identidade: a anterior só com índices cegos (nunca é gravada), a
 *    nova com índices e cifra; nenhum BSUID em claro;
 *  - phone_number exige a nova com telefone; identity não aceita a nova;
 *  - entrada inválida não chega ao banco; o resultado é conferido campo a
 *    campo; erros saem só como código;
 *  - nada envia mensagem nem chama o provedor; o consumidor da B3.2d-2a
 *    ainda NÃO chama este efeito (B3.2d-2b3).
 *
 * Escritos ANTES da implementação, contra a main d8f7357. O banco é
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
const loadEffect = () => import("@/server/whatsapp/effects/identity-change");
const { encryptWhatsAppInboxBody } = await import("@/server/whatsapp/inbox-crypto");
const { decryptWhatsAppBsuid, whatsappBsuidBlindIndexes } = await import("@/server/whatsapp/identity-crypto");

const WS = "10000000-0000-0000-0000-000000000001";
const CHANNEL = "35000000-0000-0000-0000-000000000005";
const INBOX_ID = "45000000-0000-4000-8000-000000000005";
const TOKEN = "6f1d2c3b-4a59-4e8f-9a1b-2c3d4e5f6a7f";
const IDENTITY_ID = "48000000-0000-4000-8000-000000000005";
const EVENT_ID = "evt-identidade-1";
const OLD_PHONE = "+5511988881111";
const NEW_PHONE = "+5511988882222";
const OLD_BSUID = "BR.1111111111";
const NEW_BSUID = "BR.2222222222";
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

const applied = { outcome: "applied", identity_id: IDENTITY_ID };

beforeEach(() => {
  configure();
  handlers = { whatsapp_effect_identity_change: () => ({ data: applied, error: null }) };
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

const RAW = new TextEncoder().encode(`{"version":1,"events":[{"type":"contact.identity_changed","id":"${EVENT_ID}"}]}`);

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
    routing_key: "sim-identidade-1",
    provider_event_id: EVENT_ID,
    provider_event_type: "whatsapp.inbound_message.received",
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
    change: "phone_number",
    occurredAt: "2026-10-30T11:59:58.000Z",
    previous: { phoneE164: OLD_PHONE, bsuid: null },
    next: { phoneE164: NEW_PHONE, bsuid: null },
    ...overrides,
  };
}

const effectCalls = () => rpcMock.mock.calls.filter(([n]) => n === "whatsapp_effect_identity_change") as [string, Record<string, unknown>][];
const lastArgs = () => effectCalls().at(-1)![1];
const SCOPE = { environment: "preview" as const, workspaceId: WS, channelId: CHANNEL };
const lookupOf = (bsuid: string) => Object.fromEntries(whatsappBsuidBlindIndexes(SCOPE, bsuid).map((i) => [i.keyVersion, i.blindIndexBase64]));

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

describe("1. o banco recebe a inbox, o token e só os dados da mudança", () => {
  it("argumentos exatos; nenhum contexto, contato, lead, usuário ou origem do chamador", async () => {
    const claim = await claimed();
    const { applyWhatsAppIdentityChange } = await loadEffect();
    await applyWhatsAppIdentityChange(claim, input());
    const args = lastArgs();
    expect(Object.keys(args).sort()).toEqual(
      [
        "p_change",
        "p_claim_token",
        "p_inbox_id",
        "p_next_bsuid_ciphertext",
        "p_next_bsuid_key_version",
        "p_next_bsuid_lookup",
        "p_next_phone_e164",
        "p_occurred_at",
        "p_previous_bsuid_key_version",
        "p_previous_bsuid_lookup",
        "p_previous_phone_e164",
      ].sort(),
    );
    expect(args).toMatchObject({
      p_inbox_id: INBOX_ID,
      p_claim_token: TOKEN,
      p_change: "phone_number",
      p_occurred_at: "2026-10-30T11:59:58.000Z",
      p_previous_phone_e164: OLD_PHONE,
      p_previous_bsuid_lookup: null,
      p_previous_bsuid_key_version: null,
      p_next_phone_e164: NEW_PHONE,
      p_next_bsuid_lookup: null,
      p_next_bsuid_ciphertext: null,
      p_next_bsuid_key_version: null,
    });
    const json = JSON.stringify(args);
    for (const forbidden of [WS, CHANNEL, EVENT_ID, "preview", "simulated", "contact", "lead", "whatsapp_webhook"]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it("identity sem a nova: os argumentos da nova vão nulos", async () => {
    const claim = await claimed();
    const { applyWhatsAppIdentityChange } = await loadEffect();
    await applyWhatsAppIdentityChange(claim, input({ change: "identity", next: null }));
    expect(lastArgs()).toMatchObject({
      p_change: "identity",
      p_previous_phone_e164: OLD_PHONE,
      p_next_phone_e164: null,
      p_next_bsuid_lookup: null,
      p_next_bsuid_ciphertext: null,
      p_next_bsuid_key_version: null,
    });
  });
});

// ---------------------------------------------------------------------
// 2. Criptografia: materiais separados, pelo módulo comum
// ---------------------------------------------------------------------

describe("2. identidade anterior e nova com materiais separados", () => {
  it("anterior com BSUID: só índices cegos de cada versão e a versão ativa; nenhuma cifra (a anterior nunca é gravada)", async () => {
    configure({ "1": ID_KEY_1, "2": ID_KEY_2 }, "2");
    const claim = await claimed();
    const { applyWhatsAppIdentityChange } = await loadEffect();
    await applyWhatsAppIdentityChange(claim, input({ previous: { phoneE164: OLD_PHONE, bsuid: OLD_BSUID } }));
    const args = lastArgs();
    expect(args.p_previous_bsuid_lookup).toEqual(lookupOf(OLD_BSUID));
    expect(args.p_previous_bsuid_key_version).toBe("2");
    expect(Object.keys(args)).not.toContain("p_previous_bsuid_ciphertext");
  });

  it("nova com BSUID: índices e cifra na versão ativa, no escopo do claim; a cifra decifra para o BSUID novo", async () => {
    configure({ "1": ID_KEY_1, "2": ID_KEY_2 }, "2");
    const claim = await claimed();
    const { applyWhatsAppIdentityChange } = await loadEffect();
    await applyWhatsAppIdentityChange(claim, input({ previous: { phoneE164: OLD_PHONE, bsuid: OLD_BSUID }, next: { phoneE164: NEW_PHONE, bsuid: NEW_BSUID } }));
    const args = lastArgs();
    expect(args.p_next_bsuid_lookup).toEqual(lookupOf(NEW_BSUID));
    expect(args.p_next_bsuid_lookup).not.toEqual(args.p_previous_bsuid_lookup);
    expect(args.p_next_bsuid_key_version).toBe("2");
    expect(decryptWhatsAppBsuid(SCOPE, { ciphertextBase64: args.p_next_bsuid_ciphertext as string, keyVersion: "2" })).toBe(NEW_BSUID);
    const json = JSON.stringify(args);
    for (const plain of [OLD_BSUID, NEW_BSUID]) expect(json).not.toContain(plain);
  });

  it("os mesmos materiais que o módulo comum calcula (sem cópia de AES-GCM ou índice cego)", async () => {
    const claim = await claimed();
    const { whatsappEffectIdentityArgs } = await import("@/server/whatsapp/effects/identity-args");
    const { applyWhatsAppIdentityChange } = await loadEffect();
    await applyWhatsAppIdentityChange(claim, input({ previous: { phoneE164: null, bsuid: OLD_BSUID }, next: { phoneE164: NEW_PHONE, bsuid: NEW_BSUID } }));
    const args = lastArgs();
    const previous = whatsappEffectIdentityArgs(claim, { phoneE164: null, bsuid: OLD_BSUID });
    const next = whatsappEffectIdentityArgs(claim, { phoneE164: NEW_PHONE, bsuid: NEW_BSUID });
    expect([args.p_previous_phone_e164, args.p_previous_bsuid_lookup, args.p_previous_bsuid_key_version]).toEqual([
      previous.p_phone_e164,
      previous.p_bsuid_lookup,
      previous.p_bsuid_key_version,
    ]);
    expect([args.p_next_phone_e164, args.p_next_bsuid_lookup, args.p_next_bsuid_key_version]).toEqual([next.p_phone_e164, next.p_bsuid_lookup, next.p_bsuid_key_version]);
  });

  it("BSUID sem as chaves de identidade: recusa antes do banco", async () => {
    const claim = await claimed();
    vi.stubEnv("WHATSAPP_IDENTITY_KEY_VERSIONS", "");
    const { applyWhatsAppIdentityChange } = await loadEffect();
    await expectCode(applyWhatsAppIdentityChange(claim, input({ previous: { phoneE164: null, bsuid: OLD_BSUID } })), "identity_keys_not_configured");
    expect(effectCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// 3. Validação fechada: nada chega ao banco
// ---------------------------------------------------------------------

describe("3. entrada inválida", () => {
  const invalid: [string, Record<string, unknown>][] = [
    ["mudança desconhecida", { change: "number" }],
    ["phone_number sem a nova", { next: null }],
    ["phone_number com a nova só por BSUID", { next: { phoneE164: null, bsuid: NEW_BSUID } }],
    ["identity com a nova", { change: "identity" }],
    ["anterior vazia", { previous: { phoneE164: null, bsuid: null } }],
    ["telefone anterior fora do E.164", { previous: { phoneE164: "11988881111", bsuid: null } }],
    ["telefone novo fora do E.164", { next: { phoneE164: "11988882222", bsuid: null } }],
    ["BSUID anterior malformado", { previous: { phoneE164: OLD_PHONE, bsuid: "bsuid com espaço" } }],
    ["BSUID novo malformado", { next: { phoneE164: NEW_PHONE, bsuid: "bsuid com espaço" } }],
    ["data inválida", { occurredAt: "ontem" }],
    ["campo extra (contato do chamador)", { contactId: "3f300000-0000-0000-0000-000000000005" }],
    ["campo extra (usuário do chamador)", { userId: "20000000-0000-0000-0000-000000000001" }],
    ["campo extra na anterior", { previous: { phoneE164: OLD_PHONE, bsuid: null, internal: true } }],
    ["campo extra na nova", { next: { phoneE164: NEW_PHONE, bsuid: null, contactId: "x" } }],
  ];
  for (const [label, overrides] of invalid) {
    it(`${label}: invalid_identity_change, nada pedido ao banco`, async () => {
      const claim = await claimed();
      const { applyWhatsAppIdentityChange } = await loadEffect();
      await expectCode(applyWhatsAppIdentityChange(claim, input(overrides)), "invalid_identity_change");
      expect(effectCalls()).toHaveLength(0);
    });
  }

  it("claim montado à mão ou copiado: recusado, nada pedido ao banco", async () => {
    const claim = await claimed();
    const { applyWhatsAppIdentityChange } = await loadEffect();
    await expectCode(applyWhatsAppIdentityChange({ ...claim } as never, input()), "inbox_claim_untrusted");
    expect(effectCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// 4. Resultado conferido campo a campo
// ---------------------------------------------------------------------

describe("4. resultado", () => {
  it("applied e review_required: o id da identidade, em camelCase", async () => {
    const claim = await claimed();
    const { applyWhatsAppIdentityChange } = await loadEffect();
    await expect(applyWhatsAppIdentityChange(claim, input())).resolves.toEqual({ outcome: "applied", identityId: IDENTITY_ID });
    handlers.whatsapp_effect_identity_change = () => ({ data: { outcome: "review_required", identity_id: IDENTITY_ID }, error: null });
    await expect(applyWhatsAppIdentityChange(claim, input({ change: "identity", next: null }))).resolves.toEqual({
      outcome: "review_required",
      identityId: IDENTITY_ID,
    });
  });

  for (const outcome of [
    "duplicate",
    "identity_not_found",
    "identity_conflict",
    "effect_conflict",
    "already_processed",
    "terminal_failed",
    "claim_lost",
    "not_found",
    "channel_paused",
    "channel_disconnected",
    "channel_disabled",
  ]) {
    it(`${outcome}: repassado como veio`, async () => {
      handlers.whatsapp_effect_identity_change = () => ({ data: { outcome }, error: null });
      const claim = await claimed();
      const { applyWhatsAppIdentityChange } = await loadEffect();
      await expect(applyWhatsAppIdentityChange(claim, input())).resolves.toEqual({ outcome });
    });
  }

  const bad: [string, unknown][] = [
    ["campo a mais (telefone)", { ...applied, phone_e164: NEW_PHONE }],
    ["campo a mais (contato)", { ...applied, contact_id: "3f300000-0000-0000-0000-000000000005" }],
    ["id inválido", { ...applied, identity_id: "nao-e-uuid" }],
    ["review_required sem id", { outcome: "review_required" }],
    ["message_conflict (não é resultado deste efeito)", { outcome: "message_conflict" }],
    ["resultado desconhecido", { outcome: "talvez" }],
    ["nulo", null],
  ];
  for (const [label, data] of bad) {
    it(`resposta inesperada (${label}): invalid_response`, async () => {
      handlers.whatsapp_effect_identity_change = () => ({ data, error: null });
      const claim = await claimed();
      const { applyWhatsAppIdentityChange } = await loadEffect();
      await expectCode(applyWhatsAppIdentityChange(claim, input()), "invalid_response");
    });
  }
});

// ---------------------------------------------------------------------
// 5. Erros sanitizados
// ---------------------------------------------------------------------

describe("5. erros", () => {
  for (const code of ["invalid_identity_change", "whatsapp_environment_required"]) {
    it(`${code} do banco: o mesmo código`, async () => {
      handlers.whatsapp_effect_identity_change = () => ({ data: null, error: { message: code } });
      const claim = await claimed();
      const { applyWhatsAppIdentityChange } = await loadEffect();
      await expectCode(applyWhatsAppIdentityChange(claim, input()), code);
    });
  }

  it("erro cru do banco (com telefones e BSUIDs): unknown, sem nenhum valor", async () => {
    const raw = `duplicate key (phone_e164)=(${NEW_PHONE}) old=${OLD_PHONE} bsuid=${OLD_BSUID}/${NEW_BSUID}`;
    handlers.whatsapp_effect_identity_change = () => ({ data: null, error: { message: raw } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const claim = await claimed();
    const { applyWhatsAppIdentityChange } = await loadEffect();
    const error = await expectCode(
      applyWhatsAppIdentityChange(claim, input({ previous: { phoneE164: OLD_PHONE, bsuid: OLD_BSUID }, next: { phoneE164: NEW_PHONE, bsuid: NEW_BSUID } })),
      "unknown",
    );
    const seen = [error.message, String(error.stack), JSON.stringify(error), ...[errorSpy, warnSpy, logSpy].flatMap((s) => s.mock.calls.flat().map(String))].join("\n");
    for (const leaked of [OLD_PHONE, NEW_PHONE, OLD_BSUID, NEW_BSUID, TOKEN]) expect(seen).not.toContain(leaked);
  });

  it("erro de transporte: unknown", async () => {
    handlers.whatsapp_effect_identity_change = () => {
      throw new Error(`falha de rede ${NEW_PHONE}`);
    };
    const claim = await claimed();
    const { applyWhatsAppIdentityChange } = await loadEffect();
    const error = await expectCode(applyWhatsAppIdentityChange(claim, input()), "unknown");
    expect(error.message).not.toContain(NEW_PHONE);
  });
});

// ---------------------------------------------------------------------
// 6. Estático
// ---------------------------------------------------------------------

describe("6. estático", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("o efeito não envia, não chama o provedor, não registra log e usa o módulo comum de identidade", () => {
    const src = read("src/server/whatsapp/effects/identity-change.ts");
    expect(src).not.toMatch(/provider\/ycloud|sendText|sendTemplate|fetch\(|send_message/);
    expect(src).not.toMatch(/console\./);
    expect(src).toMatch(/whatsappEffectIdentityArgs/);
    expect(src).not.toMatch(/encryptWhatsAppBsuid|whatsappBsuidBlindIndexes|createCipheriv|createHmac|inbox-crypto|calendar|google/i);
  });

  it("a migration não cria contato, lead, oportunidade, atividade nem identidade, e não mexe nos telefones do contato", () => {
    const migration = read("supabase/migrations/20261030160000_b3_2d2b2b3a_identity_change_effect.sql");
    expect(migration).not.toMatch(/insert into public\.(contacts|contact_phones|contact_identifiers|leads|opportunities|activities|whatsapp_identities|conversations|messages)\b/);
    expect(migration).not.toMatch(/(update|delete from) public\.(contacts|contact_phones|contact_identifiers|leads|opportunities|activities)\b/);
    expect(migration).not.toMatch(/whatsapp_resolve_inbound_identity/);
  });

  it("o consumidor da B3.2d-2a ainda não chama o efeito (B3.2d-2b3)", () => {
    for (const p of ["src/server/whatsapp/consumer.ts", "src/server/whatsapp/inngest-consumer.ts", "src/server/whatsapp/inngest.ts"]) {
      const src = read(p);
      expect(src).not.toMatch(/effects\/identity-change|applyWhatsAppIdentityChange|whatsapp_effect_identity_change/);
    }
  });
});
