import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { calendarEnvHeaders } from "@/server/calendar/environment";
import type { Database } from "@/server/types/database";

/**
 * Cliente `service_role` PRÓPRIO do módulo de calendário (B2) — separado do
 * da A11 e do da B1 pelo mesmo motivo documentado em
 * `src/server/proposals/admin/supabase.ts`: validar só o que este caminho
 * usa. As funções de escrita de calendário têm GRANT só a service_role de
 * propósito (nenhum usuário autenticado fabrica conexão ou vínculo por RPC
 * direta).
 *
 * Todo pedido leva o cabeçalho de ambiente, derivado de `VERCEL_ENV` no
 * servidor — é ele que o banco usa para recusar operação de outro
 * ambiente.
 */
const schema = z.object({
  SUPABASE_SECRET_KEY: z.string().min(1),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
});

export function createCalendarAdminSupabaseClient(): SupabaseClient<Database> {
  const parsed = schema.parse({
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  });
  return createClient<Database>(parsed.NEXT_PUBLIC_SUPABASE_URL, parsed.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: calendarEnvHeaders() },
  });
}
