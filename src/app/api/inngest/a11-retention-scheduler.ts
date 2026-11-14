import { NonRetriableError } from "inngest";

import { createAdminSupabaseClient } from "@/server/supabase/admin";
import { runRetentionMaintenance, type RetentionSummary } from "@/server/ingest/retention-maintenance";

/**
 * Agendador periódico da MANUTENÇÃO DE RETENÇÃO da A11 — roda a MESMA operação da rota `/api/cron/retention`
 * (`runRetentionMaintenance`, em `src/server/ingest/retention-maintenance.ts`) uma vez por hora (minuto 23), no app geral do
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
 * ESTADO: sincronizada no Inngest em 13/11/2026 (65 de 65 runs concluídos, sem retry nem duplicação, na observação
 * natural); o workflow antigo continua em funcionamento. A frequência horária (minuto 23) só vale depois de um novo
 * Resync do app `praxis-crm` com este código. Sequência futura: (1) Resync; (2) observar o próximo minuto 23 e o
 * consumo no painel; (3) confirmar que o workflow antigo rodando ao mesmo tempo não duplica efeito (alerta,
 * expiração, auditoria ou publicação — o banco reserva cada linha uma única vez); (4) SÓ ENTÃO, em PR separada,
 * retirar o `schedule` do GitHub e manter o `workflow_dispatch` como contingência para as duas operações.
 *
 * Isolamento: uma falha da outbox não impede a retenção e vice-versa — são funções distintas, cada uma com
 * concorrência 1 e observável separadamente no Inngest. Sem acionamento por evento: o gatilho é exclusivamente o
 * relógio. Um único passo. Sem chamada ao WhatsApp, à agenda ou à Vitória: só as três RPCs da operação.
 *
 * O banco é quem serializa (`for update skip locked` e marcador por linha), então esta função NÃO tenta de novo
 * (`retries: 0`): se uma execução falhar, o próximo ciclo (1 hora depois) é a recuperação. Concorrência 1 evita duas
 * rodadas em paralelo daqui; contra o workflow antigo valem as travas do banco. Cada rodada processa no máximo
 * 100 travados, 100 a vencer e 200 vencidos; a sobra fica para o ciclo seguinte.
 *
 * Por que uma vez por hora, no minuto 23: o trabalho é medido em dias (alerta antecipado 7 dias antes do vencimento,
 * expiração aos 30 dias), então a verificação horária basta. O minuto 23 evita o horário cheio e não coincide com a
 * C3b (06:17 UTC) nem com os ciclos de 10 minutos do reconciliador e da C1 que caem em minutos terminados em 0.
 *
 * Capacidade (franquia do plano Hobby: 50.000 EXECUÇÕES por mês): o Inngest cobra 3 execuções por run de um passo
 * (o run, o passo e a finalização). Uma vez por hora são 24 runs por dia, 720 por mês e 2.160 execuções por mês
 * (30 dias). Total periódico do app: C1 a cada 10 min 12.960 + reconciliador da A11 a cada 10 min 12.960 + esta
 * retenção 2.160 + C3b diária 90 = 28.170 execuções por mês (9.390 runs), com margem de ~21.830 para os eventos. A
 * estimativa anterior (~30.271) contava runs, não execuções faturáveis. NÃO ativar a Agenda nem o WhatsApp sem novo
 * cálculo; no Hobby, atingir o limite PAUSA as funções.
 *
 * Só o código fechado sai daqui: nunca a mensagem do banco, payload, dado pessoal, URL ou segredo. Sem log próprio
 * (os alertas estruturados, só com identificadores, são registrados pela operação compartilhada, exatamente como
 * pela rota). O retorno de sucesso são só as quatro contagens.
 */

export const A11_RETENTION_SCHEDULER_STEP_ID = "run-a11-retention";

export const A11_RETENTION_SCHEDULER_FUNCTION_CONFIG = {
  id: "a11-retention-scheduler" as const,
  name: "A11 — retenção e alertas dos eventos recebidos (a cada hora)",
  concurrency: { limit: 1 },
  retries: 0 as const,
  triggers: [{ cron: "23 * * * *" }],
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
