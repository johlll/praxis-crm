import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/server/types/database";

/**
 * Cliente `service_role` PRÓPRIO da B1 — deliberadamente separado de
 * `src/server/supabase/admin.ts` (o cliente da A11).
 *
 * Motivo (achado na validação de Preview): aquele cliente lê a config
 * via `getIngestConfig()`, que exige — na MESMA validação Zod — todas as
 * variáveis da A11 (Turnstile, Upstash, Inngest, `CRON_SECRET`, chaves de
 * cifra de payload), mesmo para quem só precisa do `SUPABASE_SECRET_KEY`.
 * Reaproveitá-lo aqui derrubava toda escrita da B1
 * (`begin/finalize/fail_proposal_document`, `queue/mark_proposal_email_*`)
 * em qualquer ambiente sem a A11 configurada — foi exatamente o que
 * aconteceu no Preview desta própria PR, sem nenhuma relação com Resend
 * ou com o que a B1 realmente precisa.
 *
 * Esquema mínimo, validado só no caminho que o usa — mesmo princípio que
 * `getIngestConfig()` já documentava, só que aplicado de fato aqui.
 */
const schema = z.object({
  SUPABASE_SECRET_KEY: z.string().min(1),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
});

export function createProposalsAdminSupabaseClient(): SupabaseClient<Database> {
  const parsed = schema.parse({
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  });
  return createClient<Database>(parsed.NEXT_PUBLIC_SUPABASE_URL, parsed.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
