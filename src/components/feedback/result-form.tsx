"use client";

import { useActionState, type ReactNode } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import type { ActionResult } from "@/lib/action-result";

/**
 * Formulário para Server Actions que devolvem `ActionResult`: mostra o erro
 * que o servidor devolveu (recusa do banco, permissão, falha de
 * carregamento) em vez de terminar em silêncio. O formulário continua
 * disponível para tentar de novo (o React limpa os campos após cada envio).
 */
export function ResultForm({
  action,
  children,
  className,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  children: ReactNode;
  className?: string;
}) {
  const [state, formAction] = useActionState(
    (_previous: ActionResult | null, formData: FormData) => action(formData),
    null,
  );

  return (
    <div className="flex flex-col gap-1.5">
      <form action={formAction} className={className}>
        {children}
      </form>
      {state && !state.ok ? (
        <Alert variant="danger">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
