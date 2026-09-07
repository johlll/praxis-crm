import { createServerSupabaseClient } from "@/server/supabase/server";
import type { Role } from "@/server/authz/permissions";

export type WorkspaceOption = {
  id: string;
  name: string;
  slug: string;
  role: Role;
};

/**
 * Todos os workspaces do usuário autenticado, para o seletor da sidebar.
 * A RLS de memberships é por workspace (qualquer membro vê os colegas),
 * não por dono da linha — sem o filtro por user_id, um workspace
 * compartilhado devolveria uma linha por MEMBRO (não por workspace),
 * inclusive com o papel de outra pessoa.
 */
export async function listMyWorkspaces(): Promise<WorkspaceOption[]> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data } = await supabase
    .from("memberships")
    .select("role, workspace:workspaces(id, name, slug)")
    .eq("user_id", user.id)
    .eq("status", "active")
    .order("created_at", { ascending: true });

  if (!data) return [];

  return data
    .filter((row) => row.workspace !== null)
    .map((row) => ({
      id: row.workspace!.id,
      name: row.workspace!.name,
      slug: row.workspace!.slug,
      role: row.role,
    }));
}
