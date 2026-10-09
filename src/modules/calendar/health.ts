/**
 * Detector 2 (§9.3): o que owner/admin veem ao abrir a agenda ou as
 * Integrações. Só datas e contagens. Função pura: quem lê o banco é
 * `getCalendarSyncHealth` (automation.ts).
 *
 * "Executou recentemente" e "sincronizou com sucesso" são coisas
 * diferentes: um agendador que roda e falha não está atrasado, mas também
 * não está em dia — cada caso tem o seu aviso.
 */

export type CalendarSyncHealth = {
  schedulers: Array<{
    scheduler: "inngest" | "github" | "manual";
    lastRunAt: string;
    lastOutcome: "ok" | "partial" | "failed";
    lastSuccessAt: string | null;
  }>;
  activeLinks: number;
  channelsLowLife: number;
};

export type HealthNotice = { level: "info" | "warning"; message: string };

/** Batimento automático mais antigo que isto: atrasado (§9.3). */
export const HEALTH_STALE_MS = 60 * 60_000;

const minutesSince = (now: Date, iso: string) => Math.round((now.getTime() - Date.parse(iso)) / 60_000);

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
    // Atraso = nenhuma EXECUÇÃO recente, qualquer que tenha sido o desfecho.
    const latest = health.schedulers
      .filter((h) => h.scheduler !== "manual")
      .sort((a, b) => Date.parse(b.lastRunAt) - Date.parse(a.lastRunAt))[0];
    if (!latest) {
      notices.push({ level: "warning", message: "Sincronização automática atrasada: nenhuma execução registrada neste ambiente." });
    } else if (opts.now.getTime() - Date.parse(latest.lastRunAt) > HEALTH_STALE_MS) {
      notices.push({
        level: "warning",
        message: `Sincronização automática atrasada: a última execução foi há ${minutesSince(opts.now, latest.lastRunAt)} minutos. Alterações feitas no Google podem demorar a aparecer.`,
      });
    } else if (latest.lastOutcome === "failed") {
      const success = latest.lastSuccessAt
        ? `A última execução sem falhas foi há ${minutesSince(opts.now, latest.lastSuccessAt)} minutos.`
        : "Nenhuma execução sem falhas foi registrada.";
      notices.push({
        level: "warning",
        message: `A sincronização automática está rodando, mas a última execução falhou. ${success} Alterações feitas no Google podem não ter chegado ao CRM; a próxima execução tenta de novo.`,
      });
    } else if (latest.lastOutcome === "partial") {
      notices.push({
        level: "warning",
        message:
          "A última execução da sincronização automática não conseguiu atualizar parte das agendas; as demais foram atualizadas. A próxima execução tenta de novo.",
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
