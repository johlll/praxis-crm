import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

import { getIngestConfig } from "@/server/ingest/config";

/**
 * Rate limit da ingestão pública (A11).
 *
 * API conferida na documentação oficial do Upstash antes de escrever:
 * `new Ratelimit({ redis, limiter, prefix })`,
 * `Ratelimit.slidingWindow(n, "60 s")`, retorno `{ success, ... }`.
 *
 * Duas janelas, as duas obrigatórias:
 *  - por (endpoint, HMAC do IP) — contém o visitante insistente;
 *  - por endpoint               — contém a enxurrada distribuída, que a
 *    janela por IP sozinha não pegaria.
 *
 * O identificador do visitante é o HMAC do IP, NUNCA o IP: o endereço
 * completo não vai para o Upstash, nem para log, auditoria ou
 * diagnóstico.
 */

export type RateLimitOutcome = { ok: true } | { ok: false; scope: "ip" | "endpoint" };

export type RateLimiter = (input: {
  endpointId: string;
  ipHmacHex: string;
}) => Promise<RateLimitOutcome>;

let cachedPair: { perIp: Ratelimit; perEndpoint: Ratelimit } | undefined;

function limiters() {
  if (cachedPair) return cachedPair;
  const config = getIngestConfig();
  const redis = new Redis({
    url: config.UPSTASH_REDIS_REST_URL,
    token: config.UPSTASH_REDIS_REST_TOKEN,
  });
  cachedPair = {
    perIp: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(5, "60 s"),
      prefix: "praxis:a11:ip",
    }),
    perEndpoint: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(120, "60 s"),
      prefix: "praxis:a11:endpoint",
    }),
  };
  return cachedPair;
}

export const upstashRateLimiter: RateLimiter = async ({ endpointId, ipHmacHex }) => {
  const { perIp, perEndpoint } = limiters();

  const ip = await perIp.limit(`${endpointId}:${ipHmacHex}`);
  if (!ip.success) return { ok: false, scope: "ip" };

  const endpoint = await perEndpoint.limit(endpointId);
  if (!endpoint.success) return { ok: false, scope: "endpoint" };

  return { ok: true };
};

/** Só para teste: descarta os limitadores memoizados. */
export function resetRateLimiterCache(): void {
  cachedPair = undefined;
}
