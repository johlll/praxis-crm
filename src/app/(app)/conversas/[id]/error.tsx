"use client";

import { useEffect } from "react";

import { ErrorState } from "@/components/feedback/error-state";

export default function ConversaError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex-1 overflow-y-auto p-5">
      <div className="mx-auto max-w-[760px]">
        <ErrorState
          title="Não foi possível carregar esta conversa"
          description="Não deu para buscar o histórico de mensagens. Tente novamente em instantes; se continuar, avise o responsável pelo sistema."
          onRetry={reset}
        />
      </div>
    </main>
  );
}
