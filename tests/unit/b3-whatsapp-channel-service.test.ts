/**
 * @vitest-environment node
 *
 * B3.1 — operações internas de canal de WhatsApp. Permissão pela sessão,
 * entrada estrita (workspace, usuário, papel e ambiente nunca vêm do
 * formulário), ambiente próprio configurado, e nenhuma credencial em
 * retorno ou erro. O banco é simulado: só se observa O QUE é pedido a ele.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock, guardMock } = vi.hoisted(() => ({ rpcMock: vi.fn(), guardMock: vi.fn() }));

vi.mock("@/server/authz/safe", () => ({ requirePermissionSafe: guardMock }));
vi.mock("@/server/whatsapp/admin/supabase", () => ({
  createWhatsAppAdminSupabaseClient: () => ({ rpc: rpcMock }),
}));

const service = await import("@/modules/whatsapp-channels/service");
const { mapSafeChannel, adminReadWhatsAppChannelCredential } = await import("@/server/whatsapp/admin/channels");
const { encryptWhatsAppCredential } = await import("@/server/whatsapp/credential-crypto");
const { roleHasPermission, ROLES } = await import("@/lib/roles");

const WS = "10000000-0000-0000-0000-000000000001";
const OTHER_WS = "10000000-0000-0000-0000-000000000002";
const USER = "20000000-0000-0000-0000-000000000001";
const CHANNEL = "30000000-0000-0000-0000-000000000001";
const KEY = Buffer.alloc(32, 5).toString("base64");

function safeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CHANNEL,
    label: "Canal simulado",
    provider: "simulated",
    environment: "preview",
    routing_key: "sim-1",
    display_phone_number: "+55 11 0000-0001",
    is_simulator: true,
    status: "active",
    send_enabled: false,
    status_changed_at: "2026-10-19T12:00:00Z",
    created_at: "2026-10-19T12:00:00Z",
    updated_at: "2026-10-19T12:00:00Z",
    credential_purposes: ["webhook_secret"],
    ...overrides,
  };
}

function configure() {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "chave-de-teste-b3-whatsapp-0123456789");
  vi.stubEnv("WHATSAPP_PROVIDER", "simulated");
  vi.stubEnv("WHATSAPP_CREDENTIAL_KEY_VERSIONS", JSON.stringify({ "1": KEY }));
  vi.stubEnv("WHATSAPP_CREDENTIAL_ACTIVE_KEY_VERSION", "1");
}

beforeEach(() => {
  rpcMock.mockReset();
  guardMock.mockReset();
  guardMock.mockResolvedValue({ ctx: { userId: USER, workspaceId: WS, membershipId: "m", role: "owner" } });
  configure();
});
afterEach(() => vi.unstubAllEnvs());

describe("matriz de papéis", () => {
  it("channel.manage só para owner e admin", () => {
    const allowed = ROLES.filter((role) => roleHasPermission(role, "channel.manage"));
    expect(allowed).toEqual(["owner", "admin"]);
    for (const role of ["manager", "lawyer", "sales", "viewer"] as const) {
      expect(roleHasPermission(role, "channel.manage")).toBe(false);
    }
  });

  it("permissões da A7 sem regressão", () => {
    const by = (p: Parameters<typeof roleHasPermission>[1]) => ROLES.filter((r) => roleHasPermission(r, p));
    expect(by("conversation.view")).toEqual(["owner", "admin", "manager", "lawyer", "sales", "viewer"]);
    expect(by("conversation.send")).toEqual(["owner", "admin", "manager", "lawyer", "sales"]);
    expect(by("conversation.link")).toEqual(["owner", "admin", "manager"]);
    expect(by("conversation.simulate")).toEqual(["owner", "admin"]);
    expect(by("contact.consent_manage")).toEqual(["owner", "admin", "manager", "lawyer", "sales"]);
  });

  it("todas as operações pedem channel.manage à sessão", async () => {
    rpcMock.mockResolvedValue({ data: safeRow(), error: null });
    await service.getWhatsAppChannelState({ channelId: CHANNEL });
    await service.pauseWhatsAppChannel({ channelId: CHANNEL });
    expect(guardMock).toHaveBeenCalledWith("channel.manage");
    expect(guardMock.mock.calls.every(([p]) => p === "channel.manage")).toBe(true);
  });
});

describe("recusas antes de qualquer efeito", () => {
  it("sem permissão, o banco não é chamado", async () => {
    guardMock.mockResolvedValue({ error: "Você não tem permissão para fazer isso." });
    const results = await Promise.all([
      service.listWhatsAppChannelsForManagement(),
      service.createSimulatedWhatsAppChannel({ label: "x", routingKey: "r", displayPhoneNumber: "1" }),
      service.pauseWhatsAppChannel({ channelId: CHANNEL }),
      service.reactivateWhatsAppChannel({ channelId: CHANNEL }),
      service.disableWhatsAppChannelSend({ channelId: CHANNEL }),
      service.updateWhatsAppChannelSettings({ channelId: CHANNEL, label: "x", displayPhoneNumber: "1" }),
      service.getWhatsAppChannelState({ channelId: CHANNEL }),
    ]);
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it.each([
    ["workspaceId", { workspaceId: OTHER_WS }],
    ["actorUserId", { actorUserId: USER }],
    ["role", { role: "owner" }],
    ["environment", { environment: "production" }],
    ["provider", { provider: "ycloud" }],
  ])("campo %s vindo do formulário é recusado", async (_nome, extra) => {
    const create = await service.createSimulatedWhatsAppChannel({ label: "x", routingKey: "r", displayPhoneNumber: "1", ...extra });
    const pause = await service.pauseWhatsAppChannel({ channelId: CHANNEL, ...extra });
    expect(create.ok).toBe(false);
    expect(pause.ok).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("sem WHATSAPP_ENV_SIGNING_KEY nada é pedido ao banco", async () => {
    vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "");
    const result = await service.listWhatsAppChannelsForManagement();
    expect(result).toEqual({ ok: false, error: "A integração de WhatsApp não está configurada neste ambiente." });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it.each([
    ["provedor ausente", { WHATSAPP_PROVIDER: "" }],
    ["provedor real ainda indisponível", { WHATSAPP_PROVIDER: "ycloud" }],
    ["simulado em Production", { VERCEL_ENV: "production" }],
    ["cifra não configurada", { WHATSAPP_CREDENTIAL_KEY_VERSIONS: "" }],
  ])("criar canal recusado: %s", async (_nome, env) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const result = await service.createSimulatedWhatsAppChannel({ label: "x", routingKey: "r", displayPhoneNumber: "1" });
    expect(result.ok).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe("workspace e ator vêm da sessão", () => {
  it("as operações mandam ao banco o workspace e o usuário da sessão", async () => {
    rpcMock.mockResolvedValue({ data: safeRow(), error: null });
    await service.pauseWhatsAppChannel({ channelId: CHANNEL });
    expect(rpcMock).toHaveBeenCalledWith("whatsapp_pause_channel", {
      p_channel_id: CHANNEL,
      p_workspace_id: WS,
      p_actor_user_id: USER,
    });
  });

  it("criar canal: id gerado no servidor, segredo cifrado com a AAD do canal, nada em claro", async () => {
    rpcMock.mockResolvedValue({ data: safeRow(), error: null });
    const result = await service.createSimulatedWhatsAppChannel({ label: " Canal ", routingKey: "sim-1", displayPhoneNumber: "+55 11 0000-0001" });
    expect(result.ok).toBe(true);
    const [name, args] = rpcMock.mock.calls[0]!;
    expect(name).toBe("whatsapp_create_simulated_channel");
    expect(args.p_workspace_id).toBe(WS);
    expect(args.p_actor_user_id).toBe(USER);
    expect(args.p_label).toBe("Canal");
    expect(args.p_channel_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(args.p_key_version).toBe("1");
    expect(typeof args.p_webhook_secret_ciphertext).toBe("string");
    expect(Object.keys(args).sort()).toEqual([
      "p_actor_user_id",
      "p_channel_id",
      "p_display_phone_number",
      "p_key_version",
      "p_label",
      "p_routing_key",
      "p_webhook_secret_ciphertext",
      "p_workspace_id",
    ]);
  });
});

describe("nenhuma credencial em retornos ou erros", () => {
  it("a resposta da criação não carrega o texto cifrado nem a versão da chave", async () => {
    rpcMock.mockResolvedValue({ data: safeRow(), error: null });
    const result = await service.createSimulatedWhatsAppChannel({ label: "Canal", routingKey: "sim-1", displayPhoneNumber: "1" });
    const ciphertext = rpcMock.mock.calls[0]![1].p_webhook_secret_ciphertext as string;
    const visible = JSON.stringify(result);
    expect(visible).not.toContain(ciphertext);
    expect(visible).not.toContain("key_version");
    expect(visible).not.toContain("ciphertext");
  });

  it("campos inesperados devolvidos pelo banco não atravessam para a aplicação", () => {
    const mapped = mapSafeChannel(safeRow({ ciphertext: "SEGREDO", key_version: "1", api_key: "x" }));
    expect(JSON.stringify(mapped)).not.toMatch(/SEGREDO|key_version|api_key|ciphertext/);
  });

  it("linha de outro ambiente é recusada mesmo que o banco a devolva", () => {
    expect(() => mapSafeChannel(safeRow({ environment: "production" }))).toThrow("channel_environment_mismatch");
  });

  it("erro desconhecido do banco vira mensagem genérica; nada da mensagem original vaza", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "duplicate key ... ciphertext=SEGREDO-INTERNO" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await service.pauseWhatsAppChannel({ channelId: CHANNEL });
    expect(result).toEqual({ ok: false, error: "Não foi possível concluir a operação. Tente novamente." });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("SEGREDO-INTERNO");
    warn.mockRestore();
  });

  it.each([
    ["channel_not_found", "Canal de WhatsApp não encontrado."],
    ["insufficient_permission", "Você não tem permissão para fazer isso."],
    ["whatsapp_environment_required", "A integração de WhatsApp não está configurada neste ambiente."],
    ["invalid_channel_state", "O canal não está num estado que permita esta operação."],
  ])("código conhecido %s vira mensagem própria", async (code, message) => {
    rpcMock.mockResolvedValue({ data: null, error: { message: code } });
    expect(await service.reactivateWhatsAppChannel({ channelId: CHANNEL })).toEqual({ ok: false, error: message });
  });

  it("leitura interna da credencial recusa linha de outro ambiente antes de decifrar", async () => {
    const enc = encryptWhatsAppCredential("segredo", {
      environment: "production",
      workspaceId: WS,
      channelId: CHANNEL,
      provider: "simulated",
      purpose: "webhook_secret",
    });
    rpcMock.mockResolvedValue({
      data: [{ channel_id: CHANNEL, workspace_id: WS, environment: "production", provider: "simulated", purpose: "webhook_secret", ciphertext: enc.ciphertextBase64, key_version: enc.keyVersion }],
      error: null,
    });
    await expect(adminReadWhatsAppChannelCredential({ channelId: CHANNEL, purpose: "webhook_secret" })).rejects.toThrow(
      "channel_environment_mismatch",
    );
  });

  it("leitura interna decifra a credencial do próprio ambiente", async () => {
    const enc = encryptWhatsAppCredential("segredo", {
      environment: "preview",
      workspaceId: WS,
      channelId: CHANNEL,
      provider: "simulated",
      purpose: "webhook_secret",
    });
    rpcMock.mockResolvedValue({
      data: [{ channel_id: CHANNEL, workspace_id: WS, environment: "preview", provider: "simulated", purpose: "webhook_secret", ciphertext: enc.ciphertextBase64, key_version: enc.keyVersion }],
      error: null,
    });
    await expect(adminReadWhatsAppChannelCredential({ channelId: CHANNEL, purpose: "webhook_secret" })).resolves.toBe("segredo");
  });
});
