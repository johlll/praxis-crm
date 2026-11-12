import { NonRetriableError } from "inngest";

import { createAdminSupabaseClient } from "@/server/supabase/admin";

/**
 * Agendador diário do lote de retenção da C3b (B6b) — chama `run_privacy_retention_batch` uma vez por
 * dia, às 06:17 UTC (03:17 em Brasília), no app geral do Inngest (`praxis-crm`, `/api/inngest`), em
 * função PRÓPRIA, ao lado da A11 e da C1 e sem tocar nelas. Fica nesta pasta porque o cliente
 * service_role só pode ser importado por `src/app/api/inngest/**` (eslint.config.mjs).
 *
 * Sem acionamento por evento: o gatilho é exclusivamente o relógio. Nenhuma entrada vem do navegador,
 * nenhuma rota nova, nenhuma tabela lida diretamente: só a RPC, exclusiva do `service_role`.
 *
 * Quem decide o que é elegível, o que bloqueia e o que anonimiza é o banco (C3b); aqui só se dispara o
 * lote. O banco é idempotente e pula linhas travadas, então esta função NÃO tenta de novo
 * (`retries: 0`): se uma execução falhar, o ciclo do dia seguinte é a recuperação. Concorrência 1 evita
 * dois lotes em paralelo (o pior caso de uma sobreposição seria só tempo).
 *
 * Um lote examina no máximo `PRIVACY_RETENTION_BATCH_LIMIT` contatos; a sobra fica para o dia seguinte
 * (o banco rotaciona quem foi avaliado há mais tempo).
 *
 * Só o código fechado sai daqui: nunca a mensagem do banco, id, workspace, contato, motivo, dado pessoal
 * ou segredo. Sem log próprio. O retorno de sucesso são só as três contagens.
 */

export const PRIVACY_RETENTION_BATCH_LIMIT = 50;
export const PRIVACY_RETENTION_STEP_ID = "run-privacy-retention-batch";

export const PRIVACY_RETENTION_SCHEDULER_FUNCTION_CONFIG = {
  id: "c3b-privacy-retention-scheduler" as const,
  name: "C3b — lote diário de retenção e anonimização",
  concurrency: { limit: 1 },
  retries: 0 as const,
  triggers: [{ cron: "17 6 * * *" }],
};

export type PrivacyRetentionSchedulerFailureCode =
  | "privacy_retention_not_configured"
  | "privacy_retention_failed"
  | "privacy_retention_batch_has_failures";

/** Falha da execução no Inngest, só com o código: nem mensagem original nem pilha. */
export class PrivacyRetentionSchedulerFailed extends NonRetriableError {
  constructor(public readonly code: PrivacyRetentionSchedulerFailureCode) {
    super(code);
    this.name = "PrivacyRetentionSchedulerFailed";
    this.stack = `${this.name}: ${code}`;
  }
}

export type PrivacyRetentionSummary = Readonly<{ processed: number; blocked: number; failed: number }>;

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

export async function runPrivacyRetentionScheduler(): Promise<PrivacyRetentionSummary> {
  let supabase: ReturnType<typeof createAdminSupabaseClient>;
  try {
    supabase = createAdminSupabaseClient();
  } catch {
    throw new PrivacyRetentionSchedulerFailed("privacy_retention_not_configured");
  }

  let data: unknown;
  let failed = false;
  try {
    const result = await supabase.rpc("run_privacy_retention_batch", { p_limit: PRIVACY_RETENTION_BATCH_LIMIT });
    failed = Boolean(result.error);
    data = result.data;
  } catch {
    failed = true;
  }

  const counts = (data ?? null) as { processed?: unknown; blocked?: unknown; failed?: unknown } | null;
  if (
    failed ||
    !counts ||
    !isCount(counts.processed) ||
    !isCount(counts.blocked) ||
    !isCount(counts.failed) ||
    counts.processed + counts.blocked + counts.failed > PRIVACY_RETENTION_BATCH_LIMIT
  ) {
    throw new PrivacyRetentionSchedulerFailed("privacy_retention_failed");
  }

  // Alguma anonimização falhou (e foi desfeita pelo banco): a execução fica VISÍVEL como falha no Inngest.
  // O dia seguinte tenta de novo; nada sai daqui além do código.
  if (counts.failed > 0) {
    throw new PrivacyRetentionSchedulerFailed("privacy_retention_batch_has_failures");
  }

  return { processed: counts.processed, blocked: counts.blocked, failed: counts.failed };
}

type Step = { run: (id: string, fn: () => Promise<PrivacyRetentionSummary>) => Promise<unknown> };

export async function handlePrivacyRetentionScheduler({ step }: { step: Step }) {
  return step.run(PRIVACY_RETENTION_STEP_ID, runPrivacyRetentionScheduler);
}
