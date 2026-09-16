import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { createServerSupabaseClient } from "@/server/supabase/server";

/**
 * Callback do link de confirmação de e-mail. Aceita os dois formatos que o
 * Supabase Auth gera:
 * - `?token_hash=&type=` — modelo de e-mail apontando direto para cá (o que
 *   o `praxis-crm-dev` usa desde a troca do modelo). Vale pelo prazo do
 *   token (`mailer_otp_exp`) e funciona em qualquer navegador;
 * - `?code=` — modelo padrão com o fluxo PKCE: o link passa por
 *   `/auth/v1/verify`, que já confirma o e-mail e devolve um código trocado
 *   aqui pela sessão (depende do cookie gravado no cadastro, então só vale
 *   no mesmo navegador e por pouco tempo).
 *
 * Os dois modos de falha são diferentes e não podem virar a mesma
 * mensagem: se o próprio Auth recusou o link (`?error=`), ou se o
 * `verifyOtp` falhou, o e-mail NÃO foi confirmado e é preciso um link novo;
 * se o código veio mas a sessão não pôde ser aberta, o e-mail já está
 * confirmado e basta entrar com a senha.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const authError = searchParams.get("error") ?? searchParams.get("error_code");

  if (!authError) {
    if (code) {
      const supabase = await createServerSupabaseClient();
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) redirect("/onboarding");
      // O /auth/v1/verify já confirmou o e-mail antes de redirecionar para
      // cá; só a sessão não saiu.
      redirect("/entrar?erro=sessao_nao_criada");
    }

    if (tokenHash && type) {
      const supabase = await createServerSupabaseClient();
      const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
      if (!error) redirect("/onboarding");
    }
  }

  redirect("/entrar?erro=link_invalido");
}
