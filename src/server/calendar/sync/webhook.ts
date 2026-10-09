import { hashChannelToken } from "@/server/calendar/sync/channels";
import type { InboundStore } from "@/server/calendar/sync/inbound-types";

/**
 * Notificação do Google (B2, etapa 3; §2, §7): SEM corpo, só cabeçalhos. Ela
 * é uma DICA — marca a agenda para sincronizar; nada é lido do Google nem
 * aplicado aqui, então a resposta é rápida. O banco só aceita canal
 * conhecido DO AMBIENTE, com o segredo certo e o mesmo recurso.
 *
 * Respostas: 200 para canal aceito ou já encerrado (o Google não precisa
 * repetir); 404 para canal, segredo ou ambiente desconhecidos; 400 para
 * notificação malformada.
 */

const MAX_HEADER = 1024;

function header(headers: Headers, name: string): string | null {
  const value = headers.get(name);
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > MAX_HEADER ? null : trimmed;
}

export async function handleCalendarNotification(headers: Headers, store: Pick<InboundStore, "recordNotification">): Promise<number> {
  const channelId = header(headers, "x-goog-channel-id");
  const token = header(headers, "x-goog-channel-token");
  const resourceState = header(headers, "x-goog-resource-state");
  if (!channelId || !token || !resourceState || channelId.length > 64) return 400;

  const messageNumber = Number(header(headers, "x-goog-message-number") ?? "");
  const expirationRaw = header(headers, "x-goog-channel-expiration");
  const expiration = expirationRaw ? Date.parse(expirationRaw) : Number.NaN;

  const result = await store.recordNotification({
    channelId,
    tokenHash: hashChannelToken(token),
    resourceId: header(headers, "x-goog-resource-id"),
    resourceState,
    messageNumber: Number.isSafeInteger(messageNumber) && messageNumber > 0 ? messageNumber : null,
    expiresAt: Number.isFinite(expiration) ? new Date(expiration).toISOString() : null,
  });
  return result === "rejected" ? 404 : 200;
}
