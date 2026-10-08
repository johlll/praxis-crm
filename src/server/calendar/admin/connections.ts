import { createCalendarAdminSupabaseClient } from "@/server/calendar/admin/supabase";
import { getCalendarEnvironment } from "@/server/calendar/environment";
import { decryptCalendarToken, encryptCalendarToken, type TokenContext } from "@/server/calendar/token-crypto";
import type { ProviderTokens } from "@/server/calendar/provider";

/**
 * Escritas de conexão de calendário. Só chamadas depois de a sessão do
 * usuário já ter sido verificada e autorizada (`requirePermissionSafe`) —
 * o `actorUserId` vem dessa verificação, nunca do cliente. As RPCs
 * revalidam papel, dono da conexão e ambiente por dentro.
 */

function tokenContext(workspaceId: string, userId: string): TokenContext {
  return { environment: getCalendarEnvironment(), workspaceId, userId };
}

export async function adminConnectCalendar(params: {
  workspaceId: string;
  actorUserId: string;
  tokens: ProviderTokens;
}): Promise<string> {
  const ctx = tokenContext(params.workspaceId, params.actorUserId);
  const refresh = encryptCalendarToken(params.tokens.refreshToken, ctx);
  const access = encryptCalendarToken(params.tokens.accessToken, ctx);

  const admin = createCalendarAdminSupabaseClient();
  const { data, error } = await admin.rpc("connect_calendar_account", {
    p_workspace_id: params.workspaceId,
    p_actor_user_id: params.actorUserId,
    p_google_account_email: params.tokens.accountEmail,
    p_scopes: params.tokens.scopes,
    p_refresh_token_ciphertext: refresh.ciphertextBase64,
    p_access_token_ciphertext: access.ciphertextBase64,
    p_access_token_expires_at: params.tokens.accessTokenExpiresAt.toISOString(),
    p_key_version: refresh.keyVersion,
  });
  if (error) throw new Error(error.message);
  return data;
}

export type DecryptedConnectionTokens = { accessToken: string; refreshToken: string };

/** Só o DONO da conexão obtém os tokens (a RPC recusa qualquer outro, e
 * recusa conexão de outro ambiente). */
export async function adminGetConnectionTokens(params: {
  connectionId: string;
  workspaceId: string;
  actorUserId: string;
}): Promise<DecryptedConnectionTokens> {
  const admin = createCalendarAdminSupabaseClient();
  const { data, error } = await admin.rpc("get_calendar_connection_secrets", {
    p_connection_id: params.connectionId,
    p_actor_user_id: params.actorUserId,
  });
  if (error) throw new Error(error.message);
  const row = data?.[0];
  if (!row || !row.refresh_token_ciphertext || !row.access_token_ciphertext || !row.key_version) {
    throw new Error("connection_not_found");
  }
  const ctx = tokenContext(params.workspaceId, params.actorUserId);
  return {
    refreshToken: decryptCalendarToken(row.refresh_token_ciphertext, row.key_version, ctx),
    accessToken: decryptCalendarToken(row.access_token_ciphertext, row.key_version, ctx),
  };
}

export async function adminSetConnectionCalendar(params: {
  connectionId: string;
  actorUserId: string;
  calendarId: string;
  calendarSummary: string;
}): Promise<void> {
  const admin = createCalendarAdminSupabaseClient();
  const { error } = await admin.rpc("set_calendar_connection_calendar", {
    p_connection_id: params.connectionId,
    p_actor_user_id: params.actorUserId,
    p_calendar_id: params.calendarId,
    p_calendar_summary: params.calendarSummary,
  });
  if (error) throw new Error(error.message);
}

export async function adminDisconnectCalendar(params: { connectionId: string; actorUserId: string }): Promise<void> {
  const admin = createCalendarAdminSupabaseClient();
  const { error } = await admin.rpc("disconnect_calendar_connection", {
    p_connection_id: params.connectionId,
    p_actor_user_id: params.actorUserId,
  });
  if (error) throw new Error(error.message);
}
