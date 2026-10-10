/**
 * Contrato do provedor de agenda (B2). Dois provedores: o SIMULADO (testes e
 * desenvolvimento local) e o real do Google (`google/provider.ts`), que só é
 * usado com a configuração completa (`google/config.ts`).
 */
export type ProviderTokens = {
  accessToken: string;
  /** `null` = o Google não devolveu um novo (reautorização da mesma conta e
   * cliente OAuth): o banco decide se o existente pode ser mantido. */
  refreshToken: string | null;
  accessTokenExpiresAt: Date;
  scopes: string[];
  accountEmail: string;
  /** Identidade ESTÁVEL da conta (OpenID Connect `sub`); o e-mail pode mudar. */
  accountSubject: string;
  /** Cliente OAuth que emitiu os tokens: refresh token de outro cliente não serve. */
  oauthClientId: string;
};

export type ProviderCalendar = {
  id: string;
  summary: string;
  /** O usuário é dono da agenda? `calendar.events.owned` só alcança estas. */
  owned: boolean;
};

import type { CalendarEventsApi } from "@/server/calendar/events-api";

export interface CalendarProvider extends CalendarEventsApi {
  readonly kind: "simulated" | "google";
  /** Só o SIMULADO: troca um texto de autorização por tokens. O Google usa o
   * fluxo OAuth (`/api/calendar/oauth/start` → `/callback`). */
  exchangeAuthorization(authorization: string): Promise<ProviderTokens>;
  listCalendars(accessToken: string): Promise<ProviderCalendar[]>;
  /** Novo token de acesso a partir do refresh token (OAuth). */
  refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; accessTokenExpiresAt: Date }>;
  revoke(token: string): Promise<void>;
}

/** Escopos mínimos (docs/decisoes/b2-google-agenda.md §2). Nunca o escopo
 * amplo `calendar`. */
export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
] as const;

/** Escopos de IDENTIDADE (OpenID Connect): a conta é identificada pelo `sub`
 * do ID token, não pelo id da agenda principal. */
export const IDENTITY_SCOPES = ["openid", "email"] as const;

/**
 * O provedor simulado só vale fora de Production e Preview, como os
 * adaptadores de teste da A11: nesses ambientes a variável é ignorada.
 */
export function usesSimulatedCalendarProvider(): boolean {
  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv === "production" || vercelEnv === "preview") return false;
  return process.env.CALENDAR_PROVIDER === "simulated";
}

/**
 * Provedor do ambiente:
 *  - simulado, só fora de Preview/Production e com `CALENDAR_PROVIDER=simulated`;
 *  - Google, só com `CALENDAR_PROVIDER=google` E a configuração COMPLETA
 *    (cliente OAuth, endereço de retorno, cifra dos tokens e assinatura de
 *    ambiente — `google/config.ts`);
 *  - senão, `null`: a integração fica desligada e a tela diz que não está
 *    configurada. Configuração incompleta nunca liga "pela metade".
 */
export async function getCalendarProvider(): Promise<CalendarProvider | null> {
  if (usesSimulatedCalendarProvider()) {
    const { getSimulatedCalendarProvider } = await import("@/server/calendar/simulated-provider");
    return getSimulatedCalendarProvider();
  }
  const { getGoogleCalendarConfig } = await import("@/server/calendar/google/config");
  const config = getGoogleCalendarConfig();
  if (!config) return null;
  const { createGoogleCalendarProvider } = await import("@/server/calendar/google/provider");
  return createGoogleCalendarProvider(config);
}
