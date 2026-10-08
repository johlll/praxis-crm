/**
 * Contrato do provedor de agenda (B2). A fundação roda contra um provedor
 * SIMULADO; o provedor real do Google (OAuth, Calendar API) entra numa
 * etapa posterior, quando houver projeto Google Cloud — nenhuma credencial
 * ou chamada externa existe nesta etapa.
 */
export type ProviderTokens = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  scopes: string[];
  accountEmail: string;
};

export type ProviderCalendar = {
  id: string;
  summary: string;
  /** O usuário é dono da agenda? `calendar.events.owned` só alcança estas. */
  owned: boolean;
};

export interface CalendarProvider {
  /** Troca o resultado do consentimento por tokens (OAuth). */
  exchangeAuthorization(authorization: string): Promise<ProviderTokens>;
  listCalendars(accessToken: string): Promise<ProviderCalendar[]>;
  revoke(token: string): Promise<void>;
}

/** Escopos mínimos (docs/decisoes/b2-google-agenda.md §2). Nunca o escopo
 * amplo `calendar`. */
export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
] as const;

/**
 * O provedor simulado só vale fora de Production e Preview, como os
 * adaptadores de teste da A11: nesses ambientes a variável é ignorada. O
 * provedor real ainda não existe, então lá o resultado é `null` e a tela
 * diz que a integração não está configurada.
 */
export function usesSimulatedCalendarProvider(): boolean {
  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv === "production" || vercelEnv === "preview") return false;
  return process.env.CALENDAR_PROVIDER === "simulated";
}

export async function getCalendarProvider(): Promise<CalendarProvider | null> {
  if (usesSimulatedCalendarProvider()) {
    const { getSimulatedCalendarProvider } = await import("@/server/calendar/simulated-provider");
    return getSimulatedCalendarProvider();
  }
  return null;
}
