"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";

/**
 * Lista de conversas com memória da rolagem. Trocar de conversa muda o parâmetro `[id]` da rota e o Next
 * remonta a página inteira (a lista também), então a rolagem voltaria ao topo a cada clique. Aqui a posição
 * é guardada por busca, filtro e página (sessionStorage) e restaurada antes de pintar. Se a conversa
 * destacada não estiver visível — abertura direta por link ou retorno do celular —, ela é trazida para a
 * área visível. Sem sessionStorage (modo privado, bloqueio), a lista só começa no topo.
 */
export function ScrollMemoryList({
  storageKey,
  className,
  children,
}: {
  storageKey: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLUListElement | null>(null);
  const frame = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Trocar só o filtro/busca/página não remonta a lista: sem posição guardada para a nova combinação,
    // volta ao topo em vez de ficar numa posição que não vale mais.
    let saved = 0;
    try {
      const raw = Number(window.sessionStorage.getItem(storageKey));
      if (Number.isFinite(raw) && raw > 0) saved = raw;
    } catch {
      /* sem armazenamento: começa no topo */
    }
    el.scrollTop = saved;
    const current = el.querySelector<HTMLElement>('[aria-current="page"]');
    if (current) {
      const box = el.getBoundingClientRect();
      const item = current.getBoundingClientRect();
      if (item.top < box.top || item.bottom > box.bottom) current.scrollIntoView({ block: "nearest" });
    }
  }, [storageKey]);

  function onScroll() {
    if (frame.current !== null) return;
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null;
      try {
        window.sessionStorage.setItem(storageKey, String(ref.current?.scrollTop ?? 0));
      } catch {
        /* sem armazenamento: nada a guardar */
      }
    });
  }

  return (
    <ul ref={ref} onScroll={onScroll} className={className}>
      {children}
    </ul>
  );
}
