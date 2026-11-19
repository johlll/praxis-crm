"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/**
 * Consentimento do contato, em seção secundária recolhível. Começa ABERTA quando falta consentimento vigente
 * (é o que bloqueia o envio) e recolhida nos demais casos. Depois disso quem manda é a pessoa: registrar o
 * consentimento atualiza a tela, mas não fecha a seção no meio da leitura da confirmação.
 */
export function ConsentDisclosure({ children, defaultOpen = false }: { children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="group rounded-card border border-border bg-surface"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-3 text-small font-semibold text-text-secondary marker:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-ring [&::-webkit-details-marker]:hidden">
        Consentimento do contato
        <ChevronDown size={15} className="shrink-0 transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="border-t border-border px-3.5 py-3">{children}</div>
    </details>
  );
}
