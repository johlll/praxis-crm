import type { Route } from "next";

export type NavItem = {
  href: Route;
  label: string;
  /** Ícone do lucide-react, resolvido no componente. */
  icon: NavIconName;
};

export type NavIconName =
  | "layout-grid"
  | "users"
  | "contact"
  | "bar-chart"
  | "check-square"
  | "calendar"
  | "message-circle"
  | "briefcase"
  | "zap"
  | "file-text"
  | "settings"
  | "handshake"
  | "clipboard"
  | "megaphone";

/**
 * Todas as rotas internas da barra lateral. A ordem e os rótulos vêm dos
 * protótipos aprovados; "Contatos" foi ampliação explícita da A3.
 * Os contadores só aparecem quando houver dado real (hoje: atrasadas).
 */
export const primaryNav: readonly NavItem[] = [
  { href: "/visao-geral", label: "Visão geral", icon: "layout-grid" },
  { href: "/contatos", label: "Contatos", icon: "contact" },
  { href: "/leads", label: "Leads", icon: "users" },
  { href: "/pipeline", label: "Pipeline", icon: "bar-chart" },
  { href: "/atividades", label: "Atividades", icon: "check-square" },
  { href: "/agenda", label: "Agenda", icon: "calendar" },
  { href: "/conversas", label: "Conversas", icon: "message-circle" },
  { href: "/clientes", label: "Clientes", icon: "briefcase" },
] as const;

export const secondaryNav: readonly NavItem[] = [
  { href: "/trafego-pago", label: "Tráfego Pago", icon: "megaphone" },
  { href: "/automacoes", label: "Automações", icon: "zap" },
  { href: "/relatorios", label: "Relatórios", icon: "file-text" },
  { href: "/configuracoes", label: "Configurações", icon: "settings" },
] as const;

export type NavGroup = {
  id: string;
  label: string;
  icon: NavIconName;
  items: readonly NavItem[];
};

export type NavEntry = { kind: "item"; item: NavItem } | { kind: "group"; group: NavGroup };

function item(href: Route): NavEntry {
  return { kind: "item", item: findItem(href) };
}

function findItem(href: Route): NavItem {
  const found = [...primaryNav, ...secondaryNav].find((i) => i.href === href);
  if (!found) throw new Error(`Rota sem item de navegação: ${href}`);
  return found;
}

/**
 * Agrupamento visual da barra lateral (refinamento de 15/11/2026, inspirado
 * nas referências aprovadas). Só reorganiza os MESMOS itens de
 * primaryNav/secondaryNav — nenhum fica de fora (navigation.test.tsx
 * confere) — e os grupos começam abertos.
 */
export const sidebarLayout: readonly NavEntry[] = [
  item("/visao-geral"),
  {
    kind: "group",
    group: {
      id: "comercial",
      label: "Comercial",
      icon: "handshake",
      items: ["/contatos", "/leads", "/pipeline", "/conversas"].map((h) => findItem(h as Route)),
    },
  },
  {
    kind: "group",
    group: {
      id: "operacao",
      label: "Operação",
      icon: "clipboard",
      items: ["/atividades", "/agenda", "/clientes"].map((h) => findItem(h as Route)),
    },
  },
  item("/trafego-pago"),
  item("/automacoes"),
  item("/relatorios"),
  item("/configuracoes"),
];
