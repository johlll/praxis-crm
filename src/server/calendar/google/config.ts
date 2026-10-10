import { getCalendarTokenKeys } from "@/server/calendar/token-crypto";

/**
 * Configuração do provedor REAL do Google (B2, etapa 4). A integração só liga
 * com TUDO presente e válido; faltando qualquer peça, `null` — e a tela diz
 * "não configurada", sem tocar no banco nem no Google:
 *
 *  - `CALENDAR_PROVIDER=google` (escolha explícita, além das credenciais);
 *  - `GOOGLE_OAUTH_CLIENT_ID` (cliente web, `*.apps.googleusercontent.com`);
 *  - `GOOGLE_OAUTH_CLIENT_SECRET`;
 *  - `GOOGLE_OAUTH_REDIRECT_URI`: o endereço de retorno EXATO cadastrado no
 *    cliente OAuth — https, caminho `/api/calendar/oauth/callback`, sem query
 *    nem fragmento (http só em `localhost`, fora da Vercel). É o único
 *    endereço de retorno usado: nada vem da requisição;
 *  - `CALENDAR_TOKEN_*` válidas (cifra dos tokens) e `CALENDAR_ENV_SIGNING_KEY`
 *    com ao menos 32 caracteres (assinatura de ambiente).
 *
 * Os valores nunca são registrados em log: só o NOME do que falta.
 */

export const OAUTH_CALLBACK_PATH = "/api/calendar/oauth/callback";
const MIN_SIGNING_KEY_LENGTH = 32;

export type GoogleCalendarConfig = {
  clientId: string;
  clientSecret: string;
  /** Endereço de retorno exato (string normalizada). */
  redirectUri: string;
  /** Origem do endereço de retorno: o fluxo inteiro acontece nela. */
  origin: string;
};

/** Valida o endereço de retorno. `null` se não serve. */
export function parseRedirectUri(raw: string | undefined, vercelEnv: string | undefined): URL | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const local = !vercelEnv && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== OAUTH_CALLBACK_PATH) return null;
  return url;
}

/** O que falta para ligar (só nomes; vazio = completo). */
export function missingGoogleCalendarConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = [];
  if (env.CALENDAR_PROVIDER !== "google") missing.push("CALENDAR_PROVIDER");
  if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(env.GOOGLE_OAUTH_CLIENT_ID?.trim() ?? "")) {
    missing.push("GOOGLE_OAUTH_CLIENT_ID");
  }
  if (!env.GOOGLE_OAUTH_CLIENT_SECRET?.trim()) missing.push("GOOGLE_OAUTH_CLIENT_SECRET");
  if (!parseRedirectUri(env.GOOGLE_OAUTH_REDIRECT_URI, env.VERCEL_ENV)) missing.push("GOOGLE_OAUTH_REDIRECT_URI");
  try {
    getCalendarTokenKeys();
  } catch {
    missing.push("CALENDAR_TOKEN_KEY_VERSIONS");
  }
  if ((env.CALENDAR_ENV_SIGNING_KEY ?? "").length < MIN_SIGNING_KEY_LENGTH) missing.push("CALENDAR_ENV_SIGNING_KEY");
  return missing;
}

export function getGoogleCalendarConfig(env: NodeJS.ProcessEnv = process.env): GoogleCalendarConfig | null {
  if (missingGoogleCalendarConfig(env).length > 0) return null;
  const redirect = parseRedirectUri(env.GOOGLE_OAUTH_REDIRECT_URI, env.VERCEL_ENV)!;
  return {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID!.trim(),
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET!.trim(),
    redirectUri: redirect.toString(),
    origin: redirect.origin,
  };
}
