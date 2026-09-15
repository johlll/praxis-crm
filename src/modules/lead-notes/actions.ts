"use server";

import { revalidatePath } from "next/cache";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { requirePermissionSafe } from "@/server/authz/safe";
import { toUserMessage } from "@/lib/errors";
import { createLeadNoteSchema } from "./schema";

export type LeadNoteActionState = {
  ok: boolean;
  error?: string;
  noteId?: string;
};

export async function createLeadNoteAction(
  _prevState: LeadNoteActionState,
  formData: FormData,
): Promise<LeadNoteActionState> {
  const guard = await requirePermissionSafe("lead_note.edit");
  if ("error" in guard) return { ok: false, error: guard.error };

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
