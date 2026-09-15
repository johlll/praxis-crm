"use server";

import { revalidatePath } from "next/cache";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { requirePermissionSafe } from "@/server/authz/safe";
import { toUserMessage } from "@/lib/errors";
import { upsertConflictCheckSchema } from "./schema";

export type ConflictCheckActionState = {
  ok: boolean;
  error?: string;
};

export async function upsertConflictCheckAction(
  _prevState: ConflictCheckActionState,
  formData: FormData,
): Promise<ConflictCheckActionState> {
  const guard = await requirePermissionSafe("conflict_check.edit");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsed = upsertConflictCheckSchema.safeParse({
    leadId: formData.get("leadId"),
    status: formData.get("status"),
    note: formData.get("note") ?? "",
    lockVersion: formData.get("lockVersion") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("upsert_conflict_check", {
    p_lead_id: parsed.data.leadId,
    p_status: parsed.data.status,
    ...(parsed.data.note ? { p_note: parsed.data.note } : {}),
    ...(parsed.data.lockVersion !== "" && parsed.data.lockVersion !== undefined
      ? { p_lock_version: parsed.data.lockVersion }
      : {}),
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath(`/leads/${parsed.data.leadId}`);
  return { ok: true };
}
