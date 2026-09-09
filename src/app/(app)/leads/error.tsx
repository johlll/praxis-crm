"use client";

import { useEffect } from "react";

import { ErrorState } from "@/components/feedback/error-state";

export default function LeadsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Só no console do navegador — nunca detalhe interno na tela (checklist).
    console.error(error);
  }, [error]);

  return (
    <main className="flex-1 overflow-y-auto p-5">
      <div className="mx-auto max-w-[1100px]">
        <ErrorState
          title="Não foi possível carregar os leads"
          description="Tente novamente em instantes. Se continuar, avise o responsável pelo sistema."
          onRetry={reset}
        />
      </div>
    </main>
  );
}
