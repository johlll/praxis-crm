import { isAuthRetryableFetchError } from "@supabase/supabase-js";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { DataLoadError } from "@/server/data/load-error";
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
    error: userError,
  } = await supabase.auth.getUser();
  if (userError && isAuthRetryableFetchError(userError)) throw new DataLoadError("a sessão do usuário", userError);
  if (!user) return [];

  const { data, error } = await supabase
    .from("memberships")
    .select("role, workspace:workspaces(id, name, slug)")
    .eq("user_id", user.id)
    .eq("status", "active")
    .order("created_at", { ascending: true });

  if (error) throw new DataLoadError(`os workspaces do usuário ${user.id}`, error);
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

export type WorkspaceLegalProfile = {
  legalName: string | null;
  cnpj: string | null;
  oabUf: string | null;
  oabNumber: string | null;
  addressLine: string | null;
  addressCity: string | null;
  addressUf: string | null;
  addressZip: string | null;
};

/** Cabeçalho do PDF de proposta (B1). Leitura direta — workspaces_select
 * já permite a qualquer membro ativo (A2), sem função nova. */
export async function getWorkspaceLegalProfile(workspaceId: string): Promise<WorkspaceLegalProfile | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("workspaces")
    .select("legal_name, cnpj, oab_uf, oab_number, address_line, address_city, address_uf, address_zip")
    .eq("id", workspaceId)
    .maybeSingle();

  if (error) throw new DataLoadError(`o perfil jurídico do workspace ${workspaceId}`, error);
  if (!data) return null;

  return {
    legalName: data.legal_name,
    cnpj: data.cnpj,
    oabUf: data.oab_uf,
    oabNumber: data.oab_number,
    addressLine: data.address_line,
    addressCity: data.address_city,
    addressUf: data.address_uf,
    addressZip: data.address_zip,
  };
}
