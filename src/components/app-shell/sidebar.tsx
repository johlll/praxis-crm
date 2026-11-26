"use client";

import { useId, useMemo, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Briefcase,
  Building2,
  CalendarDays,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronsUpDown,
  ClipboardList,
  Contact as ContactIcon,
  FileText,
  Handshake,
  LayoutGrid,
  Megaphone,
  MessageCircle,
  Plus,
  Settings,
  Users,
  UsersRound,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { initialsOf } from "@/lib/initials";
import { ROLE_LABEL, type Role } from "@/lib/roles";
import { switchWorkspaceAction } from "@/modules/workspace/actions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { sidebarLayout, type NavGroup, type NavIconName, type NavItem } from "./navigation";
import { SignOutItem } from "./sign-out-item";

const icons: Record<NavIconName, LucideIcon> = {
  "layout-grid": LayoutGrid,
  users: Users,
  contact: ContactIcon,
  "bar-chart": BarChart3,
  "check-square": CheckSquare,
  calendar: CalendarDays,
  "message-circle": MessageCircle,
  briefcase: Briefcase,
  zap: Zap,
  "file-text": FileText,
  settings: Settings,
  handshake: Handshake,
  clipboard: ClipboardList,
  megaphone: Megaphone,
};

const GROUPS_STORAGE_KEY = "praxis.sidebar.grupos-fechados";

function OverdueBadge({ count }: { count: number }) {
  return (
    <span
      className="rounded-full bg-danger px-1.5 py-0.5 text-label leading-none font-bold text-on-solid tabular"
      aria-label={`${count} atrasada${count === 1 ? "" : "s"}`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

function NavLink({
  item,
  active,
  nested = false,
  badge,
}: {
  item: NavItem;
  active: boolean;
  nested?: boolean;
  badge?: number | undefined;
}) {
  const Icon = icons[item.icon];

  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group/nav relative flex items-center gap-2.5 rounded-md text-body leading-4 no-underline transition-colors hover:no-underline",
        nested ? "py-[7px] pr-2 pl-2.5" : "px-2.5 py-2",
        active
          ? "bg-sidebar-active font-semibold text-sidebar-active-text shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]"
          : "font-medium text-sidebar-text hover:bg-sidebar-hover hover:text-sidebar-text-strong",
      )}
    >
      <Icon
        size={nested ? 15 : 16}
        strokeWidth={1.5}
        className={cn("shrink-0", active ? "text-accent" : "text-sidebar-muted group-hover/nav:text-sidebar-text-strong")}
        aria-hidden
      />
      <span className="flex-1 truncate">{item.label}</span>
      {badge && badge > 0 ? <OverdueBadge count={badge} /> : null}
    </Link>
  );
}

function NavGroupSection({
  group,
  open,
  onToggle,
  isActive,
  badgeFor,
}: {
  group: NavGroup;
  open: boolean;
  onToggle: () => void;
  isActive: (href: string) => boolean;
  badgeFor: (href: string) => number | undefined;
}) {
  const Icon = icons[group.icon];
  const listId = useId();
  const containsActive = group.items.some((i) => isActive(i.href));
  const hiddenBadge = open ? 0 : group.items.reduce((sum, i) => sum + (badgeFor(i.href) ?? 0), 0);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={listId}
        className={cn(
          "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-body leading-4 font-medium transition-colors hover:bg-sidebar-hover hover:text-sidebar-text-strong",
          containsActive && !open ? "text-sidebar-text-strong" : "text-sidebar-text",
        )}
      >
        <Icon size={16} strokeWidth={1.5} className="shrink-0 text-sidebar-muted" aria-hidden />
        <span className="flex-1">{group.label}</span>
        {hiddenBadge > 0 ? <OverdueBadge count={hiddenBadge} /> : null}
        <ChevronDown
          size={14}
          strokeWidth={1.5}
          className={cn("shrink-0 text-sidebar-muted transition-transform", open ? "" : "-rotate-90")}
          aria-hidden
        />
      </button>
      {open ? (
        <ul id={listId} className="m-0 ml-[18px] flex list-none flex-col gap-px border-l border-white/[0.07] py-0.5 pl-2">
          {group.items.map((i) => (
            <li key={i.href}>
              <NavLink item={i} active={isActive(i.href)} nested badge={badgeFor(i.href)} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export type SidebarWorkspace = {
  id: string;
  name: string;
  slug: string;
  role: Role;
};

export type SidebarUser = {
  fullName: string;
  initials: string;
  role: Role;
};

type SidebarProps = {
  activeWorkspace: SidebarWorkspace;
  workspaces: SidebarWorkspace[];
  overdueActivitiesCount?: number | undefined;
  user?: SidebarUser | undefined;
};

// Preferência só de conveniência (grupos fechados), guardada neste navegador.
// Sem armazenamento disponível (janela privada, bloqueio), vale só na memória
// desta aba; o servidor sempre renderiza tudo aberto.
let closedGroupsMemory = "[]";
const closedGroupsListeners = new Set<() => void>();

function subscribeClosedGroups(listener: () => void) {
  closedGroupsListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    closedGroupsListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function readClosedGroupsRaw(): string {
  try {
    return window.localStorage.getItem(GROUPS_STORAGE_KEY) ?? closedGroupsMemory;
  } catch {
    return closedGroupsMemory;
  }
}

function parseClosedGroups(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeClosedGroups(ids: string[]) {
  closedGroupsMemory = JSON.stringify(ids);
  try {
    window.localStorage.setItem(GROUPS_STORAGE_KEY, closedGroupsMemory);
  } catch {
    try {
      window.localStorage.removeItem(GROUPS_STORAGE_KEY);
    } catch {
      // Segue só na memória.
    }
  }
  for (const listener of closedGroupsListeners) listener();
}

/**
 * Conteúdo da barra lateral — usado na coluna fixa (desktop) e na gaveta do
 * celular (MobileNav). Workspace no topo e conta no rodapé, como nas
 * referências aprovadas; os grupos começam abertos e só fecham por escolha
 * de quem usa (preferência guardada só neste navegador).
 */
export function SidebarContent({ activeWorkspace, workspaces, overdueActivitiesCount, user }: SidebarProps) {
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const closedGroupsRaw = useSyncExternalStore(subscribeClosedGroups, readClosedGroupsRaw, () => "[]");
  const closedGroups = useMemo(() => parseClosedGroups(closedGroupsRaw), [closedGroupsRaw]);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const badgeFor = (href: string) => (href === "/atividades" ? overdueActivitiesCount : undefined);

  function toggleGroup(id: string) {
    writeClosedGroups(closedGroups.includes(id) ? closedGroups.filter((g) => g !== id) : [...closedGroups, id]);
  }

  function handleSwitch(workspaceId: string) {
    if (workspaceId === activeWorkspace.id) return;
    const formData = new FormData();
    formData.set("workspaceId", workspaceId);
    startTransition(() => {
      void switchWorkspaceAction(formData);
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col px-3 pt-4 pb-3 text-sidebar-text-strong">
      <div className="flex items-center gap-2.5 px-1.5 pb-4">
        <div
          className="flex size-[30px] items-center justify-center rounded-[9px] border border-accent-border bg-accent-tint font-serif text-display leading-none text-accent"
          aria-hidden
        >
          P
        </div>
        <div className="flex flex-col gap-px">
          <span className="font-serif text-[20px] leading-none tracking-[0.2px] text-sidebar-text-strong">Praxis</span>
          <span className="text-label leading-[11px] tracking-[1.3px] text-sidebar-muted uppercase">CRM Jurídico</span>
        </div>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={isPending}
            aria-label="Trocar de workspace"
            className="mb-4 flex items-center gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.03] px-2.5 py-2 text-left transition-colors hover:bg-white/[0.06] disabled:opacity-60"
          >
            <Building2 size={15} strokeWidth={1.5} className="shrink-0 text-sidebar-muted" aria-hidden />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-small font-semibold text-sidebar-text-strong">{activeWorkspace.name}</span>
              <span className="truncate text-meta text-sidebar-muted">{ROLE_LABEL[activeWorkspace.role]}</span>
            </span>
            <ChevronsUpDown size={14} className="shrink-0 text-sidebar-muted" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="bottom" className="w-[226px]">
          <DropdownMenuLabel>Seus workspaces</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {workspaces.map((ws) => (
            <DropdownMenuItem key={ws.id} onSelect={() => handleSwitch(ws.id)}>
              <span className="flex-1 truncate">{ws.name}</span>
              {ws.id === activeWorkspace.id ? <Check size={14} className="text-primary" aria-hidden /> : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/onboarding">
              <Plus size={14} aria-hidden />
              Criar novo workspace
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <nav className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1" aria-label="Navegação principal">
        {sidebarLayout.map((entry) =>
          entry.kind === "item" ? (
            <NavLink
              key={entry.item.href}
              item={entry.item}
              active={isActive(entry.item.href)}
              badge={badgeFor(entry.item.href)}
            />
          ) : (
            <NavGroupSection
              key={entry.group.id}
              group={entry.group}
              open={!closedGroups.includes(entry.group.id)}
              onToggle={() => toggleGroup(entry.group.id)}
              isActive={isActive}
              badgeFor={badgeFor}
            />
          ),
        )}
      </nav>

      {user ? (
        <div className="mt-3 border-t border-white/[0.07] pt-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Menu do usuário"
                className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-sidebar-hover"
              >
                <span
                  className="flex size-8 shrink-0 items-center justify-center rounded-full border border-accent-border bg-accent-tint text-[11px] font-bold text-accent"
                  aria-hidden
                >
                  {user.initials || initialsOf(user.fullName)}
                </span>
                <span className="flex min-w-0 flex-1 flex-col leading-[1.25]">
                  <span className="truncate text-small font-semibold text-sidebar-text-strong">{user.fullName}</span>
                  <span className="truncate text-meta text-sidebar-muted">{ROLE_LABEL[user.role]}</span>
                </span>
                <ChevronsUpDown size={14} className="shrink-0 text-sidebar-muted" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="w-[212px]">
              <DropdownMenuItem asChild>
                <a href="/configuracoes/equipe">
                  <UsersRound size={14} aria-hidden />
                  Equipe
                </a>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <SignOutItem />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
    </div>
  );
}

/** Coluna fixa da barra lateral — a partir de 1024 px (abaixo disso, MobileNav). */
export function Sidebar(props: SidebarProps) {
  return (
    <aside className="hidden w-sidebar shrink-0 flex-col border-r border-white/[0.06] bg-sidebar md:flex">
      <SidebarContent {...props} />
    </aside>
  );
}
