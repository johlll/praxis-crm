/**
 * @vitest-environment node
 *
 * B3.2d-2b2b2 — efeito atômico de STATUS e CUSTO de uma mensagem de saída
 * já gravada, no servidor.
 *
 *  - só o claim emitido pelo servidor aplica o efeito; o banco recebe o id
 *    da inbox, o token do claim e só os dados do status — nunca workspace,
 *    canal, ambiente, provedor, id do evento, origem, classificação ou autor;
 *  - o erro do provedor vai só como código opaco e bem formado (texto livre
 *    vira `unrecognized`), e só junto de `failed`;
 *  - o custo vai completo ou não vai; categoria malformada vira nula sem
 *    perder o valor; custo de `failed` é estimativa; final só com a prova
 *    de entrega;
 *  - o `externalId` vai como veio (opaco, até 512 caracteres);
 *  - destinatário opcional, pelo mesmo caminho de identidade da 2b2a;
 *  - a regra de status é a mesma de `projectWhatsAppMessageStatus`, e a
 *    matriz do pgTAP 38 é a mesma desta função;
 *  - entrada inválida não chega ao banco; o resultado é conferido campo a
 *    campo; erros saem só como código;
 *  - nada envia mensagem nem chama o provedor; o consumidor da B3.2d-2a
 *    ainda NÃO chama este efeito (B3.2d-2b3).
 *
 * Escritos ANTES da implementação, contra a main 7159941. O banco é
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
const loadEffect = () => import("@/server/whatsapp/effects/message-status");
const { encryptWhatsAppInboxBody } =
  await import("@/server/whatsapp/inbox-crypto");
const { whatsappBsuidBlindIndexes } =
  await import("@/server/whatsapp/identity-crypto");
const { projectWhatsAppMessageStatus } =
  await import("@/server/whatsapp/status-projection");

const WS = "10000000-0000-0000-0000-000000000001";
const CHANNEL = "35000000-0000-0000-0000-000000000003";
const INBOX_ID = "45000000-0000-4000-8000-000000000003";
const TOKEN = "6f1d2c3b-4a59-4e8f-9a1b-2c3d4e5f6a7d";
const MESSAGE_ID = "46000000-0000-4000-8000-000000000003";
const EVENT_ID = "evt-status-1";
const PHONE = "+5511988887777";
const BSUID = "BR.9876543210";
const PROVIDER_ID = "63f0a1b2c3d4e5f6a7b8c9d1";
const WAMID = "wamid.HBgNNTUxMTk4ODg4Nzc3NxUCABEYEjFDQUZFQ0FGRUNBRkVDQUZF";
const EXTERNAL_ID = "msg-bot_0123456789abcdef01234567";
const INBOX_KEY = Buffer.alloc(32, 9).toString("base64");
const ID_KEY_1 = Buffer.alloc(32, 44).toString("base64");

function configure() {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv(
    "WHATSAPP_ENV_SIGNING_KEY",
    "chave-de-teste-b3-whatsapp-0123456789",
  );
  vi.stubEnv("WHATSAPP_INBOX_KEY_VERSIONS", JSON.stringify({ "1": INBOX_KEY }));
  vi.stubEnv("WHATSAPP_INBOX_ACTIVE_KEY_VERSION", "1");
  vi.stubEnv(
    "WHATSAPP_IDENTITY_KEY_VERSIONS",
    JSON.stringify({ "1": ID_KEY_1 }),
  );
  vi.stubEnv("WHATSAPP_IDENTITY_ACTIVE_KEY_VERSION", "1");
}

type RpcHandler = (args: Record<string, unknown>) => {
  data: unknown;
  error: unknown;
};
let handlers: Record<string, RpcHandler> = {};

const applied = { outcome: "applied", message_id: MESSAGE_ID };

beforeEach(() => {
  configure();
  handlers = {
    whatsapp_effect_message_status: () => ({ data: applied, error: null }),
  };
  rpcMock.mockReset();
  rpcMock.mockImplementation(
    async (name: string, args: Record<string, unknown>) => {
      const handler = handlers[name];
      if (!handler)
        return { data: null, error: { message: `rpc_nao_esperada:${name}` } };
      return handler(args);
    },
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const RAW = new TextEncoder().encode(
  `{"version":1,"events":[{"type":"message.status","id":"${EVENT_ID}"}]}`,
);

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
    routing_key: "sim-status-1",
    provider_event_id: EVENT_ID,
    provider_event_type: "whatsapp.message.updated",
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
  if (result.outcome !== "claimed")
    throw new Error(`claim não obtido no teste: ${result.outcome}`);
  return result.claim;
}

const COST = {
  source: "provider",
  category: "marketing",
  amount: 0.0315,
  currency: "BRL",
  finality: "final",
} as const;

function input(overrides: Record<string, unknown> = {}) {
  return {
    providerMessageId: PROVIDER_ID,
    waMessageId: WAMID,
    externalId: EXTERNAL_ID,
    status: "delivered",
    errorCode: null,
    occurredAt: "2026-10-30T11:59:58.000Z",
    recipient: { phoneE164: PHONE, bsuid: null },
    providerCost: COST,
    ...overrides,
  };
}

const effectCalls = () =>
  rpcMock.mock.calls.filter(
    ([n]) => n === "whatsapp_effect_message_status",
  ) as [string, Record<string, unknown>][];
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

describe("1. o banco recebe a inbox, o token e só os dados do status", () => {
  it("argumentos exatos; nenhum contexto, origem, classificação ou autor do chamador", async () => {
    const claim = await claimed();
    const { applyWhatsAppMessageStatus } = await loadEffect();
    await applyWhatsAppMessageStatus(claim, input());
    const args = lastArgs();
    expect(Object.keys(args).sort()).toEqual(
      [
        "p_bsuid_ciphertext",
        "p_bsuid_key_version",
        "p_bsuid_lookup",
        "p_claim_token",
        "p_cost_amount",
        "p_cost_category",
        "p_cost_currency",
        "p_cost_finality",
        "p_error_code",
        "p_external_id",
        "p_inbox_id",
        "p_occurred_at",
        "p_phone_e164",
        "p_provider_message_id",
        "p_status",
        "p_wa_message_id",
      ].sort(),
    );
    expect(args).toMatchObject({
      p_inbox_id: INBOX_ID,
      p_claim_token: TOKEN,
      p_provider_message_id: PROVIDER_ID,
      p_wa_message_id: WAMID,
      p_external_id: EXTERNAL_ID,
      p_status: "delivered",
      p_error_code: null,
      p_occurred_at: "2026-10-30T11:59:58.000Z",
      p_phone_e164: PHONE,
      p_bsuid_lookup: null,
      p_bsuid_ciphertext: null,
      p_bsuid_key_version: null,
      p_cost_amount: 0.0315,
      p_cost_currency: "BRL",
      p_cost_category: "marketing",
      p_cost_finality: "final",
    });
    const json = JSON.stringify(args);
    for (const forbidden of [
      WS,
      CHANNEL,
      EVENT_ID,
      "preview",
      "simulated",
      "business_app",
      "external_api",
      "chatbot",
      "internal",
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it("wamid de 518 caracteres e externalId de 512 (os limites do normalizador): repassados inteiros", async () => {
    const claim = await claimed();
    const { applyWhatsAppMessageStatus } = await loadEffect();
    const waMessageId = `wamid.${"A".repeat(512)}`;
    const externalId = `correlação opaca ${"x".repeat(495)}`;
    await applyWhatsAppMessageStatus(claim, input({ waMessageId, externalId }));
    expect(lastArgs().p_wa_message_id).toBe(waMessageId);
    expect(lastArgs().p_external_id).toBe(externalId);
    expect(externalId).toHaveLength(512);
  });

  it("sem wamid, sem externalId e sem custo: nulos", async () => {
    const claim = await claimed();
    const { applyWhatsAppMessageStatus } = await loadEffect();
    await applyWhatsAppMessageStatus(
      claim,
      input({ waMessageId: null, externalId: null, providerCost: null }),
    );
    expect(lastArgs()).toMatchObject({
      p_wa_message_id: null,
      p_external_id: null,
      p_cost_amount: null,
      p_cost_currency: null,
      p_cost_category: null,
      p_cost_finality: null,
    });
  });

  for (const status of ["accepted", "sent", "delivered", "read", "failed"]) {
    it(`status ${status}: repassado como veio`, async () => {
      const claim = await claimed();
      const { applyWhatsAppMessageStatus } = await loadEffect();
      await applyWhatsAppMessageStatus(
        claim,
        input({ status, providerCost: null }),
      );
      expect(lastArgs().p_status).toBe(status);
    });
  }
});

// ---------------------------------------------------------------------
// 2. Erro do provedor: só código, só com failed
// ---------------------------------------------------------------------

describe("2. código de erro do provedor", () => {
  it("código opaco bem formado junto de failed: repassado", async () => {
    const claim = await claimed();
    const { applyWhatsAppMessageStatus } = await loadEffect();
    await applyWhatsAppMessageStatus(
      claim,
      input({ status: "failed", errorCode: "131026", providerCost: null }),
    );
    await applyWhatsAppMessageStatus(
      claim,
      input({
        status: "failed",
        errorCode: "ERR_rate.limit:1",
        providerCost: null,
      }),
    );
    expect(effectCalls().map(([, a]) => a.p_error_code)).toEqual([
      "131026",
      "ERR_rate.limit:1",
    ]);
  });

  it("texto livre, com espaço ou com dado pessoal: vira unrecognized, nunca o texto", async () => {
    const claim = await claimed();
    const { applyWhatsAppMessageStatus } = await loadEffect();
    const raw = `Message failed to send to ${PHONE}`;
    await applyWhatsAppMessageStatus(
      claim,
      input({ status: "failed", errorCode: raw, providerCost: null }),
    );
    await applyWhatsAppMessageStatus(
      claim,
      input({
        status: "failed",
        errorCode: "x".repeat(65),
        providerCost: null,
      }),
    );
    expect(effectCalls().map(([, a]) => a.p_error_code)).toEqual([
      "unrecognized",
      "unrecognized",
    ]);
    expect(JSON.stringify(effectCalls())).not.toContain(raw);
  });

  it("código junto de um status que não é failed: não vai ao banco", async () => {
    const claim = await claimed();
    const { applyWhatsAppMessageStatus } = await loadEffect();
    await applyWhatsAppMessageStatus(
      claim,
      input({ status: "delivered", errorCode: "131026" }),
    );
    expect(lastArgs().p_error_code).toBeNull();
  });
});

// ---------------------------------------------------------------------
// 3. Custo informado pelo provedor
// ---------------------------------------------------------------------

describe("3. custo", () => {
  it("estimativa: os quatro campos", async () => {
    const claim = await claimed();
    const { applyWhatsAppMessageStatus } = await loadEffect();
    await applyWhatsAppMessageStatus(
      claim,
      input({
        status: "sent",
        providerCost: { ...COST, amount: 0.02, finality: "estimated" },
      }),
    );
    expect(lastArgs()).toMatchObject({
      p_cost_amount: 0.02,
      p_cost_currency: "BRL",
      p_cost_category: "marketing",
      p_cost_finality: "estimated",
    });
  });

  it("custo zero (tipo gratuito) é um custo, não ausência", async () => {
    const claim = await claimed();
    const { applyWhatsAppMessageStatus } = await loadEffect();
    await applyWhatsAppMessageStatus(
      claim,
      input({ providerCost: { ...COST, amount: 0, category: null } }),
    );
    expect(lastArgs()).toMatchObject({
      p_cost_amount: 0,
      p_cost_category: null,
      p_cost_finality: "final",
    });
  });

  it("categoria malformada: nula, sem perder o valor (a mesma regra do domínio)", async () => {
    const claim = await claimed();
    const { applyWhatsAppMessageStatus } = await loadEffect();
    await applyWhatsAppMessageStatus(
      claim,
      input({ providerCost: { ...COST, category: "Marketing-Lite" } }),
    );
    expect(lastArgs()).toMatchObject({
      p_cost_amount: 0.0315,
      p_cost_category: null,
      p_cost_finality: "final",
    });
  });

  it("failed com custo final: vai como estimativa (failed não é cobrado)", async () => {
    const claim = await claimed();
    const { applyWhatsAppMessageStatus } = await loadEffect();
    await applyWhatsAppMessageStatus(
      claim,
      input({ status: "failed", providerCost: COST }),
    );
    expect(lastArgs()).toMatchObject({
      p_status: "failed",
      p_cost_amount: 0.0315,
      p_cost_finality: "estimated",
    });
  });

  const invalid: [string, unknown][] = [
    ["final antes da entrega (sent)", { ...COST }],
    ["valor negativo", { ...COST, amount: -0.01 }],
    ["valor infinito", { ...COST, amount: Number.POSITIVE_INFINITY }],
    ["valor NaN", { ...COST, amount: Number.NaN }],
    ["valor grande demais para a coluna", { ...COST, amount: 1e12 }],
    ["moeda fora do ISO 4217", { ...COST, currency: "real" }],
    ["finalidade desconhecida", { ...COST, finality: "quase" }],
    [
      "sem moeda (parcial)",
      {
        source: "provider",
        category: null,
        amount: 0.01,
        finality: "estimated",
      },
    ],
    ["fonte que não é o provedor", { ...COST, source: "crm" }],
    ["campo extra", { ...COST, tariff: 0.03 }],
  ];
  for (const [label, providerCost] of invalid) {
    it(`custo ${label}: invalid_status_update, nada pedido ao banco`, async () => {
      const claim = await claimed();
      const { applyWhatsAppMessageStatus } = await loadEffect();
      const status = label.startsWith("final antes") ? "sent" : "delivered";
      await expectCode(
        applyWhatsAppMessageStatus(claim, input({ status, providerCost })),
        "invalid_status_update",
      );
      expect(effectCalls()).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------
// 4. Destinatário opcional
// ---------------------------------------------------------------------

describe("4. destinatário", () => {
  it("sem destinatário: todos os argumentos de identidade nulos", async () => {
    const claim = await claimed();
    const { applyWhatsAppMessageStatus } = await loadEffect();
    await applyWhatsAppMessageStatus(claim, input({ recipient: null }));
    expect(lastArgs()).toMatchObject({
      p_phone_e164: null,
      p_bsuid_lookup: null,
      p_bsuid_ciphertext: null,
      p_bsuid_key_version: null,
    });
  });

  it("BSUID: só índice cego e cifra, no escopo do claim, pelo mesmo caminho da 2b2a", async () => {
    const claim = await claimed();
    const { whatsappEffectIdentityArgs } =
      await import("@/server/whatsapp/effects/identity-args");
    const { applyWhatsAppMessageStatus } = await loadEffect();
    await applyWhatsAppMessageStatus(
      claim,
      input({ recipient: { phoneE164: PHONE, bsuid: BSUID } }),
    );
    const args = lastArgs();
    const scope = {
      environment: "preview" as const,
      workspaceId: WS,
      channelId: CHANNEL,
    };
    expect(args.p_bsuid_lookup).toEqual(
      Object.fromEntries(
        whatsappBsuidBlindIndexes(scope, BSUID).map((i) => [
          i.keyVersion,
          i.blindIndexBase64,
        ]),
      ),
    );
    const shared = whatsappEffectIdentityArgs(claim, {
      phoneE164: PHONE,
      bsuid: BSUID,
    });
    expect([args.p_phone_e164, args.p_bsuid_key_version]).toEqual([
      shared.p_phone_e164,
      shared.p_bsuid_key_version,
    ]);
    expect(JSON.stringify(args)).not.toContain(BSUID);
  });

  it("BSUID sem as chaves de identidade: recusa antes do banco", async () => {
    const claim = await claimed();
    vi.stubEnv("WHATSAPP_IDENTITY_KEY_VERSIONS", "");
    const { applyWhatsAppMessageStatus } = await loadEffect();
    await expectCode(
      applyWhatsAppMessageStatus(
        claim,
        input({ recipient: { phoneE164: null, bsuid: BSUID } }),
      ),
      "identity_keys_not_configured",
    );
    expect(effectCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// 5. Entrada inválida não chega ao banco
// ---------------------------------------------------------------------

describe("5. entrada inválida", () => {
  const invalid: [string, Record<string, unknown>][] = [
    ["status queued (só da A7)", { status: "queued" }],
    ["status desconhecido", { status: "lido" }],
    ["id do provedor com espaço", { providerMessageId: "id com espaço" }],
    ["id do provedor vazio", { providerMessageId: "" }],
    ["wamid sem o prefixo", { waMessageId: "HBgNNTUxMTk4ODg4NzcCABEYEj" }],
    ["wamid com 519 caracteres", { waMessageId: `wamid.${"A".repeat(513)}` }],
    ["externalId vazio", { externalId: "" }],
    ["externalId com 513 caracteres", { externalId: "x".repeat(513) }],
    ["externalId com caractere de controle", { externalId: "ext\nquebra" }],
    ["data inválida", { occurredAt: "ontem" }],
    ["destinatário vazio", { recipient: { phoneE164: null, bsuid: null } }],
    [
      "telefone fora do E.164",
      { recipient: { phoneE164: "11988887777", bsuid: null } },
    ],
    [
      "BSUID malformado",
      { recipient: { phoneE164: PHONE, bsuid: "bsuid com espaço" } },
    ],
    ["campo extra (origem do chamador)", { origin: "chatbot" }],
    [
      "campo extra (autor do chamador)",
      { sentBy: "20000000-0000-0000-0000-000000000001" },
    ],
    [
      "campo extra no destinatário",
      { recipient: { phoneE164: PHONE, bsuid: null, internal: true } },
    ],
  ];
  for (const [label, overrides] of invalid) {
    it(`${label}: invalid_status_update, nada pedido ao banco`, async () => {
      const claim = await claimed();
      const { applyWhatsAppMessageStatus } = await loadEffect();
      await expectCode(
        applyWhatsAppMessageStatus(claim, input(overrides)),
        "invalid_status_update",
      );
      expect(effectCalls()).toHaveLength(0);
    });
  }

  it("claim montado à mão ou copiado: recusado, nada pedido ao banco", async () => {
    const claim = await claimed();
    const { applyWhatsAppMessageStatus } = await loadEffect();
    await expectCode(
      applyWhatsAppMessageStatus({ ...claim } as never, input()),
      "inbox_claim_untrusted",
    );
    expect(effectCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// 6. Resultado conferido campo a campo
// ---------------------------------------------------------------------

describe("6. resultado", () => {
  it("applied: o id da mensagem, em camelCase", async () => {
    const claim = await claimed();
    const { applyWhatsAppMessageStatus } = await loadEffect();
    await expect(applyWhatsAppMessageStatus(claim, input())).resolves.toEqual({
      outcome: "applied",
      messageId: MESSAGE_ID,
    });
  });

  for (const outcome of [
    "duplicate",
    "already_processed",
    "terminal_failed",
    "claim_lost",
    "not_found",
    "message_not_found",
    "message_conflict",
    "cost_conflict",
    "effect_conflict",
    "channel_paused",
    "channel_disconnected",
    "channel_disabled",
  ]) {
    it(`${outcome}: repassado como veio`, async () => {
      handlers.whatsapp_effect_message_status = () => ({
        data: { outcome },
        error: null,
      });
      const claim = await claimed();
      const { applyWhatsAppMessageStatus } = await loadEffect();
      await expect(applyWhatsAppMessageStatus(claim, input())).resolves.toEqual(
        { outcome },
      );
    });
  }

  const bad: [string, unknown][] = [
    ["campo a mais (custo)", { ...applied, provider_cost_amount: 0.0315 }],
    ["campo a mais (status)", { ...applied, status: "read" }],
    ["id inválido", { ...applied, message_id: "nao-e-uuid" }],
    [
      "identity_conflict (o status devolve message_conflict)",
      { outcome: "identity_conflict" },
    ],
    ["resultado desconhecido", { outcome: "talvez" }],
    ["nulo", null],
  ];
  for (const [label, data] of bad) {
    it(`resposta inesperada (${label}): invalid_response`, async () => {
      handlers.whatsapp_effect_message_status = () => ({ data, error: null });
      const claim = await claimed();
      const { applyWhatsAppMessageStatus } = await loadEffect();
      await expectCode(
        applyWhatsAppMessageStatus(claim, input()),
        "invalid_response",
      );
    });
  }
});

// ---------------------------------------------------------------------
// 7. Erros sanitizados
// ---------------------------------------------------------------------

describe("7. erros", () => {
  for (const code of [
    "invalid_status_update",
    "whatsapp_environment_required",
  ]) {
    it(`${code} do banco: o mesmo código`, async () => {
      handlers.whatsapp_effect_message_status = () => ({
        data: null,
        error: { message: code },
      });
      const claim = await claimed();
      const { applyWhatsAppMessageStatus } = await loadEffect();
      await expectCode(applyWhatsAppMessageStatus(claim, input()), code);
    });
  }

  it("erro cru do banco (com telefone, BSUID, wamid, externalId e custo): unknown, sem nenhum valor", async () => {
    const raw = `provider_cost_final_immutable amount=0.0315 BRL wamid=${WAMID} ext=${EXTERNAL_ID} phone=${PHONE} bsuid=${BSUID}`;
    handlers.whatsapp_effect_message_status = () => ({
      data: null,
      error: { message: raw },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const claim = await claimed();
    const { applyWhatsAppMessageStatus } = await loadEffect();
    const error = await expectCode(
      applyWhatsAppMessageStatus(
        claim,
        input({ recipient: { phoneE164: PHONE, bsuid: BSUID } }),
      ),
      "unknown",
    );
    const seen = [
      error.message,
      String(error.stack),
      JSON.stringify(error),
      ...[errorSpy, warnSpy, logSpy].flatMap((s) =>
        s.mock.calls.flat().map(String),
      ),
    ].join("\n");
    for (const leaked of [PHONE, BSUID, WAMID, EXTERNAL_ID, "0.0315", TOKEN])
      expect(seen).not.toContain(leaked);
  });

  it("erro de transporte: unknown", async () => {
    handlers.whatsapp_effect_message_status = () => {
      throw new Error(`falha de rede ${PHONE}`);
    };
    const claim = await claimed();
    const { applyWhatsAppMessageStatus } = await loadEffect();
    const error = await expectCode(
      applyWhatsAppMessageStatus(claim, input()),
      "unknown",
    );
    expect(error.message).not.toContain(PHONE);
  });
});

// ---------------------------------------------------------------------
// 8. Estático: mesma regra, mesmos limites, nada de envio ou ligação
// ---------------------------------------------------------------------

describe("8. estático", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const MIGRATION =
    "supabase/migrations/20261030140000_b3_2d2b2b2_message_status_effect.sql";

  it("a matriz de status do pgTAP 38 é a de projectWhatsAppMessageStatus", () => {
    const pgtap = read(
      "supabase/tests/database/38_b3_2d2b2b2_status_custo.test.sql",
    );
    const statuses = [
      "accepted",
      "sent",
      "delivered",
      "read",
      "failed",
    ] as const;
    for (const current of statuses) {
      for (const incoming of statuses) {
        const projected = projectWhatsAppMessageStatus(current, incoming);
        expect(pgtap).toContain(
          `${current}>${incoming}=${projected.status}:${projected.changed ? "applied" : "duplicate"}`,
        );
      }
    }
  });

  it("o banco usa a regra de status compartilhada do domínio, sem cópia", () => {
    const migration = read(MIGRATION);
    expect(migration).toMatch(
      /private\.whatsapp_message_status_should_apply\(/,
    );
  });

  it("os limites do wamid e do externalId são os do normalizador da YCloud", () => {
    const ycloud = read("src/server/whatsapp/provider/ycloud.ts");
    expect(ycloud.match(/const WAMID = (\/.*\/);/)?.[1]).toBe(
      String.raw`/^wamid\.[A-Za-z0-9._:=+/-]{1,512}$/`,
    );
    expect(ycloud).toMatch(/externalId: optOpaque\(m\.externalId, 512\)/);
    expect(read("src/server/whatsapp/effects/message-status.ts")).toContain(
      String.raw`.regex(/^wamid\.[A-Za-z0-9._:=+/-]{1,512}$/)`,
    );
    const migration = read(MIGRATION);
    expect(migration).toContain(
      String.raw`p_wa_message_id !~ '^wamid\.[A-Za-z0-9._:=+/-]+$' or char_length(p_wa_message_id) > 518`,
    );
    expect(migration).toMatch(
      /char_length\(provider_external_id\) between 1 and 512/,
    );
  });

  it("o efeito não envia, não chama o provedor e não decide origem ou autoria", () => {
    const src = read("src/server/whatsapp/effects/message-status.ts");
    expect(src).not.toMatch(
      /provider\/ycloud|sendText|sendTemplate|fetch\(|send_message/,
    );
    expect(src).not.toMatch(/["'](business_app|chatbot|automation|crm)["']/);
    expect(src).not.toMatch(
      /\.externalId\s*\.\s*(match|test|includes|startsWith|search)\(/,
    );
    expect(src).not.toMatch(/console\./);
    expect(src).toMatch(/whatsappEffectIdentityArgs/);
    expect(src).not.toMatch(
      /encryptWhatsAppBsuid|whatsappBsuidBlindIndexes|inbox-crypto/,
    );
    const migration = read(MIGRATION);
    expect(migration).not.toMatch(
      /update public\.messages\s+set[^;]*\b(origin|sender_classification|sent_by|origin_correlation_kind|origin_correlation_ref)\s*=/,
    );
    expect(migration).not.toMatch(
      /insert into public\.(messages|conversations|contacts|leads|opportunities|activities|whatsapp_identities)\b/,
    );
  });

  it("o consumidor da B3.2d-2a ainda não chama o efeito (B3.2d-2b3)", () => {
    for (const p of [
      "src/server/whatsapp/consumer.ts",
      "src/server/whatsapp/inngest-consumer.ts",
      "src/server/whatsapp/inngest.ts",
    ]) {
      const src = read(p);
      expect(src).not.toMatch(
        /effects\/message-status|applyWhatsAppMessageStatus|whatsapp_effect_message_status/,
      );
    }
  });
});
