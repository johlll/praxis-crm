import { createServerSupabaseClient } from "@/server/supabase/server";
import { DataLoadError } from "@/server/data/load-error";

/**
 * O escritório é demonstrativo? Única porta para dados fictícios: `workspaces.is_demo`, que o app não tem
 * permissão de alterar (só SQL direto). Parâmetro de URL, nome ou papel não contam. Falha LANÇA: nunca vira
 * "é demonstração" (mostraria número fictício num escritório real) nem "não é".
 */
export async function isDemoWorkspace(workspaceId: string): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.from("workspaces").select("is_demo").eq("id", workspaceId).single();
  if (error || !data) throw new DataLoadError("o tipo do escritório", error ?? undefined);
  return data.is_demo === true;
}
