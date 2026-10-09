import { createHash, randomBytes, randomUUID } from "node:crypto";

import { ProviderHttpError, ProviderUncertainError } from "@/server/calendar/events-api";
import type { ChannelRecord, InboundConnection, InboundDeps } from "@/server/calendar/sync/inbound-types";

/**
 * Canais de notificação (B2, etapa 3; §9.4). O webhook é só DICA: canal
 * vencido ou notificação perdida não perde dado, porque o polling por
 * `syncToken` recupera.
 */

/** Intervalo do agendador (polling). */
export const POLL_INTERVAL_MS = 15 * 60_000;
/** Nenhum canal é renovado antes de 10 min desde a criação. */
const MIN_RENEW_AFTER_MS = 10 * 60_000;
/** Canal `creating` sem confirmação por mais que isto é abandonado. */
export const CREATING_TIMEOUT_MS = 10 * 60_000;
/** Canal `retiring` é parado depois que o substituto entregou, ou depois disto. */
export const RETIRING_WINDOW_MS = 10 * 60_000;
/** Depois de um canal inviável, não se tenta outro antes disto (sem laço). */
export const POLLING_ONLY_BACKOFF_MS = 24 * 3600_000;

export function hashChannelToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * `renew_at` a partir da vida EFETIVA devolvida pelo Google:
 *  - `renew_at = criação + 0,7 × ttl` (margem de 30%), nunca antes de 10 min
 *    — e, como 0,7 > 0,5, nunca antes de metade da vida (histerese);
 *  - vida menor que 3 × o intervalo do agendador: o canal não é viável
 *    (seria renovado em laço) e a agenda fica só no polling.
 */
export function channelSchedule(
  createdAtMs: number,
  expirationMs: number,
  intervalMs = POLL_INTERVAL_MS,
): { viable: boolean; renewAtMs: number | null } {
  const ttl = expirationMs - createdAtMs;
  if (!Number.isFinite(ttl) || ttl < 3 * intervalMs) return { viable: false, renewAtMs: null };
  return { viable: true, renewAtMs: createdAtMs + Math.max(0.7 * ttl, MIN_RENEW_AFTER_MS) };
}

export type ChannelOutcome = "active" | "polling_only" | "failed" | "uncertain";

/**
 * Cria um canal para a agenda. A linha `creating` é gravada ANTES da chamada,
 * com o hash do segredo; o segredo só vai para o Google. Resposta perdida:
 * a linha fica `creating` e a primeira mensagem (`sync`) do webhook revela o
 * recurso — ou a manutenção a abandona depois do prazo.
 */
export async function createChannel(deps: InboundDeps, conn: InboundConnection, address: string): Promise<ChannelOutcome> {
  const channelId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  await deps.store.beginChannel(conn.userId, {
    connectionId: conn.connectionId,
    calendarId: conn.calendarId,
    channelId,
    tokenHash: hashChannelToken(token),
  });

  const createdAt = deps.now().getTime();
  let watched;
  try {
    watched = await deps.api.watchEvents(conn.accessToken, conn.calendarId, { id: channelId, token, address });
  } catch (error) {
    if (error instanceof ProviderUncertainError) return "uncertain";
    await deps.store.stopChannel(conn.userId, channelId, error instanceof ProviderHttpError ? `watch_${error.status}` : "watch_failed");
    if (error instanceof ProviderHttpError) return "failed";
    throw error;
  }

  return activate(deps, conn, { channelId, resourceId: watched.resourceId, expiration: watched.expiration, createdAt });
}

async function activate(
  deps: InboundDeps,
  conn: InboundConnection,
  ch: { channelId: string; resourceId: string; expiration: string; createdAt: number },
): Promise<ChannelOutcome> {
  const schedule = channelSchedule(ch.createdAt, Date.parse(ch.expiration));
  await deps.store.activateChannel(conn.userId, {
    channelId: ch.channelId,
    resourceId: ch.resourceId,
    expiresAt: ch.expiration,
    renewAt: schedule.renewAtMs === null ? null : new Date(schedule.renewAtMs).toISOString(),
    pollingOnly: !schedule.viable,
  });
  if (!schedule.viable) {
    // Inviável: encerrado no Google para não receber notificação inútil.
    await stopInGoogle(deps, conn, ch.channelId, ch.resourceId);
    return "polling_only";
  }
  return "active";
}

/** Canal `creating` cuja resposta se perdeu, mas cuja primeira mensagem
 * chegou ao webhook com o recurso e a validade: ativa agora. */
export async function adoptCreatingChannel(deps: InboundDeps, conn: InboundConnection, channel: ChannelRecord): Promise<ChannelOutcome> {
  if (!channel.resourceId || !channel.expiresAt) return "uncertain";
  return activate(deps, conn, {
    channelId: channel.channelId,
    resourceId: channel.resourceId,
    expiration: channel.expiresAt,
    createdAt: Date.parse(channel.createdAt),
  });
}

async function stopInGoogle(deps: InboundDeps, conn: InboundConnection, channelId: string, resourceId: string): Promise<boolean> {
  try {
    await deps.api.stopChannel(conn.accessToken, { id: channelId, resourceId });
    return true;
  } catch (error) {
    // 404: já não existe no Google. Outra falha: o canal vence sozinho e o
    // webhook já o ignora (está encerrado aqui).
    return error instanceof ProviderHttpError && error.status === 404;
  }
}

/** Para o canal no Google (se houver recurso e contexto) e o encerra aqui. */
export async function stopChannel(deps: InboundDeps, conn: InboundConnection | null, channel: ChannelRecord, reason: string): Promise<void> {
  if (conn && channel.resourceId && channel.status !== "polling_only") {
    await stopInGoogle(deps, conn, channel.channelId, channel.resourceId);
  }
  await deps.store.stopChannel(channel.userId, channel.channelId, reason);
}

/** Renova (criando o NOVO antes de parar o velho) se já é hora — e só uma
 * execução por vez, pela trava atômica do banco. */
export async function renewIfDue(
  deps: InboundDeps,
  conn: InboundConnection,
  channel: ChannelRecord,
  address: string,
): Promise<ChannelOutcome | "not_due" | "locked"> {
  if (!channel.renewAt || Date.parse(channel.renewAt) > deps.now().getTime()) return "not_due";
  const claimed = await deps.store.claimChannelRenewal(conn.userId, channel.channelId);
  if (!claimed) return "locked";
  // O novo, ao ser ativado, manda o velho para `retiring`.
  return createChannel(deps, conn, address);
}
