/**
 * @vitest-environment node
 *
 * B3.2b — API do servidor para a caixa de entrada cifrada do webhook.
 *
 * Só aceita: bytes já representados por `VerifiedWebhookBody` e o contexto
 * CONFIÁVEL do canal produzido pela resolução interna do webhook. Um objeto
 * montado à mão com UUIDs não autoriza gravação nem leitura. O corpo vai
 * cifrado com a AAD do contexto; o banco recebe só metadado, hash e texto
 * cifrado. Retenção vem de configuração confiável; sem ela, falha fechada.
 *
 * Escritos ANTES da implementação, contra a main 3feedd1. O banco é
 * simulado: só se observa o que é pedido a ele.
 */
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/server/whatsapp/admin/supabase", () => ({
  createWhatsAppAdminSupabaseClient: () => ({ rpc: rpcMock }),
}));

const loadInbox = () => import("@/server/whatsapp/inbox");
const loadInboxCrypto = () => import("@/server/whatsapp/inbox-crypto");

const channels = await import("@/server/whatsapp/admin/channels");
const { encryptWhatsAppCredential } = await import("@/server/whatsapp/credential-crypto");
const { SimulatedWhatsAppProvider, signSimulatedWebhook, SIMULATED_SIGNATURE_HEADER } = await import(
  "@/server/whatsapp/provider/simulated"
);
const { YCloudWhatsAppProvider } = await import("@/server/whatsapp/provider/ycloud");
const { VerifiedWebhookBody } = await import("@/server/whatsapp/provider/contract");

const WS = "10000000-0000-0000-0000-000000000001";
const OTHER_WS = "10000000-0000-0000-0000-000000000002";
const CHANNEL = "33000000-0000-0000-0000-000000000001";
const OTHER_CHANNEL = "33000000-0000-0000-0000-000000000002";
const INBOX_ID = "44000000-0000-0000-0000-000000000001";
const ROUTING = "sim-inbox-1";
const CRED_KEY = Buffer.alloc(32, 7).toString("base64");
const INBOX_KEY = Buffer.alloc(32, 9).toString("base64");
const WEBHOOK_SECRET = "segredo-simulado-ficticio-inbox";
const PHONE = "+5511999990000";
const TEXT = "Olá, ação — mensagem fictícia 🚀";
const NOW_MS = 1_800_000_000_000;

function configure() {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "chave-de-teste-b3-whatsapp-0123456789");
  vi.stubEnv("WHATSAPP_PROVIDER", "simulated");
  vi.stubEnv("WHATSAPP_CREDENTIAL_KEY_VERSIONS", JSON.stringify({ "1": CRED_KEY }));
  vi.stubEnv("WHATSAPP_CREDENTIAL_ACTIVE_KEY_VERSION", "1");
  vi.stubEnv("WHATSAPP_INBOX_KEY_VERSIONS", JSON.stringify({ "1": INBOX_KEY }));
  vi.stubEnv("WHATSAPP_INBOX_ACTIVE_KEY_VERSION", "1");
  vi.stubEnv("WHATSAPP_INBOX_RETENTION_SECONDS", "3600");
}

function webhookRow(overrides: Record<string, unknown> = {}) {
  const enc = encryptWhatsAppCredential(WEBHOOK_SECRET, {
    environment: "preview",
    workspaceId: WS,
    channelId: CHANNEL,
    provider: "simulated",
    purpose: "webhook_secret",
  });
  return {
    channel_id: CHANNEL,
    workspace_id: WS,
    environment: "preview",
    provider: "simulated",
    routing_key: ROUTING,
    status: "active",
    ciphertext: enc.ciphertextBase64,
    key_version: enc.keyVersion,
    ...overrides,
  };
}

type RpcHandler = (args: Record<string, unknown>) => { data: unknown; error: unknown };
let handlers: Record<string, RpcHandler> = {};

beforeEach(() => {
  configure();
  handlers = { whatsapp_resolve_webhook_channel: () => ({ data: [webhookRow()], error: null }) };
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

async function trustedChannel() {
  const resolved = await channels.adminResolveWhatsAppWebhookChannel({ provider: "simulated", routingKey: ROUTING });
  if (!resolved) throw new Error("canal não resolvido no teste");
  return resolved;
}

function simulatedBody(events: unknown[], newline = "\n") {
  return `{"version":1,${newline}"events":${JSON.stringify(events)}}`;
}

const INBOUND = { type: "message.inbound", id: "evt-inbox-1", routingKey: ROUTING, messageId: "m1", occurredAt: "2026-10-20T12:00:00Z", from: PHONE, text: TEXT };

function verify(raw: Uint8Array, secret = WEBHOOK_SECRET) {
  const provider = new SimulatedWhatsAppProvider();
  const t = Math.floor(NOW_MS / 1000);
  const headers = new Headers({ [SIMULATED_SIGNATURE_HEADER]: signSimulatedWebhook(raw, secret, t) });
  const result = provider.verifyWebhook({ rawBody: raw, headers, secret, nowMs: NOW_MS });
  if (!result.ok) throw new Error(`assinatura recusada no teste: ${result.reason}`);
  return result.verified;
}

const bytesOf = (text: string) => new TextEncoder().encode(text);
const sha256 = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex");

function storeCalls() {
  return rpcMock.mock.calls.filter(([name]) => name === "whatsapp_inbox_store");
}

describe("1. gravação", () => {
  it("cifra os bytes exatos com a AAD do contexto e manda só metadado, hash e texto cifrado", async () => {
    const { storeWhatsAppWebhookDelivery } = await loadInbox();
    const { decryptWhatsAppInboxBody } = await loadInboxCrypto();
    handlers.whatsapp_inbox_store = () => ({ data: { outcome: "inserted", inbox_id: INBOX_ID }, error: null });
    const resolved = await trustedChannel();
    const raw = bytesOf(simulatedBody([INBOUND]));

    const result = await storeWhatsAppWebhookDelivery({ channel: resolved.channel, adapter: resolved.adapter, verified: verify(raw), nowMs: NOW_MS });
    expect(result).toEqual({ outcome: "inserted", inboxId: INBOX_ID });

    const [[, args]] = storeCalls() as [[string, Record<string, string>]];
    expect(Object.keys(args).sort()).toEqual(
      [
        "p_auth_tag",
        "p_body_sha256",
        "p_channel_id",
        "p_ciphertext",
        "p_provider_event_type",
        "p_key_version",
        "p_nonce",
        "p_provider",
        "p_provider_event_id",
        "p_retain_until",
        "p_routing_key",
        "p_workspace_id",
      ].sort(),
    );
    expect(args).toMatchObject({
      p_channel_id: CHANNEL,
      p_workspace_id: WS,
      p_provider: "simulated",
      p_routing_key: ROUTING,
      p_provider_event_id: "evt-inbox-1",
      p_provider_event_type: "message.inbound",
      p_body_sha256: sha256(raw),
      p_key_version: "1",
      p_retain_until: new Date(NOW_MS + 3_600_000).toISOString(),
    });
    const plain = decryptWhatsAppInboxBody(
      { keyVersion: args.p_key_version!, nonce: args.p_nonce!, ciphertext: args.p_ciphertext!, authTag: args.p_auth_tag! },
      { environment: "preview", workspaceId: WS, channelId: CHANNEL, provider: "simulated", providerEventId: "evt-inbox-1" },
    );
    expect(Array.from(plain)).toEqual(Array.from(raw));

    const sent = JSON.stringify(args);
    for (const secret of [PHONE, TEXT, "fictícia", Buffer.from(raw).toString("base64"), WEBHOOK_SECRET, INBOX_KEY, CRED_KEY]) {
      expect(sent).not.toContain(secret);
    }
  });

  it("LF e CRLF são bytes distintos: hashes distintos, cada um decifra no seu", async () => {
    const { storeWhatsAppWebhookDelivery } = await loadInbox();
    handlers.whatsapp_inbox_store = () => ({ data: { outcome: "inserted", inbox_id: INBOX_ID }, error: null });
    const resolved = await trustedChannel();
    const lf = bytesOf(simulatedBody([INBOUND], "\n"));
    const crlf = bytesOf(simulatedBody([INBOUND], "\r\n"));
    await storeWhatsAppWebhookDelivery({ channel: resolved.channel, adapter: resolved.adapter, verified: verify(lf), nowMs: NOW_MS });
    await storeWhatsAppWebhookDelivery({ channel: resolved.channel, adapter: resolved.adapter, verified: verify(crlf), nowMs: NOW_MS });
    const [a, b] = storeCalls().map(([, args]) => (args as Record<string, string>).p_body_sha256);
    expect(a).toBe(sha256(lf));
    expect(b).toBe(sha256(crlf));
    expect(a).not.toBe(b);
  });

  it.each(["duplicate", "conflict"])("repassa o resultado %s do banco", async (outcome) => {
    const { storeWhatsAppWebhookDelivery } = await loadInbox();
    handlers.whatsapp_inbox_store = () => ({ data: { outcome, inbox_id: INBOX_ID }, error: null });
    const resolved = await trustedChannel();
    await expect(
      storeWhatsAppWebhookDelivery({ channel: resolved.channel, adapter: resolved.adapter, verified: verify(bytesOf(simulatedBody([INBOUND]))), nowMs: NOW_MS }),
    ).resolves.toEqual({ outcome, inboxId: INBOX_ID });
  });

  it.each([
    ["resultado desconhecido", { outcome: "overwritten", inbox_id: INBOX_ID }],
    ["id inválido", { outcome: "inserted", inbox_id: "x" }],
    ["sem resposta", null],
  ])("resposta fora do contrato vira erro unknown: %s", async (_name, data) => {
    const { storeWhatsAppWebhookDelivery } = await loadInbox();
    handlers.whatsapp_inbox_store = () => ({ data, error: null });
    const resolved = await trustedChannel();
    await expect(
      storeWhatsAppWebhookDelivery({ channel: resolved.channel, adapter: resolved.adapter, verified: verify(bytesOf(simulatedBody([INBOUND]))), nowMs: NOW_MS }),
    ).rejects.toMatchObject({ code: "unknown" });
  });
});

describe("2. só contexto confiável e corpo verificado", () => {
  it("contexto montado à mão com UUIDs: recusado antes do banco", async () => {
    const { storeWhatsAppWebhookDelivery } = await loadInbox();
    const forged = { channelId: CHANNEL, workspaceId: WS, environment: "preview", provider: "simulated", routingKey: ROUTING } as never;
    await expect(
      storeWhatsAppWebhookDelivery({ channel: forged, adapter: new SimulatedWhatsAppProvider(), verified: verify(bytesOf(simulatedBody([INBOUND]))), nowMs: NOW_MS }),
    ).rejects.toMatchObject({ code: "channel_context_untrusted" });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("cópia de um contexto confiável (spread) também é recusada", async () => {
    const { storeWhatsAppWebhookDelivery } = await loadInbox();
    const resolved = await trustedChannel();
    rpcMock.mockClear();
    await expect(
      storeWhatsAppWebhookDelivery({ channel: { ...resolved.channel }, adapter: resolved.adapter, verified: verify(bytesOf(simulatedBody([INBOUND]))), nowMs: NOW_MS }),
    ).rejects.toMatchObject({ code: "channel_context_untrusted" });
    expect(storeCalls()).toHaveLength(0);
  });

  it.each([
    ["bytes crus", () => bytesOf(simulatedBody([INBOUND]))],
    ["objeto que imita o corpo verificado", () => ({ byteLength: 10, decodeUtf8Strict: () => simulatedBody([INBOUND]) })],
  ])("corpo não verificado (%s): recusado antes do banco", async (_name, make) => {
    const { storeWhatsAppWebhookDelivery } = await loadInbox();
    const resolved = await trustedChannel();
    rpcMock.mockClear();
    await expect(
      storeWhatsAppWebhookDelivery({ channel: resolved.channel, adapter: resolved.adapter, verified: make() as never, nowMs: NOW_MS }),
    ).rejects.toMatchObject({ code: "unverified_body" });
    expect(storeCalls()).toHaveLength(0);
  });

  it("adaptador de outro provedor: recusado antes do banco", async () => {
    const { storeWhatsAppWebhookDelivery } = await loadInbox();
    const resolved = await trustedChannel();
    rpcMock.mockClear();
    await expect(
      storeWhatsAppWebhookDelivery({ channel: resolved.channel, adapter: new YCloudWhatsAppProvider(), verified: verify(bytesOf(simulatedBody([INBOUND]))), nowMs: NOW_MS }),
    ).rejects.toMatchObject({ code: "provider_mismatch" });
    expect(storeCalls()).toHaveLength(0);
  });

  it("contexto de Preview usado com o servidor em Production: recusado antes do banco", async () => {
    const { storeWhatsAppWebhookDelivery } = await loadInbox();
    const resolved = await trustedChannel();
    rpcMock.mockClear();
    vi.stubEnv("VERCEL_ENV", "production");
    await expect(
      storeWhatsAppWebhookDelivery({ channel: resolved.channel, adapter: resolved.adapter, verified: verify(bytesOf(simulatedBody([INBOUND]))), nowMs: NOW_MS }),
    ).rejects.toMatchObject({ code: "channel_environment_mismatch" });
    expect(storeCalls()).toHaveLength(0);
  });

  it("lote com mais de um evento não é gravado como uma entrega", async () => {
    const { storeWhatsAppWebhookDelivery } = await loadInbox();
    const resolved = await trustedChannel();
    const raw = bytesOf(simulatedBody([INBOUND, { ...INBOUND, id: "evt-inbox-2", messageId: "m2" }]));
    await expect(
      storeWhatsAppWebhookDelivery({ channel: resolved.channel, adapter: resolved.adapter, verified: verify(raw), nowMs: NOW_MS }),
    ).rejects.toMatchObject({ code: "inbox_batch_not_supported" });
    expect(storeCalls()).toHaveLength(0);
  });

  it("corpo verificado mas fora do contrato do provedor: invalid_payload, sem gravar", async () => {
    const { storeWhatsAppWebhookDelivery } = await loadInbox();
    const resolved = await trustedChannel();
    await expect(
      storeWhatsAppWebhookDelivery({ channel: resolved.channel, adapter: resolved.adapter, verified: verify(bytesOf("{ não é json")), nowMs: NOW_MS }),
    ).rejects.toMatchObject({ code: "invalid_payload" });
    expect(storeCalls()).toHaveLength(0);
  });
});

describe("3. retenção vem de configuração confiável", () => {
  it.each([
    ["ausente", undefined],
    ["vazia", ""],
    ["não numérica", "uma hora"],
    ["zero", "0"],
    ["abaixo do mínimo", "59"],
    ["fracionária", "3600.5"],
    ["acima do teto de 30 dias", String(30 * 86_400 + 1)],
  ])("%s: falha fechada, sem gravar", async (_name, value) => {
    const { storeWhatsAppWebhookDelivery } = await loadInbox();
    const resolved = await trustedChannel();
    if (value === undefined) vi.stubEnv("WHATSAPP_INBOX_RETENTION_SECONDS", undefined as unknown as string);
    else vi.stubEnv("WHATSAPP_INBOX_RETENTION_SECONDS", value);
    await expect(
      storeWhatsAppWebhookDelivery({ channel: resolved.channel, adapter: resolved.adapter, verified: verify(bytesOf(simulatedBody([INBOUND]))), nowMs: NOW_MS }),
    ).rejects.toMatchObject({ code: "retention_not_configured" });
    expect(storeCalls()).toHaveLength(0);
  });

  it("chave da inbox ausente: falha fechada, sem gravar", async () => {
    const { storeWhatsAppWebhookDelivery } = await loadInbox();
    const resolved = await trustedChannel();
    vi.stubEnv("WHATSAPP_INBOX_KEY_VERSIONS", "");
    await expect(
      storeWhatsAppWebhookDelivery({ channel: resolved.channel, adapter: resolved.adapter, verified: verify(bytesOf(simulatedBody([INBOUND]))), nowMs: NOW_MS }),
    ).rejects.toMatchObject({ code: "inbox_crypto_not_configured" });
    expect(storeCalls()).toHaveLength(0);
  });
});

describe("4. leitura de pendente", () => {
  async function storedRow(overrides: Record<string, unknown> = {}, aad: Record<string, unknown> = {}, raw = bytesOf(simulatedBody([INBOUND]))) {
    const { encryptWhatsAppInboxBody } = await loadInboxCrypto();
    const enc = encryptWhatsAppInboxBody(raw, {
      environment: "preview",
      workspaceId: WS,
      channelId: CHANNEL,
      provider: "simulated",
      providerEventId: "evt-inbox-1",
      ...aad,
    } as never);
    return {
      inbox_id: INBOX_ID,
      channel_id: CHANNEL,
      workspace_id: WS,
      environment: "preview",
      provider: "simulated",
      routing_key: ROUTING,
      provider_event_id: "evt-inbox-1",
      provider_event_type: "message.inbound",
      body_sha256: sha256(raw),
      key_version: enc.keyVersion,
      nonce: enc.nonce,
      ciphertext: enc.ciphertext,
      auth_tag: enc.authTag,
      ...overrides,
    };
  }

  it("decifra depois de conferir a identidade e devolve um corpo verificado com os bytes exatos", async () => {
    const { readPendingWhatsAppWebhookDelivery } = await loadInbox();
    const raw = bytesOf(simulatedBody([INBOUND], "\r\n"));
    const row = await storedRow({}, {}, raw);
    handlers.whatsapp_inbox_get_pending = () => ({ data: [row], error: null });
    const resolved = await trustedChannel();
    const entry = await readPendingWhatsAppWebhookDelivery({ channel: resolved.channel, inboxId: INBOX_ID });
    expect(entry).not.toBeNull();
    expect(entry!.inboxId).toBe(INBOX_ID);
    expect(entry!.providerEventId).toBe("evt-inbox-1");
    expect(VerifiedWebhookBody.is(entry!.verified)).toBe(true);
    expect(entry!.verified.decodeUtf8Strict()).toBe(new TextDecoder().decode(raw));
    const [, args] = rpcMock.mock.calls.find(([name]) => name === "whatsapp_inbox_get_pending")!;
    expect(args).toEqual({ p_inbox_id: INBOX_ID, p_channel_id: CHANNEL, p_workspace_id: WS, p_provider: "simulated", p_routing_key: ROUTING });
  });

  it.each([
    ["workspace", { workspace_id: OTHER_WS }],
    ["canal", { channel_id: OTHER_CHANNEL }],
    ["ambiente", { environment: "production" }],
    ["provedor", { provider: "ycloud" }],
    ["routing key", { routing_key: "outra" }],
    ["id da entrada", { inbox_id: "44000000-0000-0000-0000-000000000009" }],
  ])("linha com %s diferente do contexto: recusada sem decifrar", async (_name, patch) => {
    const { readPendingWhatsAppWebhookDelivery } = await loadInbox();
    const row = await storedRow(patch);
    handlers.whatsapp_inbox_get_pending = () => ({ data: [row], error: null });
    const resolved = await trustedChannel();
    await expect(readPendingWhatsAppWebhookDelivery({ channel: resolved.channel, inboxId: INBOX_ID })).rejects.toMatchObject({
      code: "channel_context_mismatch",
    });
  });

  it("texto cifrado com a AAD de outro canal, rotulado com o meu: decifragem falha", async () => {
    const { readPendingWhatsAppWebhookDelivery } = await loadInbox();
    const row = await storedRow({}, { channelId: OTHER_CHANNEL });
    handlers.whatsapp_inbox_get_pending = () => ({ data: [row], error: null });
    const resolved = await trustedChannel();
    await expect(readPendingWhatsAppWebhookDelivery({ channel: resolved.channel, inboxId: INBOX_ID })).rejects.toMatchObject({
      code: "inbox_decrypt_failed",
    });
  });

  it("hash que não confere com os bytes decifrados: inbox_integrity_failed", async () => {
    const { readPendingWhatsAppWebhookDelivery } = await loadInbox();
    const row = await storedRow({ body_sha256: "f".repeat(64) });
    handlers.whatsapp_inbox_get_pending = () => ({ data: [row], error: null });
    const resolved = await trustedChannel();
    await expect(readPendingWhatsAppWebhookDelivery({ channel: resolved.channel, inboxId: INBOX_ID })).rejects.toMatchObject({
      code: "inbox_integrity_failed",
    });
  });

  it("nenhuma pendente: null", async () => {
    const { readPendingWhatsAppWebhookDelivery } = await loadInbox();
    handlers.whatsapp_inbox_get_pending = () => ({ data: [], error: null });
    const resolved = await trustedChannel();
    await expect(readPendingWhatsAppWebhookDelivery({ channel: resolved.channel, inboxId: INBOX_ID })).resolves.toBeNull();
  });

  it("contexto montado à mão: recusado antes do banco", async () => {
    const { readPendingWhatsAppWebhookDelivery } = await loadInbox();
    const forged = { channelId: CHANNEL, workspaceId: WS, environment: "preview", provider: "simulated", routingKey: ROUTING } as never;
    await expect(readPendingWhatsAppWebhookDelivery({ channel: forged, inboxId: INBOX_ID })).rejects.toMatchObject({
      code: "channel_context_untrusted",
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe("5. estados, listagem e expurgo", () => {
  const SAFE_ROW = {
    id: INBOX_ID,
    provider_event_id: "evt-inbox-1",
    provider_event_type: "message.inbound",
    body_sha256: "a".repeat(64),
    received_at: "2026-10-20T12:00:00Z",
    retain_until: "2026-10-20T13:00:00Z",
    state: "processed",
    processed_at: "2026-10-20T12:00:05Z",
    failed_at: null,
    purged_at: null,
    error_code: null,
    conflict_count: 0,
    last_conflict_at: null,
  };

  it("marcar processado: manda a identidade do contexto e devolve só metadado", async () => {
    const { markWhatsAppWebhookDeliveryProcessed } = await loadInbox();
    handlers.whatsapp_inbox_mark_processed = () => ({ data: { ...SAFE_ROW, ciphertext: "QUJD", nonce: "AAAA" }, error: null });
    const resolved = await trustedChannel();
    const entry = await markWhatsAppWebhookDeliveryProcessed({ channel: resolved.channel, inboxId: INBOX_ID });
    expect(entry).toMatchObject({ id: INBOX_ID, state: "processed" });
    expect(Object.keys(entry)).not.toEqual(expect.arrayContaining(["ciphertext"]));
    expect(JSON.stringify(entry)).not.toContain("QUJD");
    const [, args] = rpcMock.mock.calls.find(([name]) => name === "whatsapp_inbox_mark_processed")!;
    expect(args).toEqual({ p_inbox_id: INBOX_ID, p_channel_id: CHANNEL, p_workspace_id: WS, p_provider: "simulated", p_routing_key: ROUTING });
  });

  it.each(["Telefone +5511999990000 inválido", "", "x".repeat(65), "Maiúscula", "com espaço"])(
    "código de erro fora do formato (%s): recusado antes do banco",
    async (code) => {
      const { markWhatsAppWebhookDeliveryFailed } = await loadInbox();
      const resolved = await trustedChannel();
      rpcMock.mockClear();
      await expect(markWhatsAppWebhookDeliveryFailed({ channel: resolved.channel, inboxId: INBOX_ID, errorCode: code })).rejects.toMatchObject({
        code: "invalid_error_code",
      });
      expect(rpcMock).not.toHaveBeenCalled();
    },
  );

  it("marcar falho com código sanitizado", async () => {
    const { markWhatsAppWebhookDeliveryFailed } = await loadInbox();
    handlers.whatsapp_inbox_mark_failed = () => ({
      data: { ...SAFE_ROW, state: "failed", processed_at: null, failed_at: "2026-10-20T12:00:05Z", error_code: "normalizacao_invalida" },
      error: null,
    });
    const resolved = await trustedChannel();
    await expect(
      markWhatsAppWebhookDeliveryFailed({ channel: resolved.channel, inboxId: INBOX_ID, errorCode: "normalizacao_invalida" }),
    ).resolves.toMatchObject({ state: "failed", errorCode: "normalizacao_invalida" });
    const [, args] = rpcMock.mock.calls.find(([name]) => name === "whatsapp_inbox_mark_failed")!;
    expect(args).toMatchObject({ p_error_code: "normalizacao_invalida" });
  });

  it("listagem: só metadado, mesmo que o banco devolva um campo a mais", async () => {
    const { listWhatsAppWebhookInbox } = await loadInbox();
    handlers.whatsapp_inbox_list = () => ({ data: [{ ...SAFE_ROW, ciphertext: "QUJD", nonce: "AAAA", auth_tag: "BBBB", key_version: "1" }], error: null });
    const resolved = await trustedChannel();
    const rows = await listWhatsAppWebhookInbox({ channel: resolved.channel, limit: 10 });
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(
      [
        "bodySha256",
        "conflictCount",
        "errorCode",
        "providerEventType",
        "failedAt",
        "id",
        "lastConflictAt",
        "processedAt",
        "providerEventId",
        "purgedAt",
        "receivedAt",
        "retainUntil",
        "state",
      ].sort(),
    );
  });

  it.each([0, 201, 1.5])("limite fora da faixa (%s): recusado antes do banco", async (limit) => {
    const { listWhatsAppWebhookInbox } = await loadInbox();
    const resolved = await trustedChannel();
    rpcMock.mockClear();
    await expect(listWhatsAppWebhookInbox({ channel: resolved.channel, limit })).rejects.toMatchObject({ code: "invalid_limit" });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("expurgo: só a contagem", async () => {
    const { purgeExpiredWhatsAppWebhookInbox } = await loadInbox();
    handlers.whatsapp_inbox_purge_expired = () => ({ data: { purged: 3 }, error: null });
    await expect(purgeExpiredWhatsAppWebhookInbox({ limit: 100 })).resolves.toEqual({ purged: 3 });
    expect(rpcMock).toHaveBeenCalledWith("whatsapp_inbox_purge_expired", { p_limit: 100 });
  });
});

describe("6. erros e logs sem conteúdo", () => {
  it("código conhecido do banco é repassado; mensagem desconhecida vira unknown sem o texto original", async () => {
    const { storeWhatsAppWebhookDelivery } = await loadInbox();
    const resolved = await trustedChannel();
    const verified = verify(bytesOf(simulatedBody([INBOUND])));

    handlers.whatsapp_inbox_store = () => ({ data: null, error: { message: "channel_not_found" } });
    await expect(storeWhatsAppWebhookDelivery({ channel: resolved.channel, adapter: resolved.adapter, verified, nowMs: NOW_MS })).rejects.toMatchObject({
      code: "channel_not_found",
    });

    handlers.whatsapp_inbox_store = () => ({ data: null, error: { message: `falha com ${PHONE} e ${TEXT}` } });
    const error = await storeWhatsAppWebhookDelivery({ channel: resolved.channel, adapter: resolved.adapter, verified, nowMs: NOW_MS }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "unknown" });
    expect(String(error)).not.toContain(PHONE);
    expect(JSON.stringify(error)).not.toContain(TEXT);
  });

  it("nenhuma operação escreve no console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const { storeWhatsAppWebhookDelivery } = await loadInbox();
    handlers.whatsapp_inbox_store = () => ({ data: { outcome: "conflict", inbox_id: INBOX_ID }, error: null });
    const resolved = await trustedChannel();
    await storeWhatsAppWebhookDelivery({ channel: resolved.channel, adapter: resolved.adapter, verified: verify(bytesOf(simulatedBody([INBOUND]))), nowMs: NOW_MS });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
