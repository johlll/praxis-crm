"use server";

import { revalidatePath } from "next/cache";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { requirePermission, AuthzError, type Permission } from "@/server/authz/permissions";
import { toUserMessage } from "@/lib/errors";
import { createProposalSchema, sendProposalSchema, decideProposalSchema } from "./schema";

export type ProposalActionState = {
  ok: boolean;
  error?: string;
  proposalId?: string;
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

function revalidateLeadRoutes(leadId: string) {
  revalidatePath(`/leads/${leadId}`);
}

export async function createProposalAction(
  leadId: string,
  _prevState: ProposalActionState,
  formData: FormData,
): Promise<ProposalActionState> {
  const guard = await requirePermissionSafe("proposal.edit");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

  const parsed = createProposalSchema.safeParse({
    opportunityId: formData.get("opportunityId"),
    valueCents: formData.get("valueCents"),
    feeModel: formData.get("feeModel"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("create_proposal", {
    p_opportunity_id: parsed.data.opportunityId,
    p_value_cents: parsed.data.valueCents,
    p_fee_model: parsed.data.feeModel,
  });

  if (error || !data) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidateLeadRoutes(leadId);
  return { ok: true, proposalId: data };
}

export async function sendProposalAction(
  leadId: string,
  _prevState: ProposalActionState,
  formData: FormData,
): Promise<ProposalActionState> {
  const guard = await requirePermissionSafe("proposal.edit");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

  const parsed = sendProposalSchema.safeParse({
    proposalId: formData.get("proposalId"),
    lockVersion: formData.get("lockVersion"),
    channels: formData.getAll("channels"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("send_proposal", {
    p_proposal_id: parsed.data.proposalId,
    p_lock_version: parsed.data.lockVersion,
    p_channels: parsed.data.channels,
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidateLeadRoutes(leadId);
  return { ok: true };
}

export async function decideProposalAction(
  leadId: string,
  _prevState: ProposalActionState,
  formData: FormData,
): Promise<ProposalActionState> {
  const guard = await requirePermissionSafe("proposal.edit");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

  const parsed = decideProposalSchema.safeParse({
    proposalId: formData.get("proposalId"),
    lockVersion: formData.get("lockVersion"),
    decision: formData.get("decision"),
    note: formData.get("note") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("decide_proposal", {
    p_proposal_id: parsed.data.proposalId,
    p_lock_version: parsed.data.lockVersion,
    p_decision: parsed.data.decision,
    ...(parsed.data.note ? { p_note: parsed.data.note } : {}),
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidateLeadRoutes(leadId);
  return { ok: true };
}
