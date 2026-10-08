/**
 * Contrato mínimo da API de eventos do Google Calendar usado pela B2
 * (etapa 2, CRM → Google). Reproduz só o que o plano exige
 * (docs/decisoes/b2-google-agenda.md §6):
 *  - `If-Match` com o `etag` nas escritas, e `412` quando mudou;
 *  - id de evento definido pelo cliente (409 se já existe);
 *  - Meet por `conferenceData.createRequest`, assíncrono;
 *  - `freebusy` só com intervalos ocupados, sem título.
 * O provedor real do Google implementa isto numa etapa posterior; hoje só
 * existe o simulado.
 */

export type EventDateTime = { dateTime: string };

export type ConferenceData = {
  createRequest?: { requestId: string; status: "pending" | "success" | "failure" } | undefined;
  entryPoints?: Array<{ entryPointType: "video"; uri: string }> | undefined;
};

export type CalendarEvent = {
  id: string;
  etag: string;
  status: "confirmed" | "cancelled";
  summary?: string | undefined;
  start?: EventDateTime | undefined;
  end?: EventDateTime | undefined;
  extendedProperties?: { private?: Record<string, string> } | undefined;
  conferenceData?: ConferenceData | undefined;
  attendees?: Array<{ email: string }> | undefined;
  updated: string;
};

export type EventInput = {
  id?: string | undefined;
  summary?: string | undefined;
  start?: EventDateTime | undefined;
  end?: EventDateTime | undefined;
  extendedProperties?: { private?: Record<string, string> } | undefined;
  conferenceData?: ConferenceData | undefined;
  attendees?: Array<{ email: string }> | undefined;
};

export type SendUpdates = "none" | "all";

/** Resposta HTTP de erro do Google (409, 412, 404...). */
export class ProviderHttpError extends Error {
  constructor(
    public readonly status: number,
    message?: string | undefined,
  ) {
    super(message ?? `provider_http_${status}`);
    this.name = "ProviderHttpError";
  }
}

/**
 * Timeout ou queda de rede: o resultado é DESCONHECIDO — o Google pode ter
 * aplicado a escrita ou não. Quem recebe isto nunca repete às cegas
 * (§6.7): consulta o estado.
 */
export class ProviderUncertainError extends Error {
  constructor(message = "provider_result_uncertain") {
    super(message);
    this.name = "ProviderUncertainError";
  }
}

export interface CalendarEventsApi {
  insertEvent(
    accessToken: string,
    calendarId: string,
    event: EventInput,
    opts: { conferenceDataVersion?: 0 | 1 | undefined; sendUpdates: SendUpdates },
  ): Promise<CalendarEvent>;

  /** `null` quando o evento nunca existiu (404). Evento apagado volta com
   * `status: "cancelled"`. */
  getEvent(accessToken: string, calendarId: string, eventId: string): Promise<CalendarEvent | null>;

  patchEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    patch: EventInput,
    opts: { ifMatch: string; conferenceDataVersion?: 0 | 1 | undefined; sendUpdates: SendUpdates },
  ): Promise<CalendarEvent>;

  deleteEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    opts: { ifMatch: string; sendUpdates: SendUpdates },
  ): Promise<void>;

  /** Intervalos ocupados, nunca título nem detalhe. */
  freeBusy(
    accessToken: string,
    calendarIds: string[],
    timeMin: string,
    timeMax: string,
  ): Promise<Array<{ start: string; end: string }>>;
}
