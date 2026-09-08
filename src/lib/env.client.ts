/**
 * As duas únicas variáveis que o navegador pode ver. `src/server/env.ts`
 * valida o conjunto completo (inclusive segredos) no servidor; este
 * arquivo existe separado, fora de `src/server/`, para nunca puxar um
 * segredo para dentro do bundle do cliente por engano — o Next.js só
 * inlina `process.env.NEXT_PUBLIC_*` acessado de forma estática como esta.
 */
export function getClientEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ausentes. Veja .env.example.",
    );
  }

  return { url, publishableKey };
}
