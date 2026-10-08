import {
  ProviderHttpError,
  ProviderUncertainError,
  type CalendarEvent,
  type EventInput,
} from "@/server/calendar/events-api";
import { deterministicEventId, meetRequestId } from "@/server/calendar/sync/ids";
import { googleChangedSinceBase, mergeFields, type SyncState, type Wanted } from "@/server/calendar/sync/merge";
import {
  CalendarSyncError,
  type ActivitySnapshot,
  type ConnectionContext,
  type LinkRecord,
  type LinkState,
  type SyncDeps,
} from "@/server/calendar/sync/types";

/**
 * Compromissos CRM → Google (B2, etapa 2). Orquestra criar, reagendar,
 * cancelar, Meet e disponibilidade seguindo o plano aprovado
 * (docs/decisoes/b2-google-agenda.md §6): base de sincronização por campo,
 * `If-Match`/`412` com releitura, id determinístico com conferência de
 * `409`, intenção gravada ANTES de qualquer efeito externo e recuperação de
 * resultado incerto por consulta de estado — nunca repetindo às cegas.
 *
 * Só toca em evento que o CRM criou e vinculou. Eventos externos nunca são
 * lidos aqui além dos intervalos ocupados do `freebusy`.
 */

const MAX_CONCURRENCY_ATTEMPTS = 3;
const MEET_POLL_ATTEMPTS = 3;
const MIN_DURATION = 15;
const MAX_DURATION = 480;
const DEFAULT_DURATION = 60;

// ---------------------------------------------------------------------
// Resultados
// ---------------------------------------------------------------------

export type CreateAppointmentResult =
  | { status: "created"; linkId: string | null; eventId: string; adopted: boolean; meet: MeetInfo }
  | { status: "already_linked"; link: LinkRecord }
  | { status: "busy"; busy: Array<{ start: string; end: string }> }
  | { status: "failed"; code: string }
  | { status: "uncertain"; intentId: string };

export type MeetInfo = { status: "pending" | "success" | "failed" | null; url: string | null };

export type UpdateAppointmentResult =
  | { status: "updated" | "unchanged"; meet: MeetInfo }
  | { status: "conflict_resolved"; conflicts: Array<{ field: string }>; meet: MeetInfo }
  | { status: "cancelled_in_google" }
  | { status: "needs_attention" }
  | { status: "failed"; code: string }
  | { status: "uncertain"; intentId: string };

export type CancelAppointmentResult =
  | { status: "cancelled" | "already_gone" }
  | { status: "kept_google_event" }
  | { status: "failed"; code: string }
  | { status: "uncertain"; intentId: string };

// ---------------------------------------------------------------------
// Auxiliares puras
// ---------------------------------------------------------------------

function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

function meetOf(event: CalendarEvent): MeetInfo {
  const entry = event.conferenceData?.entryPoints?.[0];
  if (entry) return { status: "success", url: entry.uri };
  const request = event.conferenceData?.createRequest;
  if (request?.status === "pending") return { status: "pending", url: null };
  if (request?.status === "failure") return { status: "failed", url: null };
  return { status: null, url: null };
}

function stateOfEvent(event: CalendarEvent): SyncState {
  return {
    title: event.summary ?? null,
    start: event.start?.dateTime ?? null,
    end: event.end?.dateTime ?? null,
    cancelled: event.status === "cancelled",
    hasMeet: meetOf(event).status !== null,
  };
}

function stateOfBase(link: LinkRecord): SyncState {
  return {
    title: link.baseTitle,
    start: link.baseStart,
    end: link.baseEnd,
    cancelled: link.baseCancelled,
    hasMeet: link.baseHasMeet,
  };
}

function linkStateFrom(
  event: CalendarEvent,
  extra: { durationMinutes: number; crmVersion: number | null; linkStatus: LinkState["linkStatus"]; meetRequestId?: string | null },
): LinkState {
  const meet = meetOf(event);
  return {
    eventId: event.id,
    etag: event.etag,
    title: event.summary ?? null,
    start: event.start?.dateTime ?? null,
    end: event.end?.dateTime ?? null,
    cancelled: event.status === "cancelled",
    hasMeet: meet.status !== null,
    meetStatus: meet.status ?? undefined,
    meetUrl: meet.url,
    meetRequestId: extra.meetRequestId ?? null,
    durationMinutes: extra.durationMinutes,
    crmVersion: extra.crmVersion,
    linkStatus: extra.linkStatus,
  };
}

function httpStatus(error: unknown): number | null {
  return error instanceof ProviderHttpError ? error.status : null;
}

function isUncertain(error: unknown): boolean {
  return error instanceof ProviderUncertainError;
}

function assertAppointment(activity: ActivitySnapshot): void {
  if (activity.type !== "meeting" || !activity.hasTime) throw new CalendarSyncError("activity_not_appointment");
}

function assertConnectionEnvironment(deps: SyncDeps, conn: ConnectionContext): void {
  // Antes de QUALQUER chamada ao Google: a conexão tem de ser do ambiente
  // que está operando.
  if (conn.environment !== deps.environment) throw new CalendarSyncError("calendar_environment_mismatch");
}

function assertLinkEnvironment(deps: SyncDeps, link: LinkRecord): void {
  if (link.environment !== deps.environment) throw new CalendarSyncError("calendar_environment_mismatch");
}

function validateDuration(minutes: number): void {
  if (!Number.isInteger(minutes) || minutes < MIN_DURATION || minutes > MAX_DURATION) {
    throw new CalendarSyncError("invalid_duration");
  }
}

function markerMatches(event: CalendarEvent, activityId: string, environment: string): boolean {
  const marker = event.extendedProperties?.private;
  return marker?.crmAppointment === activityId && marker?.crmEnv === environment;
}

// ---------------------------------------------------------------------
// Disponibilidade
// ---------------------------------------------------------------------

/** Intervalos ocupados da agenda escolhida — sem título nem detalhe, nada é
 * guardado. */
export async function getAvailability(
  deps: SyncDeps,
  conn: ConnectionContext,
  range: { from: string; to: string },
): Promise<Array<{ start: string; end: string }>> {
  assertConnectionEnvironment(deps, conn);
  return deps.api.freeBusy(conn.accessToken, [conn.calendarId], range.from, range.to);
}

export function isSlotFree(busy: Array<{ start: string; end: string }>, start: string, end: string): boolean {
  const s = Date.parse(start);
  const e = Date.parse(end);
  return !busy.some((b) => Date.parse(b.end) > s && Date.parse(b.start) < e);
}

// ---------------------------------------------------------------------
// Meet (acompanhamento do pedido assíncrono)
// ---------------------------------------------------------------------

async function settleMeet(
  deps: SyncDeps,
  conn: ConnectionContext,
  event: CalendarEvent,
): Promise<CalendarEvent> {
  let current = event;
  for (let i = 0; i < MEET_POLL_ATTEMPTS && meetOf(current).status === "pending"; i++) {
    const fresh = await deps.api.getEvent(conn.accessToken, conn.calendarId, current.id);
    if (!fresh) break;
    current = fresh;
  }
  return current;
}

// ---------------------------------------------------------------------
// Criar
// ---------------------------------------------------------------------

export type CreateOptions = {
  durationMinutes?: number;
  withMeet?: boolean;
  /** Convidados: nenhum por padrão. Só são enviados com `confirmed: true`. */
  invite?: { emails: string[]; confirmed: boolean };
  /** Consulta o freebusy antes e não cria se o horário estiver ocupado. */
  requireFree?: boolean;
};

export async function createAppointment(
  deps: SyncDeps,
  conn: ConnectionContext,
  activity: ActivitySnapshot,
  options: CreateOptions = {},
): Promise<CreateAppointmentResult> {
  assertConnectionEnvironment(deps, conn);
  assertAppointment(activity);

  const durationMinutes = options.durationMinutes ?? DEFAULT_DURATION;
  validateDuration(durationMinutes);

  const invitees = options.invite?.emails ?? [];
  if (invitees.length > 0 && options.invite?.confirmed !== true) {
    throw new CalendarSyncError("invites_require_confirmation");
  }

  // Já vinculado: nada a criar (e, se o vínculo é de outro ambiente, recusa
  // antes de qualquer chamada).
  const existingLink = await deps.store.getLink(activity.id);
  if (existingLink) {
    assertLinkEnvironment(deps, existingLink);
    return { status: "already_linked", link: existingLink };
  }

  const start = new Date(activity.dueAt).toISOString();
  const end = addMinutes(start, durationMinutes);

  if (options.requireFree) {
    const busy = await deps.api.freeBusy(conn.accessToken, [conn.calendarId], start, end);
    if (!isSlotFree(busy, start, end)) return { status: "busy", busy };
  }

  const eventId = deterministicEventId(deps.environment, activity.id, 1);
  const withMeet = options.withMeet === true;
  const requestId = meetRequestId(eventId);

  const intentId = await deps.store.beginEffect({
    connectionId: conn.connectionId,
    activityId: activity.id,
    operation: "create",
    expected: { title: activity.title, start, end, meet: withMeet },
  });

  const input: EventInput = {
    id: eventId,
    summary: activity.title,
    start: { dateTime: start },
    end: { dateTime: end },
    extendedProperties: { private: { crmAppointment: activity.id, crmEnv: deps.environment } },
    ...(withMeet ? { conferenceData: { createRequest: { requestId, status: "pending" as const } } } : {}),
    ...(invitees.length > 0 ? { attendees: invitees.map((email) => ({ email })) } : {}),
  };
  const insertOpts = {
    conferenceDataVersion: withMeet ? (1 as const) : undefined,
    sendUpdates: invitees.length > 0 ? ("all" as const) : ("none" as const),
  };

  const adoptExisting = async (): Promise<{ event: CalendarEvent } | { code: string }> => {
    const found = await deps.api.getEvent(conn.accessToken, conn.calendarId, eventId);
    if (!found) return { code: "provider_409" };
    // `409` NÃO é sucesso por si só: só vale se o evento existente é, de
    // fato, o compromisso esperado.
    if (!markerMatches(found, activity.id, deps.environment)) return { code: "id_conflict" };
    if (found.status === "cancelled") return { code: "event_cancelled_exists" };
    return { event: found };
  };

  const fail = async (code: string): Promise<CreateAppointmentResult> => {
    await deps.store.resolveEffect({ intentId, status: "failed", errorCode: code });
    return { status: "failed", code };
  };
  const uncertain = async (): Promise<CreateAppointmentResult> => {
    await deps.store.resolveEffect({ intentId, status: "uncertain", errorCode: "result_uncertain" });
    return { status: "uncertain", intentId };
  };

  let event: CalendarEvent;
  let adopted = false;

  try {
    event = await deps.api.insertEvent(conn.accessToken, conn.calendarId, input, insertOpts);
  } catch (error) {
    try {
      if (httpStatus(error) === 409) {
        const result = await adoptExisting();
        if ("code" in result) return fail(result.code);
        event = result.event;
        adopted = true;
      } else if (isUncertain(error)) {
        // Resultado desconhecido: consulta o estado ANTES de qualquer repetição.
        const found = await deps.api.getEvent(conn.accessToken, conn.calendarId, eventId);
        if (found) {
          if (!markerMatches(found, activity.id, deps.environment)) return fail("id_conflict");
          if (found.status === "cancelled") return fail("event_cancelled_exists");
          event = found;
          adopted = true;
        } else {
          // Comprovadamente não existe: uma única nova tentativa.
          try {
            event = await deps.api.insertEvent(conn.accessToken, conn.calendarId, input, insertOpts);
          } catch (second) {
            if (httpStatus(second) === 409) {
              const result = await adoptExisting();
              if ("code" in result) return fail(result.code);
              event = result.event;
              adopted = true;
            } else if (isUncertain(second)) {
              return uncertain();
            } else if (second instanceof ProviderHttpError) {
              return fail(`provider_${second.status}`);
            } else {
              throw second;
            }
          }
        }
      } else if (error instanceof ProviderHttpError) {
        return fail(`provider_${error.status}`);
      } else {
        throw error;
      }
    } catch (recoveryError) {
      // A própria consulta de recuperação falhou: resultado segue incerto,
      // sem repetir nada.
      if (isUncertain(recoveryError) || recoveryError instanceof ProviderHttpError) return uncertain();
      throw recoveryError;
    }
  }

  if (withMeet) event = await settleMeet(deps, conn, event);

  const linkId = await deps.store.resolveEffect({
    intentId,
    status: "succeeded",
    state: linkStateFrom(event, {
      durationMinutes,
      crmVersion: activity.lockVersion,
      linkStatus: "linked",
      meetRequestId: withMeet ? requestId : null,
    }),
  });

  return { status: "created", linkId, eventId: event.id, adopted, meet: meetOf(event) };
}

// ---------------------------------------------------------------------
// Atualizar (reagendar/título/Meet) com base, If-Match e releitura
// ---------------------------------------------------------------------

type UpdateKind = "update" | "meet";

async function pushUpdate(
  deps: SyncDeps,
  conn: ConnectionContext,
  activity: ActivitySnapshot,
  wanted: Wanted,
  kind: UpdateKind,
  durationMinutes: number | null,
): Promise<UpdateAppointmentResult> {
  assertConnectionEnvironment(deps, conn);

  const link = await deps.store.getLink(activity.id);
  if (!link) throw new CalendarSyncError("not_linked");
  assertLinkEnvironment(deps, link);
  if (link.status === "cancelled_in_google" || link.status === "missing_in_google") {
    return { status: "cancelled_in_google" };
  }

  const duration = durationMinutes ?? link.durationMinutes;
  const base = stateOfBase(link);

  const intentId = await deps.store.beginEffect({
    connectionId: conn.connectionId,
    activityId: activity.id,
    operation: kind,
    expected: { title: wanted.title ?? null, schedule: wanted.schedule ?? null, meet: wanted.meet ?? false },
  });

  const finish = async (status: "failed" | "uncertain", code: string) => {
    await deps.store.resolveEffect({ intentId, status, errorCode: code });
  };

  for (let attempt = 1; attempt <= MAX_CONCURRENCY_ATTEMPTS; attempt++) {
    let google: CalendarEvent | null;
    try {
      google = await deps.api.getEvent(conn.accessToken, conn.calendarId, link.eventId);
    } catch (error) {
      if (isUncertain(error) || error instanceof ProviderHttpError) {
        await finish("uncertain", "result_uncertain");
        return { status: "uncertain", intentId };
      }
      throw error;
    }

    // Evento apagado no Google: cancelado lá. A edição do CRM vira conflito
    // registrado, nunca descartada em silêncio.
    if (!google || google.status === "cancelled") {
      const crmEdited = wanted.title !== undefined || wanted.schedule !== undefined;
      if (crmEdited) {
        await deps.store.recordConflict({
          linkId: link.id,
          field: "cancellation",
          crmValue: { title: wanted.title ?? null, schedule: wanted.schedule ?? null },
          googleValue: { cancelled: true },
          resolution: "google_prevails",
        });
      }
      await deps.store.resolveEffect({
        intentId,
        status: "succeeded",
        state: {
          ...stateFromLink(link, duration, activity.lockVersion),
          cancelled: true,
          etag: google?.etag ?? link.baseEtag,
          linkStatus: "cancelled_in_google",
        },
      });
      return { status: "cancelled_in_google" };
    }

    const plan = mergeFields(base, wanted, stateOfEvent(google));

    // Conflito: o Google prevalece e o CRM converge, mas o valor do CRM é
    // GRAVADO antes de ser sobrescrito.
    for (const conflict of plan.conflicts) {
      await deps.store.recordConflict({
        linkId: link.id,
        field: conflict.field as "title" | "schedule" | "cancellation" | "meet",
        crmValue: conflict.crmValue,
        googleValue: conflict.googleValue,
        resolution: "google_prevails",
      });
    }
    const googleWins = plan.conflicts.filter((c) => c.field === "title" || c.field === "schedule");
    if (googleWins.length > 0) {
      await deps.store.applyGoogleToActivity({
        activityId: activity.id,
        title: googleWins.some((c) => c.field === "title") ? (google.summary ?? undefined) : undefined,
        dueAt: googleWins.some((c) => c.field === "schedule") ? google.start?.dateTime : undefined,
      });
    }

    const patch: EventInput = {};
    if (plan.push.title !== undefined) patch.summary = plan.push.title;
    if (plan.push.schedule !== undefined) {
      patch.start = { dateTime: plan.push.schedule.start };
      patch.end = { dateTime: plan.push.schedule.end };
    }
    const requestId = meetRequestId(link.eventId, attempt);
    if (plan.push.meet) patch.conferenceData = { createRequest: { requestId, status: "pending" } };

    let latest: CalendarEvent = google;
    if (Object.keys(patch).length > 0) {
      const outcome = await patchWithRecovery(deps, conn, google, patch, plan.push);
      if (outcome.kind === "precondition") continue; // relê e refaz a comparação
      if (outcome.kind === "gone") continue; // o próximo ciclo trata como cancelado
      if (outcome.kind === "uncertain") {
        await finish("uncertain", "result_uncertain");
        return { status: "uncertain", intentId };
      }
      if (outcome.kind === "failed") {
        await finish("failed", outcome.code);
        return { status: "failed", code: outcome.code };
      }
      latest = outcome.event;
    }

    if (plan.push.meet) latest = await settleMeet(deps, conn, latest);

    // A base avança SÓ nos campos reconciliados; o que mudou apenas no Google
    // fica para a sincronização de entrada, em vez de ser engolido aqui.
    const next = nextBase(base, stateOfEvent(latest), plan.reconciled);
    const meet = meetOf(latest);
    await deps.store.resolveEffect({
      intentId,
      status: "succeeded",
      state: {
        eventId: link.eventId,
        etag: latest.etag,
        title: next.title,
        start: next.start,
        end: next.end,
        cancelled: next.cancelled,
        hasMeet: next.hasMeet,
        meetStatus: meet.status ?? undefined,
        meetUrl: meet.url,
        meetRequestId: plan.push.meet ? requestId : link.meetRequestId,
        durationMinutes: duration,
        crmVersion: activity.lockVersion,
        linkStatus: "linked",
      },
    });

    if (plan.conflicts.length > 0) {
      return { status: "conflict_resolved", conflicts: plan.conflicts.map((c) => ({ field: c.field })), meet };
    }
    return { status: Object.keys(patch).length > 0 ? "updated" : "unchanged", meet };
  }

  // Muita disputa: não insiste. Fica sinalizado para atenção, com registro.
  await deps.store.recordConflict({
    linkId: link.id,
    field: wanted.schedule ? "schedule" : wanted.title !== undefined ? "title" : "meet",
    crmValue: { title: wanted.title ?? null, schedule: wanted.schedule ?? null },
    googleValue: null,
    resolution: "needs_attention",
  });
  await finish("failed", "precondition_failed_exhausted");
  return { status: "needs_attention" };
}

function stateFromLink(link: LinkRecord, durationMinutes: number, crmVersion: number): LinkState {
  return {
    eventId: link.eventId,
    etag: link.baseEtag,
    title: link.baseTitle,
    start: link.baseStart,
    end: link.baseEnd,
    cancelled: link.baseCancelled,
    hasMeet: link.baseHasMeet,
    meetStatus: link.meetStatus ?? undefined,
    meetUrl: link.meetUrl,
    meetRequestId: link.meetRequestId,
    durationMinutes,
    crmVersion,
    linkStatus: link.status,
  };
}

function nextBase(base: SyncState, google: SyncState, reconciled: string[]): SyncState {
  return {
    title: reconciled.includes("title") ? google.title : base.title,
    start: reconciled.includes("schedule") ? google.start : base.start,
    end: reconciled.includes("schedule") ? google.end : base.end,
    cancelled: reconciled.includes("cancellation") ? google.cancelled : base.cancelled,
    hasMeet: reconciled.includes("meet") ? google.hasMeet : base.hasMeet,
  };
}

type PatchOutcome =
  | { kind: "ok"; event: CalendarEvent }
  | { kind: "precondition" }
  | { kind: "gone" }
  | { kind: "uncertain" }
  | { kind: "failed"; code: string };

/** Confere se o evento já reflete o que se queria enviar. */
function reflects(event: CalendarEvent, pushed: Wanted): boolean {
  if (pushed.title !== undefined && event.summary !== pushed.title) return false;
  if (pushed.schedule !== undefined) {
    if (event.start?.dateTime === undefined || event.end?.dateTime === undefined) return false;
    if (Date.parse(event.start.dateTime) !== Date.parse(pushed.schedule.start)) return false;
    if (Date.parse(event.end.dateTime) !== Date.parse(pushed.schedule.end)) return false;
  }
  if (pushed.meet && meetOf(event).status === null) return false;
  return true;
}

async function patchWithRecovery(
  deps: SyncDeps,
  conn: ConnectionContext,
  google: CalendarEvent,
  patch: EventInput,
  pushed: Wanted,
): Promise<PatchOutcome> {
  const opts = {
    ifMatch: google.etag,
    conferenceDataVersion: pushed.meet ? (1 as const) : undefined,
    sendUpdates: "none" as const,
  };
  try {
    const event = await deps.api.patchEvent(conn.accessToken, conn.calendarId, google.id, patch, opts);
    return { kind: "ok", event };
  } catch (error) {
    const status = httpStatus(error);
    if (status === 412) return { kind: "precondition" };
    if (status === 404) return { kind: "gone" };
    if (!isUncertain(error)) {
      if (error instanceof ProviderHttpError) return { kind: "failed", code: `provider_${error.status}` };
      throw error;
    }
  }

  // Resultado incerto: consulta o estado, nunca repete às cegas.
  try {
    const now = await deps.api.getEvent(conn.accessToken, conn.calendarId, google.id);
    if (!now || now.status === "cancelled") return { kind: "gone" };
    if (now.etag !== google.etag) {
      // Algo mudou: ou foi a nossa escrita (reflete o pretendido) ou outra.
      return reflects(now, pushed) ? { kind: "ok", event: now } : { kind: "precondition" };
    }
    // Intacto: a escrita não chegou. Uma única nova tentativa.
    const event = await deps.api.patchEvent(conn.accessToken, conn.calendarId, google.id, patch, opts);
    return { kind: "ok", event };
  } catch (error) {
    const status = httpStatus(error);
    if (status === 412) return { kind: "precondition" };
    if (status === 404) return { kind: "gone" };
    return { kind: "uncertain" };
  }
}

/** Reagenda e/ou renomeia o evento a partir da atividade como está no CRM. */
export async function rescheduleAppointment(
  deps: SyncDeps,
  conn: ConnectionContext,
  activity: ActivitySnapshot,
  options: { durationMinutes?: number } = {},
): Promise<UpdateAppointmentResult> {
  assertAppointment(activity);
  if (options.durationMinutes !== undefined) validateDuration(options.durationMinutes);

  const link = await deps.store.getLink(activity.id);
  if (!link) throw new CalendarSyncError("not_linked");
  const duration = options.durationMinutes ?? link.durationMinutes;

  const start = new Date(activity.dueAt).toISOString();
  const wanted: Wanted = {
    title: activity.title,
    schedule: { start, end: addMinutes(start, duration) },
  };
  return pushUpdate(deps, conn, activity, wanted, "update", options.durationMinutes ?? null);
}

/** Adiciona Meet a um compromisso já vinculado (opcional, por pedido). */
export async function addMeetToAppointment(
  deps: SyncDeps,
  conn: ConnectionContext,
  activity: ActivitySnapshot,
): Promise<UpdateAppointmentResult> {
  return pushUpdate(deps, conn, activity, { meet: true }, "meet", null);
}

// ---------------------------------------------------------------------
// Cancelar
// ---------------------------------------------------------------------

/**
 * Cancela o evento do compromisso. Só apaga se o evento está como o CRM o
 * deixou (base) — se foi editado no Google, o evento é MANTIDO, o vínculo é
 * desfeito e o conflito fica registrado (§6.4).
 */
export async function cancelAppointment(
  deps: SyncDeps,
  conn: ConnectionContext,
  activity: ActivitySnapshot,
): Promise<CancelAppointmentResult> {
  assertConnectionEnvironment(deps, conn);

  const link = await deps.store.getLink(activity.id);
  if (!link) throw new CalendarSyncError("not_linked");
  assertLinkEnvironment(deps, link);

  const base = stateOfBase(link);
  const intentId = await deps.store.beginEffect({
    connectionId: conn.connectionId,
    activityId: activity.id,
    operation: "delete",
    expected: { cancel: true },
  });

  const closed = (event: CalendarEvent | null, linkStatus: LinkState["linkStatus"]): LinkState => ({
    ...stateFromLink(link, link.durationMinutes, activity.lockVersion),
    etag: event?.etag ?? link.baseEtag,
    cancelled: true,
    linkStatus,
  });

  for (let attempt = 1; attempt <= MAX_CONCURRENCY_ATTEMPTS; attempt++) {
    let google: CalendarEvent | null;
    try {
      google = await deps.api.getEvent(conn.accessToken, conn.calendarId, link.eventId);
    } catch (error) {
      if (isUncertain(error) || error instanceof ProviderHttpError) {
        await deps.store.resolveEffect({ intentId, status: "uncertain", errorCode: "result_uncertain" });
        return { status: "uncertain", intentId };
      }
      throw error;
    }

    if (!google || google.status === "cancelled") {
      await deps.store.resolveEffect({ intentId, status: "succeeded", state: closed(google, "unlinked") });
      return { status: "already_gone" };
    }

    const current = stateOfEvent(google);
    if (googleChangedSinceBase(base, current)) {
      // Editado no Google desde a última sincronização: não se apaga. O
      // evento fica, o vínculo é desfeito e o conflito é gravado.
      await deps.store.recordConflict({
        linkId: link.id,
        field: "cancellation",
        crmValue: { cancelled: true },
        googleValue: { title: current.title, start: current.start, end: current.end },
        resolution: "kept_google_event",
      });
      await deps.store.resolveEffect({
        intentId,
        status: "succeeded",
        state: { ...stateFromLink(link, link.durationMinutes, activity.lockVersion), etag: google.etag, linkStatus: "unlinked" },
      });
      return { status: "kept_google_event" };
    }

    try {
      await deps.api.deleteEvent(conn.accessToken, conn.calendarId, google.id, { ifMatch: google.etag, sendUpdates: "none" });
      await deps.store.resolveEffect({ intentId, status: "succeeded", state: closed(google, "unlinked") });
      return { status: "cancelled" };
    } catch (error) {
      const status = httpStatus(error);
      if (status === 412) continue; // mudou entre a leitura e a escrita: relê
      if (status === 404) {
        await deps.store.resolveEffect({ intentId, status: "succeeded", state: closed(google, "unlinked") });
        return { status: "already_gone" };
      }
      if (!isUncertain(error)) {
        if (error instanceof ProviderHttpError) {
          await deps.store.resolveEffect({ intentId, status: "failed", errorCode: `provider_${error.status}` });
          return { status: "failed", code: `provider_${error.status}` };
        }
        throw error;
      }
    }

    // Resultado incerto: consulta antes de qualquer repetição.
    try {
      const now = await deps.api.getEvent(conn.accessToken, conn.calendarId, google.id);
      if (!now || now.status === "cancelled") {
        await deps.store.resolveEffect({ intentId, status: "succeeded", state: closed(now, "unlinked") });
        return { status: "cancelled" };
      }
      if (now.etag === google.etag) {
        await deps.api.deleteEvent(conn.accessToken, conn.calendarId, google.id, { ifMatch: now.etag, sendUpdates: "none" });
        await deps.store.resolveEffect({ intentId, status: "succeeded", state: closed(now, "unlinked") });
        return { status: "cancelled" };
      }
      // Mudou: volta ao topo e reavalia (pode ter sido editado no Google).
    } catch (error) {
      if (httpStatus(error) === 412) continue;
      await deps.store.resolveEffect({ intentId, status: "uncertain", errorCode: "result_uncertain" });
      return { status: "uncertain", intentId };
    }
  }

  await deps.store.recordConflict({
    linkId: link.id,
    field: "cancellation",
    crmValue: { cancelled: true },
    googleValue: null,
    resolution: "needs_attention",
  });
  await deps.store.resolveEffect({ intentId, status: "failed", errorCode: "precondition_failed_exhausted" });
  return { status: "failed", code: "precondition_failed_exhausted" };
}
