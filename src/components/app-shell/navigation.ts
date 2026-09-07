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
  | "bar-chart"
  | "check-square"
  | "calendar"
  | "message-circle"
  | "briefcase"
  | "zap"
  | "file-text"
  | "settings";

/**
 * Ordem e rótulos vindos da barra lateral dos protótipos aprovados.
 * Os contadores (Leads 9, Pipeline 19, Atividades 12, Conversas 5) só
 * aparecem quando houver banco — entram a partir de A4.
 */
export const primaryNav: readonly NavItem[] = [
  { href: "/visao-geral", label: "Visão geral", icon: "layout-grid" },
  { href: "/leads", label: "Leads", icon: "users" },
  { href: "/pipeline", label: "Pipeline", icon: "bar-chart" },
  { href: "/atividades", label: "Atividades", icon: "check-square" },
  { href: "/agenda", label: "Agenda", icon: "calendar" },
  { href: "/conversas", label: "Conversas", icon: "message-circle" },
  { href: "/clientes", label: "Clientes", icon: "briefcase" },
] as const;

export const secondaryNav: readonly NavItem[] = [
  { href: "/automacoes", label: "Automações", icon: "zap" },
  { href: "/relatorios", label: "Relatórios", icon: "file-text" },
  { href: "/configuracoes", label: "Configurações", icon: "settings" },
] as const;
