import { syncCalendar } from "@/server/calendar/sync/inbound";
import type { InboundDeps } from "@/server/calendar/sync/inbound-types";

/**
 * Sincronização SOB DEMANDA (§9.2, item 3): abrir a agenda ou criar/editar
 * um compromisso dispara a sincronização incremental das agendas da PRÓPRIA
 * conexão cuja última execução tem mais de 5 minutos. O que o usuário vê
 * não depende do agendador estar vivo. Usa a mesma trava da manutenção:
 * nunca roda junto com outra execução da mesma agenda.
 */

export const ON_DEMAND_MIN_INTERVAL_MS = 5 * 60_000;
/** Teto por chamada: a sob demanda não vira uma rodada de manutenção. */
export const ON_DEMAND_MAX_CALENDARS = 5;

export type OnDemandReport = { calendars: number; synced: number; skippedRecent: number; busy: number; failed: number };

export async function syncOwnCalendarsOnDemand(
  deps: InboundDeps,
  conn: { connectionId: string; userId: string; accessToken: string },
): Promise<OnDemandReport> {
  const report: OnDemandReport = { calendars: 0, synced: 0, skippedRecent: 0, busy: 0, failed: 0 };
  const now = deps.now().getTime();
  const targets = await deps.store.listOwnSyncTargets(conn.userId, conn.connectionId);
  report.calendars = targets.length;

  let started = 0;
  for (const target of targets) {
    const lastRun = target.lastRunAt ? Date.parse(target.lastRunAt) : null;
    const leased = target.leaseUntil !== null && Date.parse(target.leaseUntil) > now;
    if ((lastRun !== null && now - lastRun < ON_DEMAND_MIN_INTERVAL_MS) || leased) {
      report.skippedRecent += 1;
      continue;
    }
    if (started >= ON_DEMAND_MAX_CALENDARS) break;
    started += 1;
    const outcome = await syncCalendar(deps, {
      connectionId: conn.connectionId,
      userId: conn.userId,
      calendarId: target.calendarId,
      environment: deps.environment,
      accessToken: conn.accessToken,
    });
    if (outcome.status === "synced") report.synced += 1;
    else if (outcome.status === "busy") report.busy += 1;
    else report.failed += 1;
  }
  return report;
}
