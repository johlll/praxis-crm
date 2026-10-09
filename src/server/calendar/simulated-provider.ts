import {
  ProviderHttpError,
  ProviderUncertainError,
  type CalendarEvent,
  type EventInput,
  type SendUpdates,
} from "@/server/calendar/events-api";
import { CALENDAR_SCOPES, type CalendarProvider, type ProviderCalendar, type ProviderTokens } from "@/server/calendar/provider";

/**
 * Provedor simulado, em memória, determinístico. A "autorização" é um texto
 * `conta@dominio` (ou `conta@dominio|calendario1,calendario2`) — o que o
 * formulário de desenvolvimento envia no lugar do consentimento do Google.
 * Nenhuma chamada de rede.
 *
 * Além do OAuth, simula a API de eventos com o comportamento que importa
 * para a B2: `etag` que muda a cada alteração, `If-Match` com `412`, id de
 * evento definido pelo cliente com `409`, Meet assíncrono (`pending` →
 * `success`), `freebusy` sem detalhes — e falhas injetáveis (timeout com a
 * escrita aplicada ou não, status de erro) para provar idempotência e
 * recuperação de resultado incerto.
 */

type Operation = "insert" | "get" | "patch" | "delete";

export type InjectedFault = {
  operation: Operation;
  /** `timeout_after_apply`: o Google aplica e a resposta se perde.
   *  `timeout_before_apply`: a requisição se perde antes de chegar.
   *  `status`: resposta HTTP de erro. */
  kind: "timeout_after_apply" | "timeout_before_apply" | "status";
  status?: number | undefined;
};

type StoredEvent = CalendarEvent & { meetReadsLeft?: number | undefined };

export class SimulatedCalendarProvider implements CalendarProvider {
  private issued = new Map<string, { email: string; calendars: ProviderCalendar[] }>();
  private refreshIssued = new Map<string, string>();
  readonly revoked: string[] = [];
  private counter = 0;

  // --- API de eventos ---------------------------------------------------
  private events = new Map<string, Map<string, StoredEvent>>();
  private etagCounter = 0;
  private faults: InjectedFault[] = [];
  /** Agendas cujo acesso foi perdido, e como o Google responde (403 ou 404). */
  private revokedCalendars = new Map<string, 403 | 404>();
  private hooks: Array<{ operation: Operation; fn: () => void }> = [];
  /** Quantas leituras (`get`) até o Meet pendente virar `success`. */
  meetReadyAfterReads = 1;
  /** Toda requisição recebida, em ordem — para provar o que NÃO foi chamado. */
  readonly calls: Array<{ operation: Operation | "freebusy" | "calendar"; eventId?: string | undefined; calendarId?: string | undefined }> = [];
  /** Convites que o Google teria enviado por e-mail. */
  readonly notificationsSent: Array<{ eventId: string; to: string[] }> = [];

  async exchangeAuthorization(authorization: string): Promise<ProviderTokens> {
    const [email, extra] = authorization.split("|");
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new Error("authorization_invalid");
    }
    this.counter += 1;
    const accessToken = `sim-access-${this.counter}`;
    const refreshToken = `sim-refresh-${this.counter}`;
    const calendars: ProviderCalendar[] = (extra ? extra.split(",") : ["principal"]).map((name, index) => ({
      id: `${name.trim()}@calendar.simulated`,
      summary: name.trim(),
      owned: index === 0,
    }));
    this.issued.set(accessToken, { email, calendars });
    this.refreshIssued.set(refreshToken, email);
    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      scopes: [...CALENDAR_SCOPES],
      accountEmail: email.toLowerCase(),
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; accessTokenExpiresAt: Date }> {
    const email = this.refreshIssued.get(refreshToken);
    if (!email) throw new Error("refresh_token_invalid");
    this.counter += 1;
    const accessToken = `sim-access-${this.counter}`;
    // Mesmas agendas da conta.
    const previous = [...this.issued.values()].find((v) => v.email === email);
    this.issued.set(accessToken, { email, calendars: previous?.calendars ?? [] });
    return { accessToken, accessTokenExpiresAt: new Date(Date.now() + 3600_000) };
  }

  async listCalendars(accessToken: string): Promise<ProviderCalendar[]> {
    const entry = this.issued.get(accessToken);
    if (!entry) throw new Error("access_token_invalid");
    return entry.calendars;
  }

  async revoke(token: string): Promise<void> {
    this.revoked.push(token);
  }

  // --- Controles de teste ----------------------------------------------

  injectFault(fault: InjectedFault): void {
    this.faults.push(fault);
  }

  /** Roda `fn` UMA vez, logo antes da próxima operação desse tipo ser
   * processada — simula uma edição que chega ao Google entre a leitura e a
   * escrita do CRM (a corrida que o `If-Match` existe para pegar). */
  onBefore(operation: Operation, fn: () => void): void {
    this.hooks.push({ operation, fn });
  }

  /** Simula a perda de acesso à agenda. `as: 404` reproduz o caso ambíguo, em
   * que o `get` volta como "não existe" e só a checagem da agenda resolve. */
  revokeCalendarAccess(calendarId: string, as: 403 | 404 = 404): void {
    this.revokedCalendars.set(calendarId, as);
  }

  restoreCalendarAccess(calendarId: string): void {
    this.revokedCalendars.delete(calendarId);
  }

  async calendarAccessible(_accessToken: string, calendarId: string): Promise<boolean> {
    this.calls.push({ operation: "calendar", calendarId });
    return !this.revokedCalendars.has(calendarId);
  }

  /** Edição feita DIRETO no Google, fora do CRM (muda o etag). */
  externalEdit(calendarId: string, eventId: string, patch: EventInput & { status?: "cancelled" | undefined }): void {
    const event = this.require(calendarId, eventId);
    Object.assign(event, patch);
    this.touch(event);
  }

  /** Evento pessoal/externo (sem a marca do CRM) que só deve bloquear
   * disponibilidade. */
  addExternalEvent(calendarId: string, start: string, end: string, summary = "Consulta médica (pessoal)"): string {
    this.etagCounter += 1;
    const id = `ext${this.etagCounter}`;
    const event: StoredEvent = {
      id,
      etag: `"${this.etagCounter}"`,
      status: "confirmed",
      summary,
      start: { dateTime: start },
      end: { dateTime: end },
      updated: new Date().toISOString(),
    };
    this.bucket(calendarId).set(id, event);
    return id;
  }

  peek(calendarId: string, eventId: string): StoredEvent | undefined {
    return this.bucket(calendarId).get(eventId);
  }

  eventCount(calendarId: string): number {
    return [...this.bucket(calendarId).values()].filter((e) => e.status === "confirmed").length;
  }

  // --- Eventos ----------------------------------------------------------

  async insertEvent(
    _accessToken: string,
    calendarId: string,
    event: EventInput,
    opts: { conferenceDataVersion?: 0 | 1 | undefined; sendUpdates: SendUpdates },
  ): Promise<CalendarEvent> {
    this.calls.push({ operation: "insert", eventId: event.id, calendarId });
    const fault = this.nextFault("insert");
    const revoked = this.revokedCalendars.get(calendarId);
    if (revoked !== undefined) throw new ProviderHttpError(revoked);
    if (fault?.kind === "timeout_before_apply") throw new ProviderUncertainError();
    if (fault?.kind === "status") throw new ProviderHttpError(fault.status ?? 500);

    if (!event.id) throw new ProviderHttpError(400, "event_id_required");
    const existing = this.bucket(calendarId).get(event.id);
    if (existing) throw new ProviderHttpError(409);

    const stored: StoredEvent = {
      id: event.id,
      etag: "",
      status: "confirmed",
      summary: event.summary,
      start: event.start,
      end: event.end,
      extendedProperties: event.extendedProperties,
      attendees: event.attendees,
      updated: "",
    };
    this.applyConference(stored, event, opts.conferenceDataVersion);
    this.touch(stored);
    this.bucket(calendarId).set(stored.id, stored);
    this.notify(stored, opts.sendUpdates);

    if (fault?.kind === "timeout_after_apply") throw new ProviderUncertainError();
    return this.snapshot(stored);
  }

  async getEvent(_accessToken: string, calendarId: string, eventId: string): Promise<CalendarEvent | null> {
    this.calls.push({ operation: "get", eventId, calendarId });
    const fault = this.nextFault("get");
    if (fault?.kind === "timeout_before_apply" || fault?.kind === "timeout_after_apply") throw new ProviderUncertainError();
    if (fault?.kind === "status") throw new ProviderHttpError(fault.status ?? 500);

    const revoked = this.revokedCalendars.get(calendarId);
    if (revoked === 403) throw new ProviderHttpError(403);
    if (revoked === 404) return null;

    const stored = this.bucket(calendarId).get(eventId);
    if (!stored) return null;
    this.advanceMeet(stored);
    return this.snapshot(stored);
  }

  async patchEvent(
    _accessToken: string,
    calendarId: string,
    eventId: string,
    patch: EventInput,
    opts: { ifMatch: string; conferenceDataVersion?: 0 | 1 | undefined; sendUpdates: SendUpdates },
  ): Promise<CalendarEvent> {
    this.calls.push({ operation: "patch", eventId, calendarId });
    const fault = this.nextFault("patch");
    const revoked = this.revokedCalendars.get(calendarId);
    if (revoked !== undefined) throw new ProviderHttpError(revoked);
    if (fault?.kind === "timeout_before_apply") throw new ProviderUncertainError();
    if (fault?.kind === "status") throw new ProviderHttpError(fault.status ?? 500);

    const stored = this.bucket(calendarId).get(eventId);
    if (!stored || stored.status === "cancelled") throw new ProviderHttpError(404);
    if (stored.etag !== opts.ifMatch) throw new ProviderHttpError(412);

    if (patch.summary !== undefined) stored.summary = patch.summary;
    if (patch.start !== undefined) stored.start = patch.start;
    if (patch.end !== undefined) stored.end = patch.end;
    if (patch.attendees !== undefined) stored.attendees = patch.attendees;
    this.applyConference(stored, patch, opts.conferenceDataVersion);
    this.touch(stored);
    this.notify(stored, opts.sendUpdates);

    if (fault?.kind === "timeout_after_apply") throw new ProviderUncertainError();
    return this.snapshot(stored);
  }

  async deleteEvent(
    _accessToken: string,
    calendarId: string,
    eventId: string,
    opts: { ifMatch: string; sendUpdates: SendUpdates },
  ): Promise<void> {
    this.calls.push({ operation: "delete", eventId, calendarId });
    const fault = this.nextFault("delete");
    const revoked = this.revokedCalendars.get(calendarId);
    if (revoked !== undefined) throw new ProviderHttpError(revoked);
    if (fault?.kind === "timeout_before_apply") throw new ProviderUncertainError();
    if (fault?.kind === "status") throw new ProviderHttpError(fault.status ?? 500);

    const stored = this.bucket(calendarId).get(eventId);
    if (!stored || stored.status === "cancelled") throw new ProviderHttpError(404);
    if (stored.etag !== opts.ifMatch) throw new ProviderHttpError(412);

    stored.status = "cancelled";
    this.touch(stored);
    this.notify(stored, opts.sendUpdates);

    if (fault?.kind === "timeout_after_apply") throw new ProviderUncertainError();
  }

  async freeBusy(
    _accessToken: string,
    calendarIds: string[],
    timeMin: string,
    timeMax: string,
  ): Promise<Array<{ start: string; end: string }>> {
    this.calls.push({ operation: "freebusy" });
    const min = Date.parse(timeMin);
    const max = Date.parse(timeMax);
    const busy: Array<{ start: string; end: string }> = [];
    for (const calendarId of calendarIds) {
      for (const event of this.bucket(calendarId).values()) {
        if (event.status !== "confirmed" || !event.start || !event.end) continue;
        const s = Date.parse(event.start.dateTime);
        const e = Date.parse(event.end.dateTime);
        if (e > min && s < max) busy.push({ start: event.start.dateTime, end: event.end.dateTime });
      }
    }
    // Só intervalos: o Google nunca devolve título no freebusy.
    return busy.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  }

  // --- Internos ---------------------------------------------------------

  private bucket(calendarId: string): Map<string, StoredEvent> {
    let b = this.events.get(calendarId);
    if (!b) {
      b = new Map();
      this.events.set(calendarId, b);
    }
    return b;
  }

  private require(calendarId: string, eventId: string): StoredEvent {
    const e = this.bucket(calendarId).get(eventId);
    if (!e) throw new Error(`evento simulado inexistente: ${eventId}`);
    return e;
  }

  private nextFault(operation: Operation): InjectedFault | undefined {
    const hookIndex = this.hooks.findIndex((h) => h.operation === operation);
    if (hookIndex >= 0) this.hooks.splice(hookIndex, 1)[0]!.fn();
    const index = this.faults.findIndex((f) => f.operation === operation);
    if (index < 0) return undefined;
    return this.faults.splice(index, 1)[0];
  }

  private touch(event: StoredEvent): void {
    this.etagCounter += 1;
    event.etag = `"${this.etagCounter}"`;
    event.updated = new Date().toISOString();
  }

  private snapshot(event: StoredEvent): CalendarEvent {
    const { meetReadsLeft: _ignored, ...rest } = event;
    void _ignored;
    return structuredClone(rest);
  }

  private applyConference(event: StoredEvent, input: EventInput, version: 0 | 1 | undefined): void {
    const request = input.conferenceData?.createRequest;
    // Sem conferenceDataVersion=1 o Google ignora o pedido de Meet.
    if (!request || version !== 1) return;
    if (event.conferenceData?.entryPoints?.length) return;
    event.conferenceData = { createRequest: { requestId: request.requestId, status: "pending" } };
    event.meetReadsLeft = this.meetReadyAfterReads;
  }

  private advanceMeet(event: StoredEvent): void {
    const request = event.conferenceData?.createRequest;
    if (!request || request.status !== "pending") return;
    if ((event.meetReadsLeft ?? 0) > 0) {
      event.meetReadsLeft = (event.meetReadsLeft ?? 0) - 1;
    }
    if ((event.meetReadsLeft ?? 0) === 0) {
      event.conferenceData = {
        createRequest: { requestId: request.requestId, status: "success" },
        entryPoints: [{ entryPointType: "video", uri: `https://meet.simulated/${event.id}` }],
      };
      this.touch(event);
    }
  }

  private notify(event: StoredEvent, sendUpdates: SendUpdates): void {
    if (sendUpdates !== "all" || !event.attendees?.length) return;
    this.notificationsSent.push({ eventId: event.id, to: event.attendees.map((a) => a.email) });
  }
}

let instance: SimulatedCalendarProvider | undefined;

export function getSimulatedCalendarProvider(): SimulatedCalendarProvider {
  instance ??= new SimulatedCalendarProvider();
  return instance;
}
