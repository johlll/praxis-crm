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
  | { status: "access_lost" }
  /** Temporário (o Google não respondeu ou recusou por ora): vale tentar de novo. */
  | { status: "pending"; code: string }
  /** Recusa definitiva do Google. */
  | { status: "failed"; code: string }
  /** Não se sabe se o Google aplicou: consultar antes de repetir. */
  | { status: "uncertain"; intentId: string };

export type CancelAppointmentResult =
  | { status: "cancelled" | "already_gone" }
  /** Editado no Google desde a última sincronização: NÃO apagado e NÃO desvinculado. */
  | { status: "kept_google_event" }
  | { status: "access_lost" }
  | { status: "pending"; code: string }
  | { status: "failed"; code: string }
  | { status: "uncertain"; intentId: string };

export type RecoverCreateResult =
  /** O evento existia no Google: foi adotado (nada foi criado de novo). */
  | { status: "adopted"; meet: MeetInfo }
  /** Confirmado que o evento NÃO existe: nada foi criado agora. */
  | { status: "not_created" }
  | { status: "already_linked" }
  | { status: "access_lost" }
  | { status: "failed"; code: string }
  | { status: "uncertain"; intentId: string };

// ---------------------------------------------------------------------
// Auxiliares puras
// ---------------------------------------------------------------------

function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

/** Duração do evento no Google em minutos; `null` se não tem início e fim com hora. */
function durationOf(event: { start?: { dateTime?: string | undefined } | undefined; end?: { dateTime?: string | undefined } | undefined }): number | null {
  const start = event.start?.dateTime;
  const end = event.end?.dateTime;
  if (!start || !end) return null;
  const minutes = Math.round((Date.parse(end) - Date.parse(start)) / 60_000);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
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
    meetStatus: meet.status,
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

/** Erro temporário (vale tentar de novo depois) × recusa definitiva do Google. */
function isRetryableCode(code: string): boolean {
  return /^provider_(429|5\d\d)$/.test(code) || code.startsWith("provider_read") || code === "precondition_failed_exhausted";
}

/** Falha ao LER o Google: nenhuma escrita foi tentada, então não é incerto. */
function readFailureCode(error: unknown): string {
  return error instanceof ProviderHttpError ? `provider_read_${error.status}` : "provider_read_timeout";
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

/**
 * O vínculo manda: o compromisso só é operado pela conexão que o criou, e na
 * agenda em que nasceu. Conferido ANTES de qualquer chamada ao Google —
 * procurar o evento numa agenda que não é a dele devolveria "não existe", o
 * que seria lido como evento apagado.
 */
function operatingConnection(link: LinkRecord, selected: ConnectionContext): ConnectionContext {
  if (link.connectionId !== selected.connectionId) throw new CalendarSyncError("link_connection_mismatch");
  // Trocar a agenda selecionada afeta só compromissos NOVOS: o existente
  // continua na agenda em que nasceu, pela mesma conexão autorizada.
  return link.calendarId === selected.calendarId ? selected : { ...selected, calendarId: link.calendarId };
}

/** 401/403: o acesso à agenda foi perdido — não é evento apagado. */
function isAccessDenied(error: unknown): boolean {
  const status = httpStatus(error);
  return status === 401 || status === 403;
}

/** A agenda do vínculo ainda é acessível? `null` = não foi possível saber. */
async function calendarReachable(deps: SyncDeps, conn: ConnectionContext): Promise<boolean | null> {
  try {
    return await deps.api.calendarAccessible(conn.accessToken, conn.calendarId);
  } catch (error) {
    if (isAccessDenied(error)) return false;
    return null;
  }
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

type UpdateRequest = {
  kind: UpdateKind;
  /** Duração pedida explicitamente. Sem ela, vale a que o evento tem no Google. */
  explicitDuration: number | null;
  /** O que o CRM quer, a partir da atividade ATUAL (relida se mudou). */
  want: (activity: ActivitySnapshot, durationMinutes: number) => Wanted;
};

async function pushUpdate(
  deps: SyncDeps,
  selected: ConnectionContext,
  initial: ActivitySnapshot,
  req: UpdateRequest,
): Promise<UpdateAppointmentResult> {
  assertConnectionEnvironment(deps, selected);

  const link = await deps.store.getLink(initial.id);
  if (!link) throw new CalendarSyncError("not_linked");
  assertLinkEnvironment(deps, link);
  const conn = operatingConnection(link, selected); // antes da intenção e de qualquer chamada externa
  if (link.status === "cancelled_in_google" || link.status === "missing_in_google") {
    return { status: "cancelled_in_google" };
  }

  const base = stateOfBase(link);
  let activity = initial;

  const expected = req.want(activity, req.explicitDuration ?? link.durationMinutes);
  const intentId = await deps.store.beginEffect({
    connectionId: conn.connectionId,
    activityId: activity.id,
    operation: req.kind,
    expected: { title: expected.title ?? null, schedule: expected.schedule ?? null, meet: expected.meet ?? false },
  });

  const finish = async (status: "failed" | "uncertain", code: string) => {
    await deps.store.resolveEffect({
      intentId,
      status,
      errorCode: code,
      ...(status === "failed" ? { syncState: isRetryableCode(code) ? ("pending" as const) : ("failed" as const) } : {}),
    });
  };
  const failure = async (code: string): Promise<UpdateAppointmentResult> => {
    await finish("failed", code);
    return isRetryableCode(code) ? { status: "pending", code } : { status: "failed", code };
  };
  // Perda de acesso: pendência EXPLÍCITA no vínculo, nunca "evento apagado".
  const accessLost = async (): Promise<UpdateAppointmentResult> => {
    await deps.store.resolveEffect({
      intentId,
      status: "failed",
      errorCode: "calendar_access_lost",
      state: { ...stateFromLink(link, link.durationMinutes, activity.lockVersion), linkStatus: "needs_attention" },
      // Recuperável: com o acesso de volta, a próxima sincronização resolve.
      syncState: "pending",
    });
    return { status: "access_lost" };
  };

  for (let attempt = 1; attempt <= MAX_CONCURRENCY_ATTEMPTS; attempt++) {
    let google: CalendarEvent | null;
    try {
      google = await deps.api.getEvent(conn.accessToken, conn.calendarId, link.eventId);
    } catch (error) {
      if (isAccessDenied(error)) return accessLost();
      // Falha de LEITURA: nada foi escrito nesta tentativa — pendente, não incerto.
      if (isUncertain(error) || error instanceof ProviderHttpError) return failure(readFailureCode(error));
      throw error;
    }
    if (google === null) {
      // "Não existe" pode ser evento apagado OU agenda que deixou de ser
      // acessível: só o primeiro caso é cancelamento.
      const reachable = await calendarReachable(deps, conn);
      if (reachable === null) return failure("provider_read_calendar");
      if (!reachable) return accessLost();
    }

    // Sem duração pedida, o evento mantém a que tem no Google: o CRM só conhece
    // o início, então reagendar não pode encurtar nem alongar o evento.
    const googleDuration = req.explicitDuration === null && google ? durationOf(google) : null;
    const duration = req.explicitDuration ?? googleDuration ?? link.durationMinutes;
    const wanted = req.want(activity, duration);

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
          ...stateFromLink(link, req.explicitDuration ?? link.durationMinutes, activity.lockVersion),
          cancelled: true,
          etag: google?.etag ?? link.baseEtag,
          linkStatus: "cancelled_in_google",
        },
      });
      return { status: "cancelled_in_google" };
    }

    // Sem duração pedida, o horário é comparado pelo INÍCIO: uma mudança só de
    // duração no Google não conflita com o CRM remarcar.
    const baseForMerge: SyncState =
      googleDuration !== null && base.start !== null ? { ...base, end: addMinutes(base.start, googleDuration) } : base;
    const plan = mergeFields(baseForMerge, wanted, stateOfEvent(google));

    // Conflito: o Google prevalece e o CRM converge. O valor do CRM é gravado
    // na MESMA transação em que o do Google é aplicado, e só se a atividade
    // ainda está na versão lida.
    const googleWins = plan.conflicts.filter((c) => c.field === "title" || c.field === "schedule");
    const titleWins = googleWins.some((c) => c.field === "title");
    const scheduleWins = googleWins.some((c) => c.field === "schedule");
    if (googleWins.length > 0) {
      const applied = await deps.store.applyGoogleToActivity({
        activityId: activity.id,
        expectedVersion: activity.lockVersion,
        title: titleWins ? (google.summary ?? undefined) : undefined,
        dueAt: scheduleWins ? google.start?.dateTime : undefined,
        conflicts: googleWins.map((c) => ({
          field: c.field as "title" | "schedule",
          // O que o CRM tem é o início; o fim registrado usa a duração que o
          // próprio CRM conhece, não a do Google.
          crmValue:
            c.field === "schedule" && wanted.schedule
              ? { start: wanted.schedule.start, end: addMinutes(wanted.schedule.start, req.explicitDuration ?? link.durationMinutes) }
              : c.crmValue,
          googleValue: c.googleValue,
        })),
      });
      if (applied === null) {
        // O CRM foi editado depois da leitura: nada foi sobrescrito. Relê a
        // atividade e reavalia tudo (inclusive o conflito) com o que ela tem agora.
        const fresh = await deps.loadActivity(activity.id);
        if (!fresh) throw new CalendarSyncError("activity_not_found");
        if (req.kind === "update") assertAppointment(fresh);
        activity = fresh;
        continue;
      }
      activity = {
        ...activity,
        title: titleWins ? (google.summary ?? activity.title) : activity.title,
        dueAt: scheduleWins ? (google.start?.dateTime ?? activity.dueAt) : activity.dueAt,
        lockVersion: applied,
      };
    }
    for (const conflict of plan.conflicts.filter((c) => c.field !== "title" && c.field !== "schedule")) {
      await deps.store.recordConflict({
        linkId: link.id,
        field: conflict.field,
        crmValue: conflict.crmValue,
        googleValue: conflict.googleValue,
        resolution: "google_prevails",
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
      if (outcome.kind === "denied") return accessLost();
      if (outcome.kind === "uncertain") {
        await finish("uncertain", "result_uncertain");
        return { status: "uncertain", intentId };
      }
      if (outcome.kind === "failed") return failure(outcome.code);
      latest = outcome.event;
    }

    if (plan.push.meet) latest = await settleMeet(deps, conn, latest);

    // A base avança SÓ nos campos reconciliados; o que mudou apenas no Google
    // fica para a sincronização de entrada, em vez de ser engolido aqui.
    const next = nextBase(base, stateOfEvent(latest), plan.reconciled);
    const meet = meetOf(latest);
    // Horário reconciliado: a duração do vínculo é a do evento que ficou (a do
    // Google, se ele venceu), para início, fim e duração permanecerem coerentes.
    const settledDuration = plan.reconciled.includes("schedule") ? durationOf(latest) : null;
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
        // Explícitos: `null` grava "sem Meet" quando o Google o removeu.
        meetStatus: meet.status,
        meetUrl: meet.url,
        meetRequestId: plan.push.meet ? requestId : link.meetRequestId,
        // Duração REAL do evento, mesmo fora de 15–480 (esse intervalo vale só
        // para o que o usuário digita, não para o que o Google já tem).
        durationMinutes: settledDuration ?? req.explicitDuration ?? link.durationMinutes,
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
  const last = req.want(activity, req.explicitDuration ?? link.durationMinutes);
  await deps.store.recordConflict({
    linkId: link.id,
    field: last.schedule ? "schedule" : last.title !== undefined ? "title" : "meet",
    crmValue: { title: last.title ?? null, schedule: last.schedule ?? null },
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
    meetStatus: link.meetStatus,
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
  | { kind: "denied" }
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
    if (isAccessDenied(error)) return { kind: "denied" };
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
    if (isAccessDenied(error)) return { kind: "denied" };
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

  return pushUpdate(deps, conn, activity, {
    kind: "update",
    explicitDuration: options.durationMinutes ?? null,
    want: (current, durationMinutes) => {
      const start = new Date(current.dueAt).toISOString();
      return { title: current.title, schedule: { start, end: addMinutes(start, durationMinutes) } };
    },
  });
}

/** Adiciona Meet a um compromisso já vinculado (opcional, por pedido). */
export async function addMeetToAppointment(
  deps: SyncDeps,
  conn: ConnectionContext,
  activity: ActivitySnapshot,
): Promise<UpdateAppointmentResult> {
  return pushUpdate(deps, conn, activity, { kind: "meet", explicitDuration: null, want: () => ({ meet: true }) });
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
  selected: ConnectionContext,
  activity: ActivitySnapshot,
): Promise<CancelAppointmentResult> {
  assertConnectionEnvironment(deps, selected);

  const link = await deps.store.getLink(activity.id);
  if (!link) throw new CalendarSyncError("not_linked");
  assertLinkEnvironment(deps, link);
  const conn = operatingConnection(link, selected); // antes da intenção e de qualquer chamada externa

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

  const accessLost = async (): Promise<CancelAppointmentResult> => {
    await deps.store.resolveEffect({
      intentId,
      status: "failed",
      errorCode: "calendar_access_lost",
      state: { ...stateFromLink(link, link.durationMinutes, activity.lockVersion), linkStatus: "needs_attention" },
      // Recuperável: com o acesso de volta, a próxima sincronização resolve.
      syncState: "pending",
    });
    return { status: "access_lost" };
  };
  const cancelFailure = async (code: string): Promise<CancelAppointmentResult> => {
    const retryable = isRetryableCode(code);
    await deps.store.resolveEffect({ intentId, status: "failed", errorCode: code, syncState: retryable ? "pending" : "failed" });
    return retryable ? { status: "pending", code } : { status: "failed", code };
  };

  for (let attempt = 1; attempt <= MAX_CONCURRENCY_ATTEMPTS; attempt++) {
    let google: CalendarEvent | null;
    try {
      google = await deps.api.getEvent(conn.accessToken, conn.calendarId, link.eventId);
    } catch (error) {
      if (isAccessDenied(error)) return accessLost();
      // Falha de LEITURA antes de apagar: nada foi tentado — pendente, não incerto.
      if (isUncertain(error) || error instanceof ProviderHttpError) return cancelFailure(readFailureCode(error));
      throw error;
    }
    if (google === null) {
      const reachable = await calendarReachable(deps, conn);
      if (reachable === null) return cancelFailure("provider_read_calendar");
      if (!reachable) return accessLost();
    }

    if (!google || google.status === "cancelled") {
      await deps.store.resolveEffect({ intentId, status: "succeeded", state: closed(google, "unlinked") });
      return { status: "already_gone" };
    }

    const current = stateOfEvent(google);
    if (googleChangedSinceBase(base, current)) {
      // Editado no Google desde a última sincronização: não se apaga, e o
      // vínculo NÃO é desfeito (nada fica abandonado no Google). O pedido de
      // cancelar fica gravado como conflito e o vínculo, como falha a resolver.
      await deps.store.recordConflict({
        linkId: link.id,
        field: "cancellation",
        crmValue: { cancelled: true },
        googleValue: { title: current.title, start: current.start, end: current.end },
        resolution: "kept_google_event",
      });
      await deps.store.resolveEffect({ intentId, status: "failed", errorCode: "google_edited_since_sync", syncState: "failed" });
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
      if (isAccessDenied(error)) return accessLost();
      if (!isUncertain(error)) {
        if (error instanceof ProviderHttpError) return cancelFailure(`provider_${error.status}`);
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
  return cancelFailure("precondition_failed_exhausted");
}

// ---------------------------------------------------------------------
// Recuperar uma inclusão com resultado incerto
// ---------------------------------------------------------------------

/**
 * A inclusão no Google ficou incerta (timeout e a conferência também falhou).
 * Aqui só se CONSULTA o Google pelo id determinístico — nunca se cria nada:
 *  - o evento existe e é este compromisso → é adotado (vínculo gravado);
 *  - comprovadamente não existe → diz isso, e o usuário decide criar de novo;
 *  - ainda não dá para saber → continua incerto.
 * Em qualquer desfecho definitivo, a intenção incerta anterior é encerrada.
 */
export async function recoverUncertainCreate(
  deps: SyncDeps,
  conn: ConnectionContext,
  activity: ActivitySnapshot,
): Promise<RecoverCreateResult> {
  assertConnectionEnvironment(deps, conn);

  const existing = await deps.store.getLink(activity.id);
  if (existing) {
    assertLinkEnvironment(deps, existing);
    return { status: "already_linked" };
  }

  const eventId = deterministicEventId(deps.environment, activity.id, 1);
  const intentId = await deps.store.beginEffect({
    connectionId: conn.connectionId,
    activityId: activity.id,
    operation: "create",
    expected: { recover: true },
  });

  const end = async (status: "failed" | "uncertain", code: string) =>
    deps.store.resolveEffect({ intentId, status, errorCode: code });

  let found: CalendarEvent | null;
  try {
    found = await deps.api.getEvent(conn.accessToken, conn.calendarId, eventId);
  } catch (error) {
    if (isAccessDenied(error)) {
      await end("failed", "calendar_access_lost");
      return { status: "access_lost" };
    }
    await end("uncertain", "result_uncertain");
    return { status: "uncertain", intentId };
  }

  if (!found) {
    const reachable = await calendarReachable(deps, conn);
    if (reachable === null) {
      await end("uncertain", "result_uncertain");
      return { status: "uncertain", intentId };
    }
    if (!reachable) {
      await end("failed", "calendar_access_lost");
      return { status: "access_lost" };
    }
    await end("failed", "not_created_confirmed");
    return { status: "not_created" };
  }

  if (!markerMatches(found, activity.id, deps.environment)) {
    await end("failed", "id_conflict");
    return { status: "failed", code: "id_conflict" };
  }
  if (found.status === "cancelled") {
    await end("failed", "event_cancelled_exists");
    return { status: "failed", code: "event_cancelled_exists" };
  }

  await deps.store.resolveEffect({
    intentId,
    status: "succeeded",
    state: linkStateFrom(found, {
      durationMinutes: durationOf(found) ?? DEFAULT_DURATION,
      crmVersion: activity.lockVersion,
      linkStatus: "linked",
      meetRequestId: found.conferenceData?.createRequest?.requestId ?? null,
    }),
  });
  return { status: "adopted", meet: meetOf(found) };
}
