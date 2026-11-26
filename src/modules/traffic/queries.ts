import { createServerSupabaseClient } from "@/server/supabase/server";
import { DataLoadError } from "@/server/data/load-error";

/**
 * Única leitura de banco da página de Tráfego Pago: o escritório ativo é demonstrativo?
 * `workspaces.is_demo` só muda por SQL direto (o app não tem permissão de UPDATE nela). Qualquer falha LANÇA:
 * nunca vira "é demonstração" (mostraria números fictícios num escritório real) nem "sem conta conectada".
 */
export async function getTrafficWorkspaceMode(workspaceId: string): Promise<"demo" | "disconnected"> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.from("workspaces").select("is_demo").eq("id", workspaceId).single();
  if (error || !data) throw new DataLoadError("o tipo do escritório para o Tráfego Pago", error ?? undefined);
  return data.is_demo === true ? "demo" : "disconnected";
}
