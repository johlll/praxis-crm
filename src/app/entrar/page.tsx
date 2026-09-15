import type { Metadata } from "next";

import { AuthForm } from "@/components/auth/auth-form";
import { Alert, AlertDescription } from "@/components/ui/alert";

export const metadata: Metadata = {
  title: "Entrar — Praxis CRM Jurídico",
};

type EntrarPageProps = {
  searchParams: Promise<{ next?: string; email?: string; erro?: string }>;
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

        {params.erro === "confirmacao_invalida" ? (
          <Alert variant="danger" className="w-full">
            <AlertDescription>
              O link de confirmação é inválido, expirou ou foi aberto em outro
              navegador. Tente entrar; se o login pedir confirmação, crie a conta
              de novo com o mesmo e-mail para receber um link novo.
            </AlertDescription>
          </Alert>
        ) : null}

        <AuthForm {...(params.next ? { next: params.next } : {})} {...(params.email ? { defaultEmail: params.email } : {})} />
      </div>
    </div>
  );
}
