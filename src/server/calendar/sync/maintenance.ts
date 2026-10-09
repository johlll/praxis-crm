import {
  CREATING_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  POLLING_ONLY_BACKOFF_MS,
  RETIRING_WINDOW_MS,
  adoptCreatingChannel,
  createChannel,
  renewIfDue,
  stopChannel,
} from "@/server/calendar/sync/channels";
import { syncCalendar } from "@/server/calendar/sync/inbound";
import type { ChannelRecord, InboundConnection, InboundDeps, SyncTarget } from "@/server/calendar/sync/inbound-types";

/**
 * Rodada de manutenção do ambiente (B2, etapa 3; §9.2): para cada (conexão,
 * agenda) com vínculo ativo, cuida do canal e sincroniza quando há dica do
 * webhook, quando o polling venceu (15 min) ou quando o sync completo de
 * segurança venceu (24 h). Encerra canais sem uso. Idempotente: pode ser
 * chamada por mais de um agendador, ao mesmo tempo — as travas do banco
 * garantem uma sincronização e uma renovação por vez.
 *
 * O relatório tem só contagens — nunca conteúdo de evento.
 */

export const FULL_SYNC_INTERVAL_MS = 24 * 3600_000;

/** Resultado de abrir a conexão de um dono: o contexto, "a reautorizar"
 * (refresh token inválido) ou indisponível agora. */
export type OpenedConnection = { accessToken: string } | "needs_reauth" | null;

export type MaintenanceDeps = InboundDeps & {
  openConnection: (owner: { connectionId: string; userId: string; workspaceId: string; calendarId: string }) => Promise<OpenedConnection>;
  /** Endereço do webhook do ambiente; sem ele, só polling. */
  webhookAddress: string | null;
  maxTargets?: number;
};

export type MaintenanceReport = {
  targets: number;
  synced: number;
  full: number;
  busy: number;
  accessLost: number;
  failed: number;
  needsReauth: number;
  conflicts: number;
  channelsCreated: number;
  channelsRenewed: number;
  channelsStopped: number;
  pollingOnly: number;
};

const key = (connectionId: string, calendarId: string) => `${connectionId}|${calendarId}`;
const ms = (iso: string | null) => (iso ? Date.parse(iso) : null);

export async function runCalendarMaintenance(deps: MaintenanceDeps): Promise<MaintenanceReport> {
  const report: MaintenanceReport = {
    targets: 0,
    synced: 0,
    full: 0,
    busy: 0,
    accessLost: 0,
    failed: 0,
    needsReauth: 0,
    conflicts: 0,
    channelsCreated: 0,
    channelsRenewed: 0,
    channelsStopped: 0,
    pollingOnly: 0,
  };
  const { targets, channels } = await deps.store.listMaintenance();
  const now = deps.now().getTime();

  // Uma abertura de conexão por dono e rodada.
  const opened = new Map<string, Promise<{ accessToken: string } | null>>();
  const open = (t: { connectionId: string; userId: string; workspaceId: string; calendarId: string }) => {
    let pending = opened.get(t.connectionId);
    if (!pending) {
      pending = (async () => {
        const result = await deps.openConnection(t).catch(() => null);
        if (result === "needs_reauth") {
          // Refresh token inválido: a conexão fica a reautorizar (aviso ao
          // usuário), sem tentar de novo em laço.
          await deps.store.markNeedsReauth(t.userId, t.connectionId, "refresh_token_invalid");
          report.needsReauth += 1;
          return null;
        }
        return result;
      })();
      opened.set(t.connectionId, pending);
    }
    return pending;
  };
  const contextFor = async (t: { connectionId: string; userId: string; workspaceId: string; calendarId: string }): Promise<InboundConnection | null> => {
    const ctx = await open(t);
    return ctx ? { connectionId: t.connectionId, userId: t.userId, calendarId: t.calendarId, environment: deps.environment, accessToken: ctx.accessToken } : null;
  };

  const activeTargets = targets.filter((t) => t.connectionStatus === "active").slice(0, deps.maxTargets ?? 25);
  const targetKeys = new Set(activeTargets.map((t) => key(t.connectionId, t.calendarId)));
  const channelsOf = (t: SyncTarget) => channels.filter((c) => c.connectionId === t.connectionId && c.calendarId === t.calendarId);
  report.targets = activeTargets.length;

  for (const target of activeTargets) {
    const conn = await contextFor(target);
    if (!conn) continue;

    if (deps.webhookAddress) await ensureChannel(deps, conn, channelsOf(target), deps.webhookAddress, now, report);

    const lastRun = ms(target.lastRunAt);
    const fullAt = ms(target.fullSyncAt);
    const dirty = ms(target.dirtyAt);
    const full = fullAt === null || now - fullAt >= FULL_SYNC_INTERVAL_MS;
    const due =
      full || !target.hasSyncToken || lastRun === null || (dirty !== null && dirty >= lastRun) || now - lastRun >= POLL_INTERVAL_MS;
    if (!due) continue;

    const outcome = await syncCalendar(deps, conn, { forceFull: full });
    if (outcome.status === "synced") {
      report.synced += 1;
      if (outcome.full) report.full += 1;
      report.conflicts += outcome.conflicts;
    } else if (outcome.status === "busy") report.busy += 1;
    else if (outcome.status === "access_lost") report.accessLost += 1;
    else report.failed += 1;
  }

  // Canais: abandonados, vencidos, aposentados e sem vínculo.
  for (const channel of channels) {
    const reason = channelEnd(channel, channels, targetKeys, now);
    if (!reason) continue;
    const conn =
      channel.connectionStatus === "active" && channel.resourceId
        ? await contextFor({ connectionId: channel.connectionId, userId: channel.userId, workspaceId: channel.workspaceId, calendarId: channel.calendarId })
        : null;
    await stopChannel(deps, conn, channel, reason);
    report.channelsStopped += 1;
  }

  return report;
}

/** Por que o canal deve ser encerrado agora (ou `null`). */
function channelEnd(channel: ChannelRecord, all: ChannelRecord[], targetKeys: Set<string>, now: number): string | null {
  if (channel.status === "stopped") return null;
  const expired = channel.expiresAt !== null && Date.parse(channel.expiresAt) <= now;
  if (!targetKeys.has(key(channel.connectionId, channel.calendarId))) return channel.status === "polling_only" ? null : "no_links";
  if (channel.status === "polling_only") return null;
  if (expired) return "expired";
  if (channel.status === "creating") {
    const adoptable = channel.resourceId !== null && channel.expiresAt !== null;
    return !adoptable && now - Date.parse(channel.createdAt) >= CREATING_TIMEOUT_MS ? "abandoned" : null;
  }
  if (channel.status === "retiring") {
    const replacementDelivered = all.some(
      (c) =>
        c.channelId !== channel.channelId &&
        c.connectionId === channel.connectionId &&
        c.calendarId === channel.calendarId &&
        c.status === "active" &&
        c.syncReceivedAt !== null,
    );
    return replacementDelivered || now - Date.parse(channel.updatedAt) >= RETIRING_WINDOW_MS ? "replaced" : null;
  }
  return null;
}

async function ensureChannel(
  deps: MaintenanceDeps,
  conn: InboundConnection,
  mine: ChannelRecord[],
  address: string,
  now: number,
  report: MaintenanceReport,
): Promise<void> {
  const live = mine.filter((c) => c.expiresAt === null || Date.parse(c.expiresAt) > now);

  // Resposta do watch perdida, mas a primeira mensagem chegou: ativa.
  for (const creating of live.filter((c) => c.status === "creating" && c.resourceId && c.expiresAt)) {
    const result = await adoptCreatingChannel(deps, conn, creating);
    if (result === "polling_only") report.pollingOnly += 1;
    return;
  }

  // Canal inviável recente: só polling, sem tentar em laço.
  if (mine.some((c) => c.status === "polling_only" && now - Date.parse(c.createdAt) < POLLING_ONLY_BACKOFF_MS)) return;

  const active = live.filter((c) => c.status === "active");
  const creatingRecently = live.some((c) => c.status === "creating" && now - Date.parse(c.createdAt) < CREATING_TIMEOUT_MS);
  if (active.length === 0) {
    if (creatingRecently) return;
    const result = await createChannel(deps, conn, address);
    if (result === "active") report.channelsCreated += 1;
    if (result === "polling_only") report.pollingOnly += 1;
    return;
  }

  for (const channel of active) {
    const result = await renewIfDue(deps, conn, channel, address);
    if (result === "active") report.channelsRenewed += 1;
    if (result === "polling_only") report.pollingOnly += 1;
  }
}
