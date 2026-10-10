import { ProviderHttpError, ProviderUncertainError } from "@/server/calendar/events-api";

/**
 * Chamada HTTP ao Google com prazo e classificação de erro (B2, etapa 4).
 *
 * Classificação pelo CÓDIGO e pelo MOTIVO (`error.errors[].reason`) que o
 * Google devolve — o código sozinho engana:
 *  - limite de chamadas (403 `rateLimitExceeded`, `userRateLimitExceeded`,
 *    `quotaExceeded`, `dailyLimitExceeded`..., ou 429) → `429`: temporário,
 *    NUNCA "perda de acesso";
 *  - API desligada no projeto (403 `accessNotConfigured`) → `503`: problema
 *    de configuração, não da conta; fica pendente e aparece no log pelo motivo;
 *  - demais 401/403 (`forbidden`, `insufficientPermissions`, credencial
 *    inválida) → como vieram: perda de acesso;
 *  - prazo esgotado ou rede → `ProviderUncertainError`: a escrita pode ter
 *    sido aplicada; quem chama consulta antes de repetir (§6.7).
 *
 * Nada do corpo da resposta vai para a mensagem do erro: o motivo do Google
 * é uma palavra fixa da API, nunca conteúdo de evento.
 */

export const DEFAULT_TIMEOUT_MS = 15_000;

const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "dailyLimitExceeded",
  "variableTermLimitExceeded",
  "RATE_LIMIT_EXCEEDED",
]);
const CONFIG_REASONS = new Set(["accessNotConfigured", "SERVICE_DISABLED"]);

export type GoogleHttp = {
  fetch: typeof fetch;
  timeoutMs?: number;
};

type ErrorBody = {
  error?: { code?: number; status?: string; errors?: Array<{ reason?: string }>; details?: Array<{ reason?: string }> } | string;
};

/** Motivo fixo do erro (`errors[].reason`, `details[].reason` ou `status`). */
export function googleReason(body: unknown): string | undefined {
  const error = (body as ErrorBody | null)?.error;
  // Endpoint de token do OAuth: `{ "error": "invalid_grant" }`.
  if (typeof error === "string") return /^[A-Za-z_]{1,64}$/.test(error) ? error : undefined;
  if (!error || typeof error !== "object") return undefined;
  const reason = error.errors?.find((e) => e.reason)?.reason ?? error.details?.find((d) => d.reason)?.reason ?? error.status;
  return typeof reason === "string" && /^[A-Za-z_]{1,64}$/.test(reason) ? reason : undefined;
}

/** Converte uma resposta de erro do Google no erro do contrato. */
export function classifyGoogleError(status: number, body: unknown): ProviderHttpError {
  const reason = googleReason(body);
  if (status === 429 || (status === 403 && reason && RATE_LIMIT_REASONS.has(reason))) {
    return new ProviderHttpError(429, "google_rate_limited", reason);
  }
  if (status === 403 && reason && CONFIG_REASONS.has(reason)) {
    return new ProviderHttpError(503, "google_api_not_configured", reason);
  }
  return new ProviderHttpError(status, `google_http_${status}`, reason);
}

export type GoogleRequest = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  accessToken?: string | undefined;
  /** JSON (API) ou formulário (OAuth). */
  json?: unknown;
  form?: Record<string, string> | undefined;
  headers?: Record<string, string> | undefined;
};

/** Faz a chamada. Resposta 2xx: o JSON (ou `null` sem corpo). Erro: lança. */
export async function googleRequest<T>(http: GoogleHttp, req: GoogleRequest): Promise<T | null> {
  const headers: Record<string, string> = { Accept: "application/json", ...(req.headers ?? {}) };
  if (req.accessToken) headers.Authorization = `Bearer ${req.accessToken}`;
  let body: string | undefined;
  if (req.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(req.json);
  } else if (req.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(req.form).toString();
  }

  let response: Response;
  try {
    response = await http.fetch(req.url, {
      method: req.method,
      headers,
      body: body ?? null,
      signal: AbortSignal.timeout(http.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    // Prazo esgotado, conexão caída, DNS: não se sabe se o Google aplicou.
    throw new ProviderUncertainError();
  }

  let parsed: unknown = null;
  let text: string;
  try {
    text = await response.text();
  } catch {
    if (response.ok) throw new ProviderUncertainError();
    text = "";
  }
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) throw classifyGoogleError(response.status, parsed);
  return parsed as T | null;
}
