import { getIngestConfig } from "@/server/ingest/config";

/**
 * Verificação do Turnstile (A11).
 *
 * API conferida na documentação oficial da Cloudflare antes de escrever:
 * POST https://challenges.cloudflare.com/turnstile/v0/siteverify, com
 * `secret`, `response`, `remoteip` e `idempotency_key`; a resposta traz
 * `success`, `error-codes`, `challenge_ts`, `hostname`, `action` e
 * `cdata`.
 *
 * `success` sozinho NÃO basta (contrato §5): um token válido obtido em
 * outro site, ou para outra ação, continuaria passando. Por isso o
 * `hostname` é conferido contra a lista do endpoint e a `action` contra a
 * action esperada dele.
 *
 * `remoteip` recebe o HMAC do IP, nunca o IP: a Cloudflare usa o campo
 * como sinal adicional, e mandar o endereço real seria expor o visitante
 * a um terceiro sem necessidade.
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileOutcome =
  | { ok: true }
  | { ok: false; reason: "invalid_token" | "hostname_mismatch" | "action_mismatch" | "verification_unavailable" };

export type TurnstileVerifier = (input: {
  token: string;
  idempotencyKey: string;
  remoteIdentifier: string;
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

  const body = new URLSearchParams({
    secret,
    response: input.token,
    remoteip: input.remoteIdentifier,
    idempotency_key: input.idempotencyKey,
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
