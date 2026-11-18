"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { PanelRight, X } from "lucide-react";

import { cn } from "@/lib/cn";

/**
 * Conversas + IA (PR 2) — casco do painel de contexto.
 *
 * Largura útil decide o formato (a barra lateral de 236 px só existe a partir de 1024):
 * - a partir de 1400 px: terceira coluna fixa;
 * - abaixo disso: gaveta que abre sobre a conversa (no celular, tela cheia).
 *
 * Abrir e fechar só troca classes CSS — o conteúdo e o compositor da conversa
 * continuam montados, então a mensagem digitada nunca se perde.
 */

type PanelContext = {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleRef: React.RefObject<HTMLButtonElement | null>;
};

const Ctx = createContext<PanelContext | null>(null);

function usePanel(): PanelContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("ContextPanel* precisa estar dentro de <ContextPanelProvider>.");
  return ctx;
}

export function ContextPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  return <Ctx.Provider value={{ open, setOpen, toggleRef }}>{children}</Ctx.Provider>;
}

/** Botão que abre o contexto; só aparece quando o painel não é uma coluna fixa. */
export function ContextPanelToggle({ label = "Contexto" }: { label?: string }) {
  const { open, setOpen, toggleRef } = usePanel();
  return (
    <button
      ref={toggleRef}
      type="button"
      onClick={() => setOpen(!open)}
      aria-expanded={open}
      aria-controls="painel-contexto"
      className="flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-small font-semibold text-text-secondary transition-colors hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring min-[1400px]:hidden"
    >
      <PanelRight size={15} aria-hidden />
      <span>{label}</span>
    </button>
  );
}

/**
 * Link-botão para abrir o contexto a partir de outro ponto da tela (por exemplo o aviso de
 * consentimento do compositor). Só aparece quando o painel é gaveta; fora do provedor não renderiza.
 */
export function OpenContextButton({ children }: { children: ReactNode }) {
  const ctx = useContext(Ctx);
  if (!ctx) return null;
  return (
    <button
      type="button"
      onClick={() => ctx.setOpen(true)}
      aria-controls="painel-contexto"
      className="font-semibold underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring min-[1400px]:hidden"
    >
      {children}
    </button>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export function ContextPanelPane({ title, children }: { title: string; children: ReactNode }) {
  const { open, setOpen, toggleRef } = usePanel();
  const paneRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    toggleRef.current?.focus();
  }, [setOpen, toggleRef]);

  useEffect(() => {
    if (!open) return;
    // Só quando é gaveta (abaixo de 1400 px): leva o foco para dentro e o mantém lá.
    const drawer = !window.matchMedia("(min-width: 1400px)").matches;
    if (!drawer) return;
    closeRef.current?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab" || !paneRef.current) return;
      const items = [...paneRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const firstEl = items[0]!;
      const lastEl = items.at(-1)!;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  return (
    <>
      {open ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Fechar o contexto"
          onClick={close}
          className="fixed inset-0 z-30 cursor-default bg-black/55 min-[1400px]:hidden"
        />
      ) : null}
      <aside
        ref={paneRef}
        id="painel-contexto"
        aria-label={title}
        className={cn(
          "min-h-0 flex-col overflow-hidden border-border bg-surface",
          open
            ? "fixed inset-y-0 right-0 z-40 flex w-full max-w-[420px] border-l shadow-2xl"
            : "hidden",
          "min-[1400px]:static min-[1400px]:z-auto min-[1400px]:flex min-[1400px]:w-[340px] min-[1400px]:max-w-none min-[1400px]:shrink-0 min-[1400px]:rounded-card min-[1400px]:border min-[1400px]:shadow-none",
        )}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2.5 min-[1400px]:hidden">
          <h2 className="m-0 text-body font-bold text-text">{title}</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={close}
            aria-label="Fechar o contexto"
            className="flex size-8 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
          >
            <X size={16} aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </aside>
    </>
  );
}
