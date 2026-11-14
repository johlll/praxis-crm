import { NonRetriableError } from "inngest";

import { createAdminSupabaseClient } from "@/server/supabase/admin";
import { runRetentionMaintenance, type RetentionSummary } from "@/server/ingest/retention-maintenance";

/**
 * Agendador periódico da MANUTENÇÃO DE RETENÇÃO da A11 — roda a MESMA operação da rota `/api/cron/retention`
 * (`runRetentionMaintenance`, em `src/server/ingest/retention-maintenance.ts`) a cada 10 minutos, no app geral do
 * Inngest (`praxis-crm`, `/api/inngest`), em função PRÓPRIA, separada do reconciliador da outbox
 * (`a11-reconciler-scheduler`) e ao lado da A11 (por evento), da C1 e da C3b, sem tocar nelas. Fica nesta pasta
 * porque o cliente service_role só pode ser importado por `src/app/api/inngest/**` (eslint.config.mjs).
 *
 * É a retenção dos EVENTOS RECEBIDOS pela captação de formulários (eventos travados, alerta antecipado de
 * vencimento e o vencimento dos 30 dias) — não a retenção LGPD de contatos da C3b.
 *
 * POR QUE EXISTE: o workflow do GitHub Actions (`.github/workflows/a11-reconcile.yml`) chama `/api/cron/outbox` e
 * `/api/cron/retention` no mesmo `schedule`, que é instável (intervalos observados de 3,4 a 10,6 horas, mediana
 * 6,5 h, só 4 execuções em 24 h contra 144 esperadas). Para poder retirar esse `schedule` sem interromper nenhuma
 * rotina da A11, as DUAS operações têm função própria no Inngest.
 *
 * ESTADO: preparada, NÃO ativada. Enquanto o app não for sincronizado no Inngest, esta função não roda; o workflow
 * antigo continua em funcionamento. Sequência futura: (1) merge e deploy; (2) sincronizar o app `praxis-crm`
 * (as duas funções novas); (3) observar pelo menos dois ciclos naturais de AMBAS; (4) confirmar que o workflow
 * antigo rodando ao mesmo tempo não duplica efeito (alerta, expiração, auditoria ou publicação — o banco reserva
 * cada linha uma única vez); (5) SÓ ENTÃO, em PR separada, retirar o `schedule` do GitHub e manter o
 * `workflow_dispatch` como contingência para as duas operações.
 *
 * Isolamento: uma falha da outbox não impede a retenção e vice-versa — são funções distintas, cada uma com
 * concorrência 1 e observável separadamente no Inngest. Sem acionamento por evento: o gatilho é exclusivamente o
 * relógio. Um único passo. Sem chamada ao WhatsApp, à agenda ou à Vitória: só as três RPCs da operação.
 *
 * O banco é quem serializa (`for update skip locked` e marcador por linha), então esta função NÃO tenta de novo
 * (`retries: 0`): se uma execução falhar, o próximo ciclo de 10 minutos é a recuperação. Concorrência 1 evita duas
 * rodadas em paralelo daqui; contra o workflow antigo valem as travas do banco. Cada rodada processa no máximo
 * 100 travados, 100 a vencer e 200 vencidos; a sobra fica para o ciclo seguinte.
 *
 * Capacidade (franquia conhecida do Inngest: 50.000 execuções por mês): a cada 10 minutos são 144 execuções por
 * dia, cerca de 4.320 por mês (30 dias). Somadas à C1 (a cada 2 min, ~21.600 por mês), ao reconciliador da A11
 * (~4.320) e à C3b (diária, ~31), o total periódico fica em ~30.271 por mês, MAIS as execuções por evento da A11, a
 * agenda e o WhatsApp. Continua abaixo da franquia, mas a margem precisa ser acompanhada ANTES de ativar a Agenda e
 * o WhatsApp. NÃO reduzir o intervalo sem reavaliar o plano.
 *
 * Só o código fechado sai daqui: nunca a mensagem do banco, payload, dado pessoal, URL ou segredo. Sem log próprio
 * (os alertas estruturados, só com identificadores, são registrados pela operação compartilhada, exatamente como
 * pela rota). O retorno de sucesso são só as quatro contagens.
 */

export const A11_RETENTION_SCHEDULER_STEP_ID = "run-a11-retention";

export const A11_RETENTION_SCHEDULER_FUNCTION_CONFIG = {
  id: "a11-retention-scheduler" as const,
  name: "A11 — retenção e alertas dos eventos recebidos (a cada 10 minutos)",
  concurrency: { limit: 1 },
  retries: 0 as const,
  triggers: [{ cron: "*/10 * * * *" }],
};

export type A11RetentionSchedulerFailureCode = "a11_retention_not_configured" | "a11_retention_failed";

/** Falha da execução no Inngest, só com o código: nem mensagem original nem pilha. */
export class A11RetentionSchedulerFailed extends NonRetriableError {
  constructor(public readonly code: A11RetentionSchedulerFailureCode) {
    super(code);
    this.name = "A11RetentionSchedulerFailed";
    this.stack = `${this.name}: ${code}`;
  }
}

export async function runA11RetentionScheduler(): Promise<RetentionSummary> {
  let supabase: ReturnType<typeof createAdminSupabaseClient>;
  try {
    supabase = createAdminSupabaseClient();
  } catch {
    throw new A11RetentionSchedulerFailed("a11_retention_not_configured");
  }

  try {
    return await runRetentionMaintenance(supabase);
  } catch {
    // Erro do banco, resposta fora do contrato ou exceção inesperada: tudo vira o mesmo código fechado.
    throw new A11RetentionSchedulerFailed("a11_retention_failed");
  }
}

type Step = { run: (id: string, fn: () => Promise<RetentionSummary>) => Promise<unknown> };

export async function handleA11RetentionScheduler({ step }: { step: Step }) {
  return step.run(A11_RETENTION_SCHEDULER_STEP_ID, runA11RetentionScheduler);
}
