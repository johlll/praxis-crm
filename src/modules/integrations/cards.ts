import type { Route } from "next";

/**
 * Central de Integrações — formato dos cartões e textos fixos (docs/decisoes/central-integracoes.md). Puro.
 * Cada cartão descreve só o que o Praxis faz HOJE; o estado vem de status.ts.
 */

export type IntegrationId = "whatsapp" | "google-agenda" | "meta-ads" | "google-ads" | "assinatura-digital" | "automacoes";

export const CATEGORIES = ["Comunicação", "Agenda", "Marketing", "Documentos", "Automação"] as const;
export type Category = (typeof CATEGORIES)[number];

/** ok: comprovado em uso · attention: pede ação · neutral: informação · unavailable: não existe · error: não deu para consultar. */
export type StateTone = "ok" | "attention" | "neutral" | "unavailable" | "error";

export type IntegrationState = { tone: StateTone; label: string; lines: string[] };

export type IntegrationLink = { href: Route; label: string };

export type IntegrationCard = {
  id: IntegrationId;
  name: string;
  category: Category;
  badge: string;
  description: string;
  /** Arquivo local em public/; null = ícone do próprio Praxis. */
  logo: string | null;
  state: IntegrationState;
  /** Ação que leva a um módulo EXISTENTE; quando não há, o cartão oferece "Ver detalhes". */
  action: IntegrationLink | null;
  details: { paragraphs: string[]; links: IntegrationLink[] };
};

type CardBase = Omit<IntegrationCard, "state" | "action" | "details">;

const LOGOS = "/logos/integracoes";

export const CARD_BASE: Record<IntegrationId, CardBase> = {
  whatsapp: {
    id: "whatsapp",
    name: "WhatsApp",
    category: "Comunicação",
    badge: "Comunicação",
    description: "Conversas com clientes dentro do Praxis. Hoje há um simulador interno; o canal real ainda não foi validado.",
    logo: `${LOGOS}/whatsapp.svg`,
  },
  "google-agenda": {
    id: "google-agenda",
    name: "Google Agenda",
    category: "Agenda",
    badge: "Agenda e compromissos",
    description:
      "Leva compromissos criados no Praxis à agenda Google que cada pessoa escolher. Cada uma conecta a própria conta.",
    logo: `${LOGOS}/google-agenda.svg`,
  },
  "meta-ads": {
    id: "meta-ads",
    name: "Meta Ads",
    category: "Marketing",
    badge: "Marketing e captação",
    description: "Resultados de anúncios do Facebook e do Instagram. A leitura das contas ainda não foi construída.",
    logo: `${LOGOS}/meta-ads.svg`,
  },
  "google-ads": {
    id: "google-ads",
    name: "Google Ads",
    category: "Marketing",
    badge: "Marketing e captação",
    description: "Resultados de anúncios do Google. A leitura das contas ainda não foi construída.",
    logo: `${LOGOS}/google-ads.svg`,
  },
  "assinatura-digital": {
    id: "assinatura-digital",
    name: "Assinatura Digital",
    category: "Documentos",
    badge: "Documentos e contratos",
    description: "Assinatura de contratos e outros documentos a partir do Praxis. Ainda não existe e não há fornecedor definido.",
    logo: `${LOGOS}/assinatura-d4sign.svg`,
  },
  automacoes: {
    id: "automacoes",
    name: "Automações",
    category: "Automação",
    badge: "Produtividade",
    description:
      "Regras internas que criam uma atividade de acompanhamento quando um lead é criado ou uma oportunidade muda de etapa.",
    logo: null,
  },
};

export const CARD_ORDER: readonly IntegrationId[] = [
  "whatsapp",
  "google-agenda",
  "meta-ads",
  "google-ads",
  "assinatura-digital",
  "automacoes",
];

/** Contagens derivadas dos próprios cartões; categoria sem cartão não aparece. */
export function categoryCounts(cards: readonly Pick<IntegrationCard, "category">[]): { category: Category; count: number }[] {
  return CATEGORIES.map((category) => ({ category, count: cards.filter((c) => c.category === category).length })).filter(
    (c) => c.count > 0,
  );
}
