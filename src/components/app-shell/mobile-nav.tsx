"use client";

import { useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Menu, X } from "lucide-react";

import { SidebarContent, type SidebarUser, type SidebarWorkspace } from "./sidebar";

type MobileNavProps = {
  activeWorkspace: SidebarWorkspace;
  workspaces: SidebarWorkspace[];
  overdueActivitiesCount?: number | undefined;
  user?: SidebarUser | undefined;
};

/**
 * Abaixo de 1024 px a barra lateral vira uma gaveta: mesma navegação,
 * mesmo seletor de workspace e mesmas ações de conta — nada some no
 * celular, só muda de lugar. Fecha ao escolher um destino.
 */
export function MobileNav(props: MobileNavProps) {
  const [open, setOpen] = useState(false);
  const overdue = props.overdueActivitiesCount ?? 0;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-sidebar px-4 md:hidden">
        <DialogPrimitive.Trigger asChild>
          <button
            type="button"
            aria-label="Abrir menu"
            className="relative flex size-9 items-center justify-center rounded-md text-sidebar-text-strong transition-colors hover:bg-sidebar-hover"
          >
            <Menu size={20} strokeWidth={1.5} aria-hidden />
            {overdue > 0 ? (
              <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-danger" aria-hidden />
            ) : null}
          </button>
        </DialogPrimitive.Trigger>
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="flex size-7 shrink-0 items-center justify-center rounded-[8px] border border-accent-border bg-accent-tint font-serif text-lead leading-none text-accent"
            aria-hidden
          >
            P
          </span>
          {/* Só a marca: o nome do workspace fica no seletor da gaveta (repetir
              o texto aqui duplicaria o nome no DOM também no desktop). */}
          <span className="font-serif text-[19px] leading-none text-sidebar-text-strong">Praxis</span>
        </div>
      </div>

      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 md:hidden" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 left-0 z-50 flex w-[min(300px,86vw)] flex-col border-r border-white/[0.06] bg-sidebar shadow-raised md:hidden"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("a")) setOpen(false);
          }}
        >
          <DialogPrimitive.Title className="sr-only">Menu de navegação</DialogPrimitive.Title>
          <DialogPrimitive.Close
            aria-label="Fechar menu"
            className="absolute top-4 right-3 z-10 flex size-8 items-center justify-center rounded-md text-sidebar-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-text-strong"
          >
            <X size={18} strokeWidth={1.5} aria-hidden />
          </DialogPrimitive.Close>
          <SidebarContent {...props} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
