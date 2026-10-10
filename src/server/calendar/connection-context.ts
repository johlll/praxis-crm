import { adminGetConnectionTokens, adminStoreAccessToken } from "@/server/calendar/admin/connections";
import { getCalendarEnvironment } from "@/server/calendar/environment";
import type { CalendarProvider } from "@/server/calendar/provider";
import type { ConnectionContext } from "@/server/calendar/sync/types";

/** Margem para renovar antes de o token vencer de fato. */
const REFRESH_MARGIN_MS = 60_000;

export type OwnConnection = {
  id: string;
  calendarId: string | null;
  status: "active" | "needs_reauth" | "disconnected";
};

/**
 * Monta o contexto de chamada ao Google a partir da conexão do PRÓPRIO
 * usuário: decifra o token (a RPC só entrega ao dono, no ambiente certo) e
 * renova o token de acesso quando vencido, guardando o novo já cifrado.
 * Falha de renovação (`invalid_grant`) deixa a conexão a reautorizar, sem
 * tentar de novo às cegas.
 */
export async function loadConnectionContext(params: {
  provider: CalendarProvider;
  connection: OwnConnection;
  workspaceId: string;
  actorUserId: string;
  now?: Date;
}): Promise<ConnectionContext> {
  const { provider, connection, workspaceId, actorUserId } = params;
  if (connection.status !== "active") throw new Error("connection_not_active");
  if (!connection.calendarId) throw new Error("calendar_not_selected");

  const { accessToken } = await loadFreshTokens({ provider, connectionId: connection.id, workspaceId, actorUserId, now: params.now });

  return {
    connectionId: connection.id,
    calendarId: connection.calendarId,
    environment: getCalendarEnvironment(),
    accessToken,
  };
}

/**
 * Tokens da PRÓPRIA conexão com o de acesso válido: renova (e guarda cifrado)
 * quando vencido ou perto de vencer. Serve também a telas que ainda não têm
 * agenda escolhida (lista de agendas) e à desconexão (encerrar canais).
 */
export async function loadFreshTokens(params: {
  provider: CalendarProvider;
  connectionId: string;
  workspaceId: string;
  actorUserId: string;
  now?: Date | undefined;
}): Promise<{ accessToken: string; refreshToken: string }> {
  const { provider, connectionId, workspaceId, actorUserId } = params;
  const tokens = await adminGetConnectionTokens({ connectionId, workspaceId, actorUserId });
  const now = (params.now ?? new Date()).getTime();
  if (tokens.accessTokenExpiresAt && tokens.accessTokenExpiresAt.getTime() - REFRESH_MARGIN_MS > now) {
    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
  }
  const refreshed = await provider.refreshAccessToken(tokens.refreshToken);
  await adminStoreAccessToken({
    connectionId,
    workspaceId,
    actorUserId,
    accessToken: refreshed.accessToken,
    accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
    keyVersion: tokens.keyVersion,
  });
  return { accessToken: refreshed.accessToken, refreshToken: tokens.refreshToken };
}
