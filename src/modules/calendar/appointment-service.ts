import { toUserMessage } from "@/lib/errors";
import { requirePermissionSafe } from "@/server/authz/safe";
import { getActivity } from "@/modules/activities/queries";
import { listCalendarConnections } from "@/modules/calendar/queries";
import type { CalendarNotice } from "@/modules/calendar/types";
import { createSupabaseSyncStore } from "@/server/calendar/admin/sync-store";
import { loadConnectionContext } from "@/server/calendar/connection-context";
import { getCalendarEnvironment } from "@/server/calendar/environment";
import { getCalendarProvider } from "@/server/calendar/provider";
import {
  cancelAppointment,
  createAppointment,
  getAvailability,
  isSlotFree,
  rescheduleAppointment,
  type CancelAppointmentResult,
  type CreateAppointmentResult,
  type CreateOptions,
  type UpdateAppointmentResult,
} from "@/server/calendar/sync/appointments";
import type { ActivitySnapshot, ConnectionContext, SyncDeps } from "@/server/calendar/sync/types";

/**
 * Serviço de compromissos CRM → Google usado pelas ações de calendário e
 * pelas ações de atividade que já existiam (criar, editar, reagendar,
 * excluir). Não é "use server": as funções daqui são chamadas por ações que
 * já conferiram a sessão, e nunca recebem usuário/workspace de formulário.
 *
 * Princípio das ações de atividade: com a integração desligada (sem
 * provedor) nada daqui toca no banco nem no Google — o comportamento
 * anterior fica idêntico. Com ela ligada, a mudança no CRM é a fonte da
 * verdade e o que acontece na agenda volta como um AVISO (`CalendarNotice`),
 * nunca como falha da ação de atividade que já foi concluída.
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
  const code = error instanceof Error ? ((error as { code?: string }).code ?? error.message) : "";
  if (code === "calendar_environment_mismatch") {
    console.warn(JSON.stringify({ event: "calendar_environment_mismatch", userId: ctx.userId, workspaceId: ctx.workspaceId }));
  }
}

export function errorMessage(error: unknown, ctx?: SessionContext): string {
  if (ctx) logRefusal(error, ctx);
  const code = error instanceof Error ? ((error as { code?: string }).code ?? error.message) : "";
  return toUserMessage({ message: code });
}

export async function prepare(
  activityId: string | null,
): Promise<{ ok: false; error: string } | { ok: true; prepared: Prepared; ctx: SessionContext }> {
  const auth = await requirePermissionSafe("calendar.connect_own");
  if ("error" in auth) return { ok: false, error: auth.error };

  const provider = await getCalendarProvider();
  if (!provider) return { ok: false, error: PROVIDER_NOT_CONFIGURED };

  const connections = await listCalendarConnections(auth.ctx.workspaceId);
  const mine = connections.find((c) => c.isMine && c.status !== "disconnected");
  if (!mine) return { ok: false, error: toUserMessage(new Error("connection_not_found")) };

  const conn = await loadConnectionContext({
    provider,
    connection: { id: mine.id, calendarId: mine.calendarId, status: mine.status },
    workspaceId: auth.ctx.workspaceId,
    actorUserId: auth.ctx.userId,
  });

  let activity: ActivitySnapshot | null = null;
  if (activityId) {
    activity = await loadActivityFromSession(activityId);
    if (!activity) return { ok: false, error: toUserMessage(new Error("activity_not_found")) };
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

// ---------------------------------------------------------------------
// Avisos
// ---------------------------------------------------------------------

const warn = (message: string): CalendarNotice => ({ level: "warning", message });

export function noticeForUpdate(result: UpdateAppointmentResult): CalendarNotice | null {
  switch (result.status) {
    case "updated":
      return { level: "success", message: "Google Agenda atualizado.", meetUrl: result.meet.url };
    case "unchanged":
      return null;
    case "conflict_resolved":
      return warn(
        "Alterado também no Google Agenda ao mesmo tempo: o valor do Google prevaleceu e a atividade foi ajustada. O seu valor anterior ficou registrado.",
      );
    case "cancelled_in_google":
      return warn("O evento foi cancelado no Google Agenda. A atividade continua no CRM, sem vínculo ativo com a agenda.");
    case "needs_attention":
      return warn("Muitas alterações simultâneas no Google Agenda. A sincronização ficou pendente: tente de novo em instantes.");
    case "access_lost":
      return warn(toUserMessage({ message: "calendar_access_lost" }));
    case "failed":
      return warn(`Salvo no CRM, mas o Google Agenda não foi atualizado (${result.code}). Tente sincronizar de novo.`);
    case "uncertain":
      return warn("Salvo no CRM, mas o resultado no Google Agenda é incerto. Confira a agenda antes de tentar de novo.");
  }
}

export function noticeForCreate(result: CreateAppointmentResult): CalendarNotice | null {
  switch (result.status) {
    case "created":
      return { level: "success", message: "Adicionado ao Google Agenda.", meetUrl: result.meet.url };
    case "already_linked":
      return null;
    case "busy":
      return warn("O horário está ocupado no Google Agenda: o compromisso não foi adicionado a ela.");
    case "failed":
      return warn(`Não foi possível adicionar ao Google Agenda (${result.code}).`);
    case "uncertain":
      return warn("Não foi possível confirmar se o evento foi criado no Google Agenda. Confira a agenda antes de tentar de novo.");
  }
}

// ---------------------------------------------------------------------
// Ações de atividade que já existiam
// ---------------------------------------------------------------------

/**
 * Depois de editar/reagendar uma atividade no CRM: leva a mudança ao Google
 * quando ela está vinculada à agenda DESTE usuário. Nunca lança. `null` =
 * nada a dizer (integração desligada ou atividade sem vínculo).
 */
export async function syncLinkedActivity(
  activityId: string,
  options: { durationMinutes?: number } = {},
): Promise<CalendarNotice | null> {
  try {
    const provider = await getCalendarProvider();
    if (!provider) return null;
    const auth = await requirePermissionSafe("calendar.connect_own");
    if ("error" in auth) return null;

    const link = await createSupabaseSyncStore(auth.ctx.userId).getLink(activityId);
    if (!link) return null;

    const prep = await prepare(activityId);
    if (!prep.ok) {
      return warn(`Salvo no CRM, mas o Google Agenda não foi atualizado: ${prep.error}`);
    }
    if (link.connectionId !== prep.prepared.conn.connectionId) {
      return warn("Salvo no CRM. Este compromisso está na agenda de outra pessoa, então o Google Agenda não foi alterado.");
    }
    const { deps, conn, activity } = prep.prepared;
    if (!activity) return null;

    return noticeForUpdate(await rescheduleAppointment(deps, conn, activity, options));
  } catch (error) {
    return warn(`Salvo no CRM, mas o Google Agenda não foi atualizado: ${errorMessage(error)}`);
  }
}

export type BeforeDelete = { proceed: true; notice: CalendarNotice | null } | { proceed: false; error: string };

function resultOfCancel(result: CancelAppointmentResult): BeforeDelete {
  switch (result.status) {
    case "cancelled":
    case "already_gone":
      return { proceed: true, notice: { level: "success", message: "Evento removido do Google Agenda." } };
    case "kept_google_event":
      return {
        proceed: true,
        notice: warn("O evento foi alterado no Google Agenda depois da última sincronização, então foi mantido lá."),
      };
    case "access_lost":
      return { proceed: false, error: `A atividade não foi excluída. ${toUserMessage({ message: "calendar_access_lost" })}` };
    case "failed":
      return {
        proceed: false,
        error: `A atividade não foi excluída: não foi possível remover o evento do Google Agenda (${result.code}).`,
      };
    case "uncertain":
      return {
        proceed: false,
        error: "A atividade não foi excluída: o resultado no Google Agenda é incerto. Confira a agenda e tente de novo.",
      };
  }
}

/**
 * Antes de excluir uma atividade vinculada: remove o evento do Google. O
 * vínculo é perdido quando a atividade é excluída, então a ordem é Google
 * primeiro — se a agenda não puder ser alcançada, a atividade NÃO é excluída.
 */
export async function cancelLinkedBeforeDelete(activityId: string): Promise<BeforeDelete> {
  try {
    const provider = await getCalendarProvider();
    if (!provider) return { proceed: true, notice: null };
    const auth = await requirePermissionSafe("calendar.connect_own");
    if ("error" in auth) return { proceed: true, notice: null };

    const link = await createSupabaseSyncStore(auth.ctx.userId).getLink(activityId);
    if (!link) return { proceed: true, notice: null };

    const prep = await prepare(activityId);
    if (!prep.ok) return { proceed: false, error: `A atividade não foi excluída: ${prep.error}` };
    if (link.connectionId !== prep.prepared.conn.connectionId) {
      return {
        proceed: true,
        notice: warn("O evento continua na agenda de outra pessoa; só ela pode removê-lo do Google Agenda."),
      };
    }
    const { deps, conn, activity } = prep.prepared;
    if (!activity) return { proceed: true, notice: null };

    return resultOfCancel(await cancelAppointment(deps, conn, activity));
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
    return noticeForCreate(result) ?? { level: "success", message: "Já estava no Google Agenda." };
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
  if (!Number.isInteger(duration) || duration < 15 || duration > 480) {
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
