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
  | "settings";

/**
 * Ordem e rótulos vindos da barra lateral dos protótipos aprovados.
 * Os contadores (Leads 9, Pipeline 19, Atividades 12, Conversas 5) só
 * aparecem quando houver banco — entram a partir de A4.
 *
 * "Contatos" não está no protótipo original — ampliação explícita de
 * escopo da A3 (aprovada pelo usuário): contatos precisam de uma tela
 * própria para serem testados/usados sem depender de seed, já que a A4
 * (Leads) ainda não existe para servir de porta de entrada.
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
  { href: "/automacoes", label: "Automações", icon: "zap" },
  { href: "/relatorios", label: "Relatórios", icon: "file-text" },
  { href: "/configuracoes", label: "Configurações", icon: "settings" },
] as const;
