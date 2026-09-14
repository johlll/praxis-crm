"use server";

import { revalidatePath } from "next/cache";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { requirePermission, AuthzError, type Permission } from "@/server/authz/permissions";
import { toUserMessage } from "@/lib/errors";
import { createLeadNoteSchema } from "./schema";

export type LeadNoteActionState = {
  ok: boolean;
  error?: string;
  noteId?: string;
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

export async function createLeadNoteAction(
  _prevState: LeadNoteActionState,
  formData: FormData,
): Promise<LeadNoteActionState> {
  const guard = await requirePermissionSafe("lead_note.edit");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

  const parsed = createLeadNoteSchema.safeParse({
    leadId: formData.get("leadId"),
    body: formData.get("body"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("create_lead_note", {
    p_lead_id: parsed.data.leadId,
    p_body: parsed.data.body,
  });

  if (error || !data) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath(`/leads/${parsed.data.leadId}`);
  return { ok: true, noteId: data };
}
