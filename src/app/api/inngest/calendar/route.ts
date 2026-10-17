import { serve } from "inngest/next";

import { calendarInngestClient, calendarInngestFunctions } from "@/server/calendar/inngest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * App do Inngest da AGENDA (`praxis-crm-agenda`, B2). Separado do app da
 * A11 (`/api/inngest`): não importa o cliente nem o validador da A11, então
 * não exige Turnstile, Upstash, chaves A11 nem `INNGEST_EVENT_KEY` (esta
 * integração não publica eventos).
 *
 * Autenticação pelo próprio SDK (assinatura com `INNGEST_SIGNING_KEY`). Em
 * Preview e Production a signing key é obrigatória: sem ela, 503 sanitizado
 * antes do SDK. Com a chave válida e `CALENDAR_SCHEDULER_ENABLED` desligada,
 * o app sincroniza uma lista VAZIA — é assim que a função sai do Inngest.
 *
 * A lista de funções é montada no carregamento do módulo: mudar a chave de
 * ativação exige redeploy e nova sincronização do app.
 */

const client = calendarInngestClient();
const handlers = serve({ client, functions: calendarInngestFunctions(client) });

type RouteHandler = (typeof handlers)["GET"];

function signingKeyRequired(): boolean {
  const env = process.env.VERCEL_ENV;
  return env === "preview" || env === "production";
}

function guarded(handler: RouteHandler): RouteHandler {
  return (async (...args: Parameters<RouteHandler>) => {
    if (signingKeyRequired() && !process.env.INNGEST_SIGNING_KEY?.trim()) {
      return Response.json({ error: "service_unavailable" }, { status: 503 });
    }
    return handler(...args);
  }) as RouteHandler;
}

export const GET = guarded(handlers.GET);
export const POST = guarded(handlers.POST);
export const PUT = guarded(handlers.PUT);
