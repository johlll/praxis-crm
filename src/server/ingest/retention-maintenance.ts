import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/server/types/database";

/**
 * Manutenção de retenção e alertas da A11 (contrato §12) — A OPERAÇÃO, num lugar só.
 *
 * Quem a chama: a rota `/api/cron/retention` (workflow do GitHub Actions) e o agendador do Inngest
 * (`src/app/api/inngest/a11-retention-scheduler.ts`). Nenhum dos dois tem lógica própria: se a operação mudar,
 * muda para os dois. Por isso este arquivo NÃO importa o cliente `service_role` (recebe-o por parâmetro) e só
 * importa tipos — o que também deixa o arquivo executável direto pelo Node (teste de concorrência real,
 * scripts/a11-schedulers-concurrency-check.mjs).
 *
 * Três passos, todos idempotentes e em lote, seguros sob execuções simultâneas (cada RPC reserva as linhas com
 * `for update skip locked` e grava o marcador e a auditoria na MESMA transação — a garantia é do banco, não daqui):
 *
 *   1. `flag_stuck_webhook_events` — marca eventos TRAVADOS (fora do tempo operacional esperado) e gera alerta
 *      estruturado + auditoria sem PII;
 *   2. `flag_expiring_webhook_events` — alerta ANTECIPADO dos que vão vencer sem processamento (7 dias antes);
 *   3. `purge_expired_webhook_events` — vencimento dos 30 dias: evento processado vira tombstone; evento NÃO
 *      processado vira `expired_unprocessed`, com auditoria, alerta e inelegibilidade — nunca apagado em silêncio.
 *
 * As três RPCs rodam SEMPRE, nesta ordem, mesmo que uma falhe; se qualquer uma falhar (ou responder algo fora do
 * contrato), nenhum alerta é registrado e a falha sai só como código fechado (`retention_failed`). O alerta
 * estruturado sai como log do servidor (console.warn) e já está gravado em `audit_logs`: a regra funciona sem
 * Sentry, que é observabilidade, não mecanismo. Só identificadores entram no log (tipo do alerta, id do evento e
 * do workspace) — nunca payload, dado pessoal ou o que mais o banco devolver.
 *
 * Só contagens e códigos fechados saem daqui: nunca a mensagem do banco.
 */

export const RETENTION_STUCK_LIMIT = 100;
export const RETENTION_EXPIRING_LIMIT = 100;
export const RETENTION_EXPIRING_DAYS_BEFORE = 7;
export const RETENTION_PURGE_LIMIT = 200;

export type RetentionFailureCode = "retention_failed";

/** Falha do banco ou resposta fora do contrato, só com o código (o mesmo que a rota responde em 503). */
export class RetentionMaintenanceError extends Error {
  readonly code: RetentionFailureCode;

  constructor(code: RetentionFailureCode) {
    super(code);
    this.name = "RetentionMaintenanceError";
    this.code = code;
  }
}

export type RetentionSummary = Readonly<{ stuck: number; expiring: number; purged: number; expired_unprocessed: number }>;

type Alert = { kind: string; webhook_event_id: string; workspace_id: string };

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Só os três campos que o log sempre levou; qualquer outra coisa que o banco mande no alerta é descartada. */
function parseAlerts(value: unknown): Alert[] | null {
  if (!Array.isArray(value)) return null;
  const alerts: Alert[] = [];
  for (const item of value) {
    const alert = asObject(item);
    if (!alert || !isText(alert.kind) || !isText(alert.webhook_event_id) || !isText(alert.workspace_id)) return null;
    alerts.push({ kind: alert.kind, webhook_event_id: alert.webhook_event_id, workspace_id: alert.workspace_id });
  }
  return alerts;
}

export async function runRetentionMaintenance(supabase: SupabaseClient<Database>): Promise<RetentionSummary> {
  const stuck = await supabase.rpc("flag_stuck_webhook_events", { p_limit: RETENTION_STUCK_LIMIT });
  const expiring = await supabase.rpc("flag_expiring_webhook_events", {
    p_limit: RETENTION_EXPIRING_LIMIT,
    p_days_before: RETENTION_EXPIRING_DAYS_BEFORE,
  });
  const purged = await supabase.rpc("purge_expired_webhook_events", { p_limit: RETENTION_PURGE_LIMIT });

  if (stuck.error || expiring.error || purged.error) throw new RetentionMaintenanceError("retention_failed");

  const stuckData = asObject(stuck.data);
  const expiringData = asObject(expiring.data);
  const purgedData = asObject(purged.data);
  const stuckAlerts = stuckData ? parseAlerts(stuckData.alerts) : null;
  const expiringAlerts = expiringData ? parseAlerts(expiringData.alerts) : null;
  const purgedAlerts = purgedData ? parseAlerts(purgedData.alerts) : null;

  if (
    !stuckData ||
    !expiringData ||
    !purgedData ||
    !stuckAlerts ||
    !expiringAlerts ||
    !purgedAlerts ||
    !isCount(stuckData.count) ||
    !isCount(expiringData.count) ||
    !isCount(purgedData.purged) ||
    !isCount(purgedData.expired_unprocessed)
  ) {
    throw new RetentionMaintenanceError("retention_failed");
  }

  for (const alert of [...stuckAlerts, ...expiringAlerts, ...purgedAlerts]) {
    // Estruturado e sem PII: só identificadores e o tipo do alerta.
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "a11.ingest.alert",
        kind: alert.kind,
        webhook_event_id: alert.webhook_event_id,
        workspace_id: alert.workspace_id,
      }),
    );
  }

  return {
    stuck: stuckData.count,
    expiring: expiringData.count,
    purged: purgedData.purged,
    expired_unprocessed: purgedData.expired_unprocessed,
  };
}
