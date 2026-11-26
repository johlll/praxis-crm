import type { ReactNode } from "react";
import { Bell, Plus } from "lucide-react";

import { cn } from "@/lib/cn";
import type { Role } from "@/lib/roles";
import { GlobalSearch } from "./global-search";

type TopbarProps = {
  title: string;
  subtitle?: string;
  /** No celular, deixa o subtítulo quebrar linha em vez de cortar (quando ele é a explicação da tela). */
  wrapSubtitle?: boolean;
  /** Ações próprias da tela, alinhadas à direita antes das ações globais. */
  actions?: ReactNode;
  /**
   * Mantido por compatibilidade com as telas existentes: desde o
   * refinamento visual (15/11/2026) a conta e o papel aparecem no rodapé da
   * barra lateral, como nas referências aprovadas.
   */
  user?: {
    fullName: string;
    initials: string;
    role: Role;
  };
};

/**
 * Cabeçalho das telas internas, no mesmo fundo da página (sem faixa
 * branca): título forte sem exagero, subtítulo discreto e ações à direita.
 */
export function Topbar({ title, subtitle, actions, wrapSubtitle = false }: TopbarProps) {
  return (
    // px-5 alinha com o p-5 do <main> das telas existentes.
    <header className="flex shrink-0 items-center gap-3 px-5 pt-4 pb-2 md:min-h-[68px] md:gap-4 md:pt-5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h1 className="m-0 truncate text-[19px] leading-tight font-bold tracking-[-0.3px] text-text md:text-[22px]">
          {title}
        </h1>
        {subtitle ? (
          <p className={cn("m-0 truncate text-small text-text-muted", wrapSubtitle && "max-md:whitespace-normal")}>{subtitle}</p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {actions}
        <div className="hidden lg:block">
          <GlobalSearch />
        </div>

        <button
          type="button"
          className="flex h-[34px] items-center gap-1.5 rounded-[9px] bg-primary px-2.5 text-[12.5px] font-bold text-on-solid shadow-card transition-colors hover:bg-primary-hover md:px-3.5"
        >
          <Plus size={15} strokeWidth={2} aria-hidden />
          <span className="max-md:sr-only">Criar</span>
        </button>

        <button
          type="button"
          aria-label="Notificações"
          className="flex size-[34px] items-center justify-center rounded-[9px] border border-border text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
        >
          <Bell size={16} strokeWidth={1.5} aria-hidden />
        </button>
      </div>
    </header>
  );
}
