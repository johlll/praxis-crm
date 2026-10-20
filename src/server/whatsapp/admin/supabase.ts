import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { whatsappEnvHeaders } from "@/server/whatsapp/environment";
import type { Database } from "@/server/types/database";

/**
 * Cliente `service_role` PRÓPRIO do WhatsApp (B3.1) — separado dos da A11,
 * B1 e B2 pelo mesmo motivo documentado em
 * `src/server/proposals/admin/supabase.ts`: validar só o que este caminho
 * usa. As funções de canal e credencial têm EXECUTE só para service_role.
 *
 * Todo pedido leva SÓ o cabeçalho de ambiente do WhatsApp
 * (`X-Praxis-WhatsApp-Env`). O cabeçalho do calendário não é enviado: o
 * banco não o aceitaria para o WhatsApp, e os módulos não compartilham
 * segredos.
 */
const schema = z.object({
  SUPABASE_SECRET_KEY: z.string().min(1),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
});

export function createWhatsAppAdminSupabaseClient(): SupabaseClient<Database> {
  const parsed = schema.parse({
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  });
  return createClient<Database>(parsed.NEXT_PUBLIC_SUPABASE_URL, parsed.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: whatsappEnvHeaders() },
  });
}
