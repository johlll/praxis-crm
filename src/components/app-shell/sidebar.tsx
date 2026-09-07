"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Briefcase,
  CalendarDays,
  CheckSquare,
  FileText,
  LayoutGrid,
  MessageCircle,
  Settings,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/cn";
import {
  primaryNav,
  secondaryNav,
  type NavIconName,
  type NavItem,
} from "./navigation";

const icons: Record<NavIconName, LucideIcon> = {
  "layout-grid": LayoutGrid,
  users: Users,
  "bar-chart": BarChart3,
  "check-square": CheckSquare,
  calendar: CalendarDays,
  "message-circle": MessageCircle,
  briefcase: Briefcase,
  zap: Zap,
  "file-text": FileText,
  settings: Settings,
};

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = icons[item.icon];

  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-body leading-4 no-underline transition-colors",
        active
          ? "bg-sidebar-active font-bold text-sidebar-active-text shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]"
          : "font-medium text-sidebar-text hover:bg-sidebar-hover hover:text-white hover:no-underline",
      )}
    >
      <Icon size={16} strokeWidth={active ? 1.5 : 1.3} aria-hidden />
      <span>{item.label}</span>
    </Link>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  return (
    <aside className="flex w-sidebar shrink-0 flex-col bg-sidebar px-3 pt-4 pb-3 text-sidebar-text-strong">
      <div className="flex items-center gap-2.5 px-2 pt-1 pb-[18px]">
        <div
          className="flex size-[30px] items-center justify-center rounded-[9px] bg-sidebar-active font-serif text-display leading-none text-sidebar-active-text"
          aria-hidden
        >
          P
        </div>
        <div className="flex flex-col gap-px">
          <span className="font-serif text-display leading-none tracking-[0.2px] text-white">
            Praxis
          </span>
          <span className="text-label leading-[11px] tracking-[1.3px] text-sidebar-muted uppercase">
            CRM Jurídico
          </span>
        </div>
      </div>

      <nav className="flex flex-col gap-0.5" aria-label="Navegação principal">
        {[...primaryNav, ...secondaryNav].map((item) => (
          <NavLink key={item.href} item={item} active={isActive(item.href)} />
        ))}
      </nav>

      <div className="mt-auto flex flex-col gap-3">
        {/*
          O bloco "Metas do mês" do protótipo depende de dados reais
          (consultas realizadas no período). Entra em A10, com o dashboard.
        */}
        <div className="flex items-center gap-2.5 rounded-md bg-white/6 px-2.5 py-2.5">
          <div
            className="flex size-8 items-center justify-center rounded-md bg-sidebar-active/20 text-meta font-bold text-sidebar-badge-text"
            aria-hidden
          >
            RA
          </div>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-small font-semibold text-white">
              Rocha &amp; Antunes
            </span>
            <span className="truncate text-meta text-sidebar-muted">
              Advogados Associados
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}
