import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/server/types/database";

/**
 * Cliente `service_role` PRÓPRIO dos documentos por caso — separado do cliente da A11 e do das propostas,
 * pelo mesmo motivo documentado em src/server/proposals/admin/supabase.ts: esquema mínimo, validado só no
 * caminho que o usa. As funções que gravam o documento (begin/finalize/abandon, remoção em duas fases e a
 * limpeza) têm EXECUTE só para service_role, e o bucket `case-documents` não tem policy nenhuma para
 * anon/authenticated: nenhuma sessão de usuário fabrica documento pronto nem sobe arquivo fora deste fluxo.
 *
 * Importável só de src/server/case-documents/admin/** (regra de lint). Todo chamador já conferiu a sessão e a
 * permissão (requirePermissionSafe); o banco confere de novo papel, escritório, alcance e o portão.
 */
const schema = z.object({
  SUPABASE_SECRET_KEY: z.string().min(1),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
});

export function createCaseDocumentsAdminSupabaseClient(): SupabaseClient<Database> {
  const parsed = schema.parse({
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  });
  return createClient<Database>(parsed.NEXT_PUBLIC_SUPABASE_URL, parsed.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
