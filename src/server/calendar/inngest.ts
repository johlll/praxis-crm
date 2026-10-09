import type { Inngest } from "inngest";

import { calendarSchedulerEnabled } from "@/server/calendar/automation-flags";

/**
 * Agendador PRINCIPAL da agenda (§9.2, item 1): função do Inngest a cada 15
 * min, por ambiente (cada deployment registra a sua). Só é oferecida ao
 * Inngest com `CALENDAR_SCHEDULER_ENABLED=true`: desligada (o padrão), a
 * lista volta vazia, o Inngest não conhece a função e nada é agendado —
 * inclusive em Production depois do merge.
 */

export const CALENDAR_SCHEDULE_CRON = "TZ=UTC */15 * * * *";

export function calendarInngestFunctions(client: Inngest) {
  if (!calendarSchedulerEnabled()) return [];
  return [
    client.createFunction(
      {
        id: "b2-calendar-maintenance",
        name: "B2 — manutenção do Google Agenda",
        // Uma rodada por vez por deployment; as travas do banco já impedem
        // trabalho duplicado entre agendadores.
        concurrency: { limit: 1 },
        retries: 0,
        triggers: [{ cron: CALENDAR_SCHEDULE_CRON }],
      },
      async ({ step }) =>
        step.run("maintenance", async () => {
          const { runScheduledCalendarMaintenance } = await import("@/server/calendar/background");
          const result = await runScheduledCalendarMaintenance("inngest");
          // Só contagens e o desfecho; nunca conteúdo de evento.
          return result ? { enabled: true, outcome: result.outcome, synced: result.report?.synced ?? 0 } : { enabled: false };
        }),
    ),
  ];
}
