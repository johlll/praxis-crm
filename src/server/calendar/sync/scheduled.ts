import type { MaintenanceReport } from "@/server/calendar/sync/maintenance";

/**
 * Uma rodada AGENDADA da manutenção (B2, etapa 3b; §9.2, §9.3): roda a
 * manutenção, grava o batimento de quem chamou e, quando quem chamou é a
 * recuperação adicional, confere o batimento do agendador principal
 * (Detector 1). Função sem Supabase nem HTTP: recebe as portas.
 *
 * O batimento e o relatório têm só contagens — nunca conteúdo de evento.
 */

export type SchedulerSource = "inngest" | "github" | "manual";

/**
 * Desfecho de uma rodada: `ok` = toda agenda tentada sincronizou; `partial` =
 * parte falhou; `failed` = a rodada falhou ou nenhuma agenda tentada
 * sincronizou. Agenda ocupada (outra execução com a trava), sem acesso ou a
 * reautorizar NÃO é falha da rodada: é situação daquela conexão, que já
 * aparece nela (vínculo para atenção, conexão a reautorizar).
 */
export type RunOutcome = "ok" | "partial" | "failed";

/** `lastRunAt` = executou; `lastSuccessAt` = última rodada `ok` (null = nenhuma). */
export type Heartbeat = { scheduler: SchedulerSource; lastRunAt: string; lastOutcome: RunOutcome; lastSuccessAt: string | null };

export type AlertClaim = { alertId: string; recipients: Array<{ email: string }> };

export interface SchedulerStore {
  recordHeartbeat(scheduler: SchedulerSource, outcome: RunOutcome, report: Record<string, number>): Promise<void>;
  listHeartbeats(): Promise<Heartbeat[]>;
  /** `null` = ainda dentro do intervalo mínimo desde o último alerta. */
  claimAlert(kind: "scheduler_stale", scheduler: SchedulerSource, cooldownMinutes: number): Promise<AlertClaim | null>;
  finishAlert(alertId: string, status: "sent" | "failed", error: string | null): Promise<void>;
}

export type AlertMessage = { to: string; subject: string; text: string; idempotencyKey: string };

export type ScheduledDeps = {
  maintenance: () => Promise<MaintenanceReport>;
  store: SchedulerStore;
  now: () => Date;
  /** `CALENDAR_SCHEDULER_ENABLED`: sem agendador principal ligado, não há o que vigiar. */
  schedulerEnabled: boolean;
  /** `CALENDAR_ALERTS_ENABLED`: desligado, nenhum e-mail sai. */
  alertsEnabled: boolean;
  /** `null` = sem provedor de e-mail configurado. */
  sendAlert: ((message: AlertMessage) => Promise<void>) | null;
};

/** Agendador principal sem batimento há mais que isto: atrasado (§9.3). */
export const SCHEDULER_STALE_MS = 60 * 60_000;
/** Intervalo mínimo entre dois alertas iguais. */
export const ALERT_COOLDOWN_MINUTES = 6 * 60;

export type DetectorOutcome =
  /** Agendador principal desligado por configuração: não há o que vigiar. */
  | "scheduler_disabled"
  | "healthy"
  /** Atrasado, mas os alertas estão desligados: nada enviado. */
  | "stale_alerts_disabled"
  /** Atrasado; já houve alerta dentro do intervalo mínimo. */
  | "stale_cooldown"
  | "stale_alert_sent"
  | "stale_alert_failed"
  /** Rodou dentro do prazo, mas a última rodada falhou (nada ou quase nada sincronizou). */
  | "last_run_failed"
  /** Rodou dentro do prazo, mas parte das agendas falhou na última rodada. */
  | "last_run_partial";

export type ScheduledResult = {
  outcome: RunOutcome;
  report: MaintenanceReport | null;
  detector: DetectorOutcome | null;
};

function countsOf(report: MaintenanceReport): Record<string, number> {
  return Object.fromEntries(Object.entries(report).filter(([, v]) => typeof v === "number")) as Record<string, number>;
}

/** Desfecho pelo relatório: falha de agenda conta; ocupada, sem acesso ou a reautorizar, não. */
export function outcomeOf(report: MaintenanceReport): RunOutcome {
  if (report.failed === 0) return "ok";
  return report.synced === 0 ? "failed" : "partial";
}

export async function runScheduledMaintenance(deps: ScheduledDeps, source: SchedulerSource): Promise<ScheduledResult> {
  let report: MaintenanceReport | null = null;
  let outcome: RunOutcome;
  try {
    report = await deps.maintenance();
    outcome = outcomeOf(report);
  } catch {
    outcome = "failed";
  }
  // O batimento é gravado mesmo quando a rodada falha: "rodou e falhou" é
  // diferente de "não rodou".
  await deps.store.recordHeartbeat(source, outcome, report ? countsOf(report) : {});

  const detector = source === "github" ? await checkPrimaryScheduler(deps) : null;
  return { outcome, report, detector };
}

/** Detector 1 (§9.3): a recuperação adicional confere o agendador principal. */
export async function checkPrimaryScheduler(deps: ScheduledDeps): Promise<DetectorOutcome> {
  if (!deps.schedulerEnabled) return "scheduler_disabled";

  const primary = (await deps.store.listHeartbeats()).find((h) => h.scheduler === "inngest");
  const last = primary ? Date.parse(primary.lastRunAt) : null;
  // Executou recentemente: não está atrasado. Se a última rodada falhou (no
  // todo ou em parte), não é saúde normal — mas também não é atraso.
  if (primary && last !== null && deps.now().getTime() - last <= SCHEDULER_STALE_MS) {
    if (primary.lastOutcome === "failed") return "last_run_failed";
    if (primary.lastOutcome === "partial") return "last_run_partial";
    return "healthy";
  }

  if (!deps.alertsEnabled) return "stale_alerts_disabled";

  const claim = await deps.store.claimAlert("scheduler_stale", "inngest", ALERT_COOLDOWN_MINUTES);
  if (!claim) return "stale_cooldown";
  if (!deps.sendAlert) {
    await deps.store.finishAlert(claim.alertId, "failed", "email_not_configured");
    return "stale_alert_failed";
  }
  if (claim.recipients.length === 0) {
    await deps.store.finishAlert(claim.alertId, "failed", "no_recipients");
    return "stale_alert_failed";
  }

  const since = primary ? `desde ${new Date(last!).toISOString()}` : "desde que foi ligada (nenhuma execução registrada)";
  let failed = 0;
  // Um e-mail por destinatário: ninguém vê o endereço dos outros.
  for (const { email } of claim.recipients) {
    try {
      await deps.sendAlert({
        to: email,
        subject: "Praxis CRM: sincronização automática do Google Agenda atrasada",
        text: [
          `A sincronização automática do Google Agenda não roda ${since}.`,
          "As alterações feitas no Google podem demorar a aparecer no CRM. Abrir a agenda no CRM força uma atualização da sua agenda.",
          "Este aviso é enviado no máximo a cada 6 horas enquanto o atraso continuar.",
        ].join("\n\n"),
        idempotencyKey: `${claim.alertId}:${email}`,
      });
    } catch {
      failed += 1;
    }
  }
  if (failed === claim.recipients.length) {
    await deps.store.finishAlert(claim.alertId, "failed", "send_failed");
    return "stale_alert_failed";
  }
  await deps.store.finishAlert(claim.alertId, "sent", failed > 0 ? `partial_${failed}` : null);
  return "stale_alert_sent";
}
