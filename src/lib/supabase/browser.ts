"use client";

import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/server/types/database";
import { getClientEnv } from "@/lib/env.client";

/**
 * Cliente do navegador — sessão do próprio usuário, sujeita à RLS o tempo
 * todo. Nunca usa a Secret Key. Novo a cada chamada é o padrão recomendado
 * pelo @supabase/ssr (o cliente internamente reaproveita a conexão).
 */
export function createBrowserSupabaseClient() {
  const { url, publishableKey } = getClientEnv();
  return createBrowserClient<Database>(url, publishableKey);
}
