/**
 * @vitest-environment node
 *
 * B3.2d-2b1 — administração das identidades INTERNAS do WhatsApp (números
 * e BSUIDs do próprio escritório, por workspace, ambiente e canal).
 *
 *  - só owner e admin (`channel.manage`); manager e member nunca;
 *  - workspace e usuário vêm SÓ da sessão; a entrada é estrita;
 *  - telefone, BSUID ou os dois — nunca nenhum;
 *  - o BSUID vai ao banco só como índice cego + texto cifrado (chaves
 *    próprias), nunca em claro; a listagem nunca devolve índice nem cifra;
 *  - erros saem como texto seguro, sem telefone, BSUID ou erro cru.
 *
 * Nenhuma identidade real: tudo fictício. O banco é simulado.
 * Escritos ANTES da implementação, contra a main 6633084.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock, guardMock } = vi.hoisted(() => ({ rpcMock: vi.fn(), guardMock: vi.fn() }));

vi.mock("@/server/authz/safe", () => ({ requirePermissionSafe: guardMock }));
vi.mock("@/server/whatsapp/admin/supabase", () => ({
  createWhatsAppAdminSupabaseClient: () => ({ rpc: rpcMock }),
}));

const loadService = () => import("@/modules/whatsapp-channels/internal-identities");
const loadCrypto = () => import("@/server/whatsapp/identity-crypto");
const { roleHasPermission } = await import("@/lib/roles");

const WS = "10000000-0000-0000-0000-000000000001";
const OTHER_WS = "10000000-0000-0000-0000-000000000002";
const USER = "20000000-0000-0000-0000-000000000001";
const CHANNEL = "36000000-0000-0000-0000-000000000001";
const IDENTITY = "37000000-0000-0000-0000-000000000001";
const PHONE = "+5511988887777";
const BSUID = "BR.9876543210";
const ID_KEY = Buffer.alloc(32, 44).toString("base64");

function configure() {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "chave-de-teste-b3-whatsapp-0123456789");
  vi.stubEnv("WHATSAPP_IDENTITY_KEY_VERSIONS", JSON.stringify({ "1": ID_KEY }));
  vi.stubEnv("WHATSAPP_IDENTITY_ACTIVE_KEY_VERSION", "1");
}

function safeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: IDENTITY,
    channel_id: CHANNEL,
    label: "Advogado (fictício)",
    phone_e164: PHONE,
    has_bsuid: false,
    is_active: true,
    created_at: "2026-10-28T12:00:00Z",
    updated_at: "2026-10-28T12:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  configure();
  rpcMock.mockReset();
  rpcMock.mockResolvedValue({ data: safeRow(), error: null });
  guardMock.mockReset();
  guardMock.mockResolvedValue({ ctx: { userId: USER, workspaceId: WS, membershipId: "m", role: "owner" } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("1. permissão", () => {
  it("channel.manage: owner e admin podem; manager e members não", () => {
    expect(roleHasPermission("owner", "channel.manage")).toBe(true);
    expect(roleHasPermission("admin", "channel.manage")).toBe(true);
    for (const role of ["manager", "lawyer", "sales", "viewer"] as const) expect(roleHasPermission(role, "channel.manage")).toBe(false);
  });

  it("toda operação pede channel.manage à sessão; recusa não chega ao banco", async () => {
    const s = await loadService();
    guardMock.mockResolvedValue({ error: "Você não tem permissão para esta ação." });
    for (const call of [
      () => s.listWhatsAppInternalIdentities({ channelId: CHANNEL }),
      () => s.createWhatsAppInternalIdentity({ channelId: CHANNEL, label: "X", phoneE164: PHONE }),
      () => s.setWhatsAppInternalIdentityActive({ identityId: IDENTITY, active: false }),
    ]) {
      await expect(call()).resolves.toEqual({ ok: false, error: "Você não tem permissão para esta ação." });
    }
    expect(guardMock.mock.calls.every(([perm]) => perm === "channel.manage")).toBe(true);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe("2. criação: telefone, BSUID ou os dois", () => {
  it("só telefone: workspace e ator da sessão, nada de BSUID", async () => {
    const s = await loadService();
    await expect(s.createWhatsAppInternalIdentity({ channelId: CHANNEL, label: "Advogado (fictício)", phoneE164: PHONE })).resolves.toMatchObject({ ok: true });
    expect(rpcMock).toHaveBeenCalledWith("whatsapp_create_internal_identity", {
      p_workspace_id: WS,
      p_actor_user_id: USER,
      p_channel_id: CHANNEL,
      p_label: "Advogado (fictício)",
      p_phone_e164: PHONE,
      p_bsuid_blind_index: null,
      p_bsuid_ciphertext: null,
      p_bsuid_key_version: null,
    });
  });

  it("só BSUID: vai como índice cego e cifra, nunca em claro; o índice é o do escopo do canal", async () => {
    const s = await loadService();
    const c = await loadCrypto();
    rpcMock.mockResolvedValue({ data: safeRow({ phone_e164: null, has_bsuid: true }), error: null });
    await expect(s.createWhatsAppInternalIdentity({ channelId: CHANNEL, label: "Número interno", bsuid: BSUID })).resolves.toMatchObject({ ok: true });
    const [name, args] = rpcMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe("whatsapp_create_internal_identity");
    expect(args.p_phone_e164).toBeNull();
    expect(args.p_bsuid_key_version).toBe("1");
    expect(args.p_bsuid_blind_index).toBe(c.encryptWhatsAppBsuid({ environment: "preview", workspaceId: WS, channelId: CHANNEL }, BSUID).blindIndexBase64);
    expect(typeof args.p_bsuid_ciphertext).toBe("string");
    expect(JSON.stringify(args)).not.toContain(BSUID);
    expect(JSON.stringify(args)).not.toContain("9876543210");
  });

  it("os dois juntos", async () => {
    const s = await loadService();
    await s.createWhatsAppInternalIdentity({ channelId: CHANNEL, label: "Ambos", phoneE164: PHONE, bsuid: BSUID });
    const args = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args.p_phone_e164).toBe(PHONE);
    expect(args.p_bsuid_blind_index).toEqual(expect.any(String));
  });

  it.each([
    ["nenhum identificador", { channelId: CHANNEL, label: "Vazia" }],
    ["telefone e BSUID vazios", { channelId: CHANNEL, label: "Vazia", phoneE164: "", bsuid: "" }],
    ["telefone fora do E.164", { channelId: CHANNEL, label: "X", phoneE164: "11988887777" }],
    ["BSUID com espaço", { channelId: CHANNEL, label: "X", bsuid: "BR 1" }],
    ["sem rótulo", { channelId: CHANNEL, label: "  ", phoneE164: PHONE }],
    ["canal inválido", { channelId: "x", label: "X", phoneE164: PHONE }],
    ["workspace no formulário", { channelId: CHANNEL, label: "X", phoneE164: PHONE, workspaceId: OTHER_WS }],
    ["ator no formulário", { channelId: CHANNEL, label: "X", phoneE164: PHONE, actorUserId: USER }],
    ["ambiente no formulário", { channelId: CHANNEL, label: "X", phoneE164: PHONE, environment: "production" }],
  ])("%s: recusado antes do banco", async (_name, input) => {
    const s = await loadService();
    const result = await s.createWhatsAppInternalIdentity(input as never);
    expect(result.ok).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("BSUID sem as chaves de identidade: recusado antes do banco; só telefone continua funcionando", async () => {
    const s = await loadService();
    vi.stubEnv("WHATSAPP_IDENTITY_KEY_VERSIONS", "");
    expect((await s.createWhatsAppInternalIdentity({ channelId: CHANNEL, label: "X", bsuid: BSUID })).ok).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
    expect((await s.createWhatsAppInternalIdentity({ channelId: CHANNEL, label: "X", phoneE164: PHONE })).ok).toBe(true);
  });

  it("ambiente do WhatsApp não configurado: recusado antes do banco", async () => {
    const s = await loadService();
    vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "");
    expect((await s.createWhatsAppInternalIdentity({ channelId: CHANNEL, label: "X", phoneE164: PHONE })).ok).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe("3. listagem e ativação", () => {
  it("listagem segura: sem índice cego nem cifra", async () => {
    const s = await loadService();
    rpcMock.mockResolvedValue({ data: [safeRow(), safeRow({ id: "37000000-0000-0000-0000-000000000002", phone_e164: null, has_bsuid: true })], error: null });
    const result = await s.listWhatsAppInternalIdentities({ channelId: CHANNEL });
    expect(rpcMock).toHaveBeenCalledWith("whatsapp_list_internal_identities", { p_workspace_id: WS, p_actor_user_id: USER, p_channel_id: CHANNEL });
    expect(result).toEqual({
      ok: true,
      data: [
        { id: IDENTITY, channelId: CHANNEL, label: "Advogado (fictício)", phoneE164: PHONE, hasBsuid: false, isActive: true, createdAt: "2026-10-28T12:00:00Z", updatedAt: "2026-10-28T12:00:00Z" },
        { id: "37000000-0000-0000-0000-000000000002", channelId: CHANNEL, label: "Advogado (fictício)", phoneE164: null, hasBsuid: true, isActive: true, createdAt: "2026-10-28T12:00:00Z", updatedAt: "2026-10-28T12:00:00Z" },
      ],
    });
  });

  it("resposta do banco com índice cego ou cifra: recusada", async () => {
    const s = await loadService();
    rpcMock.mockResolvedValue({ data: [safeRow({ bsuid_blind_index: "AAAA" })], error: null });
    expect((await s.listWhatsAppInternalIdentities({ channelId: CHANNEL })).ok).toBe(false);
    rpcMock.mockResolvedValue({ data: [safeRow({ bsuid_ciphertext: "AAAA" })], error: null });
    expect((await s.listWhatsAppInternalIdentities({ channelId: CHANNEL })).ok).toBe(false);
  });

  it("ativar e desativar: id, workspace, ator e o valor", async () => {
    const s = await loadService();
    rpcMock.mockResolvedValue({ data: safeRow({ is_active: false }), error: null });
    await expect(s.setWhatsAppInternalIdentityActive({ identityId: IDENTITY, active: false })).resolves.toMatchObject({ ok: true, data: { isActive: false } });
    expect(rpcMock).toHaveBeenCalledWith("whatsapp_set_internal_identity_active", {
      p_identity_id: IDENTITY,
      p_workspace_id: WS,
      p_actor_user_id: USER,
      p_active: false,
    });
  });
});

describe("4. erros sanitizados, nada no console", () => {
  it.each([
    ["internal_identity_taken"],
    ["insufficient_permission"],
    ["channel_not_found"],
    ["internal_identity_not_found"],
    [`duplicate key value violates unique constraint "x" Key (phone_e164)=(${PHONE})`],
  ])("erro do banco %s: texto seguro, sem telefone, BSUID ou erro cru", async (message) => {
    const s = await loadService();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    rpcMock.mockResolvedValue({ data: null, error: { message } });
    const result = await s.createWhatsAppInternalIdentity({ channelId: CHANNEL, label: "X", phoneE164: PHONE, bsuid: BSUID });
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result);
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain(BSUID);
    expect(text).not.toContain("duplicate key");
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        const logged = JSON.stringify(call);
        expect(logged).not.toContain(PHONE);
        expect(logged).not.toContain(BSUID);
      }
    }
  });
});
