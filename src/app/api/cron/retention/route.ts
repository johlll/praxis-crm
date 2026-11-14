import { NextResponse } from "next/server";

import { createAdminSupabaseClient } from "@/server/supabase/admin";
import { getIngestConfig, IngestConfigError } from "@/server/ingest/config";
import { RetentionMaintenanceError, runRetentionMaintenance } from "@/server/ingest/retention-maintenance";

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
 *
 * A operação em si mora em `src/server/ingest/retention-maintenance.ts` e é a
 * MESMA que o agendador do Inngest (`a11-retention-scheduler`) executa a cada
 * 10 minutos: esta rota só autentica e traduz a falha em HTTP. O workflow do
 * GitHub Actions continua chamando esta rota.
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

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createAdminSupabaseClient();

  try {
    return NextResponse.json(await runRetentionMaintenance(supabase));
  } catch (error) {
    if (error instanceof RetentionMaintenanceError) {
      return NextResponse.json({ error: error.code }, { status: 503 });
    }
    throw error;
  }
}

export const GET = POST;
