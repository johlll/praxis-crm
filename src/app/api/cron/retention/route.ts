import { NextResponse } from "next/server";

import { createAdminSupabaseClient } from "@/server/supabase/admin";
import { getIngestConfig, IngestConfigError } from "@/server/ingest/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Retenção e alertas (A11, contrato §12).
 *
 * Três passos, todos idempotentes e em lote, seguros sob duas execuções
 * concorrentes (as funções usam `for update skip locked`):
 *
 *   1. marca eventos TRAVADOS (fora do tempo operacional esperado) e
 *      gera alerta estruturado + auditoria sem PII;
 *   2. alerta ANTECIPADO dos que vão vencer sem processamento;
 *   3. vencimento dos 30 dias: evento processado vira tombstone;
 *      evento NÃO processado vira `expired_unprocessed`, com auditoria,
 *      alerta e inelegibilidade — nunca apagado em silêncio.
 *
 * O alerta estruturado sai daqui como log do servidor e já está gravado
 * em `audit_logs`: a regra funciona sem Sentry, que é observabilidade,
 * não mecanismo. Nenhum campo de PII entra no log.
 */

function authorized(request: Request): boolean {
  let secret: string;
  try {
    secret = getIngestConfig().CRON_SECRET;
  } catch (error) {
    if (error instanceof IngestConfigError) return false;
    throw error;
  }
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

type Alert = { kind: string; webhook_event_id: string; workspace_id: string };

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createAdminSupabaseClient();

  const stuck = await supabase.rpc("flag_stuck_webhook_events", { p_limit: 100 });
  const expiring = await supabase.rpc("flag_expiring_webhook_events", {
    p_limit: 100,
    p_days_before: 7,
  });
  const purged = await supabase.rpc("purge_expired_webhook_events", { p_limit: 200 });

  if (stuck.error || expiring.error || purged.error) {
    return NextResponse.json({ error: "retention_failed" }, { status: 503 });
  }

  const alerts: Alert[] = [
    ...(((stuck.data as { alerts?: Alert[] } | null)?.alerts ?? []) as Alert[]),
    ...(((expiring.data as { alerts?: Alert[] } | null)?.alerts ?? []) as Alert[]),
    ...(((purged.data as { alerts?: Alert[] } | null)?.alerts ?? []) as Alert[]),
  ];

  for (const alert of alerts) {
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

  const purgedResult = purged.data as { purged?: number; expired_unprocessed?: number } | null;

  return NextResponse.json({
    stuck: (stuck.data as { count?: number } | null)?.count ?? 0,
    expiring: (expiring.data as { count?: number } | null)?.count ?? 0,
    purged: purgedResult?.purged ?? 0,
    expired_unprocessed: purgedResult?.expired_unprocessed ?? 0,
  });
}

export const GET = POST;
