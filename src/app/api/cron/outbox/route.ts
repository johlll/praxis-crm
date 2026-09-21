import { NextResponse } from "next/server";

import { createAdminSupabaseClient } from "@/server/supabase/admin";
import { getIngestConfig, IngestConfigError } from "@/server/ingest/config";
import { inngestPublisher } from "@/server/ingest/publisher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reconciliador da outbox (A11, contrato §7).
 *
 * O que ele faz: encontra outbox pendente ou travada, reserva com locking
 * seguro, republica no Inngest com o MESMO `webhook_event_id` e registra
 * a tentativa.
 *
 * O que ele NUNCA faz: efeito comercial. Ele não cria contato, lead,
 * oportunidade, atividade nem touchpoint — só republica. Quem aplica
 * efeito é o worker, e só dentro da RPC transacional.
 *
 * Cobre o cenário "publiquei e a resposta se perdeu": republicar o mesmo
 * id é inofensivo (o Inngest deduplica por 24 h e, passado isso, o worker
 * encontra o evento já processado).
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

  const { data, error } = await supabase.rpc("claim_outbox_batch", {
    p_limit: 20,
    p_lock_seconds: 120,
  });
  if (error) {
    return NextResponse.json({ error: "claim_failed" }, { status: 503 });
  }

  const batch = (data ?? []) as unknown as {
    outbox_id: string;
    webhook_event_id: string;
    workspace_id: string;
  }[];

  let published = 0;
  let failed = 0;

  for (const item of batch) {
    try {
      await inngestPublisher({
        webhookEventId: item.webhook_event_id,
        workspaceId: item.workspace_id,
      });
      await supabase.rpc("mark_outbox_published", { p_outbox_id: item.outbox_id });
      published += 1;
    } catch {
      // Só o código sanitizado: a mensagem original poderia carregar
      // detalhe de infraestrutura.
      await supabase.rpc("mark_outbox_failed", {
        p_outbox_id: item.outbox_id,
        p_error_code: "publish_failed",
        p_retry_in_seconds: 60,
      });
      failed += 1;
    }
  }

  return NextResponse.json({ claimed: batch.length, published, failed });
}

// GET com o mesmo segredo, para o agendador da Vercel (que usa GET).
export const GET = POST;
