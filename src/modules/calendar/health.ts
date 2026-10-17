/**
 * Detector 2 (§9.3): o que owner/admin veem ao abrir a agenda ou as
 * Integrações. Só datas e contagens. Função pura: quem lê o banco é
 * `getCalendarSyncHealth` (automation.ts).
 *
 * "Executou recentemente" e "sincronizou com sucesso" são coisas
 * diferentes: um agendador que roda e falha não está atrasado, mas também
 * não está em dia — cada caso tem o seu aviso. O atraso é medido só pelo
 * agendador principal; a recuperação adicional aparece à parte.
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

/** "há N minutos" até 2 h; depois em horas e, passado 2 dias, em dias. */
function ago(now: Date, iso: string): string {
  const minutes = minutesSince(now, iso);
  if (minutes < 1) return "há menos de 1 minuto";
  if (minutes < 120) return `há ${minutes} ${minutes === 1 ? "minuto" : "minutos"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `há ${hours} horas`;
  return `há ${Math.floor(hours / 24)} dias`;
}

const RECOVERY_RESULT: Record<"ok" | "partial" | "failed", string> = {
  ok: "sem falhas",
  partial: "com falha em parte das agendas",
  failed: "com falha",
};

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
        "A sincronização automática com o Google Agenda está desligada neste ambiente. Abrir a página Agenda pode disparar a atualização da sua agenda conectada, no máximo uma vez a cada 5 minutos; criar ou editar um compromisso também pode dispará-la.",
    });
  } else {
    // A saúde AUTOMÁTICA é a do agendador principal (Inngest), e só dele: a
    // recuperação adicional (GitHub) roda por outro caminho e não prova que o
    // principal voltou; a chamada manual não prova nada. Atraso = nenhuma
    // EXECUÇÃO recente do principal, qualquer que tenha sido o desfecho.
    const primary = health.schedulers.find((h) => h.scheduler === "inngest");
    if (!primary) {
      notices.push({
        level: "warning",
        message: "Sincronização automática atrasada: o agendador principal não tem nenhuma execução registrada neste ambiente.",
      });
    } else if (opts.now.getTime() - Date.parse(primary.lastRunAt) > HEALTH_STALE_MS) {
      notices.push({
        level: "warning",
        message: `Sincronização automática atrasada: a última execução do agendador principal foi ${ago(opts.now, primary.lastRunAt)}. Alterações feitas no Google podem demorar a aparecer.`,
      });
    } else if (primary.lastOutcome === "failed") {
      const success = primary.lastSuccessAt
        ? `A última execução sem falhas foi ${ago(opts.now, primary.lastSuccessAt)}.`
        : "Nenhuma execução sem falhas foi registrada.";
      notices.push({
        level: "warning",
        message: `A sincronização automática está rodando, mas a última execução falhou. ${success} Alterações feitas no Google podem não ter chegado ao CRM; a próxima execução tenta de novo.`,
      });
    } else if (primary.lastOutcome === "partial") {
      notices.push({
        level: "warning",
        message:
          "A última execução da sincronização automática não conseguiu atualizar parte das agendas; as demais foram atualizadas. A próxima execução tenta de novo.",
      });
    }

    // Recuperação adicional: informação SEPARADA, com horário e resultado.
    // Nunca apaga nem suaviza o aviso do principal.
    const recovery = health.schedulers.find((h) => h.scheduler === "github");
    if (recovery) {
      notices.push({
        level: "info",
        message: `Recuperação adicional: última execução ${ago(opts.now, recovery.lastRunAt)}, ${RECOVERY_RESULT[recovery.lastOutcome]}. Ela roda por outro caminho e não comprova que o agendador principal esteja funcionando.`,
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
