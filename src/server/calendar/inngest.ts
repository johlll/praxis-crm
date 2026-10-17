import { Inngest, NonRetriableError } from "inngest";

import { calendarSchedulerEnabled } from "@/server/calendar/automation-flags";
import type { ScheduledResult } from "@/server/calendar/sync/scheduled";

/**
 * Agendador PRINCIPAL da agenda (§9.2, item 1): função do Inngest a cada 15
 * min, num app PRÓPRIO (`praxis-crm-agenda`, rota `/api/inngest/calendar`),
 * separado do app da A11 (`praxis-crm`, `/api/inngest`) — a agenda não
 * depende da configuração da A11. O app id não isola ambientes: quem separa
 * Preview de Production no Inngest é a signing key (de branch ou de
 * Production) e o ambiente anunciado pelo SDK (`VERCEL_GIT_COMMIT_REF`).
 *
 * Só é oferecida ao Inngest com `CALENDAR_SCHEDULER_ENABLED=true`: desligada
 * (o padrão), a lista volta vazia — e sincronizar o app com a lista vazia é
 * o que retira a função do Inngest.
 */

export const CALENDAR_INNGEST_APP_ID = "praxis-crm-agenda";
export const CALENDAR_SCHEDULE_CRON = "TZ=UTC */15 * * * *";

let cachedClient: Inngest | undefined;

/** Cliente próprio da agenda. Construir não exige configuração (a signing
 * key é lida pelo SDK por requisição, de `INNGEST_SIGNING_KEY`). */
export function calendarInngestClient(): Inngest {
  cachedClient ??= new Inngest({ id: CALENDAR_INNGEST_APP_ID });
  return cachedClient;
}

/** Retorno técnico da execução: só o desfecho e contagens, nunca conteúdo de
 * evento. `partial` continua explícito (houve agenda com falha). */
export function executionSummary(result: ScheduledResult | null) {
  if (!result) return { enabled: false as const };
  const r = result.report;
  return {
    enabled: true as const,
    outcome: result.outcome,
    targets: r?.targets ?? 0,
    synced: r?.synced ?? 0,
    failed: r?.failed ?? 0,
    busy: r?.busy ?? 0,
    accessLost: r?.accessLost ?? 0,
    needsReauth: r?.needsReauth ?? 0,
  };
}

/** Falha da rodada como FALHA da execução no Inngest, com erro sanitizado e
 * sem nova tentativa (o batimento já registrou o desfecho verdadeiro). */
export class CalendarMaintenanceFailed extends NonRetriableError {
  constructor(code: "calendar_maintenance_failed" | "calendar_maintenance_error") {
    super(code);
    this.name = "CalendarMaintenanceFailed";
    // Nem caminho de arquivo nem pilha saem para o Inngest: só o código.
    this.stack = `${this.name}: ${code}`;
  }
}

export async function runCalendarMaintenanceStep(
  run: () => Promise<ScheduledResult | null>,
): Promise<ReturnType<typeof executionSummary>> {
  let result: ScheduledResult | null;
  try {
    result = await run();
  } catch {
    // A mensagem original (banco, rede) não sai daqui.
    throw new CalendarMaintenanceFailed("calendar_maintenance_error");
  }
  const summary = executionSummary(result);
  if (summary.enabled && summary.outcome === "failed") throw new CalendarMaintenanceFailed("calendar_maintenance_failed");
  return summary;
}

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
        step.run("maintenance", () =>
          runCalendarMaintenanceStep(async () => {
            const { runScheduledCalendarMaintenance } = await import("@/server/calendar/background");
            return runScheduledCalendarMaintenance("inngest");
          }),
        ),
    ),
  ];
}
