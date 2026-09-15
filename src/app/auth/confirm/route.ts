import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { createServerSupabaseClient } from "@/server/supabase/server";

/**
 * Callback do link de confirmação de e-mail. Aceita os dois formatos que o
 * Supabase Auth gera:
 * - `?code=` — modelo de e-mail padrão com o fluxo PKCE do @supabase/ssr: o
 *   link passa por `/auth/v1/verify`, que confirma o e-mail e devolve um
 *   código trocado aqui pela sessão (usa o cookie `code-verifier` gravado no
 *   cadastro, então só funciona no mesmo navegador);
 * - `?token_hash=&type=` — modelo de e-mail personalizado apontando direto
 *   para esta rota, verificado com verifyOtp.
 * Depois de confirmado, o usuário já está autenticado; segue para o
 * onboarding (criar o primeiro workspace ou abrir o link do convite).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  if (code) {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) redirect("/onboarding");
  } else if (tokenHash && type) {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) redirect("/onboarding");
  }

  redirect("/entrar?erro=confirmacao_invalida");
}
