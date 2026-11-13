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
 * ESTADO: preparada, NÃO ativada. Enquanto o app não for sincronizado no Inngest, esta função não roda; o
 * workflow antigo continua em funcionamento. Sequência futura: (1) merge e deploy; (2) sincronizar o app
 * `praxis-crm`; (3) observar pelo menos duas execuções naturais; (4) confirmar que o workflow antigo rodando ao
 * mesmo tempo não duplica efeito (o banco reserva cada linha uma única vez); (5) SÓ ENTÃO, em PR separada,
 * retirar o `schedule` do GitHub e manter o `workflow_dispatch` como contingência. ATENÇÃO ao passo 5: o mesmo
 * workflow também chama `/api/cron/retention` (retenção e alertas da A11), que NÃO é coberta por esta função.
 *
 * Sem acionamento por evento: o gatilho é exclusivamente o relógio. Um único passo. Sem chamada ao WhatsApp, à
 * agenda ou à Vitória: só as RPCs da operação compartilhada e a publicação do evento da A11 no Inngest.
 *
 * O banco é quem serializa (`for update skip locked` e trava de 120 s), então esta função NÃO tenta de novo
 * (`retries: 0`): se uma execução falhar, o próximo ciclo de 10 minutos é a recuperação. Concorrência 1 evita
 * duas rodadas em paralelo daqui; contra o workflow antigo valem as travas do banco. A falha de publicação de
 * UM item não derruba a rodada: vira contagem (`failed`) e o banco reagenda o item em 60 s, como na rota.
 *
 * Capacidade (franquia conhecida do Inngest: 50.000 execuções por mês): a cada 10 minutos são 144 execuções por
 * dia, cerca de 4.320 por mês (30 dias). Somadas à C1 (a cada 2 min, ~21.600 por mês) e à C3b (diária, ~31 por
 * mês), o total periódico fica em ~25.951 por mês, MAIS as execuções por evento da A11, a agenda e o WhatsApp.
 * Continua abaixo da franquia, mas precisa de acompanhamento. NÃO reduzir o intervalo sem reavaliar o plano.
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
