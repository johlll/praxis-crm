import { createHmac } from "node:crypto";

/**
 * Ambiente em que o servidor está operando, para o isolamento da B2
 * (docs/decisoes/b2-google-agenda.md §7).
 *
 * Preview e Production compartilham o mesmo Supabase. O banco só aceita um
 * ambiente que o SERVIDOR tenha AUTENTICADO: o cabeçalho de requisição
 * `X-Praxis-Env` carrega `<ambiente>.<expira>.<hmac-sha256>`, assinado com
 * `CALENDAR_ENV_SIGNING_KEY` — uma chave por ambiente (valor diferente em
 * Preview e Production, escopo da Vercel), também registrada no banco.
 * Declarar o ambiente não basta: um usuário que chame o PostgREST direto
 * não tem a chave e não consegue produzir uma assinatura válida.
 *
 * FALHA FECHADA:
 *  - só `VERCEL_ENV=production` explícito vale `production`; tudo o mais é
 *    `preview`;
 *  - sem chave configurada, nenhum cabeçalho é enviado, e o banco trata a
 *    requisição como "sem ambiente" (recusa tudo o que depende dele).
 */
export type CalendarEnvironment = "production" | "preview";

export const CALENDAR_ENV_HEADER = "X-Praxis-Env";

/** Validade do cabeçalho. Os clientes de servidor são criados por
 * requisição, então minutos bastam; o banco recusa mais de 1 hora. */
export const CALENDAR_ENV_HEADER_TTL_SECONDS = 600;

const MIN_SIGNING_KEY_LENGTH = 32;

export function getCalendarEnvironment(): CalendarEnvironment {
  return process.env.VERCEL_ENV === "production" ? "production" : "preview";
}

/** Mesma conta do banco (`private.environment_signature`): HMAC-SHA256 de
 * `<ambiente>.<expira>` em hexadecimal. */
export function signCalendarEnvironment(environment: string, expiresAtSeconds: number, key: string): string {
  return createHmac("sha256", key).update(`${environment}.${expiresAtSeconds}`).digest("hex");
}

export function calendarEnvHeaders(nowMs: number = Date.now()): Record<string, string> {
  const key = process.env.CALENDAR_ENV_SIGNING_KEY;
  if (!key || key.length < MIN_SIGNING_KEY_LENGTH) return {};

  const environment = getCalendarEnvironment();
  const expires = Math.floor(nowMs / 1000) + CALENDAR_ENV_HEADER_TTL_SECONDS;
  return { [CALENDAR_ENV_HEADER]: `${environment}.${expires}.${signCalendarEnvironment(environment, expires, key)}` };
}
