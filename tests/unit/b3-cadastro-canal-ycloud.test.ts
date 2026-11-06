/**
 * @vitest-environment node
 *
 * B3 — cadastro controlado de canal YCloud (§28.17), camada do servidor. O banco
 * é simulado: só se observa O QUE é pedido a ele. A parte do banco (papéis,
 * ambiente assinado, unicidade, localizador, credenciais, atomicidade) está em
 * supabase/tests/database/42_b3_cadastro_canal_ycloud.test.sql.
 *
 * Aqui: permissão pela sessão; entrada estrita (workspace, usuário, papel,
 * ambiente e provedor nunca vêm do chamador); YCloud habilitada e cifra
 * configurada; credenciais cifradas antes do banco, com a AAD do canal; nenhum
 * segredo em retorno, erro ou log; falha do banco sem segundo pedido.
 * Valores fictícios.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock, guardMock } = vi.hoisted(() => ({ rpcMock: vi.fn(), guardMock: vi.fn() }));

vi.mock("@/server/authz/safe", () => ({ requirePermissionSafe: guardMock }));
vi.mock("@/server/whatsapp/admin/supabase", () => ({
  createWhatsAppAdminSupabaseClient: () => ({ rpc: rpcMock }),
}));

const service = await import("@/modules/whatsapp-channels/service");
const { decryptWhatsAppCredential } = await import("@/server/whatsapp/credential-crypto");

const WS = "10000000-0000-0000-0000-000000000001";
const OTHER_WS = "10000000-0000-0000-0000-000000000002";
const USER = "20000000-0000-0000-0000-000000000001";
const ROUTE_ID = "7c1a5e2e-3b4f-4c6d-9e8f-0a1b2c3d4e5f";
const KEY = Buffer.alloc(32, 5).toString("base64");
const API_KEY = "ycloud-api-key-ficticia-0123456789";
const NEW_SECRET = "whsec-ficticio-9876543210";
const ROUTING_KEY = "WABAFICTICIO:5511000000001";
const INPUT = { label: "Canal YCloud", routingKey: ROUTING_KEY, displayPhoneNumber: "+55 11 0000-0303", apiKey: API_KEY };

type Call = { fn: string; args: Record<string, unknown> };
const calls = (): Call[] => rpcMock.mock.calls.map(([fn, args]) => ({ fn: fn as string, args: args as Record<string, unknown> }));
const createArgs = () => calls().find((c) => c.fn === "whatsapp_create_ycloud_channel")!.args;

function safeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "51000000-0000-0000-0000-00000000000a",
    label: "Canal YCloud",
    provider: "ycloud",
    environment: "preview",
    routing_key: ROUTING_KEY,
    display_phone_number: "+55 11 0000-0303",
    is_simulator: false,
    status: "paused",
    send_enabled: false,
    status_changed_at: "2026-11-06T12:00:00Z",
    created_at: "2026-11-06T12:00:00Z",
    updated_at: "2026-11-06T12:00:00Z",
    credential_purposes: ["api_key", "webhook_secret"],
    ...overrides,
  };
}

function configure() {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "chave-de-teste-b3-whatsapp-0123456789");
  vi.stubEnv("WHATSAPP_PROVIDER", "ycloud");
  vi.stubEnv("WHATSAPP_CREDENTIAL_KEY_VERSIONS", JSON.stringify({ "1": KEY }));
  vi.stubEnv("WHATSAPP_CREDENTIAL_ACTIVE_KEY_VERSION", "1");
}

let spies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  rpcMock.mockReset();
  guardMock.mockReset();
  guardMock.mockResolvedValue({ ctx: { userId: USER, workspaceId: WS, membershipId: "m", role: "owner" } });
  rpcMock.mockImplementation(async (fn: string) =>
    fn === "whatsapp_create_ycloud_channel" ? { data: { ...safeRow(), webhook_route_id: ROUTE_ID }, error: null } : { data: safeRow(), error: null },
  );
  configure();
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const everythingPrinted = () => spies.flatMap((spy) => (spy.mock.calls as unknown[][]).map((c) => JSON.stringify(c))).join("\n");

describe("quem cria e o que o chamador pode informar", () => {
  it.each(["owner", "admin"])("%s cria: workspace e ator vêm só da sessão", async (role) => {
    guardMock.mockResolvedValue({ ctx: { userId: USER, workspaceId: WS, membershipId: "m", role } });
    const result = await service.createYCloudWhatsAppChannel(INPUT);
    expect(result.ok).toBe(true);
    expect(guardMock).toHaveBeenCalledWith("channel.manage");
    expect(createArgs()).toMatchObject({ p_workspace_id: WS, p_actor_user_id: USER, p_routing_key: ROUTING_KEY });
  });

  it("sem permissão (manager e demais papéis): nada é pedido ao banco", async () => {
    guardMock.mockResolvedValue({ error: "Você não tem permissão para fazer isso." });
    const results = await Promise.all([
      service.createYCloudWhatsAppChannel(INPUT),
      service.storeWhatsAppChannelCredential({ channelId: ROUTE_ID, purpose: "webhook_secret", secret: NEW_SECRET }),
    ]);
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it.each([
    ["workspaceId", { workspaceId: OTHER_WS }],
    ["actorUserId", { actorUserId: USER }],
    ["role", { role: "owner" }],
    ["environment", { environment: "production" }],
    ["provider", { provider: "simulated" }],
    ["webhookRouteId", { webhookRouteId: ROUTE_ID }],
    ["sendEnabled", { sendEnabled: true }],
    ["status", { status: "active" }],
  ])("campo %s vindo do chamador é recusado", async (_nome, extra) => {
    const create = await service.createYCloudWhatsAppChannel({ ...INPUT, ...extra });
    const store = await service.storeWhatsAppChannelCredential({ channelId: ROUTE_ID, purpose: "webhook_secret", secret: NEW_SECRET, ...extra });
    expect(create.ok).toBe(false);
    expect(store.ok).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it.each([
    ["credencial curta", { apiKey: "curta" }],
    ["credencial com espaço", { apiKey: "chave com espaco 123456" }],
    ["credencial com quebra de linha", { apiKey: "chave-123456\nsegunda" }],
    ["routing key com barra", { routingKey: "waba/phone" }],
    ["sem rótulo", { label: " " }],
  ])("entrada inválida (%s): nada é pedido ao banco", async (_nome, extra) => {
    expect((await service.createYCloudWhatsAppChannel({ ...INPUT, ...extra })).ok).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it.each([
    ["sem WHATSAPP_ENV_SIGNING_KEY", { WHATSAPP_ENV_SIGNING_KEY: "" }],
    ["chave de ambiente curta demais", { WHATSAPP_ENV_SIGNING_KEY: "curta" }],
    ["YCloud não habilitada (variável ausente)", { WHATSAPP_PROVIDER: "" }],
    ["outro provedor habilitado (simulated)", { WHATSAPP_PROVIDER: "simulated" }],
    ["outro provedor habilitado (meta)", { WHATSAPP_PROVIDER: "meta" }],
    ["variável em maiúsculas", { WHATSAPP_PROVIDER: "YCLOUD" }],
    ["cifra não configurada", { WHATSAPP_CREDENTIAL_KEY_VERSIONS: "" }],
  ])("recusado antes do banco: %s", async (_nome, env) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const result = await service.createYCloudWhatsAppChannel(INPUT);
    expect(result.ok).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe("o que vai ao banco e o que volta", () => {
  it("o provedor e o ambiente não são parâmetros: o banco os decide", async () => {
    await service.createYCloudWhatsAppChannel(INPUT);
    expect(Object.keys(createArgs()).sort()).toEqual(
      [
        "p_actor_user_id",
        "p_api_key_ciphertext",
        "p_api_key_key_version",
        "p_channel_id",
        "p_display_phone_number",
        "p_label",
        "p_routing_key",
        "p_webhook_secret_ciphertext",
        "p_webhook_secret_key_version",
        "p_workspace_id",
      ].sort(),
    );
  });

  it("a chave de API vai cifrada, com a AAD do canal, e nada em texto puro", async () => {
    await service.createYCloudWhatsAppChannel(INPUT);
    const args = createArgs();
    expect(JSON.stringify(args)).not.toContain(API_KEY);
    const ctx = { environment: "preview" as const, workspaceId: WS, channelId: args.p_channel_id as string, provider: "ycloud" as const };
    expect(decryptWhatsAppCredential(args.p_api_key_ciphertext as string, args.p_api_key_key_version as string, { ...ctx, purpose: "api_key" })).toBe(API_KEY);
    // AAD presa à finalidade: o texto cifrado da chave de API não abre como segredo do webhook.
    expect(() =>
      decryptWhatsAppCredential(args.p_api_key_ciphertext as string, args.p_api_key_key_version as string, { ...ctx, purpose: "webhook_secret" }),
    ).toThrow();
    // ...nem em outro canal ou outro workspace.
    expect(() =>
      decryptWhatsAppCredential(args.p_api_key_ciphertext as string, args.p_api_key_key_version as string, { ...ctx, purpose: "api_key", workspaceId: OTHER_WS }),
    ).toThrow();
  });

  it("o segredo do webhook nasce provisório, aleatório e diferente a cada canal", async () => {
    await service.createYCloudWhatsAppChannel(INPUT);
    await service.createYCloudWhatsAppChannel(INPUT);
    const [first, second] = calls().map((c) => c.args);
    const open = (args: Record<string, unknown>) =>
      decryptWhatsAppCredential(args.p_webhook_secret_ciphertext as string, args.p_webhook_secret_key_version as string, {
        environment: "preview",
        workspaceId: WS,
        channelId: args.p_channel_id as string,
        provider: "ycloud",
        purpose: "webhook_secret",
      });
    expect(open(first!)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(open(first!)).not.toBe(open(second!));
    expect(open(first!)).not.toBe(API_KEY);
    expect(first!.p_channel_id).not.toBe(second!.p_channel_id);
  });

  it("devolve o canal seguro e o localizador do webhook, sem credencial", async () => {
    const result = await service.createYCloudWhatsAppChannel(INPUT);
    expect(result).toMatchObject({
      ok: true,
      data: { provider: "ycloud", environment: "preview", status: "paused", sendEnabled: false, isSimulator: false, webhookRouteId: ROUTE_ID },
    });
    const text = JSON.stringify(result);
    const args = createArgs();
    for (const secret of [API_KEY, args.p_api_key_ciphertext, args.p_webhook_secret_ciphertext]) expect(text).not.toContain(secret as string);
    expect(text).not.toMatch(/ciphertext|key_version|keyVersion|apiKey/i);
  });

  it("resposta do banco sem localizador, ou de outro ambiente: falha sem devolver o canal", async () => {
    rpcMock.mockResolvedValueOnce({ data: safeRow(), error: null });
    expect((await service.createYCloudWhatsAppChannel(INPUT)).ok).toBe(false);
    rpcMock.mockResolvedValueOnce({ data: { ...safeRow({ environment: "production" }), webhook_route_id: ROUTE_ID }, error: null });
    expect((await service.createYCloudWhatsAppChannel(INPUT)).ok).toBe(false);
  });
});

describe("chamada administrativa direta (sem sessão), como na configuração do Preview", () => {
  it.each([
    ["YCloud não habilitada", { WHATSAPP_PROVIDER: "" }],
    ["outro provedor habilitado", { WHATSAPP_PROVIDER: "simulated" }],
  ])("falha fechada antes do banco: %s", async (_nome, env) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const { adminCreateYCloudWhatsAppChannel, WhatsAppChannelStoreError } = await import("@/server/whatsapp/admin/channels");
    const erro = await adminCreateYCloudWhatsAppChannel({ workspaceId: WS, actorUserId: USER, ...INPUT }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(WhatsAppChannelStoreError);
    expect(erro).toMatchObject({ code: "whatsapp_provider_unavailable" });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("habilitada: cria e devolve o localizador", async () => {
    const { adminCreateYCloudWhatsAppChannel } = await import("@/server/whatsapp/admin/channels");
    await expect(adminCreateYCloudWhatsAppChannel({ workspaceId: WS, actorUserId: USER, ...INPUT })).resolves.toMatchObject({
      provider: "ycloud",
      status: "paused",
      sendEnabled: false,
      webhookRouteId: ROUTE_ID,
    });
  });
});

describe("falhas", () => {
  it("routing key duplicada: mensagem fixa, sem dizer de quem é nem repetir a chave", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "channel_routing_key_taken" } });
    const result = await service.createYCloudWhatsAppChannel(INPUT);
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result);
    expect(text).not.toContain(ROUTING_KEY);
    expect(text).not.toMatch(/workspace|credencial|segredo/i);
  });

  it("falha no meio: um único pedido ao banco, sem segunda tentativa, e nada vaza", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: `erro cru com ${API_KEY} e ${ROUTING_KEY}` } });
    const result = await service.createYCloudWhatsAppChannel(INPUT);
    expect(result.ok).toBe(false);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    const printed = `${JSON.stringify(result)}\n${everythingPrinted()}`;
    for (const secret of [API_KEY, ROUTING_KEY, createArgs().p_api_key_ciphertext as string]) expect(printed).not.toContain(secret);
  });

  it("banco que não responde: a falha é tratada e nada vaza", async () => {
    rpcMock.mockRejectedValue(new TypeError(`fetch failed ${API_KEY}`));
    const result = await service.createYCloudWhatsAppChannel(INPUT);
    expect(result.ok).toBe(false);
    expect(`${JSON.stringify(result)}\n${everythingPrinted()}`).not.toContain(API_KEY);
  });
});

describe("substituição de credencial (segredo real do webhook)", () => {
  const CHANNEL = "51000000-0000-0000-0000-00000000000a";

  it("lê o estado do canal no banco, cifra com o provedor e o ambiente DELE e não devolve o valor", async () => {
    const result = await service.storeWhatsAppChannelCredential({ channelId: CHANNEL, purpose: "webhook_secret", secret: NEW_SECRET });
    expect(result.ok).toBe(true);
    expect(calls().map((c) => c.fn)).toEqual(["whatsapp_get_channel_state", "whatsapp_store_channel_credential"]);
    const args = calls()[1]!.args;
    expect(args).toMatchObject({ p_channel_id: CHANNEL, p_workspace_id: WS, p_actor_user_id: USER, p_purpose: "webhook_secret" });
    expect(JSON.stringify(args)).not.toContain(NEW_SECRET);
    expect(
      decryptWhatsAppCredential(args.p_ciphertext as string, args.p_key_version as string, {
        environment: "preview",
        workspaceId: WS,
        channelId: CHANNEL,
        provider: "ycloud",
        purpose: "webhook_secret",
      }),
    ).toBe(NEW_SECRET);
    expect(`${JSON.stringify(result)}\n${everythingPrinted()}`).not.toContain(NEW_SECRET);
  });

  it("canal que o banco não confirma para este ator: nada é gravado", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "channel_not_found" } });
    const result = await service.storeWhatsAppChannelCredential({ channelId: CHANNEL, purpose: "api_key", secret: NEW_SECRET });
    expect(result.ok).toBe(false);
    expect(calls().map((c) => c.fn)).toEqual(["whatsapp_get_channel_state"]);
  });
});
