"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { requirePermission, requireUser } from "@/server/authz/permissions";
import { switchActiveWorkspace } from "@/server/auth/workspace";
import { getRequestOrigin } from "@/server/request-origin";
import { toUserMessage } from "@/lib/errors";
import {
  acceptInvitationSchema,
  createInvitationSchema,
  invitationIdSchema,
  membershipIdSchema,
  updateMembershipRoleSchema,
} from "./schema";

export type TeamActionState = {
  ok: boolean;
  error?: string;
  /** Só preenchido na criação de convite — o link é mostrado UMA vez. */
  inviteLink?: string;
};

/**
 * Cria o convite. A verificação "é owner/admin" acontece duas vezes por
 * design: aqui (requirePermission, para dar erro sanitizado cedo) e de
 * novo dentro de create_workspace_invitation() no banco (porque a
 * autorização de verdade nunca pode depender só do que o servidor Next.js
 * decidiu — se algum dia outro caminho chamar essa função RPC, ela
 * continua segura sozinha).
 */
export async function createInvitationAction(
  _prevState: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const ctx = await requirePermission("invitation.manage");

  const parsed = createInvitationSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  // Resolvido ANTES de criar o convite: se a origem não puder ser
  // determinada, é melhor não criar nada do que criar e não conseguir
  // mostrar o link.
  let origin: string;
  try {
    origin = await getRequestOrigin();
  } catch {
    return { ok: false, error: "Não foi possível montar o link de convite. Tente novamente." };
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("create_workspace_invitation", {
    p_workspace_id: ctx.workspaceId,
    p_email: parsed.data.email,
    p_role: parsed.data.role,
  });

  if (error || !data || data.length === 0) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath("/configuracoes/equipe");

  const invite = data[0];
  if (!invite) {
    return { ok: false, error: toUserMessage(error) };
  }

  return {
    ok: true,
    inviteLink: `${origin}/convite/${invite.token}`,
  };
}

export async function cancelInvitationAction(formData: FormData): Promise<void> {
  await requirePermission("invitation.manage");

  const parsed = invitationIdSchema.safeParse({
    invitationId: formData.get("invitationId"),
  });
  if (!parsed.success) return;

  const supabase = await createServerSupabaseClient();
  await supabase.rpc("cancel_workspace_invitation", {
    p_invitation_id: parsed.data.invitationId,
  });

  revalidatePath("/configuracoes/equipe");
}

export async function updateMembershipRoleAction(formData: FormData): Promise<void> {
  await requirePermission("membership.manage");

  const parsed = updateMembershipRoleSchema.safeParse({
    membershipId: formData.get("membershipId"),
    role: formData.get("role"),
  });
  if (!parsed.success) return;

  const supabase = await createServerSupabaseClient();
  await supabase.rpc("update_membership_role", {
    p_membership_id: parsed.data.membershipId,
    p_new_role: parsed.data.role,
  });

  revalidatePath("/configuracoes/equipe");
}

export async function removeMembershipAction(formData: FormData): Promise<void> {
  await requirePermission("membership.manage");

  const parsed = membershipIdSchema.safeParse({
    membershipId: formData.get("membershipId"),
  });
  if (!parsed.success) return;

  const supabase = await createServerSupabaseClient();
  await supabase.rpc("remove_membership", {
    p_membership_id: parsed.data.membershipId,
  });

  revalidatePath("/configuracoes/equipe");
}

export type AcceptInvitationState = {
  ok: boolean;
  error?: string;
};

/**
 * O e-mail da sessão é conferido dentro de accept_workspace_invitation()
 * no banco — esta action não repete a checagem, só encaminha; duplicar a
 * regra aqui só criaria dois lugares para ela divergir.
 */
export async function acceptInvitationAction(
  _prevState: AcceptInvitationState,
  formData: FormData,
): Promise<AcceptInvitationState> {
  await requireUser();

  const parsed = acceptInvitationSchema.safeParse({
    token: formData.get("token"),
  });
  if (!parsed.success) {
    return { ok: false, error: "Link de convite inválido." };
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("accept_workspace_invitation", {
    p_token: parsed.data.token,
  });

  if (error || !data) {
    return { ok: false, error: toUserMessage(error) };
  }

  // Sem isto, quem acabou de aceitar caía em /onboarding: aceitar cria a
  // membership, mas não mexe no cookie de workspace ativo sozinho — e sem
  // cookie válido, requireMembershipOrRedirect() manda para onboarding
  // mesmo já sendo membro de verdade.
  await switchActiveWorkspace(data.workspace_id);

  redirect("/visao-geral");
}
