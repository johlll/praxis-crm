import { Bell, Plus } from "lucide-react";

import { ROLE_LABEL, type Role } from "@/lib/roles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GlobalSearch } from "./global-search";
import { SignOutItem } from "./sign-out-item";

type TopbarProps = {
  title: string;
  subtitle?: string;
  user: {
    fullName: string;
    initials: string;
    role: Role;
  };
};

/**
 * Cabeçalho das telas internas — medidas conferidas nos protótipos
 * (header 60px, título 16.5px/700, busca central de 420×34). O usuário à
 * direita vem da sessão real (ver `(app)/layout.tsx`), não mais fixo.
 */
export function Topbar({ title, subtitle, user }: TopbarProps) {
  return (
    <header className="flex h-[60px] shrink-0 items-center gap-[18px] border-b border-border bg-surface px-5">
      <div className="flex min-w-0 flex-col">
        <h1 className="m-0 truncate text-[16.5px] leading-tight font-bold tracking-[-0.2px] text-text">
          {title}
        </h1>
        {subtitle ? (
          <p className="m-0 truncate text-meta text-text-soft">{subtitle}</p>
        ) : null}
      </div>

      <div className="flex flex-1 justify-center">
        <GlobalSearch />
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          className="flex h-[34px] items-center gap-1.5 rounded-[9px] bg-primary px-3.5 text-[12.5px] font-bold text-white shadow-[0_1px_2px_rgba(12,46,44,0.22)] transition-colors hover:bg-primary-hover"
        >
          <Plus size={14} strokeWidth={2} aria-hidden />
          Criar
        </button>

        <button
          type="button"
          aria-label="Notificações"
          className="flex size-8 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-app"
        >
          <Bell size={17} strokeWidth={1.3} aria-hidden />
        </button>

        <div className="mx-[3px] h-[22px] w-px bg-border" aria-hidden />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Menu do usuário"
              className="flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-app"
            >
              <div
                className="flex size-8 items-center justify-center rounded-md bg-primary-tint text-[11px] font-bold text-primary"
                aria-hidden
              >
                {user.initials}
              </div>
              <div className="flex flex-col text-left leading-[1.2]">
                <span className="text-[11.5px] font-semibold text-text">
                  {user.fullName}
                </span>
                <span className="text-[10px] text-text-muted">
                  {ROLE_LABEL[user.role]}
                </span>
              </div>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[200px]">
            <DropdownMenuItem asChild>
              <a href="/configuracoes/equipe">Equipe</a>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <SignOutItem />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
