"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { Search } from "lucide-react";

/** Assinatura estável: a plataforma não muda durante a sessão. */
const subscribe = () => () => {};

/**
 * Busca global do topo — 420×34, como no protótipo. Em A1 é apenas o campo
 * com o atalho funcionando (foco); a busca real depende de dados e entra em A4.
 */
export function GlobalSearch() {
  const inputRef = useRef<HTMLInputElement>(null);

  // No servidor assumimos "não é Mac"; o cliente corrige na hidratação.
  const isMac = useSyncExternalStore(
    subscribe,
    () => /Mac|iPhone|iPad/.test(navigator.userAgent),
    () => false,
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="relative h-[34px] w-[420px]">
      <Search
        size={14}
        strokeWidth={1.5}
        className="pointer-events-none absolute top-1/2 left-[11px] -translate-y-1/2 text-text-muted"
        aria-hidden
      />
      {/* focus-visible substitui o outline nativo por um anel na cor de
          seleção do sistema (--color-primary-ring) — nunca remove sem repor. */}
      <input
        ref={inputRef}
        type="search"
        placeholder="Buscar clientes, processos, oportunidades…"
        aria-label="Busca global"
        aria-keyshortcuts="Meta+K Control+K"
        className="h-full w-full rounded-[9px] border border-border bg-app pr-14 pl-[33px] text-[12.5px] text-text transition-colors placeholder:text-text-muted hover:border-border-input focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
      />
      <kbd
        className="pointer-events-none absolute top-1/2 right-[11px] -translate-y-1/2 rounded-sm border border-border bg-surface px-[5px] py-px font-mono text-[10px] text-text-disabled"
        aria-hidden
      >
        {isMac ? "⌘K" : "Ctrl K"}
      </kbd>
    </div>
  );
}
