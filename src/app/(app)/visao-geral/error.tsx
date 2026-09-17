"use client";

import { useEffect } from "react";

import { ErrorState } from "@/components/feedback/error-state";

export default function VisaoGeralError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    // Só no console do navegador — nunca detalhe interno na tela (checklist).
    console.error(error);
  }, [error]);

  return (
    <main className="flex-1 overflow-y-auto p-5">
      <div className="mx-auto max-w-[1400px]">
        <ErrorState
          title="Não foi possível carregar a visão geral"
          description="Os indicadores não foram calculados, então nenhum número é mostrado no lugar deles. Tente novamente em instantes; se continuar, avise o responsável pelo sistema."
          onRetry={retry}
        />
      </div>
    </main>
  );
}
