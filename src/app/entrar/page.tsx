import type { Metadata } from "next";

import { AuthForm } from "@/components/auth/auth-form";
import { Alert, AlertDescription } from "@/components/ui/alert";

export const metadata: Metadata = {
  title: "Entrar — Praxis CRM Jurídico",
};

type EntrarPageProps = {
  searchParams: Promise<{ next?: string; email?: string; erro?: string }>;
};

/** Avisos da volta do link de confirmação (`/auth/confirm`). São três
 * coisas distintas e o texto não pode confundi-las: a validade do LINK, o
 * ESTADO DA CONTA e a abertura da SESSÃO. "Link inválido" só diz que
 * aquele link não vale mais (expirou ou já foi usado) — não prova nada
 * sobre a conta estar confirmada, então oferece os dois caminhos. "Sessão
 * não criada" é o caso em que o Auth confirmou o e-mail e só a sessão não
 * saiu: aí a conta está confirmada e basta entrar. */
const AVISOS: Record<string, string> = {
  link_invalido:
    "Este link de confirmação não vale mais: já foi usado ou expirou. Isso não diz se a sua conta está confirmada — se já estiver, é só entrar abaixo. Se o login pedir confirmação, use \"Criar conta\" com o mesmo e-mail para receber um link novo: sua conta é mantida e a senha continua sendo a que você já cadastrou.",
  sessao_nao_criada:
    "Seu e-mail foi confirmado, mas não foi possível abrir a sessão por este link. Entre com seu e-mail e senha.",
};

export default async function EntrarPage({ searchParams }: EntrarPageProps) {
  const params = await searchParams;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <div className="flex w-full max-w-[380px] flex-col items-center gap-8">
        <div className="flex items-center gap-2.5">
          <div
            className="flex size-9 items-center justify-center rounded-[9px] bg-sidebar-active font-serif text-display leading-none text-sidebar-active-text"
            aria-hidden
          >
            P
          </div>
          <div className="flex flex-col gap-px">
            <span className="font-serif text-display leading-none text-text">
              Praxis
            </span>
            <span className="text-label tracking-[1.3px] text-text-tertiary uppercase">
              CRM Jurídico
            </span>
          </div>
        </div>

        {AVISOS[params.erro ?? ""] ? (
          <Alert variant="danger" className="w-full">
            <AlertDescription>{AVISOS[params.erro ?? ""]}</AlertDescription>
          </Alert>
        ) : null}

        <AuthForm {...(params.next ? { next: params.next } : {})} {...(params.email ? { defaultEmail: params.email } : {})} />
      </div>
    </div>
  );
}
