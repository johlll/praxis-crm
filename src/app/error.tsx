"use client";

import { useEffect } from "react";

import { ErrorState } from "@/components/feedback/error-state";

/**
 * Cobre falhas no `(app)/layout.tsx` (sessão, workspace, contador da
 * sidebar), que o `(app)/error.tsx` não alcança por estar no mesmo segmento.
 */
export default function RootError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-[480px]">
        <ErrorState
          title="Não foi possível abrir o Praxis agora"
          description="Tente novamente em instantes. Se continuar, avise o responsável pelo sistema."
          onRetry={retry}
        />
      </div>
    </div>
  );
}
