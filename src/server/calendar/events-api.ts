/**
 * Contrato mínimo da API de eventos do Google Calendar usado pela B2
 * (etapa 2, CRM → Google; etapa 3, Google → CRM). Reproduz só o que o plano
 * exige (docs/decisoes/b2-google-agenda.md §6):
 *  - listagem incremental por `syncToken`, paginada, com `410` (etapa 3);
 *  - canais de notificação (`watch`/`stop`), sem renovação automática;
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
  /** Série (evento-mestre) ou instância de série: não suportados no vínculo (§6.2). */
  recurrence?: string[] | undefined;
  recurringEventId?: string | undefined;
  updated: string;
};

/**
 * Item da listagem incremental (`events.list` com `fields` mínimo, §6.2):
 * nunca título, descrição, convidados ou local — a listagem traz eventos de
 * TODA a agenda, inclusive os que não são do CRM.
 */
export type EventListItem = Pick<CalendarEvent, "id" | "etag" | "status" | "updated" | "start" | "end" | "extendedProperties">;

/**
 * Consulta da listagem. A MESMA consulta vale para todas as páginas: a
 * página seguinte repete o `syncToken` e os demais parâmetros e só acrescenta
 * o `pageToken`.
 */
export type EventListQuery = {
  /** Sem ele: listagem completa. */
  syncToken?: string | undefined;
  showDeleted: true;
  singleEvents: false;
  maxResults: number;
};

export type EventListPage = {
  items: EventListItem[];
  /** Há mais páginas. */
  nextPageToken?: string | undefined;
  /** Só na ÚLTIMA página. */
  nextSyncToken?: string | undefined;
};

/** Canal de notificação criado por `events.watch`. `expiration` é o
 * EFETIVO devolvido pelo Google (não há TTL fixo documentado). */
export type WatchChannel = { resourceId: string; expiration: string };

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

/**
 * Resposta HTTP de erro do Google (409, 412, 404...). `reason` é o motivo
 * devolvido pelo Google (`errors[].reason`), só para diagnóstico. O
 * adaptador real NORMALIZA o status quando o código sozinho engana: limite
 * de chamadas que o Google devolve como 403 vira 429 (temporário, nunca
 * "perda de acesso"); evento apagado (410) vira 404.
 */
export class ProviderHttpError extends Error {
  constructor(
    public readonly status: number,
    message?: string | undefined,
    public readonly reason?: string | undefined,
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

  /**
   * A agenda ainda é acessível a esta conexão? `false` = o acesso foi perdido
   * (ou a agenda deixou de existir). Existe para não confundir "perdi o
   * acesso" com "o evento foi apagado": ambos podem voltar como 404 no `get`.
   */
  calendarAccessible(accessToken: string, calendarId: string): Promise<boolean>;

  /**
   * Listagem para sincronização (Google → CRM). Parâmetros SEMPRE iguais do
   * sync completo em diante (`showDeleted` verdadeiro, sem `timeMin`,
   * `q`, `privateExtendedProperty`...), porque o `syncToken` é incompatível
   * com eles. Sem `syncToken` = listagem completa. Página seguinte = a mesma
   * consulta com `pageToken`. `410` (`ProviderHttpError`), em qualquer página
   * = token inválido: descartar e refazer a listagem completa.
   */
  listEvents(
    accessToken: string,
    calendarId: string,
    query: EventListQuery & { pageToken?: string | undefined },
  ): Promise<EventListPage>;

  /** Cria um canal de notificação para a agenda. O Google não renova canais. */
  watchEvents(
    accessToken: string,
    calendarId: string,
    channel: { id: string; token: string; address: string },
  ): Promise<WatchChannel>;

  /** Encerra um canal (`channels.stop`). */
  stopChannel(accessToken: string, channel: { id: string; resourceId: string }): Promise<void>;

  /** Intervalos ocupados, nunca título nem detalhe. */
  freeBusy(
    accessToken: string,
    calendarIds: string[],
    timeMin: string,
    timeMax: string,
  ): Promise<Array<{ start: string; end: string }>>;
}
