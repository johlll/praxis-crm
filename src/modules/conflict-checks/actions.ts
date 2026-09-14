"use server";

import { revalidatePath } from "next/cache";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { requirePermission, AuthzError, type Permission } from "@/server/authz/permissions";
import { toUserMessage } from "@/lib/errors";
import { upsertConflictCheckSchema } from "./schema";

export type ConflictCheckActionState = {
  ok: boolean;
  error?: string;
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

export async function upsertConflictCheckAction(
  _prevState: ConflictCheckActionState,
  formData: FormData,
): Promise<ConflictCheckActionState> {
  const guard = await requirePermissionSafe("conflict_check.edit");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

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
