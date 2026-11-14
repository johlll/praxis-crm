import { NonRetriableError } from "inngest";

import { createAdminSupabaseClient } from "@/server/supabase/admin";
import { OutboxReconcileError, reconcileOutbox, type OutboxReconcileSummary } from "@/server/ingest/outbox-reconciler";
import { inngestPublisher } from "@/server/ingest/publisher";

/**
 * Agendador periódico do reconciliador da outbox da A11 — roda a MESMA operação da rota `/api/cron/outbox`
 * (`reconcileOutbox`, em `src/server/ingest/outbox-reconciler.ts`) a cada 10 minutos, no app geral do Inngest
 * (`praxis-crm`, `/api/inngest`), em função PRÓPRIA, ao lado da A11 (por evento), da C1 e da C3b, sem tocar
 * nelas. Fica nesta pasta porque o cliente service_role só pode ser importado por `src/app/api/inngest/**`
 * (eslint.config.mjs).
 *
 * POR QUE EXISTE: o `schedule` do GitHub Actions (`.github/workflows/a11-reconcile.yml`, configurado para
 * cada 10 minutos) é instável — intervalos observados de 3,4 a 10,6 horas (mediana 6,5 h), só 4 execuções em
 * 24 h contra 144 esperadas. O Inngest dispara por relógio próprio.
 *
 * ESTADO: sincronizada no Inngest em 13/11/2026 (65 de 65 runs concluídos, sem retry nem duplicação, na observação
 * natural); o workflow antigo continua em funcionamento. Sequência futura: (1) observar a coincidência com o
 * workflow antigo e confirmar que não duplica efeito (o banco reserva cada linha uma única vez); (2) SÓ ENTÃO, em
 * PR separada, retirar o `schedule` do GitHub e manter o `workflow_dispatch` como contingência. ATENÇÃO: o mesmo
 * workflow também chama `/api/cron/retention` (retenção e alertas da A11), que é coberta pela função própria
 * `a11-retention-scheduler` (uma vez por hora), não por esta.
 *
 * Sem acionamento por evento: o gatilho é exclusivamente o relógio. Um único passo. Sem chamada ao WhatsApp, à
 * agenda ou à Vitória: só as RPCs da operação compartilhada e a publicação do evento da A11 no Inngest.
 *
 * O banco é quem serializa (`for update skip locked` e trava de 120 s), então esta função NÃO tenta de novo
 * (`retries: 0`): se uma execução falhar, o próximo ciclo de 10 minutos é a recuperação. Concorrência 1 evita
 * duas rodadas em paralelo daqui; contra o workflow antigo valem as travas do banco. A falha de publicação de
 * UM item não derruba a rodada: vira contagem (`failed`) e o banco reagenda o item em 60 s, como na rota.
 *
 * Capacidade (franquia do plano Hobby: 50.000 EXECUÇÕES por mês): o Inngest cobra 3 execuções por run de um passo
 * (o run, o passo e a finalização). A cada 10 minutos são 144 runs por dia, 4.320 por mês e 12.960 execuções por
 * mês (30 dias). Total periódico do app: C1 a cada 10 min 12.960 + esta função 12.960 + retenção da A11 horária
 * 2.160 + C3b diária 90 = 28.170 execuções por mês (9.390 runs), com margem de ~21.830 para os eventos. A
 * estimativa anterior contava runs, não execuções faturáveis. NÃO encurtar o intervalo nem ativar a Agenda ou o
 * WhatsApp sem novo cálculo; no Hobby, atingir o limite PAUSA as funções.
 *
 * Só o código fechado sai daqui: nunca a mensagem do banco, payload, dado pessoal, URL ou segredo. Sem log
 * próprio. O retorno de sucesso são só as quatro contagens.
 */

export const A11_RECONCILER_SCHEDULER_STEP_ID = "reconcile-outbox";

export const A11_RECONCILER_SCHEDULER_FUNCTION_CONFIG = {
  id: "a11-reconciler-scheduler" as const,
  name: "A11 — reconciliar a outbox (a cada 10 minutos)",
  concurrency: { limit: 1 },
  retries: 0 as const,
  triggers: [{ cron: "*/10 * * * *" }],
};

export type A11ReconcilerSchedulerFailureCode =
  | "a11_reconciler_not_configured"
  | "a11_reconciler_resolve_failed"
  | "a11_reconciler_claim_failed"
  | "a11_reconciler_failed";

/** Falha da execução no Inngest, só com o código: nem mensagem original nem pilha. */
export class A11ReconcilerSchedulerFailed extends NonRetriableError {
  constructor(public readonly code: A11ReconcilerSchedulerFailureCode) {
    super(code);
    this.name = "A11ReconcilerSchedulerFailed";
    this.stack = `${this.name}: ${code}`;
  }
}

export async function runA11ReconcilerScheduler(): Promise<OutboxReconcileSummary> {
  let supabase: ReturnType<typeof createAdminSupabaseClient>;
  try {
    supabase = createAdminSupabaseClient();
  } catch {
    throw new A11ReconcilerSchedulerFailed("a11_reconciler_not_configured");
  }

  try {
    return await reconcileOutbox(supabase, inngestPublisher);
  } catch (error) {
    if (error instanceof OutboxReconcileError) {
      throw new A11ReconcilerSchedulerFailed(
        error.code === "resolve_failed" ? "a11_reconciler_resolve_failed" : "a11_reconciler_claim_failed",
      );
    }
    throw new A11ReconcilerSchedulerFailed("a11_reconciler_failed");
  }
}

type Step = { run: (id: string, fn: () => Promise<OutboxReconcileSummary>) => Promise<unknown> };

export async function handleA11ReconcilerScheduler({ step }: { step: Step }) {
  return step.run(A11_RECONCILER_SCHEDULER_STEP_ID, runA11ReconcilerScheduler);
}
