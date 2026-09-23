import { createHash } from "node:crypto";

import { getIngestConfig } from "@/server/ingest/config";

/**
 * Verificação do Turnstile (A11).
 *
 * API conferida na documentação oficial da Cloudflare antes de escrever:
 * POST https://challenges.cloudflare.com/turnstile/v0/siteverify, com
 * `secret`, `response`, `remoteip` (OPCIONAL) e `idempotency_key`; a
 * resposta traz `success`, `error-codes`, `challenge_ts`, `hostname`,
 * `action` e `cdata`.
 *
 * `success` sozinho NÃO basta (contrato §5): um token válido obtido em
 * outro site, ou para outra ação, continuaria passando. Por isso o
 * `hostname` é conferido contra a lista do endpoint e a `action` contra a
 * action esperada dele.
 *
 * `remoteip` NÃO é enviado (defeito corrigido): o campo da Cloudflare
 * representa um ENDEREÇO IP real — a política da A11 não permite mandar
 * o IP, nem completo nem como HMAC, para nenhum terceiro (contrato §5).
 * Um HMAC não é um IP e preencher o campo com ele não teria efeito útil
 * na verificação, só o risco de tratar um HMAC como se fosse endereço.
 * Omitir o campo é seguro: a Cloudflare o trata como opcional.
 *
 * `idempotency_key` é derivado do PRÓPRIO TOKEN (SHA-256), não do
 * `sourceEventId` da submissão (defeito corrigido): a chave precisa ser
 * estável só entre retries da MESMA verificação — ou seja, quando o
 * cliente reenvia com o TOKEN QUE NÃO MUDOU. Usar `sourceEventId` fazia
 * duas verificações de tokens DIFERENTES (ex.: token renovado após
 * expirar) compartilhar a mesma chave, arriscando a Cloudflare devolver
 * uma resposta cacheada da verificação anterior para um token novo.
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileOutcome =
  | { ok: true }
  | { ok: false; reason: "invalid_token" | "hostname_mismatch" | "action_mismatch" | "verification_unavailable" };

export type TurnstileVerifier = (input: {
  token: string;
  expectedAction: string;
  allowedHostnames: string[];
}) => Promise<TurnstileOutcome>;

type SiteverifyResponse = {
  success?: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
};

export const cloudflareTurnstileVerifier: TurnstileVerifier = async (input) => {
  const secret = getIngestConfig().TURNSTILE_SECRET_KEY;

  // Estável só quando o TOKEN é o mesmo (retry de rede da mesma
  // verificação); um token diferente (renovado) produz uma chave nova.
  const idempotencyKey = createHash("sha256").update(input.token, "utf8").digest("hex");

  const body = new URLSearchParams({
    secret,
    response: input.token,
    idempotency_key: idempotencyKey,
  });

  let parsed: SiteverifyResponse;
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { ok: false, reason: "verification_unavailable" };
    parsed = (await response.json()) as SiteverifyResponse;
  } catch {
    // Falha de rede com a Cloudflare é falha FECHADA: sem verificação, a
    // submissão não entra. Nunca "passa porque o verificador caiu".
    return { ok: false, reason: "verification_unavailable" };
  }

  if (parsed.success !== true) return { ok: false, reason: "invalid_token" };

  const hostname = (parsed.hostname ?? "").toLowerCase();
  if (!input.allowedHostnames.map((h) => h.toLowerCase()).includes(hostname)) {
    return { ok: false, reason: "hostname_mismatch" };
  }

  if ((parsed.action ?? "") !== input.expectedAction) {
    return { ok: false, reason: "action_mismatch" };
  }

  return { ok: true };
};
