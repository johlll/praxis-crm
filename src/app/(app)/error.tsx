"use client";

import { useEffect } from "react";

import { ErrorState } from "@/components/feedback/error-state";

/**
 * Limite de erro das rotas autenticadas que não têm um próprio (atividades,
 * pipeline, oportunidade, contatos, configurações, visão geral). `retry`
 * refaz a busca no servidor (a alternativa só re-renderizaria o mesmo erro).
 */
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    // Só no console do navegador — nunca detalhe interno na tela.
    console.error(error);
  }, [error]);

  return (
    <main className="flex-1 overflow-y-auto p-5">
      <div className="mx-auto max-w-[1100px]">
        <ErrorState
          title="Não foi possível carregar esta página"
          description="Tente novamente em instantes. Se continuar, avise o responsável pelo sistema."
          onRetry={retry}
        />
      </div>
    </main>
  );
}
