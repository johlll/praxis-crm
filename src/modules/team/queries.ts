import { createServerSupabaseClient } from "@/server/supabase/server";
import type { Role } from "@/server/authz/permissions";

export type TeamMember = {
  membershipId: string;
  userId: string;
  fullName: string | null;
  email: string;
  role: Role;
  isCurrentUser: boolean;
};

export type PendingInvitation = {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdAt: string;
};

/**
 * Lista de membros do workspace ativo. A RLS de memberships já restringe
 * ao workspace passado (e não deixaria ler de outro mesmo que o
 * `workspaceId` viesse adulterado) — o filtro aqui é só para não puxar
 * membership de workspace nenhum a mais na mesma resposta.
 */
export async function listTeamMembers(
  workspaceId: string,
  currentUserId: string,
): Promise<TeamMember[]> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("memberships")
    .select("id, user_id, role, user:users(full_name, email)")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });

  if (!data) return [];

  return data
    .filter((row) => row.user !== null)
    .map((row) => ({
      membershipId: row.id,
      userId: row.user_id,
      fullName: row.user!.full_name,
      email: row.user!.email,
      role: row.role,
      isCurrentUser: row.user_id === currentUserId,
    }));
}

/** Só chega aqui quem já passou por requirePermission("invitation.view")
 * no caller — a RLS de workspace_invitations também já restringe a
 * owner/admin sozinha, esta é a segunda camada, não a única. */
export async function listPendingInvitations(workspaceId: string): Promise<PendingInvitation[]> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("workspace_invitations")
    .select("id, email, role, expires_at, created_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  return (data ?? []).map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }));
}
