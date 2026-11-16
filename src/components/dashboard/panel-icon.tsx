import type { LucideIcon } from "lucide-react";

/** Ícone discreto do cabeçalho de cada painel: bronze só no detalhe. */
export function PanelIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-[9px] border border-accent-border/70 bg-accent-tint text-accent"
    >
      <Icon size={16} strokeWidth={1.6} />
    </span>
  );
}
