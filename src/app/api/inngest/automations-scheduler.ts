import { NonRetriableError } from "inngest";

import { createAdminSupabaseClient } from "@/server/supabase/admin";

/**
 * Agendador periódico das automações (B6a) — roda a rodada do sistema da C1
 * (`process_automation_events_system`) a cada 10 minutos, no app geral do
 * Inngest (`praxis-crm`, `/api/inngest`), em função PRÓPRIA e isolada do worker
 * da A11. Fica nesta pasta porque o cliente service_role só pode ser
 * importado por `src/app/api/inngest/**` (eslint.config.mjs).
 *
 * Sem acionamento por evento: o gatilho é exclusivamente o relógio.
 *
 * O banco é quem controla tentativas e espera (4 tentativas, 1/5/30 min, depois
 * dead-letter), então esta função NÃO tenta de novo (`retries: 0`): se uma
 * execução falhar, o próximo ciclo é a recuperação. Concorrência 1 evita duas
 * rodadas em paralelo; a rodada já é idempotente e pula linhas travadas
 * (`for update skip locked`), então o pior caso de uma sobreposição é só tempo.
 *
 * Uma rodada processa UM lote (`AUTOMATIONS_SCHEDULER_BATCH_LIMIT`); a sobra
 * fica para o ciclo seguinte.
 *
 * Por que 10 minutos: o processamento é pedido NA HORA pelas operações de lead e de
 * mudança de etapa (`scheduleAutomationRun`, depois da resposta), pelo botão
 * "Processar agora" e, como contingência, pela rota `/api/cron/automations`. O
 * relógio aqui é só recuperação e processamento das novas tentativas (1/5/30 min
 * no banco); um atraso máximo de 10 minutos é suficiente para o MVP.
 *
 * Capacidade (franquia do plano Hobby: 50.000 EXECUÇÕES por mês): o Inngest cobra
 * 3 execuções por run de um passo (o run, o passo e a finalização). A cada 10
 * minutos são 144 runs por dia, 4.320 por mês e 12.960 execuções por mês (30
 * dias) — dividida com a A11, a agenda, o WhatsApp e as execuções reais. A
 * C1 a cada 2 minutos custava ~64.800 por mês e estourava a franquia sozinha. NÃO
 * encurtar o intervalo sem recalcular o consumo; no Hobby, atingir o limite PAUSA
 * as funções (inclusive a A11 por evento).
 *
 * Só o código sanitizado sai daqui: nunca a mensagem do banco, payload, dado
 * pessoal ou segredo. Sem log.
 */

export const AUTOMATIONS_SCHEDULER_BATCH_LIMIT = 100;
export const AUTOMATIONS_SCHEDULER_STEP_ID = "process-automations";

export const AUTOMATIONS_SCHEDULER_FUNCTION_CONFIG = {
  id: "c1-automations-scheduler" as const,
  name: "C1 — processar automações",
  concurrency: { limit: 1 },
  retries: 0 as const,
  triggers: [{ cron: "*/10 * * * *" }],
};

export type AutomationsSchedulerFailureCode = "automations_scheduler_not_configured" | "automations_scheduler_failed";

/** Falha da execução no Inngest, só com o código: nem mensagem original nem pilha. */
export class AutomationsSchedulerFailed extends NonRetriableError {
  constructor(public readonly code: AutomationsSchedulerFailureCode) {
    super(code);
    this.name = "AutomationsSchedulerFailed";
    this.stack = `${this.name}: ${code}`;
  }
}

export type AutomationsSchedulerSummary = Readonly<{ events: number; executions: number }>;

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

export async function runAutomationsScheduler(): Promise<AutomationsSchedulerSummary> {
  let supabase: ReturnType<typeof createAdminSupabaseClient>;
  try {
    supabase = createAdminSupabaseClient();
  } catch {
    throw new AutomationsSchedulerFailed("automations_scheduler_not_configured");
  }

  let data: unknown;
  let failed = false;
  try {
    const result = await supabase.rpc("process_automation_events_system", { p_limit: AUTOMATIONS_SCHEDULER_BATCH_LIMIT });
    failed = Boolean(result.error);
    data = result.data;
  } catch {
    failed = true;
  }

  const counts = (data ?? null) as { events?: unknown; executions?: unknown } | null;
  if (failed || !counts || !isCount(counts.events) || !isCount(counts.executions)) {
    throw new AutomationsSchedulerFailed("automations_scheduler_failed");
  }
  return { events: counts.events, executions: counts.executions };
}

type Step = { run: (id: string, fn: () => Promise<AutomationsSchedulerSummary>) => Promise<unknown> };

export async function handleAutomationsScheduler({ step }: { step: Step }) {
  return step.run(AUTOMATIONS_SCHEDULER_STEP_ID, runAutomationsScheduler);
}
