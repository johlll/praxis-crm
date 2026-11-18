"use client";

import { useLinkStatus } from "next/link";
import { Loader2 } from "lucide-react";

/**
 * Retorno imediato ao clicar num link da lista (conversa ou filtro) enquanto a nova tela carrega. Fica
 * DENTRO do <Link>. Tem tamanho fixo e está sempre renderizado, para não causar deslocamento de
 * layout; só o ícone aparece e some. O texto "Abrindo…" é só para leitor de tela.
 */
export function LinkPending() {
  const { pending } = useLinkStatus();
  return (
    <span aria-hidden={!pending} className="inline-flex size-3.5 shrink-0 items-center justify-center text-text-muted">
      {pending ? (
        <>
          <Loader2 size={13} className="animate-spin" aria-hidden />
          <span role="status" className="sr-only">
            Abrindo…
          </span>
        </>
      ) : null}
    </span>
  );
}
