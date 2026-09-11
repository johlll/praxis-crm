"use server";

import { revalidatePath } from "next/cache";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { requirePermission, AuthzError, type Permission } from "@/server/authz/permissions";
import { toUserMessage } from "@/lib/errors";
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
};

const PERMISSION_DENIED_MESSAGE = "Você não tem permissão para fazer isso.";

async function requirePermissionSafe(
  permission: Permission,
): Promise<{ ctx: Awaited<ReturnType<typeof requirePermission>> } | { deniedMessage: string }> {
  try {
    return { ctx: await requirePermission(permission) };
  } catch (error) {
    if (error instanceof AuthzError) return { deniedMessage: PERMISSION_DENIED_MESSAGE };
    throw error;
  }
}

/** As telas que listam atividades variam (Central, painel da oportunidade,
 * futuramente lead) — revalida sempre as mesmas três rotas amplas, mais
 * barato e simples que rastrear qual página específica chamou a action. */
function revalidateActivityRoutes(leadId?: string, opportunityId?: string) {
  revalidatePath("/atividades");
  revalidatePath("/agenda");
  revalidatePath("/pipeline");
  if (leadId) revalidatePath(`/leads/${leadId}`);
  if (opportunityId) revalidatePath(`/oportunidades/${opportunityId}`);
}

export async function createActivityAction(
  _prevState: ActivityActionState,
  formData: FormData,
): Promise<ActivityActionState> {
  const guard = await requirePermissionSafe("activity.edit");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

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

  revalidateActivityRoutes(parsed.data.leadId, parsed.data.opportunityId || undefined);
  return { ok: true, activityId: data };
}

export async function updateActivityAction(
  _prevState: ActivityActionState,
  formData: FormData,
): Promise<ActivityActionState> {
  const guard = await requirePermissionSafe("activity.edit");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

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

  revalidateActivityRoutes();
  return { ok: true, activityId: parsed.data.activityId };
}

export async function rescheduleActivityAction(
  activityId: string,
  lockVersion: number,
  dueDate: string,
  dueTime: string,
  scope?: { leadId?: string; opportunityId?: string },
): Promise<ActivityActionState> {
  const guard = await requirePermissionSafe("activity.edit");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

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

  revalidateActivityRoutes(scope?.leadId, scope?.opportunityId);
  return { ok: true, activityId: parsed.data.activityId };
}

export async function reassignActivityAction(
  activityId: string,
  lockVersion: number,
  assignedTo: string | null,
  scope?: { leadId?: string; opportunityId?: string },
): Promise<ActivityActionState> {
  const guard = await requirePermissionSafe("activity.edit");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

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
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

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
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

  const parsed = deleteActivitySchema.safeParse({ activityId });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("delete_activity", { p_activity_id: parsed.data.activityId });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidateActivityRoutes(scope?.leadId, scope?.opportunityId);
  return { ok: true };
}

export type StageRuleActionState = { ok: boolean; error?: string };

export async function setStageAutoActivityRuleAction(
  _prevState: StageRuleActionState,
  formData: FormData,
): Promise<StageRuleActionState> {
  const guard = await requirePermissionSafe("activity.configure");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

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
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

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
