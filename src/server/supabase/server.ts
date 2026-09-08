import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import type { Database } from "@/server/types/database";
import { getEnv } from "@/server/env";

/**
 * Cliente com a sessão do usuário — para Server Components, Server Actions
 * e Route Handlers. Sujeito à RLS o tempo todo; é o único cliente que o
 * resto da A2 usa (nenhum caminho desta fase precisa da Secret Key).
 *
 * Padrão oficial atual do @supabase/ssr para o App Router: getAll/setAll
 * (não o trio get/set/remove, descontinuado). `cookies()` é assíncrono
 * desde o Next 15 — mantido aqui.
 */
export async function createServerSupabaseClient() {
  const env = getEnv();
  const cookieStore = await cookies();

  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Chamado de dentro de um Server Component (não pode escrever
            // cookie). Sem problema: o middleware já cuida de renovar a
            // sessão a cada request antes de qualquer Server Component
            // rodar.
          }
        },
      },
    },
  );
}
