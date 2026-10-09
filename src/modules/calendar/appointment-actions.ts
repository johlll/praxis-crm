"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requirePermissionSafe } from "@/server/authz/safe";
import { toUserMessage } from "@/lib/errors";
import { uuidSchema } from "@/lib/uuid";
import { getActivity } from "@/modules/activities/queries";
import { listCalendarConnections } from "@/modules/calendar/queries";
import { createSupabaseSyncStore } from "@/server/calendar/admin/sync-store";
import { loadConnectionContext } from "@/server/calendar/connection-context";
import { getCalendarEnvironment } from "@/server/calendar/environment";
import { getCalendarProvider } from "@/server/calendar/provider";
import {
  addMeetToAppointment,
  cancelAppointment,
  createAppointment,
  getAvailability,
  rescheduleAppointment,
} from "@/server/calendar/sync/appointments";
import type { ActivitySnapshot, ConnectionContext, SyncDeps } from "@/server/calendar/sync/types";

/**
 * Compromissos CRM → Google (B2, etapa 2). Cada ação confere a permissão
 * pela sessão (`calendar.connect_own`), lê a atividade pela SESSÃO do
 * usuário (RLS e alcance de verdade), e entrega ao orquestrador o usuário e
 * o workspace da sessão — nunca valores vindos do formulário. O ambiente vem
 * do servidor. O banco recusa, por dentro, vínculo de outro ambiente.
 *
 * Esta etapa não altera as ações de atividade que já existem: a ligação
 * delas com estas (reagendar/excluir disparando o Google) é a etapa
 * seguinte, junto da interface.
 */

export type AppointmentActionState = {
  ok: boolean;
  error?: string;
  /** Resultado do orquestrador (`created`, `updated`, `conflict_resolved`...). */
  result?: string;
  meetUrl?: string | null;
  busy?: Array<{ start: string; end: string }>;
};

const PROVIDER_NOT_CONFIGURED = toUserMessage(new Error("calendar_provider_not_configured"));

type Prepared = { deps: SyncDeps; conn: ConnectionContext; activity: ActivitySnapshot };

/** Falha de ambiente: o banco aborta a transação, então o registro fica no
 * servidor — só o código e ids internos. */
function logRefusal(error: unknown, ctx: { userId: string; workspaceId: string }) {
  const code = error instanceof Error ? (error as { code?: string }).code ?? error.message : "";
  if (code === "calendar_environment_mismatch") {
    console.warn(JSON.stringify({ event: "calendar_environment_mismatch", userId: ctx.userId, workspaceId: ctx.workspaceId }));
  }
}

type ActivityDetail = NonNullable<Awaited<ReturnType<typeof getActivity>>>;

function snapshotOf(detail: ActivityDetail): ActivitySnapshot {
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
async function loadActivityFromSession(activityId: string): Promise<ActivitySnapshot | null> {
  const detail = await getActivity(activityId);
  return detail ? snapshotOf(detail) : null;
}

async function prepare(activityId: string | null): Promise<
  | { ok: false; error: string }
  | { ok: true; prepared: Omit<Prepared, "activity"> & { activity: ActivitySnapshot | null }; ctx: { userId: string; workspaceId: string } }
> {
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
    const detail = await getActivity(activityId);
    if (!detail) return { ok: false, error: toUserMessage(new Error("activity_not_found")) };
    activity = snapshotOf(detail);
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

function failure(error: unknown, ctx?: { userId: string; workspaceId: string }): AppointmentActionState {
  if (ctx) logRefusal(error, ctx);
  const code = error instanceof Error ? ((error as { code?: string }).code ?? error.message) : "";
  return { ok: false, error: toUserMessage({ message: code }) };
}

const activityIdSchema = z.object({ activityId: uuidSchema });

const createSchema = z.object({
  activityId: uuidSchema,
  durationMinutes: z.coerce.number().int().min(15).max(480).default(60),
  withMeet: z.preprocess((v) => v === "on" || v === "true", z.boolean()),
  requireFree: z.preprocess((v) => v === "on" || v === "true", z.boolean()),
  inviteEmails: z.string().trim().max(2000).optional(),
  confirmInvites: z.preprocess((v) => v === "on" || v === "true", z.boolean()),
});

function describe(result: { status: string; meet?: { url: string | null } }): AppointmentActionState {
  const ok = !["failed", "uncertain", "needs_attention", "busy", "access_lost"].includes(result.status);
  return {
    ok,
    result: result.status,
    meetUrl: result.meet?.url ?? null,
    ...(result.status === "access_lost" ? { error: toUserMessage({ message: "calendar_access_lost" }) } : {}),
  };
}

export async function createAppointmentAction(
  _prev: AppointmentActionState,
  formData: FormData,
): Promise<AppointmentActionState> {
  const parsed = createSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: "Confira os dados do compromisso." };

  const prep = await prepare(parsed.data.activityId);
  if (!prep.ok) return { ok: false, error: prep.error };
  const { deps, conn, activity } = prep.prepared;
  if (!activity) return failure(new Error("activity_not_found"));

  const emails = (parsed.data.inviteEmails ?? "")
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  try {
    const result = await createAppointment(deps, conn, activity, {
      durationMinutes: parsed.data.durationMinutes,
      withMeet: parsed.data.withMeet,
      requireFree: parsed.data.requireFree,
      ...(emails.length > 0 ? { invite: { emails, confirmed: parsed.data.confirmInvites } } : {}),
    });
    if (result.status === "busy") return { ok: false, result: "busy", busy: result.busy };
    if (result.status === "failed") return { ok: false, result: "failed", error: toUserMessage({ message: result.code }) };
    revalidatePath("/agenda");
    return describe(result.status === "already_linked" ? { status: "already_linked" } : result);
  } catch (error) {
    return failure(error, prep.ctx);
  }
}

export async function rescheduleAppointmentAction(
  _prev: AppointmentActionState,
  formData: FormData,
): Promise<AppointmentActionState> {
  const parsed = activityIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: "Compromisso inválido." };

  const prep = await prepare(parsed.data.activityId);
  if (!prep.ok) return { ok: false, error: prep.error };
  const { deps, conn, activity } = prep.prepared;
  if (!activity) return failure(new Error("activity_not_found"));

  try {
    const result = await rescheduleAppointment(deps, conn, activity);
    revalidatePath("/agenda");
    return describe(result);
  } catch (error) {
    return failure(error, prep.ctx);
  }
}

export async function addMeetAction(_prev: AppointmentActionState, formData: FormData): Promise<AppointmentActionState> {
  const parsed = activityIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: "Compromisso inválido." };

  const prep = await prepare(parsed.data.activityId);
  if (!prep.ok) return { ok: false, error: prep.error };
  const { deps, conn, activity } = prep.prepared;
  if (!activity) return failure(new Error("activity_not_found"));

  try {
    return describe(await addMeetToAppointment(deps, conn, activity));
  } catch (error) {
    return failure(error, prep.ctx);
  }
}

export async function cancelAppointmentAction(
  _prev: AppointmentActionState,
  formData: FormData,
): Promise<AppointmentActionState> {
  const parsed = activityIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: "Compromisso inválido." };

  const prep = await prepare(parsed.data.activityId);
  if (!prep.ok) return { ok: false, error: prep.error };
  const { deps, conn, activity } = prep.prepared;
  if (!activity) return failure(new Error("activity_not_found"));

  try {
    const result = await cancelAppointment(deps, conn, activity);
    revalidatePath("/agenda");
    return describe(result);
  } catch (error) {
    return failure(error, prep.ctx);
  }
}

const availabilitySchema = z.object({ from: z.string().datetime(), to: z.string().datetime() });

/** Intervalos ocupados da agenda escolhida (sem títulos). */
export async function checkAvailabilityAction(
  _prev: AppointmentActionState,
  formData: FormData,
): Promise<AppointmentActionState> {
  const parsed = availabilitySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: "Informe o período." };

  const prep = await prepare(null);
  if (!prep.ok) return { ok: false, error: prep.error };

  try {
    const busy = await getAvailability(prep.prepared.deps, prep.prepared.conn, parsed.data);
    return { ok: true, busy };
  } catch (error) {
    return failure(error, prep.ctx);
  }
}
