/**
 * @vitest-environment node
 *
 * B3.2c — rota pública autenticada do webhook de WhatsApp
 * (`POST /api/webhooks/whatsapp/[provider]/[webhookRouteId]`).
 *
 * Ordem obrigatória: provedor habilitado → localizador opaco válido → bytes
 * exatos → canal pelo localizador (no ambiente autenticado; a routing key
 * real só existe por dentro) → assinatura com o segredo DESSE canal →
 * inspeção mínima e inbox cifrada → evento interno `{ inboxId }`. Nada de
 * normalização, contato, lead ou conversa nesta etapa.
 *
 * Escritos ANTES da implementação, contra a main 7e30e2c; revisados (URL
 * sem routing key, evento mínimo) ANTES da correção, contra o HEAD 68c5f47.
 * O banco e a publicação do evento são simulados. Tudo fictício.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock, publishMock } = vi.hoisted(() => ({ rpcMock: vi.fn(), publishMock: vi.fn() }));

vi.mock("@/server/whatsapp/admin/supabase", () => ({
  createWhatsAppAdminSupabaseClient: () => ({ rpc: rpcMock }),
}));

vi.mock("@/server/whatsapp/inbox-events", () => ({
  WHATSAPP_INBOX_RECEIVED_EVENT: "praxis/whatsapp.inbox.received",
  publishWhatsAppInboxReceived: publishMock,
}));

const loadRoute = () => import("@/app/api/webhooks/whatsapp/[provider]/[webhookRouteId]/route");
const loadHandler = () => import("@/server/whatsapp/webhook-route");

const { encryptWhatsAppCredential } = await import("@/server/whatsapp/credential-crypto");
const { decryptWhatsAppInboxBody } = await import("@/server/whatsapp/inbox-crypto");
const { SimulatedWhatsAppProvider, signSimulatedWebhook, SIMULATED_SIGNATURE_HEADER } = await import(
  "@/server/whatsapp/provider/simulated"
);
const { isPublicPath } = await import("@/proxy");

const WS = "10000000-0000-0000-0000-000000000001";
const CHANNEL = "33000000-0000-0000-0000-000000000021";
const OTHER_CHANNEL = "33000000-0000-0000-0000-000000000022";
const INBOX_ID = "44000000-0000-0000-0000-000000000021";
/** Localizador público: UUID aleatório próprio do canal (versão 4). */
const ROUTE_ID = "7c1a5e2e-3b4f-4c6d-9e8f-0a1b2c3d4e5f";
/** Routing key real, no formato da YCloud (WABA + número do escritório),
 * mesmo num canal simulado: prova que ela nunca sai do servidor. */
const WABA = "100000000000001";
const BIZ_PHONE = "+12025550199";
const ROUTING = `${WABA}:${BIZ_PHONE}`;
const CRED_KEY = Buffer.alloc(32, 7).toString("base64");
const INBOX_KEY = Buffer.alloc(32, 9).toString("base64");
const SECRET = "segredo-simulado-ficticio-rota";
const OTHER_SECRET = "segredo-simulado-ficticio-outro";
const PHONE = "+12025550101";
const TEXT = "Olá, ação — mensagem fictícia 🚀";

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

/** Linha da resolução pelo localizador: canal e routing key real, sem segredo. */
function routeRow(overrides: Record<string, unknown> = {}) {
  return {
    channel_id: CHANNEL,
    workspace_id: WS,
    environment: "preview",
    provider: "simulated",
    routing_key: ROUTING,
    status: "active",
    ...overrides,
  };
}

/** Linha da resolução do webhook (B3.1): canal + segredo cifrado com a AAD
 * do próprio canal da linha. */
function channelRow(overrides: Record<string, unknown> = {}) {
  const enc = encryptWhatsAppCredential(SECRET, {
    environment: "preview",
    workspaceId: WS,
    channelId: typeof overrides.channel_id === "string" ? overrides.channel_id : CHANNEL,
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
  handlers = {
    whatsapp_resolve_webhook_route: () => ({ data: [routeRow()], error: null }),
    whatsapp_resolve_webhook_channel: () => ({ data: [channelRow()], error: null }),
    whatsapp_inbox_store: () => ({ data: { outcome: "inserted", inbox_id: INBOX_ID }, error: null }),
  };
  rpcMock.mockReset();
  rpcMock.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    const handler = handlers[name];
    if (!handler) return { data: null, error: { message: `rpc_nao_esperada:${name}` } };
    return handler(args);
  });
  publishMock.mockReset();
  publishMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);
const sha256 = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex");

const INBOUND = { type: "message.inbound", id: "evt-rota-1", routingKey: ROUTING, messageId: "m1", occurredAt: "2026-10-21T12:00:00Z", from: PHONE, text: TEXT };
const simBody = (events: unknown[], newline = "\n") => `{"version":1,${newline}"events":${JSON.stringify(events)}}`;

type PostOptions = {
  provider?: string;
  webhookRouteId?: string;
  /** `false`: sem cabeçalho; string: segredo usado para assinar. */
  sign?: false | string;
  signBytes?: Uint8Array;
  t?: number;
  headers?: Record<string, string>;
};

const requestedUrls: string[] = [];

async function post(raw: Uint8Array, opts: PostOptions = {}) {
  const { POST } = await loadRoute();
  const provider = opts.provider ?? "simulated";
  const webhookRouteId = opts.webhookRouteId ?? ROUTE_ID;
  const headers: Record<string, string> = { "content-type": "application/json", ...opts.headers };
  if (opts.sign !== false) {
    const t = opts.t ?? Math.floor(Date.now() / 1000);
    headers[SIMULATED_SIGNATURE_HEADER] = signSimulatedWebhook(opts.signBytes ?? raw, opts.sign ?? SECRET, t);
  }
  const url = `https://praxis.invalid/api/webhooks/whatsapp/${provider}/${encodeURIComponent(webhookRouteId)}`;
  requestedUrls.push(url);
  const request = new Request(url, {
    method: "POST",
    headers,
    // Cópia num ArrayBuffer próprio: os mesmos bytes, no tipo que `Request` aceita.
    body: new Uint8Array(raw).buffer,
  });
  const response = await POST(request, { params: Promise.resolve({ provider, webhookRouteId }) });
  const text = await response.text();
  return { status: response.status, text, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

const calls = (name: string) => rpcMock.mock.calls.filter(([n]) => n === name);
const rpcNames = () => rpcMock.mock.calls.map(([n]) => n as string);

// ---------------------------------------------------------------------
// 0. A URL só tem o localizador opaco
// ---------------------------------------------------------------------

describe("0. a URL nunca leva a routing key", () => {
  const base = join(process.cwd(), "src", "app", "api", "webhooks", "whatsapp", "[provider]");

  it("o único segmento dinâmico depois do provedor é [webhookRouteId]", () => {
    expect(existsSync(join(base, "[webhookRouteId]", "route.ts"))).toBe(true);
    expect(existsSync(join(base, "[routingKey]"))).toBe(false);
    expect(readdirSync(base)).toEqual(["[webhookRouteId]"]);
  });

  it("o caminho do webhook de um canal é /api/webhooks/whatsapp/<provedor>/<UUID>, sem WABA, telefone ou routing key", async () => {
    const { whatsappWebhookPath } = await loadHandler();
    const path = whatsappWebhookPath({ provider: "ycloud", webhookRouteId: ROUTE_ID });
    expect(path).toBe(`/api/webhooks/whatsapp/ycloud/${ROUTE_ID}`);
    for (const value of [WABA, BIZ_PHONE, ROUTING, BIZ_PHONE.slice(1), encodeURIComponent(BIZ_PHONE)]) expect(path).not.toContain(value);
  });

  it("o caminho só é montado com um UUID", async () => {
    const { whatsappWebhookPath } = await loadHandler();
    expect(() => whatsappWebhookPath({ provider: "ycloud", webhookRouteId: ROUTING })).toThrow("invalid_webhook_route_id");
  });

  it("uma entrega válida chega por uma URL sem WABA, telefone ou routing key", async () => {
    requestedUrls.length = 0;
    const result = await post(bytes(simBody([INBOUND])));
    expect(result.status).toBe(200);
    expect(requestedUrls).toHaveLength(1);
    for (const url of requestedUrls) {
      for (const value of [WABA, BIZ_PHONE, encodeURIComponent(BIZ_PHONE), ROUTING, encodeURIComponent(ROUTING)]) expect(url).not.toContain(value);
    }
  });
});

// ---------------------------------------------------------------------
// 1. Desligado: nada de banco
// ---------------------------------------------------------------------

describe("1. WhatsApp desligado ou localizador inválido: 404 sem tocar no banco", () => {
  it.each([
    ["WHATSAPP_PROVIDER ausente", () => vi.stubEnv("WHATSAPP_PROVIDER", undefined as unknown as string)],
    ["WHATSAPP_PROVIDER vazio", () => vi.stubEnv("WHATSAPP_PROVIDER", "")],
    ["simulador em Production", () => vi.stubEnv("VERCEL_ENV", "production")],
    ["sem chave de ambiente do WhatsApp", () => vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "")],
    ["chave de ambiente curta", () => vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "curta")],
  ])("%s", async (_name, setup) => {
    setup();
    const result = await post(bytes(simBody([INBOUND])));
    expect(result.status).toBe(404);
    expect(result.json).toEqual({ error: "not_found" });
    expect(rpcMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it.each([
    ["provedor desconhecido", { provider: "desconhecido" }],
    ["provedor diferente do habilitado", { provider: "ycloud" }],
    ["provedor em maiúsculas", { provider: "SIMULATED" }],
  ])("%s: 404 sem banco", async (_name, opts) => {
    const result = await post(bytes(simBody([INBOUND])), opts);
    expect(result.status).toBe(404);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("YCloud habilitado, mas sem adaptador registrado nesta etapa: 404 sem banco", async () => {
    vi.stubEnv("WHATSAPP_PROVIDER", "ycloud");
    const result = await post(bytes("{}"), { provider: "ycloud", sign: false });
    expect(result.status).toBe(404);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it.each([
    ["vazio", ""],
    ["não é UUID", "nao-e-uuid"],
    ["a routing key real", ROUTING],
    ["o WABA", WABA],
    ["o telefone do escritório", BIZ_PHONE],
    ["UUID com caractere inválido", "7c1a5e2e-3b4f-4c6d-9e8f-0a1b2c3d4e5g"],
    ["UUID curto", "7c1a5e2e-3b4f-4c6d-9e8f-0a1b2c3d4e5"],
    ["UUID com espaço", ` ${ROUTE_ID}`],
  ])("localizador %s: 404 e nenhuma consulta", async (_name, webhookRouteId) => {
    const result = await post(bytes(simBody([INBOUND])), { webhookRouteId });
    expect(result.status).toBe(404);
    expect(result.json).toEqual({ error: "not_found" });
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// 2. Bytes exatos
// ---------------------------------------------------------------------

describe("2. bytes exatos", () => {
  it("corpo acima de 256 KiB: 413 antes de qualquer banco", async () => {
    const raw = new Uint8Array(256 * 1024 + 1).fill(0x20);
    const result = await post(raw, { sign: false });
    expect(result.status).toBe(413);
    expect(result.json).toEqual({ error: "payload_too_large" });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("Content-Length declarado acima do limite: 413 antes de qualquer banco", async () => {
    const result = await post(bytes(simBody([INBOUND])), { headers: { "content-length": String(256 * 1024 + 1) } });
    expect(result.status).toBe(413);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("BOM (UTF-8 estrita, como na B3.1): autêntico, mas recusado com 400, sem gravar", async () => {
    const result = await post(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(simBody([INBOUND]))]));
    expect(result.status).toBe(400);
    expect(calls("whatsapp_inbox_store")).toHaveLength(0);
  });

  it("CRLF preservado: a inbox recebe e cifra exatamente os bytes assinados", async () => {
    const raw = bytes(simBody([INBOUND], "\r\n"));
    const result = await post(raw);
    expect(result.status).toBe(200);
    const [[, args]] = calls("whatsapp_inbox_store") as [[string, Record<string, string>]];
    expect(args.p_body_sha256).toBe(sha256(raw));
    const plain = decryptWhatsAppInboxBody(
      { keyVersion: args.p_key_version!, nonce: args.p_nonce!, ciphertext: args.p_ciphertext!, authTag: args.p_auth_tag! },
      { environment: "preview", workspaceId: WS, channelId: CHANNEL, provider: "simulated", providerEventId: "evt-rota-1" },
    );
    expect(Array.from(plain)).toEqual(Array.from(raw));
  });
});

// ---------------------------------------------------------------------
// 3. Canal pelo localizador opaco, ANTES da assinatura
// ---------------------------------------------------------------------

describe("3. canal pelo localizador opaco, antes da assinatura", () => {
  it("resolve pelo localizador, recebe a routing key real por dentro e só depois grava", async () => {
    const result = await post(bytes(simBody([INBOUND])));
    expect(result.status).toBe(200);
    expect(rpcNames()).toEqual(["whatsapp_resolve_webhook_route", "whatsapp_resolve_webhook_channel", "whatsapp_inbox_store"]);
    expect(calls("whatsapp_resolve_webhook_route")[0]![1]).toEqual({ p_provider: "simulated", p_webhook_route_id: ROUTE_ID });
    // A routing key real vem do banco, nunca da URL.
    expect(calls("whatsapp_resolve_webhook_channel")[0]![1]).toEqual({ p_provider: "simulated", p_routing_key: ROUTING });
    expect(calls("whatsapp_inbox_store")[0]![1]).toMatchObject({ p_channel_id: CHANNEL, p_workspace_id: WS, p_routing_key: ROUTING });
  });

  it("localizador em maiúsculas é o mesmo UUID", async () => {
    const result = await post(bytes(simBody([INBOUND])), { webhookRouteId: ROUTE_ID.toUpperCase() });
    expect(result.status).toBe(200);
    expect(calls("whatsapp_resolve_webhook_route")[0]![1]).toEqual({ p_provider: "simulated", p_webhook_route_id: ROUTE_ID });
  });

  it("localizador desconhecido, de canal desativado ou de outro ambiente: 404, só uma consulta", async () => {
    handlers.whatsapp_resolve_webhook_route = () => ({ data: [], error: null });
    const result = await post(bytes(simBody([INBOUND])));
    expect(result.status).toBe(404);
    expect(result.json).toEqual({ error: "not_found" });
    expect(rpcNames()).toEqual(["whatsapp_resolve_webhook_route"]);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it.each([
    ["de outro ambiente", { environment: "production" }],
    ["de outro provedor", { provider: "ycloud" }],
    ["sem routing key", { routing_key: "" }],
  ])("linha do localizador %s devolvida por engano: 404, sem segredo nem gravação", async (_name, patch) => {
    handlers.whatsapp_resolve_webhook_route = () => ({ data: [routeRow(patch)], error: null });
    const result = await post(bytes(simBody([INBOUND])));
    expect(result.status).toBe(404);
    expect(rpcNames()).toEqual(["whatsapp_resolve_webhook_route"]);
  });

  it("mais de uma linha para o localizador: 404, sem seguir", async () => {
    handlers.whatsapp_resolve_webhook_route = () => ({ data: [routeRow(), routeRow({ channel_id: OTHER_CHANNEL })], error: null });
    const result = await post(bytes(simBody([INBOUND])));
    expect(result.status).toBe(404);
    expect(rpcNames()).toEqual(["whatsapp_resolve_webhook_route"]);
  });

  it("a resolução do segredo devolve outro canal: 404, sem gravar", async () => {
    handlers.whatsapp_resolve_webhook_channel = () => ({ data: [channelRow({ channel_id: OTHER_CHANNEL })], error: null });
    const result = await post(bytes(simBody([INBOUND])));
    expect(result.status).toBe(404);
    expect(calls("whatsapp_inbox_store")).toHaveLength(0);
  });

  it("canal desativado entre as duas resoluções: 404, sem gravar", async () => {
    handlers.whatsapp_resolve_webhook_channel = () => ({ data: [], error: null });
    const result = await post(bytes(simBody([INBOUND])));
    expect(result.status).toBe(404);
    expect(calls("whatsapp_inbox_store")).toHaveLength(0);
  });

  it.each(["whatsapp_resolve_webhook_route", "whatsapp_resolve_webhook_channel"])("falha do banco em %s: 503, sem detalhe", async (name) => {
    handlers[name] = () => ({ data: null, error: { message: `erro interno com ${BIZ_PHONE} e ${ROUTING}` } });
    const result = await post(bytes(simBody([INBOUND])));
    expect(result.status).toBe(503);
    expect(result.json).toEqual({ error: "service_unavailable" });
    for (const value of [BIZ_PHONE, ROUTING, "erro interno"]) expect(result.text).not.toContain(value);
  });
});

// ---------------------------------------------------------------------
// 4. Assinatura com o segredo do canal resolvido
// ---------------------------------------------------------------------

describe("4. assinatura sobre os bytes, com o segredo do canal resolvido", () => {
  it.each([
    ["sem cabeçalho", { sign: false as const }],
    ["segredo de outro canal", { sign: OTHER_SECRET }],
    ["assinatura de outros bytes", { signBytes: bytes(simBody([{ ...INBOUND, text: "outro texto" }])) }],
    ["horário vencido", { t: Math.floor(Date.now() / 1000) - 3600 }],
    ["horário no futuro", { t: Math.floor(Date.now() / 1000) + 3600 }],
    ["cabeçalho malformado", { sign: false as const, headers: { [SIMULATED_SIGNATURE_HEADER]: "qualquer coisa" } }],
  ])("%s: 401 igual para todos, sem gravar nem publicar", async (_name, opts) => {
    const result = await post(bytes(simBody([INBOUND])), opts);
    expect(result.status).toBe(401);
    expect(result.json).toEqual({ error: "invalid_signature" });
    expect(calls("whatsapp_inbox_store")).toHaveLength(0);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("um byte alterado depois de assinar: 401", async () => {
    const raw = bytes(simBody([INBOUND]));
    const tampered = raw.slice();
    tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 0x01;
    const result = await post(tampered, { signBytes: raw });
    expect(result.status).toBe(401);
    expect(calls("whatsapp_inbox_store")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// 5. Inbox cifrada e evento interno mínimo
// ---------------------------------------------------------------------

describe("5. inbox cifrada e evento interno { inboxId }", () => {
  it("primeira entrega: 200 e um evento só com o id da inbox", async () => {
    const result = await post(bytes(simBody([INBOUND])));
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ status: "received" });
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock.mock.calls[0]).toEqual([{ inboxId: INBOX_ID }]);
  });

  it("duplicata republica exatamente o mesmo evento", async () => {
    await post(bytes(simBody([INBOUND])));
    handlers.whatsapp_inbox_store = () => ({ data: { outcome: "duplicate", inbox_id: INBOX_ID }, error: null });
    const result = await post(bytes(simBody([INBOUND])));
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ status: "received" });
    expect(publishMock).toHaveBeenCalledTimes(2);
    expect(publishMock.mock.calls[1]).toEqual(publishMock.mock.calls[0]);
    expect(publishMock.mock.calls[1]).toEqual([{ inboxId: INBOX_ID }]);
  });

  it("conflito: 200 (sem nova tentativa do provedor) e nenhum evento", async () => {
    handlers.whatsapp_inbox_store = () => ({ data: { outcome: "conflict", inbox_id: INBOX_ID }, error: null });
    const result = await post(bytes(simBody([INBOUND])));
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ status: "received" });
    expect(publishMock).not.toHaveBeenCalled();
  });

  it.each(["paused", "disconnected"])("canal %s: guarda (200), mas não publica evento", async (status) => {
    handlers.whatsapp_resolve_webhook_route = () => ({ data: [routeRow({ status })], error: null });
    handlers.whatsapp_resolve_webhook_channel = () => ({ data: [channelRow({ status })], error: null });
    const result = await post(bytes(simBody([INBOUND])));
    expect(result.status).toBe(200);
    expect(calls("whatsapp_inbox_store")).toHaveLength(1);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("falha ao publicar: continua 200 e a entrada fica pendente (nada é marcado nem apagado)", async () => {
    publishMock.mockRejectedValue(new Error(`falha com ${PHONE} e ${INBOX_ID}`));
    const result = await post(bytes(simBody([INBOUND])));
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ status: "received" });
    expect(rpcNames()).toEqual(["whatsapp_resolve_webhook_route", "whatsapp_resolve_webhook_channel", "whatsapp_inbox_store"]);
    for (const value of [PHONE, INBOX_ID, "falha com"]) expect(result.text).not.toContain(value);
  });

  it("evento autêntico sem identidade: guardado, sem normalizar", async () => {
    const normalize = vi.spyOn(SimulatedWhatsAppProvider.prototype, "normalizeEvents");
    const { from: _from, ...withoutIdentity } = INBOUND;
    const result = await post(bytes(simBody([withoutIdentity])));
    expect(result.status).toBe(200);
    expect(calls("whatsapp_inbox_store")).toHaveLength(1);
    expect(normalize).not.toHaveBeenCalled();
  });

  it("nenhuma normalização em entrega normal", async () => {
    const normalize = vi.spyOn(SimulatedWhatsAppProvider.prototype, "normalizeEvents");
    await post(bytes(simBody([INBOUND])));
    expect(normalize).not.toHaveBeenCalled();
  });

  it.each([
    ["JSON inválido", "{ não é json"],
    ["lote", simBody([INBOUND, { ...INBOUND, id: "evt-rota-2" }])],
    ["versão incompatível", JSON.stringify({ version: 2, events: [INBOUND] })],
    ["envelope sem id", simBody([(({ id: _id, ...rest }) => rest)(INBOUND)])],
  ])("autêntico, mas %s: 400, sem gravar nem publicar", async (_name, text) => {
    const result = await post(bytes(text));
    expect(result.status).toBe(400);
    expect(result.json).toEqual({ error: "invalid_payload" });
    expect(calls("whatsapp_inbox_store")).toHaveLength(0);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it.each([
    ["sem retenção configurada", () => vi.stubEnv("WHATSAPP_INBOX_RETENTION_SECONDS", undefined as unknown as string)],
    ["sem chave da inbox", () => vi.stubEnv("WHATSAPP_INBOX_KEY_VERSIONS", "")],
  ])("%s: 503 (o provedor tenta de novo), sem gravar nem publicar", async (_name, setup) => {
    setup();
    const result = await post(bytes(simBody([INBOUND])));
    expect(result.status).toBe(503);
    expect(result.json).toEqual({ error: "service_unavailable" });
    expect(calls("whatsapp_inbox_store")).toHaveLength(0);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("canal desativado entre a resolução e a gravação: 404, sem publicar", async () => {
    handlers.whatsapp_inbox_store = () => ({ data: null, error: { message: "channel_not_found" } });
    const result = await post(bytes(simBody([INBOUND])));
    expect(result.status).toBe(404);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("falha desconhecida do banco na gravação: 503, sem detalhe", async () => {
    handlers.whatsapp_inbox_store = () => ({ data: null, error: { message: `falha com ${TEXT}` } });
    const result = await post(bytes(simBody([INBOUND])));
    expect(result.status).toBe(503);
    expect(result.text).not.toContain(TEXT);
    expect(publishMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// 6. Nada de conteúdo sai da rota
// ---------------------------------------------------------------------

describe("6. nada de conteúdo, id interno, routing key ou log", () => {
  const FORBIDDEN = [PHONE, TEXT, INBOX_ID, CHANNEL, WS, SECRET, ROUTING, WABA, BIZ_PHONE, "rpc_nao_esperada", "Error"];

  it("as respostas não trazem conteúdo, telefone, WABA, routing key, ids internos, segredo ou erro bruto", async () => {
    const results = [await post(bytes(simBody([INBOUND])))];
    handlers.whatsapp_inbox_store = () => ({ data: { outcome: "duplicate", inbox_id: INBOX_ID }, error: null });
    results.push(await post(bytes(simBody([INBOUND]))));
    results.push(await post(bytes(simBody([INBOUND])), { sign: OTHER_SECRET }));
    handlers.whatsapp_resolve_webhook_channel = () => ({ data: null, error: { message: `erro bruto ${ROUTING}` } });
    results.push(await post(bytes(simBody([INBOUND]))));
    handlers.whatsapp_resolve_webhook_route = () => ({ data: [], error: null });
    results.push(await post(bytes(simBody([INBOUND]))));
    for (const r of results) for (const value of FORBIDDEN) expect(r.text).not.toContain(value);
  });

  it("nenhuma etapa escreve no console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    publishMock.mockRejectedValue(new Error("falha"));
    await post(bytes(simBody([INBOUND])));
    await post(bytes(simBody([INBOUND])), { sign: OTHER_SECRET });
    handlers.whatsapp_resolve_webhook_route = () => ({ data: null, error: { message: "x" } });
    await post(bytes(simBody([INBOUND])));
    await post(bytes(simBody([INBOUND])), { webhookRouteId: ROUTING });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("a rota é pública (sem sessão): autenticada pela assinatura do canal", () => {
    expect(isPublicPath(`/api/webhooks/whatsapp/simulated/${ROUTE_ID}`)).toBe(true);
    expect(isPublicPath("/api/webhooks/outro")).toBe(false);
    expect(isPublicPath("/api/webhooks/whatsappx")).toBe(false);
  });

  it("runtime Node e sem cache", async () => {
    const route = await loadRoute();
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
  });
});
