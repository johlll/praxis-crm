import {
  ProviderHttpError,
  ProviderUncertainError,
  type CalendarEvent,
  type EventListItem,
  type EventListQuery,
} from "@/server/calendar/events-api";
import { CalendarSyncError } from "@/server/calendar/sync/types";
import { planInbound, planStatusOnly, type GoogleSnapshot, type InboundPlan } from "@/server/calendar/sync/inbound-plan";
import type { InboundConnection, InboundDeps, InboundLink } from "@/server/calendar/sync/inbound-types";

/**
 * Sincronização Google → CRM de UMA agenda de uma conexão (B2, etapa 3;
 * docs/decisoes/b2-google-agenda.md §6.2):
 *
 *  1. trava: uma execução por (conexão, agenda);
 *  2. lista com o `syncToken` guardado (ou completa, sem ele), página a
 *     página, com `fields` mínimo — eventos de TODA a agenda;
 *  3. cada item é reconhecido pelo vínculo local `(agenda, evento)`. Sem
 *     vínculo: descartado em memória — não é gravado, logado nem contado;
 *  4. só para o evento vinculado busca-se o detalhe (`events.get`: título e
 *     Meet) e aplica-se a regra por campo contra a base, numa transação;
 *  5. o novo `syncToken` só é gravado depois de TODAS as páginas e de todos
 *     os itens vinculados aplicados. Qualquer falha mantém o anterior e a
 *     execução é refeita (o processamento é idempotente);
 *  6. `410`, em qualquer página: o token é descartado e a listagem completa
 *     é refeita — nada do CRM é apagado; vínculo ausente na completa é
 *     confirmado com `get`;
 *  7. toda escrita (descartar o token, aplicar, concluir) leva a trava, e o
 *     banco confere que ela ainda é desta execução NA MESMA operação. Quem
 *     perdeu a trava para no ato, sem gravar nada.
 */

export type SyncOutcome =
  | { status: "synced"; full: boolean; pages: number; applied: number; conflicts: number; notAuthorized: number }
  /** Outra execução detém a trava. */
  | { status: "busy" }
  | { status: "access_lost" }
  | { status: "failed"; code: string };

const MAX_APPLY_ATTEMPTS = 3;

/** Itens por página pedidos ao Google (o máximo que ele aceita é 2500). */
export const LIST_PAGE_SIZE = 250;

class AbortRun extends Error {
  constructor(
    readonly outcome: "failed" | "access_lost",
    readonly code: string,
  ) {
    super(code);
  }
}

const isAccessDenied = (error: unknown) =>
  error instanceof ProviderHttpError && (error.status === 401 || error.status === 403 || error.status === 404);

function failureCode(error: unknown): string {
  if (error instanceof ProviderHttpError) return `provider_${error.status}`;
  if (error instanceof ProviderUncertainError) return "provider_timeout";
  return "sync_error";
}

function snapshotOf(event: CalendarEvent): GoogleSnapshot {
  const entry = event.conferenceData?.entryPoints?.[0];
  const request = event.conferenceData?.createRequest;
  const meetStatus = entry ? "success" : request?.status === "pending" ? "pending" : request?.status === "failure" ? "failed" : null;
  return {
    etag: event.etag,
    cancelled: event.status === "cancelled",
    title: event.summary ?? null,
    start: event.start?.dateTime ?? null,
    end: event.end?.dateTime ?? null,
    hasMeet: meetStatus !== null,
    meetStatus,
    meetUrl: entry?.uri ?? null,
  };
}

/** A marca privada, quando presente, tem de ser DESTE compromisso e ambiente. */
function markerCoherent(item: Pick<EventListItem, "extendedProperties">, link: InboundLink, environment: string): boolean {
  const marker = item.extendedProperties?.private;
  if (!marker || (marker.crmAppointment === undefined && marker.crmEnv === undefined)) return true;
  return marker.crmAppointment === link.activityId && marker.crmEnv === environment;
}

type Counters = { applied: number; conflicts: number; notAuthorized: number };

/** Uma execução: quem roda, com qual trava, e o que já aplicou. */
type Run = { deps: InboundDeps; conn: InboundConnection; leaseId: string; counters: Counters };

const sameInstant = (a: string | null, b: string | null): boolean =>
  a === b || (a !== null && b !== null && Date.parse(a) === Date.parse(b));

/**
 * O item listado é o eco da base? O `etag` igual sozinho NÃO prova que todos
 * os campos foram reconciliados: o que a listagem traz (estado e horário)
 * também tem de bater com a base. O título não vem na listagem; por isso a
 * base só recebe o `etag` de um evento quando TODOS os campos sincronizados
 * conferem com ele (`pushUpdate`, na saída).
 */
function listedMatchesBase(item: EventListItem, link: InboundLink): boolean {
  if (item.etag !== link.baseEtag) return false;
  const cancelled = item.status === "cancelled";
  if (cancelled !== link.baseCancelled) return false;
  if (cancelled) return true;
  return sameInstant(item.start?.dateTime ?? null, link.baseStart) && sameInstant(item.end?.dateTime ?? null, link.baseEnd);
}

/** O plano não muda nada no CRM nem na base: não há o que gravar. */
function planIsNoop(plan: InboundPlan, link: InboundLink): boolean {
  const s = plan.state;
  return (
    plan.title === undefined &&
    plan.dueAt === undefined &&
    plan.conflicts.length === 0 &&
    s.etag === link.baseEtag &&
    s.linkStatus === link.status &&
    s.title === link.baseTitle &&
    sameInstant(s.start, link.baseStart) &&
    sameInstant(s.end, link.baseEnd) &&
    s.cancelled === link.baseCancelled &&
    s.hasMeet === link.baseHasMeet &&
    s.meetStatus === link.meetStatus &&
    s.meetUrl === link.meetUrl &&
    s.durationMinutes === link.durationMinutes
  );
}

export async function syncCalendar(
  deps: InboundDeps,
  conn: InboundConnection,
  opts: { forceFull?: boolean } = {},
): Promise<SyncOutcome> {
  if (conn.environment !== deps.environment) throw new CalendarSyncError("calendar_environment_mismatch");
  const actor = conn.userId;

  const lease = await deps.store.claimSync(actor, conn.connectionId, conn.calendarId);
  if (!lease) return { status: "busy" };

  const counters: Counters = { applied: 0, conflicts: 0, notAuthorized: 0 };
  const run: Run = { deps, conn, leaseId: lease.leaseId, counters };
  let full = opts.forceFull === true || !lease.syncToken;
  try {
    const links = await deps.store.listLinks(actor, conn.connectionId, conn.calendarId);
    const byEvent = new Map(links.map((l) => [l.eventId, l]));

    let listing = await listAndApply(run, byEvent, full ? undefined : (lease.syncToken ?? undefined));
    if (listing === "gone") {
      // 410 (em qualquer página): o token não vale mais. Descarta JÁ e refaz
      // a listagem completa. O que as páginas anteriores aplicaram fica: a
      // completa o reconhece pela base e não reaplica.
      if (!(await deps.store.resetSyncToken(actor, lease.leaseId))) throw new AbortRun("failed", "lease_lost");
      full = true;
      listing = await listAndApply(run, byEvent, undefined);
      if (listing === "gone") throw new AbortRun("failed", "provider_410_on_full_listing");
    }

    if (full) {
      // Vínculo que não apareceu na listagem completa: confirma com `get`
      // antes de concluir qualquer coisa.
      for (const link of links) {
        if (listing.seen.has(link.eventId) || (link.status !== "linked" && link.status !== "needs_attention")) continue;
        await reconcileMissing(run, link);
      }
    }

    const committed = await deps.store.finishSync(actor, lease.leaseId, "success", {
      syncToken: listing.nextSyncToken,
      full,
    });
    if (!committed) return { status: "failed", code: "lease_lost" };
    return { status: "synced", full, pages: listing.pages, ...counters };
  } catch (error) {
    const abort = error instanceof AbortRun ? error : new AbortRun("failed", failureCode(error));
    await deps.store.finishSync(actor, lease.leaseId, abort.outcome, { full, error: abort.code });
    if (abort.outcome === "access_lost") return { status: "access_lost" };
    return { status: "failed", code: abort.code };
  }
}

async function listAndApply(
  run: Run,
  byEvent: Map<string, InboundLink>,
  syncToken: string | undefined,
): Promise<"gone" | { nextSyncToken: string; pages: number; seen: Set<string> }> {
  const { deps, conn } = run;
  // A consulta inicial vale para TODAS as páginas: a seguinte só acrescenta
  // o `pageToken` (o Google recusa página de consulta diferente).
  const query: EventListQuery = {
    ...(syncToken ? { syncToken } : {}),
    showDeleted: true,
    singleEvents: false,
    maxResults: LIST_PAGE_SIZE,
  };
  const seen = new Set<string>();
  let pageToken: string | undefined;
  let pages = 0;

  for (;;) {
    let page;
    try {
      page = await deps.api.listEvents(conn.accessToken, conn.calendarId, pageToken ? { ...query, pageToken } : query);
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status === 410 && query.syncToken) return "gone";
      if (isAccessDenied(error)) throw new AbortRun("access_lost", "calendar_access_lost");
      throw new AbortRun("failed", failureCode(error));
    }
    pages += 1;

    for (const item of page.items) {
      const link = byEvent.get(item.id);
      // Evento sem vínculo: descartado aqui, sem gravar, logar nem contar.
      if (!link) continue;
      seen.add(item.id);
      await applyLinked(run, link, item);
    }

    if (page.nextPageToken) {
      pageToken = page.nextPageToken;
      continue;
    }
    if (!page.nextSyncToken) throw new AbortRun("failed", "missing_sync_token");
    return { nextSyncToken: page.nextSyncToken, pages, seen };
  }
}

/** Lê o detalhe do evento vinculado. `null` = não existe mais (com o acesso confirmado). */
async function readLinkedEvent(deps: InboundDeps, conn: InboundConnection, eventId: string): Promise<CalendarEvent | null> {
  let event: CalendarEvent | null;
  try {
    event = await deps.api.getEvent(conn.accessToken, conn.calendarId, eventId);
  } catch (error) {
    if (isAccessDenied(error)) throw new AbortRun("access_lost", "calendar_access_lost");
    throw new AbortRun("failed", failureCode(error));
  }
  if (event) return event;
  // "Não existe" só vale com o acesso à agenda confirmado.
  let reachable: boolean;
  try {
    reachable = await deps.api.calendarAccessible(conn.accessToken, conn.calendarId);
  } catch (error) {
    if (isAccessDenied(error)) throw new AbortRun("access_lost", "calendar_access_lost");
    throw new AbortRun("failed", failureCode(error));
  }
  if (!reachable) throw new AbortRun("access_lost", "calendar_access_lost");
  return null;
}

function planFor(deps: InboundDeps, link: InboundLink, item: Pick<EventListItem, "extendedProperties">, event: CalendarEvent | null, etag: string): InboundPlan | null {
  if (!markerCoherent(item, link, deps.environment) || (event && !markerCoherent(event, link, deps.environment))) {
    return planStatusOnly(link, etag, "needs_attention", ["marker"]);
  }
  if (event === null) {
    return link.status === "missing_in_google" ? null : planStatusOnly(link, link.baseEtag ?? etag, "missing_in_google", ["missing"]);
  }
  // Série ou instância de série: não suportada no vínculo, não é alterada.
  if (event.recurrence?.length || event.recurringEventId) {
    return planStatusOnly(link, event.etag, "needs_attention", ["recurring"]);
  }
  if (event.status === "cancelled" && link.status === "cancelled_in_google") return planStatusOnly(link, event.etag, "cancelled_in_google");
  return planInbound(link, snapshotOf(event));
}

async function applyLinked(run: Run, initial: InboundLink, item: EventListItem): Promise<void> {
  const { deps, conn, counters } = run;
  // Eco de uma escrita do próprio CRM (ou nada novo): a base tem este etag E
  // os campos listados batem com ela.
  if (listedMatchesBase(item, initial)) return;
  if (initial.status === "unlinked") return;

  let link = initial;
  for (let attempt = 1; attempt <= MAX_APPLY_ATTEMPTS; attempt++) {
    // Cancelado: a listagem basta (o Google devolve apagados com `status`).
    const event =
      item.status === "cancelled"
        ? ({ ...item, status: "cancelled" } as CalendarEvent)
        : await readLinkedEvent(deps, conn, link.eventId);
    const plan = planFor(deps, link, item, event, event?.etag ?? item.etag);
    if (!plan || planIsNoop(plan, link)) return;

    const result = await deps.store.applyInbound(conn.userId, {
      leaseId: run.leaseId,
      linkId: link.id,
      expectedBaseEtag: link.baseEtag,
      expectedVersion: link.activity?.lockVersion ?? null,
      title: plan.title,
      dueAt: plan.dueAt,
      conflicts: plan.conflicts,
      state: plan.state,
    });
    if (result.status === "applied") {
      counters.applied += 1;
      counters.conflicts += plan.conflicts.length;
      return;
    }
    if (result.status === "not_authorized") {
      counters.notAuthorized += 1;
      return;
    }
    // Outra execução assumiu a trava: nada foi gravado, e esta para aqui.
    if (result.status === "lease_lost") throw new AbortRun("failed", "lease_lost");
    // Mudou no meio (CRM editado ou outra operação gravou a base): relê o
    // vínculo e a atividade e reavalia tudo.
    const fresh = (await deps.store.listLinks(conn.userId, conn.connectionId, conn.calendarId)).find((l) => l.id === link.id);
    if (!fresh || fresh.status === "unlinked") return;
    if (listedMatchesBase(item, fresh)) return;
    link = fresh;
  }
  // Não convergiu: o token NÃO avança e a próxima execução refaz.
  throw new AbortRun("failed", "apply_retry_exhausted");
}

/** Vínculo ausente da listagem completa: confirmado com `get` (e com o acesso
 * à agenda) antes de virar `missing_in_google`. Nunca apaga a atividade. */
async function reconcileMissing(run: Run, link: InboundLink): Promise<void> {
  const { deps, conn, counters } = run;
  const event = await readLinkedEvent(deps, conn, link.eventId);
  if (event) {
    // Existe, só não veio na listagem: trata como qualquer mudança.
    const { id, etag, status, updated, start, end, extendedProperties } = event;
    await applyLinked(run, link, { id, etag, status, updated, start, end, extendedProperties });
    return;
  }
  if (link.status === "missing_in_google") return;
  const plan = planStatusOnly(link, link.baseEtag ?? "", "missing_in_google", ["missing"]);
  const result = await deps.store.applyInbound(conn.userId, {
    leaseId: run.leaseId,
    linkId: link.id,
    expectedBaseEtag: link.baseEtag,
    expectedVersion: link.activity?.lockVersion ?? null,
    conflicts: [],
    state: plan.state,
  });
  if (result.status === "lease_lost") throw new AbortRun("failed", "lease_lost");
  // Mudou no meio: a próxima listagem completa confirma de novo.
  if (result.status === "stale_link" || result.status === "stale_activity") throw new AbortRun("failed", "apply_retry_exhausted");
  if (result.status === "applied") counters.applied += 1;
}
