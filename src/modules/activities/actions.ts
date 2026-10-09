"use server";

import { revalidatePath } from "next/cache";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { requirePermissionSafe } from "@/server/authz/safe";
import { requireMembership } from "@/server/authz/permissions";
import { toUserMessage } from "@/lib/errors";
import { zonedInstant } from "@/lib/timezone";
import {
  cancelLinkedBeforeDelete,
  createForNewActivity,
  parseCalendarCreate,
  preflightCalendarCreate,
  syncLinkedActivity,
  toCreateOptions,
} from "@/modules/calendar/appointment-service";
import type { CalendarNotice } from "@/modules/calendar/types";
import { listActivities, type ActivityListItem } from "./queries";
import {
  createActivitySchema,
  updateActivitySchema,
  rescheduleActivitySchema,
  reassignActivitySchema,
  completeActivitySchema,
  deleteActivitySchema,
  setStageAutoActivityRuleSchema,
  deleteStageAutoActivityRuleSchema,
} from "./schema";

export type ActivityActionState = {
  ok: boolean;
  error?: string;
  activityId?: string;
  /** O que aconteceu no Google Agenda (só quando a integração está ligada e a atividade tem vínculo). */
  calendar?: CalendarNotice;
};

/** As telas que listam atividades variam (Central, painel da oportunidade,
 * futuramente lead) — revalida sempre as mesmas três rotas amplas, mais
 * barato e simples que rastrear qual página específica chamou a action. */
function revalidateActivityRoutes(leadId?: string, opportunityId?: string) {
  revalidatePath("/atividades");
  revalidatePath("/agenda");
  revalidatePath("/visao-geral");
  revalidatePath("/pipeline");
  if (leadId) revalidatePath(`/leads/${leadId}`);
  if (opportunityId) revalidatePath(`/oportunidades/${opportunityId}`);
}

export async function createActivityAction(
  _prevState: ActivityActionState,
  formData: FormData,
): Promise<ActivityActionState> {
  const guard = await requirePermissionSafe("activity.edit");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsed = createActivitySchema.safeParse({
    leadId: formData.get("leadId"),
    opportunityId: formData.get("opportunityId") ?? "",
    type: formData.get("type"),
    title: formData.get("title"),
    notes: formData.get("notes") ?? "",
    assignedTo: formData.get("assignedTo") ?? "",
    priority: formData.get("priority") || "media",
    dueDate: formData.get("dueDate"),
    dueTime: formData.get("dueTime") ?? "",
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  // Google Agenda (opcional): tudo o que dá para conferir ANTES de criar é
  // conferido antes — a atividade não nasce para só depois falhar na agenda.
  const calendarForm = parseCalendarCreate(formData);
  if (!calendarForm.ok) return { ok: false, error: calendarForm.error };
  if (calendarForm.options) {
    if (parsed.data.type !== "meeting" || !parsed.data.dueTime) {
      return { ok: false, error: toUserMessage({ message: "activity_not_appointment" }) };
    }
    const problem = await preflightCalendarCreate(calendarForm.options, {
      start: zonedInstant(parsed.data.dueDate, parsed.data.dueTime),
    });
    if (problem) return { ok: false, error: problem };
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("create_activity", {
    p_lead_id: parsed.data.leadId,
    p_type: parsed.data.type,
    p_title: parsed.data.title,
    p_due_date: parsed.data.dueDate,
    ...(parsed.data.dueTime ? { p_due_time: parsed.data.dueTime } : {}),
    ...(parsed.data.opportunityId ? { p_opportunity_id: parsed.data.opportunityId } : {}),
    ...(parsed.data.notes ? { p_notes: parsed.data.notes } : {}),
    ...(parsed.data.assignedTo ? { p_assigned_to: parsed.data.assignedTo } : {}),
    p_priority: parsed.data.priority,
  });

  if (error || !data) {
    return { ok: false, error: toUserMessage(error) };
  }

  const calendar = calendarForm.options
    ? await createForNewActivity(data, toCreateOptions(calendarForm.options))
    : undefined;

  revalidateActivityRoutes(parsed.data.leadId, parsed.data.opportunityId || undefined);
  return { ok: true, activityId: data, ...(calendar ? { calendar } : {}) };
}

export async function updateActivityAction(
  _prevState: ActivityActionState,
  formData: FormData,
): Promise<ActivityActionState> {
  const guard = await requirePermissionSafe("activity.edit");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsed = updateActivitySchema.safeParse({
    activityId: formData.get("activityId"),
    lockVersion: formData.get("lockVersion"),
    type: formData.get("type") ?? "",
    title: formData.get("title") ?? "",
    notes: formData.get("notes") ?? "",
    clearNotes: formData.has("clearNotes"),
    priority: formData.get("priority") ?? "",
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("update_activity", {
    p_activity_id: parsed.data.activityId,
    p_lock_version: parsed.data.lockVersion,
    ...(parsed.data.type ? { p_type: parsed.data.type } : {}),
    ...(parsed.data.title ? { p_title: parsed.data.title } : {}),
    ...(parsed.data.notes ? { p_notes: parsed.data.notes } : {}),
    p_clear_notes: parsed.data.clearNotes,
    ...(parsed.data.priority ? { p_priority: parsed.data.priority } : {}),
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  // Título novo de um compromisso vinculado vai ao Google (sem vínculo, nada acontece).
  const calendar = await syncLinkedActivity(parsed.data.activityId);

  revalidateActivityRoutes();
  return { ok: true, activityId: parsed.data.activityId, ...(calendar ? { calendar } : {}) };
}

export async function rescheduleActivityAction(
  activityId: string,
  lockVersion: number,
  dueDate: string,
  dueTime: string,
  scope?: { leadId?: string; opportunityId?: string },
  /** Duração nova, só quando o usuário a alterou (15–480). Sem ela, vale a do evento no Google. */
  calendar?: { durationMinutes?: number },
): Promise<ActivityActionState> {
  const guard = await requirePermissionSafe("activity.edit");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsed = rescheduleActivitySchema.safeParse({ activityId, lockVersion, dueDate, dueTime });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("reschedule_activity", {
    p_activity_id: parsed.data.activityId,
    p_lock_version: parsed.data.lockVersion,
    p_due_date: parsed.data.dueDate,
    ...(parsed.data.dueTime ? { p_due_time: parsed.data.dueTime } : {}),
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  const notice = await syncLinkedActivity(
    parsed.data.activityId,
    calendar?.durationMinutes !== undefined ? { durationMinutes: calendar.durationMinutes } : {},
  );

  revalidateActivityRoutes(scope?.leadId, scope?.opportunityId);
  return { ok: true, activityId: parsed.data.activityId, ...(notice ? { calendar: notice } : {}) };
}

export async function reassignActivityAction(
  activityId: string,
  lockVersion: number,
  assignedTo: string | null,
  scope?: { leadId?: string; opportunityId?: string },
): Promise<ActivityActionState> {
  const guard = await requirePermissionSafe("activity.edit");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsed = reassignActivitySchema.safeParse({ activityId, lockVersion, assignedTo: assignedTo ?? "" });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("reassign_activity", {
    p_activity_id: parsed.data.activityId,
    p_lock_version: parsed.data.lockVersion,
    ...(parsed.data.assignedTo ? { p_assigned_to: parsed.data.assignedTo } : {}),
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidateActivityRoutes(scope?.leadId, scope?.opportunityId);
  return { ok: true, activityId: parsed.data.activityId };
}

export async function completeActivityAction(
  activityId: string,
  lockVersion: number,
  scope?: { leadId?: string; opportunityId?: string },
): Promise<ActivityActionState> {
  const guard = await requirePermissionSafe("activity.edit");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsed = completeActivitySchema.safeParse({ activityId, lockVersion });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("complete_activity", {
    p_activity_id: parsed.data.activityId,
    p_lock_version: parsed.data.lockVersion,
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidateActivityRoutes(scope?.leadId, scope?.opportunityId);
  return { ok: true, activityId: parsed.data.activityId };
}

export async function deleteActivityAction(
  activityId: string,
  scope?: { leadId?: string; opportunityId?: string },
): Promise<ActivityActionState> {
  const guard = await requirePermissionSafe("activity.edit");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsed = deleteActivitySchema.safeParse({ activityId });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  // Vinculada ao Google: o evento sai da agenda ANTES (o vínculo se perde com a
  // atividade). Se a agenda não puder ser alcançada, a atividade NÃO é excluída.
  const beforeDelete = await cancelLinkedBeforeDelete(parsed.data.activityId);
  if (!beforeDelete.proceed) return { ok: false, error: beforeDelete.error };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("delete_activity", { p_activity_id: parsed.data.activityId });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidateActivityRoutes(scope?.leadId, scope?.opportunityId);
  return { ok: true, ...(beforeDelete.notice ? { calendar: beforeDelete.notice } : {}) };
}

export type StageRuleActionState = { ok: boolean; error?: string };

export async function setStageAutoActivityRuleAction(
  _prevState: StageRuleActionState,
  formData: FormData,
): Promise<StageRuleActionState> {
  const guard = await requirePermissionSafe("activity.configure");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsed = setStageAutoActivityRuleSchema.safeParse({
    stageId: formData.get("stageId"),
    activityType: formData.get("activityType"),
    title: formData.get("title"),
    dueOffsetHours: formData.get("dueOffsetHours") || 24,
    assigneeRule: formData.get("assigneeRule") || "lead_owner",
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("set_stage_auto_activity_rule", {
    p_stage_id: parsed.data.stageId,
    p_activity_type: parsed.data.activityType,
    p_title: parsed.data.title,
    p_due_offset_hours: parsed.data.dueOffsetHours,
    p_assignee_rule: parsed.data.assigneeRule,
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath("/configuracoes/pipelines");
  return { ok: true };
}

export async function deleteStageAutoActivityRuleAction(stageId: string): Promise<StageRuleActionState> {
  const guard = await requirePermissionSafe("activity.configure");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsed = deleteStageAutoActivityRuleSchema.safeParse({ stageId });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("delete_stage_auto_activity_rule", { p_stage_id: parsed.data.stageId });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath("/configuracoes/pipelines");
  return { ok: true };
}

const LEAD_ACTIVITIES_PAGE_SIZE = 50;

/**
 * "Carregar mais" da aba Atividades/Visão geral do Perfil 360. Uma falha
 * chega como `ok: false` (listActivities lança ActivitiesLoadError) —
 * nunca como lista vazia + hasMore=false, que sumiria com o botão.
 */
export async function loadMoreLeadActivitiesAction(
  leadId: string,
  page: number,
): Promise<{ ok: true; items: ActivityListItem[]; hasMore: boolean } | { ok: false; error: string }> {
  try {
    const { workspaceId } = await requireMembership();
    const result = await listActivities(workspaceId, {
      leadId,
      status: "all",
      page,
      pageSize: LEAD_ACTIVITIES_PAGE_SIZE,
    });
    return { ok: true, items: result.items, hasMore: result.hasMore };
  } catch {
    return { ok: false, error: "Não foi possível carregar mais atividades. Tente novamente." };
  }
}
