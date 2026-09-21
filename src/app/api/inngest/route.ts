import { serve } from "inngest/next";

import { createAdminSupabaseClient } from "@/server/supabase/admin";
import { getIngestConfig, IngestConfigError } from "@/server/ingest/config";
import { FORM_EVENT_NAME, inngestClient } from "@/server/ingest/publisher";
import { processWebhookEvent } from "@/server/ingest/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Worker da A11.
 *
 * API conferida na documentação oficial do Inngest e no `.d.ts` do pacote
 * instalado antes de escrever: `serve({ client, functions })` de
 * `inngest/next`, exportando `GET/POST/PUT`; `createFunction(config,
 * handler)` com `triggers` na CONFIGURAÇÃO (a forma de três argumentos da
 * v3 não vale mais na v4).
 *
 * O worker chama UMA RPC transacional que bloqueia o evento e aplica
 * todos os efeitos de uma vez. Falha em qualquer etapa desfaz tudo. Duas
 * entregas do mesmo evento não repetem efeito: a segunda encontra o
 * evento já processado. A garantia é at-least-once com efeitos
 * idempotentes, nunca exactly-once.
 *
 * Nada aqui exige configuração em tempo de BUILD — só por requisição
 * (ver o guarda abaixo). Um ambiente sem Inngest configurado continua
 * compilando e subindo; só esta rota responde 503 sanitizado.
 */

const client = inngestClient();

const processFormSubmission = client.createFunction(
  {
    id: "a11-process-form-submission",
    name: "A11 — processar submissão de formulário",
    // Uma execução por evento: a RPC já serializa com lock, mas limitar
    // aqui evita gerar contenção à toa quando o cron republica.
    concurrency: { limit: 5 },
    retries: 5,
    triggers: [{ event: FORM_EVENT_NAME }],
  },
  async ({ event, step }) => {
    const webhookEventId = String((event.data as { webhookEventId?: string }).webhookEventId ?? "");
    if (!webhookEventId) return { skipped: "missing_webhook_event_id" };

    return step.run("process", async () => {
      const supabase = createAdminSupabaseClient();
      const outcome = await processWebhookEvent(supabase, webhookEventId);

      if (outcome.status === "failed") {
        await supabase.rpc("mark_webhook_event_failed", {
          p_webhook_event_id: webhookEventId,
          p_error_code: outcome.code,
        });
        // Lança para o Inngest tentar de novo — com o código sanitizado,
        // nunca com conteúdo do payload.
        throw new Error(outcome.code);
      }

      return outcome;
    });
  },
);

const handlers = serve({ client, functions: [processFormSubmission] });

/**
 * Falha FECHADA por requisição: sem configuração obrigatória, a rota
 * responde 503 sanitizado em vez de atender o Inngest com proteções
 * pela metade.
 */
type RouteHandler = (typeof handlers)["GET"];

function guarded(handler: RouteHandler): RouteHandler {
  return (async (...args: Parameters<RouteHandler>) => {
    try {
      getIngestConfig();
    } catch (error) {
      if (error instanceof IngestConfigError) {
        return Response.json({ error: "service_unavailable" }, { status: 503 });
      }
      throw error;
    }
    return handler(...args);
  }) as RouteHandler;
}

export const GET = guarded(handlers.GET);
export const POST = guarded(handlers.POST);
export const PUT = guarded(handlers.PUT);
