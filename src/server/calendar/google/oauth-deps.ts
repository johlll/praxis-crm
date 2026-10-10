import { adminConnectCalendar } from "@/server/calendar/admin/connections";
import { createSupabaseOAuthStateStore } from "@/server/calendar/admin/oauth-states";
import { getCalendarEnvironment } from "@/server/calendar/environment";
import { getGoogleCalendarConfig } from "@/server/calendar/google/config";
import type { OAuthFlowDeps } from "@/server/calendar/google/oauth-flow";
import { decryptCalendarToken, encryptCalendarToken } from "@/server/calendar/token-crypto";

/** Nome do cookie que liga o retorno ao navegador que iniciou. */
export const OAUTH_BROWSER_COOKIE = "praxis_gcal_oauth";
export const OAUTH_COOKIE_PATH = "/api/calendar/oauth";
export const OAUTH_COOKIE_MAX_AGE_S = 600;

/** Dependências REAIS do fluxo. `null` com a integração Google desligada. */
export function googleOAuthDeps(): OAuthFlowDeps | null {
  const config = getGoogleCalendarConfig();
  if (!config) return null;
  const ctx = (session: { userId: string; workspaceId: string }) => ({
    environment: getCalendarEnvironment(),
    workspaceId: session.workspaceId,
    userId: session.userId,
  });
  return {
    config,
    http: { fetch: globalThis.fetch.bind(globalThis) },
    states: createSupabaseOAuthStateStore(),
    connect: (session, tokens) => adminConnectCalendar({ workspaceId: session.workspaceId, actorUserId: session.userId, tokens }),
    // O verificador PKCE é cifrado como os tokens: o outro ambiente não o lê.
    encryptVerifier: (verifier, session) => {
      const encrypted = encryptCalendarToken(verifier, ctx(session));
      return { ciphertext: encrypted.ciphertextBase64, keyVersion: encrypted.keyVersion };
    },
    decryptVerifier: (ciphertext, keyVersion, session) => decryptCalendarToken(ciphertext, keyVersion, ctx(session)),
    now: () => new Date(),
  };
}
