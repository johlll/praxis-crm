"use client";

import { useEffect } from "react";

import { ErrorState } from "@/components/feedback/error-state";

/** Falha de leitura: nunca vira "sem conexão" nem "sem resultados". `retry` refaz a busca no servidor. */
export default function TrafficError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex-1 overflow-y-auto p-5">
      <div className="mx-auto max-w-[1100px]">
        <ErrorState
          title="Não foi possível carregar o Tráfego Pago"
          description="Os números não foram carregados. Isso não significa que não há conta conectada nem resultados. Tente novamente em instantes."
          onRetry={retry}
        />
      </div>
    </main>
  );
}
