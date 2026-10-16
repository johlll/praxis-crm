import { adminGetConnectionTokens, adminMarkNeedsReauthIfCurrent, adminStoreAccessToken } from "@/server/calendar/admin/connections";
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
 * Falhas de renovação: ver `loadFreshTokens`.
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
 * Erros de domínio da renovação (mensagens em `src/lib/errors.ts`):
 *  - `calendar_reauth_required`: o Google recusou o refresh token
 *    (`invalid_grant`: revogado, vencido, senha trocada, 7 dias do modo de
 *    teste). A conexão fica "a reautorizar" e a tela oferece "Autorizar
 *    novamente";
 *  - `calendar_oauth_misconfigured`: o cliente OAuth do ambiente foi recusado
 *    (`invalid_client`, `unauthorized_client`) — configuração, não o usuário;
 *  - `calendar_refresh_unavailable`: rede, prazo, limite de chamadas ou erro
 *    temporário do Google — tentar de novo depois;
 *  - `connection_not_active`: a conexão foi desconectada durante a chamada.
 * Nenhum desses chama a agenda: a operação para antes.
 */
const OAUTH_CONFIG_CODES = new Set(["invalid_client", "unauthorized_client"]);

function refreshFailure(error: unknown): "reauth" | "config" | "temporary" {
  const message = error instanceof Error ? error.message : "";
  if (message === "refresh_token_invalid") return "reauth";
  const code = message.startsWith("refresh_failed:") ? message.slice("refresh_failed:".length) : "";
  return OAUTH_CONFIG_CODES.has(code) ? "config" : "temporary";
}

/**
 * Tokens da PRÓPRIA conexão com o de acesso válido: renova (e guarda cifrado)
 * quando vencido ou perto de vencer. Serve também a telas que ainda não têm
 * agenda escolhida (lista de agendas) e à desconexão (encerrar canais).
 *
 * Ponto ÚNICO de reconhecimento da revogação (sob demanda, ações e
 * manutenção agendada passam todos por aqui). Limitação: enquanto o token de
 * acesso guardado não vence (até ~1 h), não há renovação — a revogação feita
 * no Google só é reconhecida na próxima renovação.
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
  let refreshed: { accessToken: string; accessTokenExpiresAt: Date };
  try {
    refreshed = await provider.refreshAccessToken(tokens.refreshToken);
  } catch (error) {
    const kind = refreshFailure(error);
    if (kind === "config") throw new Error("calendar_oauth_misconfigured");
    if (kind === "temporary") throw new Error("calendar_refresh_unavailable");
    let outcome;
    try {
      outcome = await adminMarkNeedsReauthIfCurrent({
        connectionId,
        workspaceId,
        actorUserId,
        refreshFingerprint: tokens.refreshFingerprint,
        reason: "refresh_token_invalid",
      });
    } catch {
      // Não deu para registrar: a próxima renovação tenta de novo.
      throw new Error("calendar_refresh_unavailable");
    }
    if (outcome === "disconnected") throw new Error("connection_not_active");
    // "stale": o usuário reautorizou enquanto o token velho falhava — a
    // conexão atual está boa; esta operação só não usou o token novo.
    if (outcome === "stale") throw new Error("calendar_refresh_unavailable");
    throw new Error("calendar_reauth_required");
  }
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
