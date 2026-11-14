import { NextResponse } from "next/server";

import { createAdminSupabaseClient } from "@/server/supabase/admin";
import { getIngestConfig, IngestConfigError } from "@/server/ingest/config";
import { OutboxReconcileError, reconcileOutbox } from "@/server/ingest/outbox-reconciler";
import { inngestPublisher } from "@/server/ingest/publisher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reconciliador da outbox (A11, contrato §7).
 *
 * O que ele faz: primeiro converge outbox órfã (evento já terminal por
 * outro caminho — processado, expirado sem processamento, ou purgado —
 * que nunca seria republicada, mas também nunca saía de pending/failed/
 * publishing); depois encontra a outbox pendente ou travada que SOBROU,
 * reserva com locking seguro, republica no Inngest com o MESMO
 * `webhook_event_id` e registra a tentativa.
 *
 * O que ele NUNCA faz: efeito comercial. Ele não cria contato, lead,
 * oportunidade, atividade nem touchpoint — só republica ou converge. Quem
 * aplica efeito é o worker, e só dentro da RPC transacional.
 *
 * Cobre o cenário "publiquei e a resposta se perdeu": republicar o mesmo
 * id é inofensivo (o Inngest deduplica por 24 h e, passado isso, o worker
 * encontra o evento já processado).
 *
 * A operação em si mora em `src/server/ingest/outbox-reconciler.ts` e é a
 * MESMA que o agendador do Inngest (`a11-reconciler-scheduler`) executa a
 * cada 10 minutos: esta rota só autentica e traduz a falha em HTTP. O
 * workflow do GitHub Actions continua chamando esta rota.
 */

function authorized(request: Request): boolean {
  let secret: string;
  try {
    secret = getIngestConfig().CRON_SECRET;
  } catch (error) {
    if (error instanceof IngestConfigError) return false;
    throw error;
  }
  const header = request.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createAdminSupabaseClient();

  try {
    return NextResponse.json(await reconcileOutbox(supabase, inngestPublisher));
  } catch (error) {
    if (error instanceof OutboxReconcileError) {
      return NextResponse.json({ error: error.code }, { status: 503 });
    }
    throw error;
  }
}

// GET com o mesmo segredo, para o agendador da Vercel (que usa GET).
export const GET = POST;
