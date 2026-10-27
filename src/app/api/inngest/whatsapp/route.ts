import { serve } from "inngest/next";

import { isWhatsAppEnvironmentConfigured } from "@/server/whatsapp/environment";
import { whatsappInngestServeClient, whatsappInngestServeConfig } from "@/server/whatsapp/inngest";
import { whatsappInngestFunctions } from "@/server/whatsapp/inngest-consumer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * App do Inngest do WHATSAPP (`praxis-crm-whatsapp`, B3.2d-2a,
 * docs/decisoes/b3-whatsapp-real.md §20). Separado da A11 (`/api/inngest`)
 * e da agenda (`/api/inngest/calendar`): não importa nenhum cliente,
 * validador ou variável deles.
 *
 * Autenticação pelo SDK com a signing key PRÓPRIA
 * (`WHATSAPP_INNGEST_SIGNING_KEY`, reserva
 * `WHATSAPP_INNGEST_SIGNING_KEY_FALLBACK`). Em Preview e Production, sem
 * ela ou sem o ambiente assinado do WhatsApp: 503 sanitizado antes do SDK,
 * e o modo de desenvolvimento nunca liga.
 *
 * Cliente e funções são montados por requisição, depois da conferência: a
 * configuração lida é sempre a atual, e nada do SDK existe sem ela.
 */

type Handler = ReturnType<typeof serve>["GET"];

function unavailable(): Response {
  return Response.json({ error: "service_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
}

function handle(method: "GET" | "POST" | "PUT"): Handler {
  return (async (...args: Parameters<Handler>) => {
    const config = whatsappInngestServeConfig();
    if (!config.ok || !isWhatsAppEnvironmentConfigured()) return unavailable();
    const client = whatsappInngestServeClient(config);
    const handlers = serve({ client, functions: whatsappInngestFunctions(client) });
    return handlers[method](...args);
  }) as Handler;
}

export const GET = handle("GET");
export const POST = handle("POST");
export const PUT = handle("PUT");
