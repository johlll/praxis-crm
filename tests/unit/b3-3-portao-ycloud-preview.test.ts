/**
 * @vitest-environment node
 *
 * B3.3 — portão do envio: canal YCloud de Preview (§28.20), camada do servidor.
 * As regras (papel, ambiente assinado, provedor, canal ativo, api_key do mesmo
 * canal) são do banco e estão provadas em
 * supabase/tests/database/44_b3_3_portao_ycloud_preview.test.sql. Aqui:
 * o servidor só repassa canal, workspace e ator da sessão (nunca provedor,
 * ambiente, credencial ou canal vindos do chamador); as recusas do banco viram
 * códigos simbólicos; nenhum segredo em retorno ou erro; nenhuma rede; e a
 * migration só troca a função do portão (sem tabela, coluna, índice, enum ou
 * dado).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/server/whatsapp/admin/supabase", () => ({ createWhatsAppAdminSupabaseClient: () => ({ rpc: rpcMock }) }));

const { adminEnableWhatsAppChannelSend, WhatsAppChannelStoreError } = await import("@/server/whatsapp/admin/channels");

const WS = "10000000-0000-0000-0000-000000000001";
const USER = "20000000-0000-0000-0000-000000000001";
const CHANNEL = "66000000-0000-0000-0000-00000000000a";
const SECRET = "ycloud-api-key-ficticia-0123456789";

const safeRow = (over: Record<string, unknown> = {}) => ({
  id: CHANNEL,
  label: "Canal YCloud de teste",
  provider: "ycloud",
  environment: "preview",
  routing_key: "WABAFICTICIO:5511000000001",
  display_phone_number: "+55 11 0000-0303",
  is_simulator: false,
  status: "active",
  send_enabled: true,
  status_changed_at: "2026-11-09T12:00:00Z",
  created_at: "2026-11-09T12:00:00Z",
  updated_at: "2026-11-09T12:00:00Z",
  credential_purposes: ["api_key", "webhook_secret"],
  ...over,
});

const fetchSpy = vi.fn();
let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  rpcMock.mockReset();
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});

afterEach(() => {
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled(); // habilitar o envio nunca fala com a YCloud
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("servidor: o que é pedido ao banco", () => {
  it("só canal, workspace e ator; devolve a projeção segura, sem credencial", async () => {
    rpcMock.mockResolvedValue({ data: safeRow(), error: null });
    const channel = await adminEnableWhatsAppChannelSend({ workspaceId: WS, actorUserId: USER, channelId: CHANNEL });

    expect(rpcMock).toHaveBeenCalledExactlyOnceWith("whatsapp_enable_channel_send", {
      p_channel_id: CHANNEL,
      p_workspace_id: WS,
      p_actor_user_id: USER,
    });
    expect(channel).toMatchObject({ id: CHANNEL, provider: "ycloud", environment: "preview", status: "active", sendEnabled: true });
    expect(JSON.stringify(channel)).not.toMatch(/ciphertext|key_version|api_key_ciphertext/);
  });

  it("provedor, ambiente, credencial ou canal extras do chamador não chegam ao banco", async () => {
    rpcMock.mockResolvedValue({ data: safeRow(), error: null });
    const hostile = {
      workspaceId: WS,
      actorUserId: USER,
      channelId: CHANNEL,
      provider: "ycloud",
      environment: "preview",
      apiKey: SECRET,
      credential: SECRET,
      p_provider: "ycloud",
    } as Parameters<typeof adminEnableWhatsAppChannelSend>[0];
    await adminEnableWhatsAppChannelSend(hostile);

    const args = rpcMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(["p_actor_user_id", "p_channel_id", "p_workspace_id"]);
    expect(JSON.stringify(rpcMock.mock.calls)).not.toContain(SECRET);
  });
});

describe("servidor: recusas do banco viram códigos simbólicos", () => {
  it.each([
    "provider_send_not_available",
    "credential_not_found",
    "insufficient_permission",
    "invalid_channel_state",
    "channel_not_found",
    "whatsapp_environment_required",
  ])("%s passa como código, sem texto do banco", async (code) => {
    rpcMock.mockResolvedValue({ data: null, error: { message: code } });
    const error = await adminEnableWhatsAppChannelSend({ workspaceId: WS, actorUserId: USER, channelId: CHANNEL }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WhatsAppChannelStoreError);
    expect((error as InstanceType<typeof WhatsAppChannelStoreError>).code).toBe(code);
    expect((error as Error).message).toBe(code);
  });

  it("mensagem desconhecida (ainda que com segredo ou telefone) vira 'unknown' e não é repassada", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: `falha ${SECRET} +5511987654321 Conteúdo sigiloso` } });
    const error = (await adminEnableWhatsAppChannelSend({ workspaceId: WS, actorUserId: USER, channelId: CHANNEL }).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(WhatsAppChannelStoreError);
    expect(error.message).toBe("unknown");
    expect(JSON.stringify({ message: error.message, stack: String(error.stack).split("\n")[0] })).not.toMatch(/ycloud-api-key|5511987654321|sigiloso/);
  });

  it("retorno do banco fora do formato é recusado, não repassado", async () => {
    rpcMock.mockResolvedValue({ data: { ...safeRow(), provider: "outro" }, error: null });
    await expect(adminEnableWhatsAppChannelSend({ workspaceId: WS, actorUserId: USER, channelId: CHANNEL })).rejects.toBeInstanceOf(Error);
  });
});

describe("a migration só troca a função do portão", () => {
  const sql = readFileSync(resolve(import.meta.dirname, "../../supabase/migrations/20261109130000_b3_3_portao_ycloud_preview.sql"), "utf8");
  const bodyStart = sql.indexOf("$body$");
  const bodyEnd = sql.lastIndexOf("$body$");
  const body = sql.slice(bodyStart + 6, bodyEnd);
  // Fora do corpo da função: só comentários, o create or replace e revoke/grant.
  const outside = (sql.slice(0, bodyStart) + sql.slice(bodyEnd + 6)).replace(/--[^\n]*/g, "");

  it("uma função, mesma assinatura, SECURITY DEFINER, search_path vazio, EXECUTE só service_role", () => {
    expect((sql.match(/create or replace function/g) ?? []).length).toBe(1);
    expect(sql).toMatch(/create or replace function public\.whatsapp_enable_channel_send\(p_channel_id uuid, p_workspace_id uuid, p_actor_user_id uuid\)/);
    expect(sql).toMatch(/security definer\s+set search_path = ''/);
    expect(sql).toContain("revoke all on function public.whatsapp_enable_channel_send(uuid, uuid, uuid) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function public.whatsapp_enable_channel_send(uuid, uuid, uuid) to service_role;");
    expect(sql).not.toMatch(/grant\s+execute[^;]*\bto\s+[^;]*\b(anon|authenticated|public)\b/);
  });

  it("nenhuma tabela, coluna, índice, enum, backfill ou dado fora da função", () => {
    expect(outside).not.toMatch(/\b(create|alter|drop)\s+(table|index|type|trigger|policy|schema|extension|constraint)\b/i);
    expect(outside).not.toMatch(/\b(insert|update|delete|truncate)\b/i);
    expect(outside.replace(/\s+/g, " ").trim()).toMatch(/^create or replace function public\.whatsapp_enable_channel_send\([^)]*\) returns jsonb language plpgsql security definer set search_path = '' as\s*;\s*revoke all/);
  });

  it("a regra: Preview + YCloud + canal ativo + api_key do mesmo canal; o webhook_secret não conta; sem rede", () => {
    expect(body).toMatch(/v_channel\.provider = 'ycloud'/);
    expect(body).toMatch(/v_env is distinct from 'preview'::public\.whatsapp_environment/);
    expect(body).toMatch(/v_channel\.environment is distinct from 'preview'::public\.whatsapp_environment/);
    expect(body).toMatch(/elsif v_channel\.provider <> 'simulated' then\s+raise exception 'provider_send_not_available'/);
    expect(body).toMatch(/v_channel\.status <> 'active'/);
    for (const part of ["c.channel_id = v_channel.id", "c.workspace_id = v_channel.workspace_id", "c.environment = v_channel.environment", "c.provider = v_channel.provider", "c.purpose = 'api_key'"]) {
      expect(body).toContain(part);
    }
    expect(body).toContain("private.whatsapp_lock_managed_channel(p_channel_id, p_workspace_id, p_actor_user_id, v_env)");
    expect(body).not.toMatch(/webhook_secret|ciphertext|key_version|http|pg_net/i);
  });
});
