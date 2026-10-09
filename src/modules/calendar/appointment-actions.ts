"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { toUserMessage } from "@/lib/errors";
import { zonedInstant } from "@/lib/timezone";
import { uuidSchema } from "@/lib/uuid";
import { errorMessage, prepare, toCreateOptions } from "@/modules/calendar/appointment-service";
import {
  addMeetToAppointment,
  cancelAppointment,
  createAppointment,
  getAvailability,
  rescheduleAppointment,
} from "@/server/calendar/sync/appointments";

/**
 * Compromissos CRM → Google (B2). Cada ação confere a permissão pela sessão
 * (`calendar.connect_own`), lê a atividade pela SESSÃO do usuário (RLS e
 * alcance de verdade), e entrega ao orquestrador o usuário e o workspace da
 * sessão — nunca valores vindos do formulário. O ambiente vem do servidor. O
 * banco recusa, por dentro, vínculo de outro ambiente ou de outra conexão.
 *
 * São as ações dos botões "Adicionar ao Google Agenda", "Meet", "Sincronizar"
 * e "Remover da agenda". As ações de atividade que já existiam (criar,
 * editar, reagendar, excluir) chamam o mesmo serviço
 * (`appointment-service.ts`).
 */

export type AppointmentActionState = {
  ok: boolean;
  error?: string;
  /** Resultado do orquestrador (`created`, `updated`, `conflict_resolved`...). */
  result?: string;
  meetUrl?: string | null;
  busy?: Array<{ start: string; end: string }>;
};

/** As telas que mostram o selo da agenda (listas e agenda semanal). */
function revalidateCalendarRoutes() {
  revalidatePath("/agenda");
  revalidatePath("/atividades");
  revalidatePath("/leads/[id]", "page");
  revalidatePath("/oportunidades/[id]", "page");
}

function failure(error: unknown, ctx?: { userId: string; workspaceId: string }): AppointmentActionState {
  return { ok: false, error: errorMessage(error, ctx) };
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
    const result = await createAppointment(
      deps,
      conn,
      activity,
      toCreateOptions({
        durationMinutes: parsed.data.durationMinutes,
        withMeet: parsed.data.withMeet,
        requireFree: parsed.data.requireFree,
        inviteEmails: emails,
        confirmInvites: parsed.data.confirmInvites,
      }),
    );
    if (result.status === "busy") return { ok: false, result: "busy", busy: result.busy };
    if (result.status === "failed") return { ok: false, result: "failed", error: toUserMessage({ message: result.code }) };
    revalidateCalendarRoutes();
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
    revalidateCalendarRoutes();
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
    const result = await addMeetToAppointment(deps, conn, activity);
    revalidateCalendarRoutes();
    return describe(result);
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
    revalidateCalendarRoutes();
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

const slotSchema = z.object({
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueTime: z.string().regex(/^\d{2}:\d{2}$/),
  durationMinutes: z.coerce.number().int().min(15).max(480).default(60),
});

/**
 * "Verificar disponibilidade" do formulário: recebe a data e a hora digitadas
 * (no fuso do escritório) e a duração, e devolve só os intervalos ocupados
 * que encostam nesse horário — nunca título nem detalhe de evento.
 */
export async function checkSlotAvailabilityAction(
  _prev: AppointmentActionState,
  formData: FormData,
): Promise<AppointmentActionState> {
  const parsed = slotSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: "Informe a data, o horário e a duração." };

  const prep = await prepare(null);
  if (!prep.ok) return { ok: false, error: prep.error };

  const from = zonedInstant(parsed.data.dueDate, parsed.data.dueTime);
  const to = new Date(Date.parse(from) + parsed.data.durationMinutes * 60_000).toISOString();
  try {
    const busy = await getAvailability(prep.prepared.deps, prep.prepared.conn, { from, to });
    return { ok: true, busy };
  } catch (error) {
    return failure(error, prep.ctx);
  }
}
