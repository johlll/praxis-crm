"use client";

import { useEffect } from "react";

import { ErrorState } from "@/components/feedback/error-state";

export default function CamposPersonalizadosError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    // Só no console do navegador — nunca detalhe interno na tela (checklist).
    console.error(error);
  }, [error]);

  return (
    <main className="flex-1 overflow-y-auto p-5">
      <div className="mx-auto max-w-[900px]">
        <ErrorState
          title="Não foi possível carregar os campos personalizados"
          description="Tente novamente em instantes. Se continuar, avise o responsável pelo sistema."
          onRetry={retry}
        />
      </div>
    </main>
  );
}
