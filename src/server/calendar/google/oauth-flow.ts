import type { GoogleCalendarConfig } from "@/server/calendar/google/config";
import type { GoogleHttp } from "@/server/calendar/google/http";
import {
  authorizationUrl,
  exchangeCode,
  missingCalendarScopes,
  OAuthError,
  randomToken,
  sha256,
  verifyIdTokenClaims,
} from "@/server/calendar/google/oauth";
import type { ProviderTokens } from "@/server/calendar/provider";

/**
 * Fluxo "Conectar com Google" (B2, etapa 4), sem Next nem Supabase: recebe as
 * portas. As rotas `/api/calendar/oauth/start` e `/callback` só ligam sessão,
 * cookie e redirecionamento.
 *
 * Início: `state` (32 bytes aleatórios), `nonce` do OpenID Connect e
 * verificador PKCE novos a cada tentativa. O banco guarda só os HASHES do
 * state, do nonce e do cookie do navegador, e o verificador CIFRADO com a
 * chave do ambiente — vinculados ao usuário, ao workspace e ao ambiente
 * autenticado, por 10 minutos.
 *
 * Retorno: o state é CONSUMIDO antes de qualquer outra coisa (uso único, mesmo
 * quando a autorização foi negada); só depois se conferem prazo, ambiente,
 * sessão (mesmo usuário e workspace) e navegador (mesmo cookie). Então o
 * código é trocado (PKCE), o ID token conferido, os escopos CONCEDIDOS
 * conferidos e a conexão gravada pela identidade da conta.
 *
 * Nenhum código, token, segredo, e-mail ou identificador de conta é
 * devolvido no resultado ou registrado: só o desfecho.
 */

export type OAuthSession = { userId: string; workspaceId: string };

export type ConsumeResult =
  | { status: "ok"; nonceHash: string; verifierCiphertext: string; keyVersion: string }
  | { status: "not_found" | "expired" | "wrong_environment" | "session_mismatch" | "browser_mismatch" };

export interface OAuthStateStore {
  begin(p: {
    session: OAuthSession;
    stateHash: string;
    browserHash: string;
    nonceHash: string;
    verifierCiphertext: string;
    keyVersion: string;
  }): Promise<void>;
  /** Apaga o estado e devolve o que ele permitia (uso único). */
  consume(p: { stateHash: string; session: OAuthSession; browserHash: string | null }): Promise<ConsumeResult>;
}

export type OAuthFlowDeps = {
  config: GoogleCalendarConfig;
  http: GoogleHttp;
  states: OAuthStateStore;
  /** Grava a conexão pela identidade (`connect_calendar_identity`). */
  connect: (session: OAuthSession, tokens: ProviderTokens) => Promise<{ connectionId: string; refreshKept: boolean }>;
  encryptVerifier: (verifier: string, session: OAuthSession) => { ciphertext: string; keyVersion: string };
  decryptVerifier: (ciphertext: string, keyVersion: string, session: OAuthSession) => string;
  now: () => Date;
};

/** Desfechos do retorno — viram uma mensagem FIXA na tela (nada da URL é ecoado). */
export type OAuthOutcome =
  | "connected"
  | "cancelled"
  | "invalid_state"
  | "expired"
  | "session_mismatch"
  | "wrong_environment"
  | "browser_mismatch"
  | "partial_scopes"
  | "refresh_missing"
  | "account_mismatch"
  | "account_in_use"
  | "identity_invalid"
  | "failed";

export async function startGoogleOAuth(
  deps: OAuthFlowDeps,
  session: OAuthSession,
): Promise<{ authorizationUrl: string; browserNonce: string }> {
  const state = randomToken();
  const nonce = randomToken();
  const browserNonce = randomToken();
  const codeVerifier = randomToken(48); // 64 caracteres (PKCE: 43–128)
  const verifier = deps.encryptVerifier(codeVerifier, session);
  await deps.states.begin({
    session,
    stateHash: sha256(state),
    browserHash: sha256(browserNonce),
    nonceHash: sha256(nonce),
    verifierCiphertext: verifier.ciphertext,
    keyVersion: verifier.keyVersion,
  });
  return { authorizationUrl: authorizationUrl(deps.config, { state, nonce, codeVerifier }), browserNonce };
}

const CONSUME_OUTCOME: Record<Exclude<ConsumeResult["status"], "ok">, OAuthOutcome> = {
  not_found: "invalid_state",
  expired: "expired",
  wrong_environment: "wrong_environment",
  session_mismatch: "session_mismatch",
  browser_mismatch: "browser_mismatch",
};

const CONNECT_OUTCOME: Record<string, OAuthOutcome> = {
  refresh_token_missing: "refresh_missing",
  calendar_account_mismatch: "account_mismatch",
  calendar_account_in_use: "account_in_use",
};

export type OAuthResult = { outcome: OAuthOutcome; connectionId?: string; refreshKept?: boolean; code?: string };

export async function completeGoogleOAuth(
  deps: OAuthFlowDeps,
  session: OAuthSession,
  params: { state?: string | null; code?: string | null; error?: string | null; browserNonce?: string | null },
): Promise<OAuthResult> {
  const state = params.state ?? "";
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(state)) return { outcome: "invalid_state" };

  // Uso único: consome ANTES de olhar o resto, inclusive quando o Google
  // devolveu erro.
  const consumed = await deps.states.consume({
    stateHash: sha256(state),
    session,
    browserHash: params.browserNonce ? sha256(params.browserNonce) : null,
  });
  if (consumed.status !== "ok") return { outcome: CONSUME_OUTCOME[consumed.status] };

  if (params.error) return { outcome: params.error === "access_denied" ? "cancelled" : "failed", code: "authorization_error" };
  if (!params.code || params.code.length > 2048) return { outcome: "invalid_state" };

  let codeVerifier: string;
  try {
    codeVerifier = deps.decryptVerifier(consumed.verifierCiphertext, consumed.keyVersion, session);
  } catch {
    return { outcome: "failed", code: "verifier_unreadable" };
  }

  const now = deps.now();
  let grant;
  try {
    grant = await exchangeCode(deps.http, deps.config, { code: params.code, codeVerifier, now });
  } catch (error) {
    return { outcome: "failed", code: error instanceof OAuthError ? error.message : "token_exchange_failed" };
  }

  let identity;
  try {
    identity = verifyIdTokenClaims(grant.idToken, {
      clientId: deps.config.clientId,
      nonceHash: consumed.nonceHash,
      nowSeconds: Math.floor(now.getTime() / 1000),
    });
  } catch (error) {
    return { outcome: "identity_invalid", code: error instanceof OAuthError ? error.message : "id_token_invalid" };
  }

  // Consentimento parcial: nada é guardado. (O token não é revogado aqui:
  // revogar derrubaria também uma autorização anterior, ainda válida, da
  // mesma conta para este app.)
  if (missingCalendarScopes(grant.scopes).length > 0) return { outcome: "partial_scopes" };

  try {
    const result = await deps.connect(session, {
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
      accessTokenExpiresAt: grant.accessTokenExpiresAt,
      scopes: grant.scopes,
      accountEmail: identity.email,
      accountSubject: identity.subject,
      oauthClientId: deps.config.clientId,
    });
    return { outcome: "connected", connectionId: result.connectionId, refreshKept: result.refreshKept };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const known = Object.keys(CONNECT_OUTCOME).find((k) => message.includes(k));
    return known ? { outcome: CONNECT_OUTCOME[known]!, code: known } : { outcome: "failed", code: "connect_failed" };
  }
}
