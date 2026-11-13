import type { SupabaseClient } from "@supabase/supabase-js";

import type { EventPublisher } from "@/server/ingest/publisher";
import type { Database } from "@/server/types/database";

/**
 * Reconciliador da outbox da A11 (contrato §7) — A OPERAÇÃO, num lugar só.
 *
 * Quem a chama: a rota `/api/cron/outbox` (workflow do GitHub Actions) e o agendador do Inngest
 * (`src/app/api/inngest/a11-reconciler-scheduler.ts`). Nenhum dos dois tem lógica própria: se a operação
 * mudar, muda para os dois. Por isso este arquivo NÃO importa o cliente `service_role` nem o publicador
 * (que exige configuração): recebe os dois por parâmetro, e só tipos são importados — o que também deixa o
 * arquivo executável direto pelo Node (teste de concorrência real, scripts/a11-schedulers-concurrency-check.mjs).
 *
 * O que faz: primeiro converge outbox órfã (evento já terminal por outro caminho — processado, expirado sem
 * processamento ou purgado — que nunca seria republicada); depois reserva a outbox pendente ou travada que
 * SOBROU (`claim_outbox_batch`, com `for update skip locked` e trava de 120 s), republica no Inngest com o
 * MESMO `webhook_event_id` e registra o resultado.
 *
 * O que NUNCA faz: efeito comercial (não cria contato, lead, oportunidade, atividade nem touchpoint — quem
 * aplica efeito é o worker, dentro da RPC transacional) e leitura direta de tabela: só as quatro RPCs abaixo.
 *
 * Concorrência: duas execuções ao mesmo tempo (o workflow antigo e o Inngest, por exemplo) nunca pegam a mesma
 * linha — a garantia é do banco (`claim_outbox_batch`/`resolve_stale_outbox_batch`), não daqui; republicar o
 * mesmo id é inofensivo (o Inngest deduplica por 24 h e o worker é idempotente).
 *
 * Só contagens e códigos fechados saem daqui: nunca a mensagem do banco, payload, dado pessoal ou segredo.
 */

export const OUTBOX_RESOLVE_LIMIT = 200;
export const OUTBOX_CLAIM_LIMIT = 20;
export const OUTBOX_LOCK_SECONDS = 120;
export const OUTBOX_PUBLISH_RETRY_SECONDS = 60;
export const OUTBOX_PUBLISH_ERROR_CODE = "publish_failed";

export type OutboxReconcileFailureCode = "resolve_failed" | "claim_failed";

/** Falha do banco na convergência ou na reserva, só com o código (o mesmo que a rota responde em 503). */
export class OutboxReconcileError extends Error {
  readonly code: OutboxReconcileFailureCode;

  constructor(code: OutboxReconcileFailureCode) {
    super(code);
    this.name = "OutboxReconcileError";
    this.code = code;
  }
}

export type OutboxReconcileSummary = Readonly<{ resolved: number; claimed: number; published: number; failed: number }>;

type ClaimedItem = { outbox_id: string; webhook_event_id: string; workspace_id: string };

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function isClaimedItem(value: unknown): value is ClaimedItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return isText(item.outbox_id) && isText(item.webhook_event_id) && isText(item.workspace_id);
}

export async function reconcileOutbox(
  supabase: SupabaseClient<Database>,
  publish: EventPublisher,
): Promise<OutboxReconcileSummary> {
  const resolution = await supabase.rpc("resolve_stale_outbox_batch", { p_limit: OUTBOX_RESOLVE_LIMIT });
  if (resolution.error) throw new OutboxReconcileError("resolve_failed");
  const resolvedRows: unknown = resolution.data ?? [];
  if (!Array.isArray(resolvedRows)) throw new OutboxReconcileError("resolve_failed");
  const resolved = resolvedRows.length;

  const claim = await supabase.rpc("claim_outbox_batch", {
    p_limit: OUTBOX_CLAIM_LIMIT,
    p_lock_seconds: OUTBOX_LOCK_SECONDS,
  });
  if (claim.error) throw new OutboxReconcileError("claim_failed");
  const claimedRows: unknown = claim.data ?? [];
  if (!Array.isArray(claimedRows) || !claimedRows.every(isClaimedItem)) throw new OutboxReconcileError("claim_failed");
  const batch: ClaimedItem[] = claimedRows;

  let published = 0;
  let failed = 0;

  for (const item of batch) {
    try {
      await publish({ webhookEventId: item.webhook_event_id, workspaceId: item.workspace_id });
      await supabase.rpc("mark_outbox_published", { p_outbox_id: item.outbox_id });
      published += 1;
    } catch {
      // Só o código sanitizado: a mensagem original poderia carregar detalhe de infraestrutura.
      await supabase.rpc("mark_outbox_failed", {
        p_outbox_id: item.outbox_id,
        p_error_code: OUTBOX_PUBLISH_ERROR_CODE,
        p_retry_in_seconds: OUTBOX_PUBLISH_RETRY_SECONDS,
      });
      failed += 1;
    }
  }

  return { resolved, claimed: batch.length, published, failed };
}
