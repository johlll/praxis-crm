/**
 * Design tokens do Praxis CRM.
 *
 * Extraídos dos protótipos aprovados em
 * "Central de Atividades do CRM 3" (Central de Atividades, Pipeline,
 * Perfil 360 do Lead, Visão Geral).
 *
 * Este arquivo é a fonte de verdade em TypeScript; `globals.css` declara os
 * mesmos valores como CSS variables para o Tailwind. Ao mudar um token,
 * mude nos dois lugares — o teste `tokens.test.ts` falha se divergirem.
 */

export const color = {
  // Fundos
  canvas: "#EFEEE9",
  app: "#F5F4EF",
  surface: "#FFFFFF",
  surfaceSubtle: "#FBFBF8",
  surfaceMuted: "#FCFCFA",
  surfaceSelected: "#F2F7F5",

  // Barra lateral
  sidebar: "#0C2E2C",
  sidebarHover: "#133A37",
  sidebarText: "#B7CCC7",
  sidebarTextStrong: "#CFDEDA",
  sidebarMuted: "#7FA39C",
  sidebarActive: "#1E9E7F",
  sidebarActiveText: "#04221D",
  sidebarBadgeText: "#8FE3C9",

  // Marca
  primary: "#0E6C5C",
  primaryHover: "#0A5447",
  primaryAccent: "#1E9E7F",
  primaryTint: "#EAF4F1",
  primaryRing: "#E1EEE9",
  primaryBorder: "#CFE6D8",

  // Texto
  // textTertiary/textSoft/textMuted foram escurecidos em relação ao
  // protótipo (6E7671/7C8480/8A918D) para atingir 4.5:1 (WCAG 2.1 AA)
  // contra os três fundos claros do produto — ver tests/unit/contrast.test.ts.
  // A ordem de ênfase é preservada: text > textSecondary > textTertiary >
  // textSoft > textMuted.
  text: "#17201E",
  textSecondary: "#4C5551",
  textTertiary: "#5C635F",
  textMuted: "#676C69",
  textSoft: "#626865",
  // Único tom abaixo de AA: reservado a elementos decorativos
  // (aria-hidden) ou dica secundária desabilitada (ex.: atalho ⌘K),
  // nunca a texto que carregue informação essencial.
  textDisabled: "#A5AAA6",

  // Bordas
  border: "#E4E2DA",
  borderSubtle: "#EDECE5",
  borderInput: "#C9C6BB",
  borderStrong: "#D7D5CE",
  borderUnassigned: "#C9A55C",

  // Semânticos
  danger: "#B3402E",
  dangerBg: "#FBECE9",
  warning: "#8A5A00",
  warningBg: "#FBF2E3",
  info: "#1F5C99",
  infoBg: "#EAF1FA",
  infoBgAlt: "#E9F0F7",
  success: "#18794E",
  successBg: "#E8F6EC",
  successBgAlt: "#E7F3EC",
  purple: "#5A45A8",
  purpleBg: "#EEEAF9",
  purpleBgAlt: "#F0EDFB",
  neutral: "#4C5551",
  neutralBg: "#F0EFE9",
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
  card: "0 1px 1px rgba(23,32,30,0.03)",
  raised: "0 1px 2px rgba(23,32,30,0.12)",
  ring: "0 0 0 2px #E1EEE9",
} as const;

/** Larguras estruturais medidas nos protótipos (1440×900). */
export const layout = {
  sidebarWidth: 228,
  detailPanelWidth: 372,
  profilePanelWidth: 320,
  kanbanColumnWidth: 272,
  kanbanColumnStep: 282,
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
 * Tokens de cor usados como cor de TEXTO sobre um fundo claro (surface, app
 * ou canvas). Todos devem atingir contraste mínimo 4.5:1 (WCAG 2.1 AA)
 * contra os três — verificado em tests/unit/contrast.test.ts.
 */
export const textColorTokens = [
  "text",
  "textSecondary",
  "textTertiary",
  "textMuted",
  "textSoft",
  "primary",
  "danger",
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

