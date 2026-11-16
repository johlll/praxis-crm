/**
 * Design tokens do Praxis CRM.
 *
 * Tema escuro aprovado por João em 15/11/2026 (refinamento visual, 1º
 * escopo): composição e densidade inspiradas nas referências enviadas,
 * paleta conferida no CSS do blog da Vizentini — fundo principal #151A18,
 * superfícies/cards #232B28 e hover de superfícies #29322F. Bronze só como
 * acento discreto (marca, item ativo, destaques pequenos).
 *
 * Os NOMES dos tokens continuam os mesmos do tema claro anterior: as telas
 * usam tokens semânticos (bg-surface, text-text, border-border…), então
 * todas herdam o tema sem redesenho individual.
 *
 * Este arquivo é a fonte de verdade em TypeScript; `globals.css` declara os
 * mesmos valores como CSS variables para o Tailwind. Ao mudar um token,
 * mude nos dois lugares — o teste `tokens.test.ts` falha se divergirem.
 */

export const color = {
  // Fundos — canvas é o fundo principal; app é o preenchimento "rebaixado"
  // (chips, campos, contadores) sobre uma superfície.
  canvas: "#151A18",
  app: "#1B211F",
  surface: "#232B28",
  surfaceHover: "#29322F",
  surfaceSubtle: "#1C2321",
  surfaceMuted: "#1F2624",
  surfaceSelected: "#263330",

  // Barra lateral
  sidebar: "#191F1D",
  sidebarHover: "#222A27",
  sidebarText: "#B4BEB9",
  sidebarTextStrong: "#E6EBE8",
  sidebarMuted: "#8F9A95",
  sidebarActive: "#29322F",
  sidebarActiveText: "#F3F5F4",
  sidebarBadgeText: "#DDBA92",

  // Marca — verde Praxis clareado para o fundo escuro; texto escuro por
  // cima quando ele é fundo de botão (onSolid).
  primary: "#3DB591",
  primaryHover: "#52C4A1",
  primaryAccent: "#2E9C7B",
  primaryTint: "#1D3530",
  primaryRing: "#2C5148",
  primaryBorder: "#2F5A4E",

  // Acento bronze (detalhes, nunca grandes áreas)
  accent: "#C9A27A",
  accentTint: "#30291F",
  accentBorder: "#5B4935",

  // Texto sobre fundo sólido claro (bg-primary, bg-danger, bg-warning…)
  onSolid: "#0E1412",

  // Texto — todos com 4.5:1 (WCAG 2.1 AA) contra canvas, app, surface e
  // surfaceHover; ver tests/unit/contrast.test.ts. Ordem de ênfase:
  // text > textSecondary > textTertiary > textSoft > textMuted.
  text: "#EEF1EF",
  textSecondary: "#C7CECA",
  textTertiary: "#ABB4AF",
  textMuted: "#9AA49F",
  textSoft: "#A2ABA6",
  // Único tom abaixo de AA: reservado a elementos decorativos
  // (aria-hidden) ou dica secundária desabilitada (ex.: atalho ⌘K),
  // nunca a texto que carregue informação essencial.
  textDisabled: "#66706B",

  // Bordas
  border: "#2F3935",
  borderSubtle: "#29322F",
  borderInput: "#3B4743",
  borderStrong: "#44504B",
  borderUnassigned: "#C9A55C",

  // Semânticos — texto claro sobre fundo tingido escuro
  danger: "#F28B79",
  dangerBg: "#3A2421",
  warning: "#E7B866",
  warningBg: "#362D1D",
  info: "#88B9EE",
  infoBg: "#1E2C3A",
  infoBgAlt: "#1F2B36",
  success: "#6ECF99",
  successBg: "#1C3328",
  successBgAlt: "#1F3129",
  purple: "#B8A7F2",
  purpleBg: "#2C2740",
  purpleBgAlt: "#29253A",
  neutral: "#BFC7C3",
  neutralBg: "#2A322F",
} as const;

export const font = {
  sans: "'Public Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif",
  serif: "'Instrument Serif', Georgia, serif",
  mono: "'IBM Plex Mono', 'SFMono-Regular', Consolas, monospace",
} as const;

/** Escala tipográfica em px, como nos protótipos (base 13). */
export const fontSize = {
  label: 9.5,
  meta: 11,
  small: 12,
  body: 13,
  lead: 15,
  display: 19,
} as const;

export const radius = {
  sm: 4,
  input: 6,
  md: 8,
  card: 10,
  lg: 12,
  pill: 20,
} as const;

export const shadow = {
  card: "0 1px 2px rgba(0,0,0,0.22)",
  raised: "0 10px 28px rgba(0,0,0,0.38)",
  ring: "0 0 0 2px #2C5148",
} as const;

/** Larguras estruturais (sidebar próxima dos ~230–245 px das referências). */
export const layout = {
  sidebarWidth: 236,
  detailPanelWidth: 372,
  profilePanelWidth: 320,
  kanbanColumnWidth: 256,
  kanbanColumnStep: 266,
  contentMaxWidth: 1440,
} as const;

/** Densidade da tabela: padding vertical da célula. */
export const density = {
  comfortable: 11,
  compact: 7,
} as const;

export const breakpoint = {
  /** Abaixo disto a tabela vira cartões e o kanban rola. */
  md: 1024,
  /** Layout de referência do protótipo. */
  lg: 1280,
} as const;

export type ColorToken = keyof typeof color;

/**
 * Tokens de cor usados como cor de TEXTO sobre os fundos do produto
 * (canvas, app, surface e surfaceHover). Todos devem atingir contraste
 * mínimo 4.5:1 (WCAG 2.1 AA) contra os quatro — verificado em
 * tests/unit/contrast.test.ts.
 */
export const textColorTokens = [
  "text",
  "textSecondary",
  "textTertiary",
  "textMuted",
  "textSoft",
  "primary",
  "accent",
  "danger",
  "warning",
  "success",
  "info",
] as const satisfies readonly ColorToken[];

/**
 * Pares "texto escuro sobre cor sólida" (botão primário, badge de
 * atrasadas, chamada de atenção): onSolid precisa de 4.5:1 sobre cada um.
 */
export const solidBackgroundTokens = [
  "primary",
  "primaryHover",
  "danger",
  "warning",
  "accent",
] as const satisfies readonly ColorToken[];

/**
 * Tokens deliberadamente abaixo de AA: usados só em elementos decorativos
 * (ícones aria-hidden) ou em dica secundária desabilitada (o atalho ⌘K),
 * nunca em texto que carregue informação essencial. O teste de contraste
 * não os cobra — mas exige que fiquem fora de textColorTokens.
 */
export const decorativeColorTokens = [
  "textDisabled",
] as const satisfies readonly ColorToken[];

