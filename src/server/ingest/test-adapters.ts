import type { SupabaseClient } from "@supabase/supabase-js";

import type { EventPublisher } from "@/server/ingest/publisher";
import type { RateLimiter } from "@/server/ingest/rate-limit";
import type { TurnstileVerifier } from "@/server/ingest/turnstile";
import { processWebhookEvent } from "@/server/ingest/worker";

/**
 * Adaptadores de TESTE (A11).
 *
 * Existem para que o e2e e o desenvolvimento local exercitem o fluxo
 * inteiro sem Cloudflare, Upstash e Inngest de verdade. Só entram em cena
 * quando `usesTestAdapters()` devolve true — e essa função RECUSA
 * produção e preview por construção, mesmo com a variável presente.
 *
 * Isto não é "desligar a proteção quando falta configuração": é
 * substituí-la explicitamente, num ambiente identificado como de teste.
 * Falta de configuração em produção continua sendo falha fechada.
 */

/** Aceita apenas um token declaradamente de teste. */
export const fakeTurnstileVerifier: TurnstileVerifier = async ({ token, expectedAction, allowedHostnames }) => {
  if (token !== "teste-turnstile-ok") return { ok: false, reason: "invalid_token" };
  // Mantém as MESMAS conferências do verificador real, para que o e2e
  // continue provando que hostname e action são checados.
  if (!allowedHostnames.includes("localhost")) return { ok: false, reason: "hostname_mismatch" };
  if (!expectedAction) return { ok: false, reason: "action_mismatch" };
  return { ok: true };
};

/** Janela em memória, por processo. Suficiente para provar a recusa. */
const hits = new Map<string, number[]>();

export const fakeRateLimiter: RateLimiter = async ({ endpointId, ipHmacHex }) => {
  const key = `${endpointId}:${ipHmacHex}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((time) => now - time < 60_000);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > 5 ? { ok: false, scope: "ip" } : { ok: true };
};

export function resetFakeRateLimiter(): void {
  hits.clear();
}

/**
 * Publicação que processa NA HORA, em vez de enfileirar.
 *
 * É o único ponto em que o teste difere de verdade da produção: lá, o
 * Inngest chama o worker; aqui, o worker é chamado direto. A RPC exercida
 * é exatamente a mesma, então a garantia testada (idempotência, efeitos
 * transacionais) é a de produção.
 */
export function inlineWorkerPublisher(supabase: SupabaseClient): EventPublisher {
  return async ({ webhookEventId }) => {
    await processWebhookEvent(supabase, webhookEventId);
  };
}
