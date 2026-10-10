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

/**
 * Grava a conexão pela IDENTIDADE da conta (`sub`) e pelo cliente OAuth
 * (`connect_calendar_identity`). Sem refresh token novo, o banco só mantém o
 * existente se for da mesma conta, do mesmo cliente e da mesma versão de
 * chave — por isso o token de acesso é cifrado com a versão ATIVA, e uma
 * troca de chave pede novo consentimento.
 */
export async function adminConnectCalendar(params: {
  workspaceId: string;
  actorUserId: string;
  tokens: ProviderTokens;
}): Promise<{ connectionId: string; refreshKept: boolean }> {
  const ctx = tokenContext(params.workspaceId, params.actorUserId);
  const access = encryptCalendarToken(params.tokens.accessToken, ctx);
  const refresh = params.tokens.refreshToken ? encryptCalendarToken(params.tokens.refreshToken, ctx, access.keyVersion) : null;

  const admin = createCalendarAdminSupabaseClient();
  const { data, error } = await admin.rpc("connect_calendar_identity", {
    p_workspace_id: params.workspaceId,
    p_actor_user_id: params.actorUserId,
    p_google_subject: params.tokens.accountSubject,
    p_oauth_client_id: params.tokens.oauthClientId,
    p_google_account_email: params.tokens.accountEmail,
    p_scopes: params.tokens.scopes,
    p_refresh_token_ciphertext: refresh?.ciphertextBase64 ?? "",
    p_access_token_ciphertext: access.ciphertextBase64,
    p_access_token_expires_at: params.tokens.accessTokenExpiresAt.toISOString(),
    p_key_version: access.keyVersion,
  });
  if (error) throw new Error(error.message);
  return data as unknown as { connectionId: string; refreshKept: boolean };
}

export type DecryptedConnectionTokens = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date | null;
  keyVersion: string;
};

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
    accessTokenExpiresAt: row.access_token_expires_at ? new Date(row.access_token_expires_at) : null,
    keyVersion: row.key_version,
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

/** Guarda o novo token de acesso, cifrado com a MESMA versão de chave da
 * conexão (refresh e acesso são lidos com a mesma versão). */
export async function adminStoreAccessToken(params: {
  connectionId: string;
  workspaceId: string;
  actorUserId: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  keyVersion: string;
}): Promise<void> {
  const ctx = tokenContext(params.workspaceId, params.actorUserId);
  const encrypted = encryptCalendarToken(params.accessToken, ctx, params.keyVersion);
  const admin = createCalendarAdminSupabaseClient();
  const { error } = await admin.rpc("store_calendar_access_token", {
    p_connection_id: params.connectionId,
    p_actor_user_id: params.actorUserId,
    p_access_token_ciphertext: encrypted.ciphertextBase64,
    p_access_token_expires_at: params.accessTokenExpiresAt.toISOString(),
    p_key_version: encrypted.keyVersion,
  });
  if (error) throw new Error(error.message);
}
