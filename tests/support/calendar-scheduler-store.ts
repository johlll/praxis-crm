import type { AlertClaim, Heartbeat, SchedulerSource, SchedulerStore } from "@/server/calendar/sync/scheduled";

/**
 * Batimento e alertas em memória, com a mesma semântica das RPCs da
 * migration `20261012100000_b2_scheduler_alerts_restore` (só números no
 * relatório, intervalo mínimo entre alertas, falha não conta para o
 * intervalo). O banco real é coberto pelo pgTAP (`25_b2_scheduler_alerts_restore`).
 */
export class MemorySchedulerStore implements SchedulerStore {
  heartbeats = new Map<SchedulerSource, Heartbeat & { report: Record<string, number>; runs: number }>();
  alerts: Array<{ id: string; createdAt: number; status: "claimed" | "sent" | "failed"; error: string | null; recipients: number }> = [];
  /** Owner/admin dos workspaces com vínculo ativo (o banco os calcula). */
  recipients: Array<{ email: string }> = [{ email: "dona@exemplo.test" }, { email: "admin@exemplo.test" }];
  private seq = 0;

  constructor(readonly now: () => Date) {}

  async recordHeartbeat(scheduler: SchedulerSource, outcome: "ok" | "failed", report: Record<string, number>): Promise<void> {
    const numeric = Object.fromEntries(Object.entries(report).filter(([, v]) => typeof v === "number"));
    const previous = this.heartbeats.get(scheduler);
    this.heartbeats.set(scheduler, {
      scheduler,
      lastRunAt: this.now().toISOString(),
      lastOutcome: outcome,
      report: numeric,
      runs: (previous?.runs ?? 0) + 1,
    });
  }

  async listHeartbeats(): Promise<Heartbeat[]> {
    return [...this.heartbeats.values()].map(({ scheduler, lastRunAt, lastOutcome }) => ({ scheduler, lastRunAt, lastOutcome }));
  }

  async claimAlert(_kind: "scheduler_stale", _scheduler: SchedulerSource, cooldownMinutes: number): Promise<AlertClaim | null> {
    const since = this.now().getTime() - Math.max(60, cooldownMinutes) * 60_000;
    if (this.alerts.some((a) => a.status !== "failed" && a.createdAt > since)) return null;
    this.seq += 1;
    const id = `alerta-${this.seq}`;
    this.alerts.push({ id, createdAt: this.now().getTime(), status: "claimed", error: null, recipients: this.recipients.length });
    return { alertId: id, recipients: structuredClone(this.recipients) };
  }

  async finishAlert(alertId: string, status: "sent" | "failed", error: string | null): Promise<void> {
    const alert = this.alerts.find((a) => a.id === alertId && a.status === "claimed");
    if (alert) Object.assign(alert, { status, error });
  }
}
