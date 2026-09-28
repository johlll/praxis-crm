import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getIngestConfig } from "@/server/ingest/config";
import type { Database } from "@/server/types/database";

/**
 * Cliente `service_role` — IGNORA a RLS por completo.
 *
 * Importação restrita por lint (`eslint.config.mjs`,
 * `no-restricted-imports`) às rotas de ingestão pública e de jobs:
 * `src/app/api/forms/**`, `src/app/api/webhooks/**`, `src/app/api/cron/**`
 * e `src/app/api/inngest/**`. Nenhuma página, Server Action ou módulo de
 * domínio pode importá-lo — esses caminhos usam a sessão do usuário, para
 * que a RLS continue valendo.
 *
 * Por que um visitante anônimo precisa disto: a rota pública não tem
 * sessão nenhuma. A alternativa seria conceder EXECUTE das funções de
 * ingestão a `anon`, o que permitiria a qualquer um com a chave
 * publicável chamar a RPC direto, pulando Turnstile e rate limit. O
 * service_role fica no servidor, atrás das proteções, e cada função que
 * ele chama continua validando as próprias regras por dentro.
 */
export function createAdminSupabaseClient(): SupabaseClient<Database> {
  const config = getIngestConfig();
  return createClient<Database>(config.NEXT_PUBLIC_SUPABASE_URL, config.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
