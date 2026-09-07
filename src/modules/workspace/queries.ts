import { createServerSupabaseClient } from "@/server/supabase/server";
import type { Role } from "@/server/authz/permissions";

export type WorkspaceOption = {
  id: string;
  name: string;
  slug: string;
  role: Role;
};

/**
 * Todos os workspaces do usuário autenticado, para o seletor da sidebar —
 * já vem filtrado pela RLS de memberships, não precisa de where extra.
 */
export async function listMyWorkspaces(): Promise<WorkspaceOption[]> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("memberships")
    .select("role, workspace:workspaces(id, name, slug)")
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
