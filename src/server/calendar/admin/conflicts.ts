import { createCalendarAdminSupabaseClient } from "@/server/calendar/admin/supabase";

export type RestoreConflictResult =
  | { status: "restored"; activityId: string; lockVersion: number }
  | { status: "already_restored" | "not_restorable" | "outdated" | "link_inactive" | "not_owner"; activityId: string };

/**
 * Restaura no CRM o valor que perdeu num conflito (`restore_calendar_conflict`,
 * GRANT só a service_role), em nome do usuário que a sessão já autorizou. O
 * banco confere ambiente, papel, alcance, dono da conexão e se o valor que
 * prevaleceu ainda é o atual.
 */
export async function adminRestoreCalendarConflict(params: {
  conflictId: string;
  actorUserId: string;
}): Promise<RestoreConflictResult> {
  const admin = createCalendarAdminSupabaseClient();
  const { data, error } = await admin.rpc("restore_calendar_conflict", {
    p_conflict_id: params.conflictId,
    p_actor_user_id: params.actorUserId,
  });
  if (error) throw new Error(error.message);
  return data as unknown as RestoreConflictResult;
}
