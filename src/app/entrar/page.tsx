import type { Metadata } from "next";

import { AuthForm } from "@/components/auth/auth-form";
import { Alert, AlertDescription } from "@/components/ui/alert";

export const metadata: Metadata = {
  title: "Entrar — Praxis CRM Jurídico",
};

type EntrarPageProps = {
  searchParams: Promise<{ next?: string; email?: string; erro?: string }>;
};

/** Avisos da volta do link de confirmação (`/auth/confirm`). "Link
 * inválido" e "sessão não criada" pedem ações diferentes: no primeiro o
 * e-mail não foi confirmado e é preciso um link novo; no segundo a conta já
 * está confirmada e basta entrar. */
const AVISOS: Record<string, string> = {
  link_invalido:
    "O link de confirmação é inválido ou já expirou. Crie a conta de novo com o mesmo e-mail para receber um link novo.",
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
