import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { createServerSupabaseClient } from "@/server/supabase/server";

/**
 * Callback do link de confirmação de e-mail (padrão oficial atual do
 * @supabase/ssr: token_hash + type na URL, verificados via verifyOtp — não
 * o fluxo antigo de "confirmation_url" direto). Depois de confirmado, o
 * usuário já está autenticado; segue para o onboarding (criar o primeiro
 * workspace) — ele ainda não tem membership nenhuma.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  if (tokenHash && type) {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });

    if (!error) {
      redirect("/onboarding");
    }
  }

  redirect("/entrar?erro=confirmacao_invalida");
}
