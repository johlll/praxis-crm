import { createGoogleCalendarApi } from "@/server/calendar/google/calendar-api";
import type { GoogleCalendarConfig } from "@/server/calendar/google/config";
import type { GoogleHttp } from "@/server/calendar/google/http";
import { refreshAccessToken, revokeToken } from "@/server/calendar/google/oauth";
import type { CalendarProvider } from "@/server/calendar/provider";

/**
 * Provedor REAL do Google (B2, etapa 4): a API de eventos e o OAuth por trás
 * do mesmo contrato do simulado. A conexão nasce pelo fluxo OAuth
 * (`google/oauth-flow.ts`), nunca por `exchangeAuthorization`.
 */
export function createGoogleCalendarProvider(
  config: GoogleCalendarConfig,
  http: GoogleHttp = { fetch: globalThis.fetch.bind(globalThis) },
  now: () => Date = () => new Date(),
): CalendarProvider {
  const api = createGoogleCalendarApi(http);
  return {
    kind: "google",
    ...api,
    async exchangeAuthorization() {
      throw new Error("oauth_flow_required");
    },
    refreshAccessToken: (refreshToken) => refreshAccessToken(http, config, refreshToken, now()),
    revoke: (token) => revokeToken(http, token),
  };
}
