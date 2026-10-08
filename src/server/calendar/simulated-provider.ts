import { CALENDAR_SCOPES, type CalendarProvider, type ProviderCalendar, type ProviderTokens } from "@/server/calendar/provider";

/**
 * Provedor simulado, em memória, determinístico. A "autorização" é um texto
 * `conta@dominio` (ou `conta@dominio|calendario1,calendario2`) — o que o
 * formulário de desenvolvimento envia no lugar do consentimento do Google.
 * Nenhuma chamada de rede.
 */
export class SimulatedCalendarProvider implements CalendarProvider {
  private issued = new Map<string, { email: string; calendars: ProviderCalendar[] }>();
  readonly revoked: string[] = [];
  private counter = 0;

  async exchangeAuthorization(authorization: string): Promise<ProviderTokens> {
    const [email, extra] = authorization.split("|");
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new Error("authorization_invalid");
    }
    this.counter += 1;
    const accessToken = `sim-access-${this.counter}`;
    const calendars: ProviderCalendar[] = (extra ? extra.split(",") : ["principal"]).map((name, index) => ({
      id: `${name.trim()}@calendar.simulated`,
      summary: name.trim(),
      owned: index === 0,
    }));
    this.issued.set(accessToken, { email, calendars });
    return {
      accessToken,
      refreshToken: `sim-refresh-${this.counter}`,
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      scopes: [...CALENDAR_SCOPES],
      accountEmail: email.toLowerCase(),
    };
  }

  async listCalendars(accessToken: string): Promise<ProviderCalendar[]> {
    const entry = this.issued.get(accessToken);
    if (!entry) throw new Error("access_token_invalid");
    return entry.calendars;
  }

  async revoke(token: string): Promise<void> {
    this.revoked.push(token);
  }
}

let instance: SimulatedCalendarProvider | undefined;

export function getSimulatedCalendarProvider(): SimulatedCalendarProvider {
  instance ??= new SimulatedCalendarProvider();
  return instance;
}
