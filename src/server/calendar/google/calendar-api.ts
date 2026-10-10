import {
  ProviderHttpError,
  type CalendarEvent,
  type CalendarEventsApi,
  type ConferenceData,
  type EventInput,
  type EventListItem,
  type EventListPage,
  type EventListQuery,
  type SendUpdates,
  type WatchChannel,
} from "@/server/calendar/events-api";
import { googleRequest, type GoogleHttp } from "@/server/calendar/google/http";
import type { ProviderCalendar } from "@/server/calendar/provider";

/**
 * Google Calendar API v3 por trás do contrato `CalendarEventsApi` (B2, etapa
 * 4). Só o que o contrato pede, com o MÍNIMO de campos (`fields`):
 *  - a listagem nunca pede título, descrição, convidados ou local (ela traz
 *    eventos de TODA a agenda, inclusive os que não são do CRM);
 *  - a leitura de um evento vinculado pede só o que a sincronização compara;
 *  - escritas com `If-Match` (412 quando mudou), id definido pelo cliente
 *    (409 se já existe), `sendUpdates` sempre explícito;
 *  - evento apagado (`410`) é tratado como inexistente (404), como no
 *    contrato; `410` da LISTAGEM continua `410` (token de sincronização
 *    inválido);
 *  - horários devolvidos em UTC (ISO), como o resto do CRM compara.
 */

const BASE = "https://www.googleapis.com/calendar/v3";
const EVENT_FIELDS = "id,etag,status,summary,start,end,extendedProperties,conferenceData,recurrence,recurringEventId,updated";
const LIST_FIELDS = "items(id,etag,status,updated,start,end,extendedProperties),nextPageToken,nextSyncToken";

type GoogleDateTime = { dateTime?: string; date?: string; timeZone?: string };
type GoogleEvent = {
  id: string;
  etag?: string;
  status?: string;
  summary?: string;
  start?: GoogleDateTime;
  end?: GoogleDateTime;
  extendedProperties?: { private?: Record<string, string> };
  conferenceData?: GoogleConferenceData;
  recurrence?: string[];
  recurringEventId?: string;
  updated?: string;
};

/** `conferenceData` como o Google devolve (Calendar API v3). */
type GoogleConferenceData = {
  createRequest?: { requestId?: string; status?: { statusCode?: string } };
  entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
};

const MEET_STATUS = new Set(["pending", "success", "failure"]);

/**
 * Leitura do Meet: o Google traz `createRequest.status.statusCode` (objeto);
 * o contrato usa a string. Endereço só do entryPoint de VÍDEO — telefone,
 * "more" e SIP podem vir antes e nunca viram o link da reunião.
 */
function fromGoogleConference(raw: GoogleConferenceData | undefined): ConferenceData | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: ConferenceData = {};
  const request = raw.createRequest;
  const statusCode = request?.status?.statusCode;
  if (request && typeof request.requestId === "string" && typeof statusCode === "string" && MEET_STATUS.has(statusCode)) {
    out.createRequest = { requestId: request.requestId, status: statusCode as "pending" | "success" | "failure" };
  }
  const video = Array.isArray(raw.entryPoints)
    ? raw.entryPoints.find((e) => e?.entryPointType === "video" && typeof e.uri === "string" && e.uri.startsWith("https://"))
    : undefined;
  if (video?.uri) out.entryPoints = [{ entryPointType: "video", uri: video.uri }];
  return out.createRequest || out.entryPoints ? out : undefined;
}

/**
 * Escrita do Meet: só `requestId` e `conferenceSolutionKey` (hangoutsMeet).
 * `status` e `entryPoints` são do Google (somente leitura) e nunca vão no corpo.
 */
function toGoogleConference(input: ConferenceData): Record<string, unknown> | undefined {
  const requestId = input.createRequest?.requestId;
  if (!requestId) return undefined;
  return { createRequest: { requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } };
}

const enc = encodeURIComponent;
const eventsUrl = (calendarId: string) => `${BASE}/calendars/${enc(calendarId)}/events`;

function utc(value: GoogleDateTime | undefined): { dateTime: string } | undefined {
  // Evento de dia inteiro (`date`) não tem horário: o CRM não o vincula.
  if (!value?.dateTime) return undefined;
  const ms = Date.parse(value.dateTime);
  return Number.isFinite(ms) ? { dateTime: new Date(ms).toISOString() } : undefined;
}

function toEvent(raw: GoogleEvent): CalendarEvent {
  return {
    id: raw.id,
    etag: raw.etag ?? "",
    status: raw.status === "cancelled" ? "cancelled" : "confirmed",
    summary: raw.summary,
    start: utc(raw.start),
    end: utc(raw.end),
    extendedProperties: raw.extendedProperties?.private ? { private: { ...raw.extendedProperties.private } } : undefined,
    conferenceData: fromGoogleConference(raw.conferenceData),
    recurrence: raw.recurrence,
    recurringEventId: raw.recurringEventId,
    updated: raw.updated ?? "",
  };
}

function toListItem(raw: GoogleEvent): EventListItem {
  const event = toEvent(raw);
  return {
    id: event.id,
    etag: event.etag,
    status: event.status,
    updated: event.updated,
    start: event.start,
    end: event.end,
    extendedProperties: event.extendedProperties,
  };
}

/** Corpo de escrita: só os campos do contrato. */
function toBody(input: EventInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.id !== undefined) body.id = input.id;
  if (input.summary !== undefined) body.summary = input.summary;
  if (input.start !== undefined) body.start = { dateTime: input.start.dateTime };
  if (input.end !== undefined) body.end = { dateTime: input.end.dateTime };
  if (input.extendedProperties !== undefined) body.extendedProperties = input.extendedProperties;
  if (input.conferenceData !== undefined) {
    const conference = toGoogleConference(input.conferenceData);
    if (conference) body.conferenceData = conference;
  }
  if (input.attendees !== undefined) body.attendees = input.attendees.map((a) => ({ email: a.email }));
  return body;
}

/** 410 de um evento = apagado: no contrato, inexistente (404). */
function goneAsNotFound(error: unknown): never {
  if (error instanceof ProviderHttpError && error.status === 410) {
    throw new ProviderHttpError(404, "google_http_404", error.reason);
  }
  throw error;
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) search.set(k, String(v));
  const s = search.toString();
  return s ? `?${s}` : "";
}

export function createGoogleCalendarApi(http: GoogleHttp): CalendarEventsApi & {
  listCalendars(accessToken: string): Promise<ProviderCalendar[]>;
} {
  return {
    async insertEvent(accessToken, calendarId, event, opts) {
      const raw = await googleRequest<GoogleEvent>(http, {
        method: "POST",
        url:
          eventsUrl(calendarId) +
          query({ conferenceDataVersion: opts.conferenceDataVersion, sendUpdates: opts.sendUpdates, fields: EVENT_FIELDS }),
        accessToken,
        json: toBody(event),
      });
      return toEvent(raw!);
    },

    async getEvent(accessToken, calendarId, eventId) {
      try {
        const raw = await googleRequest<GoogleEvent>(http, {
          method: "GET",
          url: `${eventsUrl(calendarId)}/${enc(eventId)}` + query({ fields: EVENT_FIELDS }),
          accessToken,
        });
        return toEvent(raw!);
      } catch (error) {
        if (error instanceof ProviderHttpError && (error.status === 404 || error.status === 410)) return null;
        throw error;
      }
    },

    async patchEvent(accessToken, calendarId, eventId, patch, opts) {
      const raw = await googleRequest<GoogleEvent>(http, {
        method: "PATCH",
        url:
          `${eventsUrl(calendarId)}/${enc(eventId)}` +
          query({ conferenceDataVersion: opts.conferenceDataVersion, sendUpdates: opts.sendUpdates, fields: EVENT_FIELDS }),
        accessToken,
        headers: { "If-Match": opts.ifMatch },
        json: toBody(patch),
      }).catch(goneAsNotFound);
      return toEvent(raw!);
    },

    async deleteEvent(accessToken, calendarId, eventId, opts: { ifMatch: string; sendUpdates: SendUpdates }) {
      await googleRequest(http, {
        method: "DELETE",
        url: `${eventsUrl(calendarId)}/${enc(eventId)}` + query({ sendUpdates: opts.sendUpdates }),
        accessToken,
        headers: { "If-Match": opts.ifMatch },
      }).catch(goneAsNotFound);
    },

    /**
     * A agenda continua na lista desta conta (`calendarList.get`, coberto pelo
     * escopo `calendar.calendarlist.readonly`). 404/403 = não alcança mais;
     * 401, limite de chamadas ou falha temporária sobem (não se sabe).
     */
    async calendarAccessible(accessToken, calendarId) {
      try {
        await googleRequest(http, {
          method: "GET",
          url: `${BASE}/users/me/calendarList/${enc(calendarId)}` + query({ fields: "id" }),
          accessToken,
        });
        return true;
      } catch (error) {
        if (error instanceof ProviderHttpError && (error.status === 404 || error.status === 403)) return false;
        throw error;
      }
    },

    async listEvents(accessToken, calendarId, q: EventListQuery & { pageToken?: string | undefined }): Promise<EventListPage> {
      // Parâmetros IDÊNTICOS em todas as páginas e execuções (o `syncToken` é
      // incompatível com filtros); a página seguinte só acrescenta `pageToken`.
      const raw = await googleRequest<{ items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string }>(http, {
        method: "GET",
        url:
          eventsUrl(calendarId) +
          query({
            syncToken: q.syncToken,
            showDeleted: q.showDeleted,
            singleEvents: q.singleEvents,
            maxResults: q.maxResults,
            pageToken: q.pageToken,
            fields: LIST_FIELDS,
          }),
        accessToken,
      });
      return {
        items: (raw?.items ?? []).map(toListItem),
        nextPageToken: raw?.nextPageToken,
        nextSyncToken: raw?.nextSyncToken,
      };
    },

    async watchEvents(accessToken, calendarId, channel): Promise<WatchChannel> {
      const raw = await googleRequest<{ resourceId?: string; expiration?: string }>(http, {
        method: "POST",
        url: `${eventsUrl(calendarId)}/watch`,
        accessToken,
        json: { id: channel.id, type: "web_hook", address: channel.address, token: channel.token },
      });
      const expiration = Number(raw?.expiration);
      if (!raw?.resourceId || !Number.isFinite(expiration)) throw new ProviderHttpError(502, "google_watch_incomplete");
      // Vale o vencimento EFETIVO devolvido (não há TTL fixo documentado).
      return { resourceId: raw.resourceId, expiration: new Date(expiration).toISOString() };
    },

    async stopChannel(accessToken, channel) {
      await googleRequest(http, {
        method: "POST",
        url: `${BASE}/channels/stop`,
        accessToken,
        json: { id: channel.id, resourceId: channel.resourceId },
      });
    },

    async freeBusy(accessToken, calendarIds, timeMin, timeMax) {
      const raw = await googleRequest<unknown>(http, {
        method: "POST",
        url: `${BASE}/freeBusy`,
        accessToken,
        json: { timeMin, timeMax, items: calendarIds.map((id) => ({ id })) },
      });
      // Disponibilidade desconhecida NUNCA é "livre": resposta malformada,
      // agenda ausente, `busy` que não é lista, intervalo ilegível ou erro por
      // agenda (com ou sem motivo) → erro. Só `busy: []` com a agenda
      // presente e sem erro significa livre.
      const unknown = (reason?: string) => new ProviderHttpError(503, "google_freebusy_unknown", reason);
      const calendars = (raw as { calendars?: unknown } | null)?.calendars;
      if (!calendars || typeof calendars !== "object" || Array.isArray(calendars)) throw unknown();
      const busy: Array<{ start: string; end: string }> = [];
      for (const id of calendarIds) {
        const entry = (calendars as Record<string, unknown>)[id] as
          | { busy?: unknown; errors?: unknown }
          | undefined;
        if (!entry || typeof entry !== "object") throw unknown();
        // `errors` presente (e não uma lista vazia): agenda com erro.
        if (entry.errors !== undefined && !(Array.isArray(entry.errors) && entry.errors.length === 0)) {
          const errors = Array.isArray(entry.errors) ? (entry.errors as Array<{ reason?: unknown }>) : [];
          const reason = errors.map((e) => e?.reason).find((r): r is string => typeof r === "string" && /^[A-Za-z_]{1,64}$/.test(r));
          throw new ProviderHttpError(reason === "notFound" ? 404 : 503, "google_freebusy_error", reason);
        }
        if (!Array.isArray(entry.busy)) throw unknown();
        for (const b of entry.busy as Array<{ start?: unknown; end?: unknown }>) {
          const s = typeof b?.start === "string" ? Date.parse(b.start) : NaN;
          const e = typeof b?.end === "string" ? Date.parse(b.end) : NaN;
          if (!Number.isFinite(s) || !Number.isFinite(e)) throw unknown();
          busy.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString() });
        }
      }
      return busy;
    },

    /** Agendas da conta; `owned` = dono (o escopo `events.owned` só alcança estas). */
    async listCalendars(accessToken) {
      const calendars: ProviderCalendar[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 20; page++) {
        const raw = await googleRequest<{
          items?: Array<{ id: string; summary?: string; summaryOverride?: string; accessRole?: string }>;
          nextPageToken?: string;
        }>(http, {
          method: "GET",
          url:
            `${BASE}/users/me/calendarList` +
            query({ maxResults: 250, pageToken, fields: "items(id,summary,summaryOverride,accessRole),nextPageToken" }),
          accessToken,
        });
        for (const item of raw?.items ?? []) {
          calendars.push({ id: item.id, summary: item.summaryOverride ?? item.summary ?? item.id, owned: item.accessRole === "owner" });
        }
        pageToken = raw?.nextPageToken;
        if (!pageToken) break;
      }
      return calendars;
    },
  };
}
