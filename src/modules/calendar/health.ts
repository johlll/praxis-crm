/**
 * Detector 2 (§9.3): o que owner/admin veem ao abrir a agenda ou as
 * Integrações. Só datas e contagens. Função pura: quem lê o banco é
 * `getCalendarSyncHealth` (automation.ts).
 */

export type CalendarSyncHealth = {
  schedulers: Array<{ scheduler: "inngest" | "github" | "manual"; lastRunAt: string; lastOutcome: "ok" | "failed" }>;
  activeLinks: number;
  channelsLowLife: number;
};

export type HealthNotice = { level: "info" | "warning"; message: string };

/** Batimento automático mais antigo que isto: atrasado (§9.3). */
export const HEALTH_STALE_MS = 60 * 60_000;

export function syncHealthNotices(
  health: CalendarSyncHealth,
  opts: { now: Date; schedulerEnabled: boolean },
): HealthNotice[] {
  if (health.activeLinks === 0) return [];
  const notices: HealthNotice[] = [];

  if (!opts.schedulerEnabled) {
    notices.push({
      level: "info",
      message:
        "A sincronização automática com o Google Agenda está desligada neste ambiente. A agenda é atualizada quando você abre esta tela e quando cria ou edita um compromisso.",
    });
  } else {
    // Só os agendadores automáticos contam (chamada manual não prova nada).
    const automatic = health.schedulers
      .filter((h) => h.scheduler !== "manual" && h.lastOutcome === "ok")
      .map((h) => Date.parse(h.lastRunAt));
    const latest = automatic.length > 0 ? Math.max(...automatic) : null;
    if (latest === null) {
      notices.push({ level: "warning", message: "Sincronização automática atrasada: nenhuma execução registrada neste ambiente." });
    } else if (opts.now.getTime() - latest > HEALTH_STALE_MS) {
      const minutes = Math.round((opts.now.getTime() - latest) / 60_000);
      notices.push({
        level: "warning",
        message: `Sincronização automática atrasada: a última execução foi há ${minutes} minutos. Alterações feitas no Google podem demorar a aparecer.`,
      });
    }
  }

  if (health.channelsLowLife > 0) {
    notices.push({
      level: "warning",
      message:
        health.channelsLowLife === 1
          ? "1 canal de notificação do Google Agenda está perto de vencer sem renovação."
          : `${health.channelsLowLife} canais de notificação do Google Agenda estão perto de vencer sem renovação.`,
    });
  }
  return notices;
}
