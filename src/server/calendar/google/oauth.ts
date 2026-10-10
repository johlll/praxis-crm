import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { ProviderHttpError } from "@/server/calendar/events-api";
import type { GoogleCalendarConfig } from "@/server/calendar/google/config";
import { googleRequest, type GoogleHttp } from "@/server/calendar/google/http";
import { CALENDAR_SCOPES, IDENTITY_SCOPES } from "@/server/calendar/provider";

/**
 * OAuth 2.0 + OpenID Connect do Google (B2, etapa 4), servidor web com
 * segredo do cliente E PKCE (S256).
 *
 * Identidade da conta: o `sub` do ID token (OpenID Connect), estável mesmo se
 * o e-mail mudar — nunca o id da agenda principal. O ID token vem DIRETO do
 * endpoint de token do Google, por TLS; por isso, como permite o OpenID
 * Connect Core 1.0 §3.1.3.7 (item 6) e a documentação do Google ("Obtain
 * user information from the ID token"), a assinatura não é conferida aqui, e
 * sim as declarações: `iss` do Google, `aud` = este cliente, `exp` no futuro,
 * `nonce` = o desta autorização, `sub` presente e e-mail verificado.
 *
 * Escopos concedidos: o Google pode conceder só parte (consentimento
 * granular). O campo `scope` da resposta diz o que foi concedido; faltando
 * qualquer escopo de agenda, a conexão é recusada.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
/** Tolerância de relógio para `exp`/`iat`. */
const CLOCK_SKEW_S = 120;

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** Comparação em tempo constante de dois hashes hex. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function authorizationUrl(
  config: GoogleCalendarConfig,
  params: { state: string; nonce: string; codeVerifier: string },
): string {
  const url = new URL(AUTH_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: [...IDENTITY_SCOPES, ...CALENDAR_SCOPES].join(" "),
    access_type: "offline",
    // Consentimento explícito: é o que faz o Google devolver o refresh token.
    prompt: "consent select_account",
    include_granted_scopes: "false",
    state: params.state,
    nonce: params.nonce,
    code_challenge: pkceChallenge(params.codeVerifier),
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export class OAuthError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "OAuthError";
  }
}

export type IdentityClaims = { subject: string; email: string };

/** Declarações do ID token, sem conferir assinatura (ver cabeçalho). */
export function verifyIdTokenClaims(
  idToken: string | undefined,
  expected: { clientId: string; nonceHash: string; nowSeconds: number },
): IdentityClaims {
  if (!idToken) throw new OAuthError("id_token_missing");
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new OAuthError("id_token_invalid");
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new OAuthError("id_token_invalid");
  }
  if (typeof claims.iss !== "string" || !ISSUERS.has(claims.iss)) throw new OAuthError("id_token_issuer");
  const aud = claims.aud;
  const audOk = aud === expected.clientId || (Array.isArray(aud) && aud.includes(expected.clientId) && claims.azp === expected.clientId);
  if (!audOk) throw new OAuthError("id_token_audience");
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < expected.nowSeconds) throw new OAuthError("id_token_expired");
  if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_S > expected.nowSeconds) throw new OAuthError("id_token_not_yet_valid");
  if (typeof claims.nonce !== "string" || !sameHash(sha256(claims.nonce), expected.nonceHash)) throw new OAuthError("id_token_nonce");
  if (typeof claims.sub !== "string" || !/^[\x21-\x7e]{1,255}$/.test(claims.sub)) throw new OAuthError("id_token_subject");
  if (typeof claims.email !== "string" || claims.email_verified !== true) throw new OAuthError("id_token_email_unverified");
  return { subject: claims.sub, email: claims.email.toLowerCase() };
}

export type ExchangedGrant = {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date;
  /** Escopos EFETIVAMENTE concedidos. */
  scopes: string[];
  idToken: string | undefined;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  token_type?: string;
};

/** Erro do endpoint de token: só o código fixo do OAuth (`invalid_grant`...). */
function oauthErrorCode(error: unknown): string {
  return error instanceof ProviderHttpError ? (error.reason ?? `oauth_http_${error.status}`) : "oauth_unavailable";
}

export async function exchangeCode(
  http: GoogleHttp,
  config: GoogleCalendarConfig,
  params: { code: string; codeVerifier: string; now: Date },
): Promise<ExchangedGrant> {
  let raw: TokenResponse | null;
  try {
    raw = await googleRequest<TokenResponse>(http, {
      method: "POST",
      url: TOKEN_ENDPOINT,
      form: {
        grant_type: "authorization_code",
        code: params.code,
        code_verifier: params.codeVerifier,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
      },
    });
  } catch (error) {
    throw new OAuthError(`token_exchange_failed:${oauthErrorCode(error)}`);
  }
  if (!raw?.access_token || typeof raw.expires_in !== "number") throw new OAuthError("token_response_incomplete");
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? null,
    accessTokenExpiresAt: new Date(params.now.getTime() + raw.expires_in * 1000),
    scopes: (raw.scope ?? "").split(/\s+/).filter(Boolean),
    idToken: raw.id_token,
  };
}

/** Escopos de agenda que faltam no que foi concedido. */
export function missingCalendarScopes(granted: string[]): string[] {
  const set = new Set(granted);
  return CALENDAR_SCOPES.filter((s) => !set.has(s));
}

export async function refreshAccessToken(
  http: GoogleHttp,
  config: GoogleCalendarConfig,
  refreshToken: string,
  now: Date,
): Promise<{ accessToken: string; accessTokenExpiresAt: Date }> {
  let raw: TokenResponse | null;
  try {
    raw = await googleRequest<TokenResponse>(http, {
      method: "POST",
      url: TOKEN_ENDPOINT,
      form: {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      },
    });
  } catch (error) {
    // `invalid_grant` (revogado, vencido, senha trocada, 7 dias do modo de
    // teste): a conexão fica a reautorizar — `background.ts` reconhece o código.
    const code = oauthErrorCode(error);
    throw new Error(code === "invalid_grant" ? "refresh_token_invalid" : `refresh_failed:${code}`);
  }
  if (!raw?.access_token || typeof raw.expires_in !== "number") throw new Error("refresh_failed:incomplete");
  return { accessToken: raw.access_token, accessTokenExpiresAt: new Date(now.getTime() + raw.expires_in * 1000) };
}

/** Revoga a autorização (o Google revoga o refresh token e os de acesso dele). */
export async function revokeToken(http: GoogleHttp, token: string): Promise<void> {
  try {
    await googleRequest(http, { method: "POST", url: REVOKE_ENDPOINT, form: { token } });
  } catch (error) {
    // Já inválido: nada a revogar.
    if (error instanceof ProviderHttpError && error.status === 400) return;
    throw error;
  }
}
