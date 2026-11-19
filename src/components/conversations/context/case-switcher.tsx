"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, Link2 } from "lucide-react";

import { cn } from "@/lib/cn";
import type { CaseBadge } from "@/modules/conversations/case-display";
import { CaseBadgeChip } from "./case-badge";

export type CaseSwitcherOption = {
  id: string;
  href: string;
  title: string;
  /** "Aberta em 12/03/2026" + desempate real quando há casos parecidos. */
  openedLine: string;
  badge: CaseBadge;
  isLinked: boolean;
  selected: boolean;
};

/**
 * Escolha do caso mostrado no painel. Cada opção é um LINK (`?caso=`): muda só o foco da tela — o vínculo
 * gravado da conversa não muda e nada é transferido. Fecha com Esc, clique fora ou escolha.
 */
export function CaseSwitcher({ options, label }: { options: CaseSwitcherOption[]; label: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-meta font-semibold text-text-secondary transition-colors hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
      >
        {label}
        <ChevronDown size={14} aria-hidden className={cn("transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <ul
          id={listId}
          aria-label="Casos deste contato"
          // Ancorado à direita (o botão fica no canto direito do painel): abre para dentro, sem transbordar.
          className="absolute right-0 top-full z-20 m-0 mt-1.5 flex max-h-[320px] w-[280px] max-w-[calc(100vw-2rem)] list-none flex-col gap-1 overflow-y-auto rounded-card border border-border bg-surface p-1.5 shadow-xl"
        >
          {options.map((o) => (
            <li key={o.id}>
              <Link
                href={o.href as never}
                onClick={() => setOpen(false)}
                aria-current={o.selected ? "true" : undefined}
                className={cn(
                  "flex items-start gap-2 rounded-input px-2.5 py-2 no-underline transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring",
                  o.selected ? "bg-primary-tint" : "hover:bg-surface-hover",
                )}
              >
                <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-primary" aria-hidden>
                  {o.selected ? <Check size={14} /> : null}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-small font-semibold text-text [overflow-wrap:anywhere]">{o.title}</span>
                  <span className="text-meta text-text-tertiary">{o.openedLine}</span>
                  <span className="flex flex-wrap items-center gap-1">
                    <CaseBadgeChip badge={o.badge} />
                    {o.isLinked ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-px text-label font-semibold text-text-tertiary">
                        <Link2 size={10} aria-hidden />
                        vínculo da conversa
                      </span>
                    ) : null}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
