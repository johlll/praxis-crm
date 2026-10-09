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

  const tokens = await adminGetConnectionTokens({ connectionId: connection.id, workspaceId, actorUserId });

  const now = (params.now ?? new Date()).getTime();
  let accessToken = tokens.accessToken;
  if (!tokens.accessTokenExpiresAt || tokens.accessTokenExpiresAt.getTime() - REFRESH_MARGIN_MS <= now) {
    const refreshed = await provider.refreshAccessToken(tokens.refreshToken);
    accessToken = refreshed.accessToken;
    await adminStoreAccessToken({
      connectionId: connection.id,
      workspaceId,
      actorUserId,
      accessToken,
      accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
      keyVersion: tokens.keyVersion,
    });
  }

  return {
    connectionId: connection.id,
    calendarId: connection.calendarId,
    environment: getCalendarEnvironment(),
    accessToken,
  };
}
