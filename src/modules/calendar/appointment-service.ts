import { toUserMessage } from "@/lib/errors";
import { requirePermissionSafe } from "@/server/authz/safe";
import { getActivity } from "@/modules/activities/queries";
import { readActivityCalendarInfo } from "@/modules/calendar/activity-links";
import { listCalendarConnections } from "@/modules/calendar/queries";
import {
  MAX_APPOINTMENT_MINUTES,
  MIN_APPOINTMENT_MINUTES,
  type ActivityCalendarInfo,
  type CalendarNotice,
} from "@/modules/calendar/types";
import { createSupabaseSyncStore } from "@/server/calendar/admin/sync-store";
import { loadConnectionContext } from "@/server/calendar/connection-context";
import { getCalendarEnvironment } from "@/server/calendar/environment";
import { getCalendarProvider } from "@/server/calendar/provider";
import {
  cancelAppointment,
  createAppointment,
  getAvailability,
  isSlotFree,
  recoverUncertainCreate,
  rescheduleAppointment,
  type CancelAppointmentResult,
  type CreateAppointmentResult,
  type CreateOptions,
  type RecoverCreateResult,
  type UpdateAppointmentResult,
} from "@/server/calendar/sync/appointments";
import type { ActivitySnapshot, ConnectionContext, SyncDeps } from "@/server/calendar/sync/types";

/**
 * Serviço de compromissos CRM → Google usado pelas ações de calendário e
 * pelas ações de atividade que já existiam (criar, editar, reagendar,
 * excluir). Não é "use server": as funções daqui são chamadas por ações que
 * já conferiram a sessão, e nunca recebem usuário/workspace de formulário.
 *
 * Princípios:
 *  - Integração desligada (sem provedor): nada daqui toca no banco nem no
 *    Google — o comportamento anterior fica idêntico.
 *  - O que precisa ser RECUSADO é recusado ANTES de qualquer escrita no CRM
 *    ou no Google (`guardActivityChange`).
 *  - Depois de salvar no CRM, o que acontece na agenda volta como AVISO
 *    (`CalendarNotice`) e, se não deu certo, fica GRAVADO no vínculo como
 *    pendência, falha ou resultado incerto — visível depois de recarregar.
 */

export const PROVIDER_NOT_CONFIGURED = toUserMessage(new Error("calendar_provider_not_configured"));

type ActivityDetail = NonNullable<Awaited<ReturnType<typeof getActivity>>>;

export function snapshotOf(detail: ActivityDetail): ActivitySnapshot {
  return {
    id: detail.id,
    title: detail.title,
    dueAt: detail.dueAt,
    hasTime: detail.hasTime,
    type: detail.type,
    lockVersion: detail.lockVersion,
  };
}

/** Relê a atividade pela SESSÃO do usuário (RLS e alcance de verdade). */
export async function loadActivityFromSession(activityId: string): Promise<ActivitySnapshot | null> {
  const detail = await getActivity(activityId);
  return detail ? snapshotOf(detail) : null;
}

export type SessionContext = { userId: string; workspaceId: string };

export type Prepared = { deps: SyncDeps; conn: ConnectionContext; activity: ActivitySnapshot | null };

/** Falha de ambiente: o banco aborta a transação, então o registro fica no
 * servidor — só o código e ids internos. */
export function logRefusal(error: unknown, ctx: SessionContext) {
  const code = codeOf(error);
  if (code === "calendar_environment_mismatch") {
    console.warn(JSON.stringify({ event: "calendar_environment_mismatch", userId: ctx.userId, workspaceId: ctx.workspaceId }));
  }
}

function codeOf(error: unknown): string {
  return error instanceof Error ? ((error as { code?: string }).code ?? error.message) : "";
}

export function errorMessage(error: unknown, ctx?: SessionContext): string {
  if (ctx) logRefusal(error, ctx);
  return toUserMessage({ message: codeOf(error) });
}

export async function prepare(
  activityId: string | null,
): Promise<{ ok: false; error: string; code: string } | { ok: true; prepared: Prepared; ctx: SessionContext }> {
  const auth = await requirePermissionSafe("calendar.connect_own");
  if ("error" in auth) return { ok: false, error: auth.error, code: "insufficient_permission" };

  const provider = await getCalendarProvider();
  if (!provider) return { ok: false, error: PROVIDER_NOT_CONFIGURED, code: "calendar_provider_not_configured" };

  const connections = await listCalendarConnections(auth.ctx.workspaceId);
  const mine = connections.find((c) => c.isMine && c.status !== "disconnected");
  if (!mine) return { ok: false, error: toUserMessage(new Error("connection_not_found")), code: "connection_not_found" };

  let conn: ConnectionContext;
  try {
    conn = await loadConnectionContext({
      provider,
      connection: { id: mine.id, calendarId: mine.calendarId, status: mine.status },
      workspaceId: auth.ctx.workspaceId,
      actorUserId: auth.ctx.userId,
    });
  } catch (error) {
    return { ok: false, error: errorMessage(error), code: codeOf(error) || "connection_unavailable" };
  }

  let activity: ActivitySnapshot | null = null;
  if (activityId) {
    activity = await loadActivityFromSession(activityId);
    if (!activity) return { ok: false, error: toUserMessage(new Error("activity_not_found")), code: "activity_not_found" };
  }

  return {
    ok: true,
    ctx: { userId: auth.ctx.userId, workspaceId: auth.ctx.workspaceId },
    prepared: {
      deps: {
        api: provider,
        store: createSupabaseSyncStore(auth.ctx.userId),
        environment: getCalendarEnvironment(),
        loadActivity: loadActivityFromSession,
      },
      conn,
      activity,
    },
  };
}

// ---------------------------------------------------------------------
// Opções de criação (formulário → orquestrador)
// ---------------------------------------------------------------------

export type CreateFormOptions = {
  durationMinutes: number;
  withMeet: boolean;
  requireFree: boolean;
  inviteEmails: string[];
  confirmInvites: boolean;
};

export function toCreateOptions(form: CreateFormOptions): CreateOptions {
  return {
    durationMinutes: form.durationMinutes,
    withMeet: form.withMeet,
    requireFree: form.requireFree,
    ...(form.inviteEmails.length > 0 ? { invite: { emails: form.inviteEmails, confirmed: form.confirmInvites } } : {}),
  };
}

/** Duração digitada: inteiro entre 15 e 480. Conferida no servidor, sem
 * depender do navegador. */
export function isValidTypedDuration(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_APPOINTMENT_MINUTES &&
    value <= MAX_APPOINTMENT_MINUTES
  );
}

// ---------------------------------------------------------------------
// Avisos — cada resultado com a sua mensagem
// ---------------------------------------------------------------------

const warn = (message: string): CalendarNotice => ({ level: "warning", message });
const ok = (message: string, meetUrl?: string | null): CalendarNotice => ({
  level: "success",
  message,
  ...(meetUrl !== undefined ? { meetUrl } : {}),
});

const UNCERTAIN =
  "Resultado incerto no Google Agenda: não foi possível confirmar se a alteração foi aplicada. Use “Verificar” — a agenda é consultada antes de qualquer nova tentativa.";

/** Depois de reagendar/editar/sincronizar. `prefix` diz o que já aconteceu no CRM. */
export function noticeForUpdate(result: UpdateAppointmentResult, prefix = ""): CalendarNotice | null {
  switch (result.status) {
    case "updated":
      return ok(`${prefix}Google Agenda atualizado.`, result.meet.url);
    case "unchanged":
      return null;
    case "conflict_resolved":
      return warn(
        `${prefix}O evento também foi alterado no Google Agenda ao mesmo tempo (${result.conflicts.map((c) => FIELD_LABEL[c.field] ?? c.field).join(", ")}): o Google prevaleceu e a atividade foi ajustada para ficar igual. O valor anterior do CRM ficou registrado.`,
      );
    case "cancelled_in_google":
      return warn(`${prefix}O evento foi cancelado no Google Agenda. A atividade continua no CRM.`);
    case "needs_attention":
      return warn(`${prefix}O evento mudou várias vezes no Google Agenda durante a sincronização. Ficou pendente: tente sincronizar de novo.`);
    case "access_lost":
      return warn(`${prefix}${toUserMessage({ message: "calendar_access_lost" })}`);
    case "pending":
      return warn(`${prefix}O Google Agenda não respondeu (${result.code}). A alteração ficou pendente: tente sincronizar de novo.`);
    case "failed":
      return warn(`${prefix}O Google Agenda recusou a alteração (${result.code}). Ficou registrada como falha a resolver.`);
    case "uncertain":
      return warn(`${prefix}${UNCERTAIN}`);
  }
}

const FIELD_LABEL: Record<string, string> = { title: "título", schedule: "horário", cancellation: "cancelamento", meet: "Meet" };

export function noticeForMeet(result: UpdateAppointmentResult): CalendarNotice | null {
  if (result.status === "updated" || result.status === "unchanged" || result.status === "conflict_resolved") {
    const { meet } = result;
    if (meet.status === "success" && meet.url) {
      return ok(result.status === "unchanged" ? "O evento já tinha link do Meet." : "Link do Meet criado.", meet.url);
    }
    if (meet.status === "pending") {
      return warn("O Meet foi pedido e ainda está sendo criado pelo Google. O link aparece quando ficar pronto.");
    }
    if (meet.status === "failed") return warn("O Google não conseguiu criar o Meet. Tente de novo mais tarde.");
    return warn("O Meet não foi confirmado pelo Google. Tente de novo.");
  }
  return noticeForUpdate(result);
}

export function noticeForCancel(result: CancelAppointmentResult): CalendarNotice {
  switch (result.status) {
    case "cancelled":
      return ok("Removido do Google Agenda.");
    case "already_gone":
      return ok("O evento já não estava no Google Agenda; o vínculo foi encerrado.");
    case "kept_google_event":
      return warn(
        "O evento NÃO foi removido: ele foi alterado no Google Agenda depois da última sincronização. O evento e o vínculo continuam; confira o evento no Google antes de tentar de novo.",
      );
    case "access_lost":
      return warn(toUserMessage({ message: "calendar_access_lost" }));
    case "pending":
      return warn(`O Google Agenda não respondeu (${result.code}). Nada foi removido; tente de novo.`);
    case "failed":
      return warn(`O Google Agenda recusou a remoção (${result.code}). Nada foi removido.`);
    case "uncertain":
      return warn(UNCERTAIN);
  }
}

export function noticeForCreate(result: CreateAppointmentResult): CalendarNotice | null {
  switch (result.status) {
    case "created": {
      const base = result.adopted ? "O evento já existia no Google Agenda e foi vinculado." : "Adicionado ao Google Agenda.";
      // Meet pedido e ainda não pronto não é "link criado".
      if (result.meet.status === "pending") return warn(`${base} O Meet foi pedido e ainda está sendo criado pelo Google.`);
      if (result.meet.status === "failed") return warn(`${base} O Google não conseguiu criar o Meet.`);
      return ok(base, result.meet.url);
    }
    case "already_linked":
      return null;
    case "busy":
      return warn("O horário está ocupado no Google Agenda: o compromisso não foi adicionado a ela.");
    case "failed":
      return warn(`Não foi possível adicionar ao Google Agenda (${result.code}).`);
    case "uncertain":
      return warn(
        "Não foi possível confirmar se o evento foi criado no Google Agenda. Use “Verificar” — a agenda é consultada antes de qualquer nova tentativa.",
      );
  }
}

const STILL_PENDING = "Não dá para saber se o evento foi criado: a verificação continua pendente e nada foi criado de novo.";

/**
 * `selectedCalendarId`: a agenda selecionada AGORA. Quando difere da agenda
 * da tentativa, a mensagem diz onde o compromisso ficou (ou onde a ausência
 * foi confirmada).
 */
export function noticeForRecover(result: RecoverCreateResult, selectedCalendarId: string | null = null): CalendarNotice {
  switch (result.status) {
    case "adopted":
      return ok(
        result.calendarId !== selectedCalendarId
          ? "Confirmado: o evento estava no Google Agenda, na agenda em que a inclusão foi feita, e foi vinculado à atividade. Essa não é a agenda selecionada agora: o compromisso continua na agenda original; só compromissos novos vão para a selecionada."
          : "Confirmado: o evento estava no Google Agenda e foi vinculado à atividade.",
        result.meet.url,
      );
    case "not_created":
      return warn(
        result.calendarId !== selectedCalendarId
          ? "Confirmado na agenda em que a inclusão foi tentada: o evento não foi criado lá. Nada foi criado agora; se adicionar de novo, ele irá para a agenda selecionada agora."
          : "Confirmado: o evento não foi criado no Google Agenda. Nada foi criado agora; adicione de novo se quiser.",
      );
    case "already_linked":
      return ok("O compromisso já está vinculado ao Google Agenda.");
    case "nothing_open":
      return ok("Não há inclusão pendente de verificação para este compromisso.");
    case "not_owner":
      return warn("Esta inclusão foi feita pela agenda de outra pessoa: só ela pode verificá-la. Nada foi consultado nem alterado.");
    case "in_progress":
      return warn("A inclusão ainda pode estar em andamento. Verifique de novo em instantes; nada foi repetido.");
    case "insufficient_info":
      return warn(
        "Esta inclusão foi registrada sem a agenda e o evento usados, então não é possível concluir se o evento foi criado. Ela continua pendente; confira a agenda no Google.",
      );
    case "connection_unavailable":
      return warn(
        `A conexão usada na inclusão não está disponível (trocada, desconectada ou a reautorizar). ${STILL_PENDING} Reautorize essa conexão e verifique de novo.`,
      );
    case "access_lost":
      return warn(`Sem acesso à agenda em que a inclusão foi feita. ${STILL_PENDING} Restabeleça o acesso a essa agenda e verifique de novo.`);
    case "failed":
      return warn(`Não foi possível confirmar a inclusão (${result.code}).`);
    case "uncertain":
      return warn("O Google Agenda ainda não respondeu: o resultado continua incerto. Tente verificar de novo em instantes.");
  }
}

// ---------------------------------------------------------------------
// Verificar uma inclusão incerta
// ---------------------------------------------------------------------

/**
 * "Verificar inclusão": resolve a intenção ORIGINAL com a conexão que a fez
 * (do próprio usuário, ativa) e na agenda gravada nela. Não usa `prepare`,
 * que exige a conexão e a agenda selecionadas AGORA.
 */
export async function verifyUncertainCreate(
  activityId: string,
): Promise<{ ok: false; error: string } | { ok: true; result: RecoverCreateResult; notice: CalendarNotice }> {
  const auth = await requirePermissionSafe("calendar.connect_own");
  if ("error" in auth) return { ok: false, error: auth.error };
  const ctx: SessionContext = { userId: auth.ctx.userId, workspaceId: auth.ctx.workspaceId };

  const provider = await getCalendarProvider();
  if (!provider) return { ok: false, error: PROVIDER_NOT_CONFIGURED };

  try {
    const activity = await loadActivityFromSession(activityId);
    if (!activity) return { ok: false, error: toUserMessage(new Error("activity_not_found")) };

    const connections = await listCalendarConnections(ctx.workspaceId);
    const selected = connections.find((c) => c.isMine && c.status !== "disconnected") ?? null;
    const deps: SyncDeps = {
      api: provider,
      store: createSupabaseSyncStore(ctx.userId),
      environment: getCalendarEnvironment(),
      loadActivity: loadActivityFromSession,
    };

    const result = await recoverUncertainCreate(deps, activity, async ({ connectionId, calendarId }) => {
      // Só a conexão ORIGINAL, do próprio usuário e ativa. Outra conexão (mesmo
      // que dele, depois de reconectar) não tem como responder pela tentativa.
      const original = connections.find((c) => c.id === connectionId && c.isMine);
      if (!original || original.status !== "active") return null;
      try {
        return await loadConnectionContext({
          provider,
          connection: { id: original.id, calendarId, status: original.status },
          workspaceId: ctx.workspaceId,
          actorUserId: ctx.userId,
        });
      } catch {
        return null;
      }
    });
    return { ok: true, result, notice: noticeForRecover(result, selected?.calendarId ?? null) };
  } catch (error) {
    return { ok: false, error: errorMessage(error, ctx) };
  }
}

// ---------------------------------------------------------------------
// Trava ANTES da escrita
// ---------------------------------------------------------------------

export type ActivityChange =
  | { kind: "update"; title?: string | undefined; type?: string | undefined }
  | { kind: "reschedule"; dueTime: string }
  | { kind: "delete" };

export type GuardResult =
  | { ok: false; error: string }
  /** `sync`: depois de salvar, levar a mudança ao Google (vínculo meu e mudança relevante). */
  | { ok: true; sync: boolean; info: ActivityCalendarInfo | null };

const RESOLVE_FIRST = "resolva o vínculo com o Google Agenda primeiro (remova o compromisso da agenda)";

/**
 * Confere o vínculo com o Google ANTES de qualquer escrita no CRM ou no
 * Google, e recusa o que não pode acontecer sem resolver o vínculo:
 *  - compromisso na agenda de OUTRA pessoa: título, horário, duração, tipo e
 *    exclusão ficam bloqueados (notas e prioridade continuam livres);
 *  - mudar o tipo de um compromisso vinculado ou tirar o horário dele;
 *  - qualquer mudança desse tipo enquanto uma inclusão no Google está incerta.
 * Com a integração desligada, não confere nada (não há vínculo a ler).
 */
export async function guardActivityChange(activityId: string, change: ActivityChange): Promise<GuardResult> {
  let info: ActivityCalendarInfo | null;
  try {
    info = await readActivityCalendarInfo(activityId);
  } catch {
    return { ok: false, error: "Não foi possível conferir o vínculo com o Google Agenda. Nada foi alterado; tente de novo." };
  }
  if (!info) return { ok: true, sync: false, info: null };

  // Evento já cancelado/ausente no Google: não há o que divergir nem abandonar.
  const live = info.status !== "cancelled_in_google" && info.status !== "missing_in_google";

  let relevant: boolean;
  if (change.kind === "update") {
    const current = await getActivity(activityId);
    if (!current) return { ok: false, error: toUserMessage({ message: "activity_not_found" }) };
    const titleChanged = change.title !== undefined && change.title !== "" && change.title !== current.title;
    const typeChanged = change.type !== undefined && change.type !== "" && change.type !== current.type;
    if (live && typeChanged && change.type !== "meeting") {
      return { ok: false, error: `Este compromisso está no Google Agenda: para mudar o tipo, ${RESOLVE_FIRST}.` };
    }
    relevant = titleChanged || typeChanged;
  } else if (change.kind === "reschedule") {
    if (live && change.dueTime === "") {
      return { ok: false, error: `Este compromisso está no Google Agenda: para tirar o horário, ${RESOLVE_FIRST}.` };
    }
    relevant = true;
  } else {
    relevant = true;
  }

  if (!relevant) return { ok: true, sync: false, info };

  if (info.status === "not_linked") {
    return {
      ok: false,
      error:
        "A inclusão deste compromisso no Google Agenda ficou com resultado incerto. Use “Verificar inclusão” antes de alterar ou excluir — o evento pode existir na agenda.",
    };
  }
  if (live && !info.isMine) {
    return {
      ok: false,
      error:
        change.kind === "delete"
          ? "Este compromisso está na agenda de outra pessoa: só ela pode excluí-lo enquanto estiver vinculado."
          : "Este compromisso está na agenda de outra pessoa: título, horário e duração só podem ser alterados por ela. Notas e prioridade continuam editáveis.",
    };
  }
  return { ok: true, sync: live && info.isMine && change.kind !== "delete", info };
}

// ---------------------------------------------------------------------
// Depois de salvar no CRM
// ---------------------------------------------------------------------

/** Pendência gravada quando a sincronização nem chegou a começar. */
async function markPending(activityId: string, reason: string): Promise<boolean> {
  try {
    const auth = await requirePermissionSafe("calendar.connect_own");
    if ("error" in auth) return false;
    return await createSupabaseSyncStore(auth.ctx.userId).markLinkPending({ activityId, reason: reason.slice(0, 100) });
  } catch {
    return false;
  }
}

/**
 * Depois de editar/reagendar no CRM uma atividade vinculada à agenda DESTE
 * usuário (a trava já conferiu): leva a mudança ao Google. Nunca lança. Se
 * não der certo, o vínculo fica com a pendência gravada.
 */
export async function syncLinkedActivity(
  activityId: string,
  options: { durationMinutes?: number } = {},
): Promise<CalendarNotice | null> {
  const prefix = "Salvo no CRM. ";
  const prep = await prepare(activityId).catch((error: unknown) => ({ ok: false as const, error: errorMessage(error), code: codeOf(error) }));
  if (!prep.ok) {
    const marked = await markPending(activityId, prep.code || "prepare_failed");
    return warn(
      `${prefix}O Google Agenda não foi atualizado: ${prep.error}${marked ? " A alteração ficou pendente." : ""}`,
    );
  }
  const { deps, conn, activity } = prep.prepared;
  if (!activity) return null;
  try {
    return noticeForUpdate(await rescheduleAppointment(deps, conn, activity, options), prefix);
  } catch (error) {
    const marked = await markPending(activityId, codeOf(error) || "sync_error");
    return warn(`${prefix}O Google Agenda não foi atualizado: ${errorMessage(error)}${marked ? " A alteração ficou pendente." : ""}`);
  }
}

export type BeforeDelete = { proceed: true; notice: CalendarNotice | null } | { proceed: false; error: string };

/**
 * Antes de excluir uma atividade vinculada à agenda DESTE usuário (a trava já
 * recusou a de outra pessoa): remove o evento do Google primeiro, porque o
 * vínculo se perde com a atividade. Qualquer desfecho que não seja "removido"
 * ou "já não existia" impede a exclusão — nada fica abandonado no Google.
 */
export async function cancelLinkedBeforeDelete(activityId: string, info: ActivityCalendarInfo | null): Promise<BeforeDelete> {
  if (!info) return { proceed: true, notice: null };
  try {
    const prep = await prepare(activityId);
    if (!prep.ok) return { proceed: false, error: `A atividade não foi excluída: ${prep.error}` };
    const { deps, conn, activity } = prep.prepared;
    if (!activity) return { proceed: true, notice: null };

    const result = await cancelAppointment(deps, conn, activity);
    if (result.status === "cancelled" || result.status === "already_gone") {
      return { proceed: true, notice: noticeForCancel(result) };
    }
    return { proceed: false, error: `A atividade não foi excluída. ${noticeForCancel(result).message}` };
  } catch (error) {
    return { proceed: false, error: `A atividade não foi excluída: ${errorMessage(error)}` };
  }
}

/** Depois de criar a atividade no CRM: adiciona o compromisso ao Google. Nunca lança. */
export async function createForNewActivity(activityId: string, options: CreateOptions): Promise<CalendarNotice> {
  try {
    const prep = await prepare(activityId);
    if (!prep.ok) return warn(`Atividade criada, mas não foi adicionada ao Google Agenda: ${prep.error}`);
    const { deps, conn, activity } = prep.prepared;
    if (!activity) return warn("Atividade criada, mas não foi adicionada ao Google Agenda.");
    const result = await createAppointment(deps, conn, activity, options);
    return noticeForCreate(result) ?? ok("Já estava no Google Agenda.");
  } catch (error) {
    return warn(`Atividade criada, mas não foi adicionada ao Google Agenda: ${errorMessage(error)}`);
  }
}

// ---------------------------------------------------------------------
// Criar atividade já com o compromisso na agenda (formulário único)
// ---------------------------------------------------------------------

const checked = (value: FormDataEntryValue | null) => value === "on" || value === "true";
const EMAIL = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;
const MAX_INVITEES = 20;

/**
 * Lê do formulário de "Nova atividade" a parte do Google Agenda. `options:
 * null` = o usuário não pediu para adicionar à agenda. Erro de formulário
 * volta como mensagem, antes de qualquer criação.
 */
export function parseCalendarCreate(
  formData: FormData,
): { ok: true; options: CreateFormOptions | null } | { ok: false; error: string } {
  if (!checked(formData.get("calendarAdd"))) return { ok: true, options: null };

  const duration = Number(formData.get("durationMinutes") || 60);
  if (!isValidTypedDuration(duration)) {
    return { ok: false, error: toUserMessage({ message: "invalid_duration" }) };
  }

  const inviteEmails = String(formData.get("inviteEmails") ?? "")
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (inviteEmails.length > MAX_INVITEES || inviteEmails.some((e) => !EMAIL.test(e))) {
    return { ok: false, error: "Confira os e-mails dos convidados (até 20, separados por vírgula ou espaço)." };
  }
  const confirmInvites = checked(formData.get("confirmInvites"));
  if (inviteEmails.length > 0 && !confirmInvites) {
    return { ok: false, error: toUserMessage({ message: "invites_require_confirmation" }) };
  }

  return {
    ok: true,
    options: {
      durationMinutes: duration,
      withMeet: checked(formData.get("withMeet")),
      requireFree: checked(formData.get("requireFree")),
      inviteEmails,
      confirmInvites,
    },
  };
}

/**
 * Antes de criar a atividade: confere que a agenda do usuário está pronta
 * (permissão, conexão, token) e, se ele pediu, que o horário está livre —
 * para não criar a atividade e só depois descobrir o problema.
 */
export async function preflightCalendarCreate(
  options: CreateFormOptions,
  slot: { start: string },
): Promise<string | null> {
  try {
    const prep = await prepare(null);
    if (!prep.ok) return prep.error;
    if (options.requireFree) {
      const end = new Date(Date.parse(slot.start) + options.durationMinutes * 60_000).toISOString();
      const busy = await getAvailability(prep.prepared.deps, prep.prepared.conn, { from: slot.start, to: end });
      if (!isSlotFree(busy, slot.start, end)) {
        return "O horário está ocupado no Google Agenda. Escolha outro horário ou desmarque a opção de só criar se estiver livre.";
      }
    }
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}
