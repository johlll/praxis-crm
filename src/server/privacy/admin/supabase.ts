import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/server/types/database";

/**
 * Cliente `service_role` PRÓPRIO da exportação de dados do titular (C3a) — mesmo
 * desenho do cliente da B1 (src/server/proposals/admin/supabase.ts), pelo mesmo
 * motivo: o cliente da A11 (src/server/supabase/admin.ts) exige, na MESMA validação,
 * todas as variáveis de ingestão (Turnstile, Upstash, Inngest...) e é restrito por lint
 * a webhooks e jobs. Aqui só entra o que esta feature usa.
 *
 * Por que service_role: as três RPCs da exportação (`request_privacy_export`,
 * `get_privacy_export_payload`, `finish_privacy_export`) têm EXECUTE só para
 * service_role. A leitura devolve o conjunto completo e o ciphertext do CPF/CNPJ, então
 * nenhuma sessão de usuário pode chamá-la direto — só a rota de entrega, que autoriza
 * pela sessão (`privacy.manage`), envia o ator já validado e decifra em Node.
 */
const schema = z.object({
  SUPABASE_SECRET_KEY: z.string().min(1),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
});

export function createPrivacyAdminSupabaseClient(): SupabaseClient<Database> {
  const parsed = schema.parse({
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  });
  return createClient<Database>(parsed.NEXT_PUBLIC_SUPABASE_URL, parsed.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
