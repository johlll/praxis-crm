import { NextResponse } from "next/server";

import { createAdminSupabaseClient } from "@/server/supabase/admin";
import { handleFormSubmission, resolveEndpointForCors, type PublicFailure } from "@/server/ingest/handler";
import { usesTestAdapters } from "@/server/ingest/config";
import { corsPreflightHeaders, corsResponseHeaders, matchAllowedOrigin } from "@/server/ingest/cors";
import { fakeRateLimiter, fakeTurnstileVerifier, inlineWorkerPublisher } from "@/server/ingest/test-adapters";
import { inngestPublisher } from "@/server/ingest/publisher";
import { upstashRateLimiter } from "@/server/ingest/rate-limit";
import { cloudflareTurnstileVerifier } from "@/server/ingest/turnstile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Captação pública (A11).
 *
 * A resposta de ACEITAÇÃO é sempre a mesma, para evento novo e para
 * qualquer repetição — 202, mesmo corpo, mesmo protocolo opaco. Nunca
 * devolve id interno, id de contato/lead/oportunidade, nem qualquer sinal
 * de que a pessoa já era conhecida (contrato §1: sem enumeração).
 */

const STATUS: Record<PublicFailure, number> = {
  // "não existe" e "desativado/revogado" respondem IGUAL, de propósito.
  form_endpoint_unavailable: 404,
  invalid_submission: 400,
  captcha_failed: 403,
  rate_limited: 429,
  payload_too_large: 413,
  idempotency_payload_conflict: 409,
  service_unavailable: 503,
};

/**
 * Preflight de CORS (item 3 da auditoria pós-dry-run). Resolve o
 * endpoint só pela chave da URL (sem corpo — é assim que um preflight
 * chega) e autoriza a origem exata quando o hostname dela está entre os
 * `allowed_hostnames` do endpoint. Sem nenhum cabeçalho de CORS para
 * origem não autorizada: o navegador bloqueia o POST antes de enviá-lo.
 */
export async function OPTIONS(request: Request, { params }: { params: Promise<{ endpointKey: string }> }) {
  const { endpointKey } = await params;
  const supabase = createAdminSupabaseClient();
  const endpoint = await resolveEndpointForCors(supabase, endpointKey);
  const allowedOrigin = endpoint
    ? matchAllowedOrigin(request.headers.get("origin"), endpoint.allowed_hostnames)
    : null;

  return new NextResponse(null, { status: 204, headers: corsPreflightHeaders(allowedOrigin) });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ endpointKey: string }> },
) {
  const { endpointKey } = await params;

  let result;
  try {
    const supabase = createAdminSupabaseClient();

    // Adaptadores de teste NUNCA valem em produção nem em preview:
    // `usesTestAdapters()` recusa os dois ambientes por construção,
    // mesmo com a variável presente. Falta de configuração continua
    // sendo falha fechada, nunca proteção desligada.
    const testMode = usesTestAdapters();

    result = await handleFormSubmission(endpointKey, request, {
      supabase,
      verifyTurnstile: testMode ? fakeTurnstileVerifier : cloudflareTurnstileVerifier,
      rateLimit: testMode ? fakeRateLimiter : upstashRateLimiter,
      publish: testMode ? inlineWorkerPublisher(supabase) : inngestPublisher,
    });
  } catch {
    // Qualquer erro inesperado vira a MESMA resposta sanitizada: nenhum
    // detalhe interno cruza a fronteira pública. Sem `result`, não há
    // endpoint resolvido e portanto nenhuma origem para autorizar.
    return NextResponse.json({ error: "service_unavailable" }, { status: 503 });
  }

  // Cabeçalhos de CORS acompanham sucesso E erro, desde que a origem
  // seja autorizada (defeito corrigido: a rota não tinha CORS nenhum).
  const headers = corsResponseHeaders(result.corsOrigin);

  if (!result.ok) {
    return NextResponse.json({ error: result.failure }, { status: STATUS[result.failure], headers });
  }

  return NextResponse.json({ protocol: result.protocol, status: "received" }, { status: 202, headers });
}
