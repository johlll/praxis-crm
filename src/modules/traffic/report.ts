import { dayNumber, isoOfDay, PLATFORMS, type DateRange, type Platform } from "./schema";

/**
 * Tráfego Pago — do conjunto de dados aos números da tela (docs/decisoes/trafego-pago.md). Puro. Cartões,
 * gráfico, distribuição, tabela e CSV saem DESTA conta, sobre as mesmas linhas diárias já filtradas: não há
 * segunda fonte que possa divergir.
 *
 * Contrato de dados (vale para a demonstração e para a integração futura):
 *  - área de atuação é um campo declarado da campanha; nunca deduzida do nome;
 *  - contrato é uma métrica própria recebida pronta; nunca deduzida de oportunidade ganha;
 *  - conversas são as informadas pela PLATAFORMA de anúncios; não são as conversas registradas no CRM;
 *  - CPL = investimento ÷ leads qualificados; sem lead qualificado, não há CPL (nunca divide por zero).
 */

export type CampaignStatus = "ativa" | "pausada" | "encerrada";
export const STATUS_LABEL: Record<CampaignStatus, string> = { ativa: "Ativa", pausada: "Pausada", encerrada: "Encerrada" };

export type Metrics = {
  investmentCents: number;
  conversations: number;
  qualifiedLeads: number;
  contracts: number;
};

export type Campaign = {
  id: string;
  name: string;
  platform: Platform;
  legalArea: string | null;
  /** Situação ATUAL informada pela plataforma (não é do período). */
  status: CampaignStatus;
};

export type DailyMetric = Metrics & { campaignId: string; date: string };

export type TrafficDataset = {
  /** Intervalo em que há dados. Fora dele não é zero: é ausência de dado. */
  coverage: { from: string; to: string };
  campaigns: Campaign[];
  daily: DailyMetric[];
};

export type CampaignRow = Campaign & Metrics & { cplCents: number | null };

export type Comparison =
  | { kind: "no_base"; reason: "no_coverage" | "previous_zero" }
  | { kind: "change"; percent: number; previous: number };

export type SeriesBucket = { from: string; to: string; days: number; partial: boolean; qualifiedLeads: number; contracts: number };

export type PlatformShare = { platform: Platform; selected: boolean; investmentCents: number; percent: number | null };

export type TrafficReport = {
  rows: CampaignRow[];
  totals: Metrics & { cplCents: number | null };
  comparison: Record<keyof Metrics, Comparison>;
  distribution: PlatformShare[];
  series: SeriesBucket[];
  bucketDays: number;
  /** O período começa antes dos dados (ou null se está todo coberto). */
  coverageNotice: { dataStartsAt: string } | null;
};

const METRIC_KEYS = ["investmentCents", "conversations", "qualifiedLeads", "contracts"] as const;
const zero = (): Metrics => ({ investmentCents: 0, conversations: 0, qualifiedLeads: 0, contracts: 0 });

function add(target: Metrics, source: Metrics): void {
  for (const key of METRIC_KEYS) target[key] += source[key];
}

/** CPL em centavos (arredondado ao centavo); null quando não há lead qualificado. */
export function costPerLeadCents(investmentCents: number, qualifiedLeads: number): number | null {
  return qualifiedLeads > 0 ? Math.round(investmentCents / qualifiedLeads) : null;
}

/** Variação com uma casa decimal. Sem período anterior coberto, ou com base zero: sem percentual. */
export function compare(current: number, previous: number, covered: boolean): Comparison {
  if (!covered) return { kind: "no_base", reason: "no_coverage" };
  if (previous === 0) return { kind: "no_base", reason: "previous_zero" };
  return { kind: "change", percent: Math.round(((current - previous) / previous) * 1000) / 10, previous };
}

/** Percentuais inteiros que somam exatamente 100 (maior resto). Total zero → sem percentual. */
export function wholePercents(values: readonly number[]): (number | null)[] {
  const total = values.reduce((sum, v) => sum + v, 0);
  if (total <= 0) return values.map(() => null);
  const exact = values.map((v) => (v * 100) / total);
  const floors = exact.map(Math.floor);
  let missing = 100 - floors.reduce((sum, v) => sum + v, 0);
  const order = exact.map((v, i) => ({ i, rest: v - floors[i]! })).sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (missing <= 0) break;
    floors[i]! += 1;
    missing -= 1;
  }
  return floors;
}

const MAX_POINTS = 11;

/**
 * Faixas do gráfico, alinhadas ao FIM do período: o último ponto é sempre uma faixa inteira; quando o total de
 * dias não divide, é a primeira que fica menor (marcada como parcial). Soma simples, sem interpolar.
 */
export function buildBuckets(period: DateRange): { from: string; to: string; days: number; partial: boolean }[] {
  const size = period.days <= 14 ? 1 : Math.ceil(period.days / MAX_POINTS);
  const buckets: { from: string; to: string; days: number; partial: boolean }[] = [];
  const start = dayNumber(period.from)!;
  for (let end = dayNumber(period.to)!; end >= start; end -= size) {
    const from = Math.max(start, end - size + 1);
    const days = end - from + 1;
    buckets.unshift({ from: isoOfDay(from), to: isoOfDay(end), days, partial: days < size });
  }
  return buckets;
}

export function buildTrafficReport(
  dataset: TrafficDataset,
  platforms: readonly Platform[],
  current: DateRange,
  previous: DateRange,
): TrafficReport {
  const campaigns = new Map(dataset.campaigns.filter((c) => platforms.includes(c.platform)).map((c) => [c.id, c]));
  const within = (date: string, range: DateRange) => date >= range.from && date <= range.to;

  const perCampaign = new Map<string, Metrics>();
  const previousTotals = zero();
  const buckets: SeriesBucket[] = buildBuckets(current).map((b) => ({ ...b, qualifiedLeads: 0, contracts: 0 }));

  for (const day of dataset.daily) {
    if (!campaigns.has(day.campaignId)) continue;
    if (within(day.date, current)) {
      let sum = perCampaign.get(day.campaignId);
      if (!sum) perCampaign.set(day.campaignId, (sum = zero()));
      add(sum, day);
      const bucket = buckets.find((b) => day.date >= b.from && day.date <= b.to)!;
      bucket.qualifiedLeads += day.qualifiedLeads;
      bucket.contracts += day.contracts;
    } else if (within(day.date, previous)) {
      add(previousTotals, day);
    }
  }

  // Campanha sem nenhum número no período não vira linha de zeros.
  const rows: CampaignRow[] = [...campaigns.values()].flatMap((campaign) => {
    const sum = perCampaign.get(campaign.id);
    if (!sum || METRIC_KEYS.every((k) => sum[k] === 0)) return [];
    return [{ ...campaign, ...sum, cplCents: costPerLeadCents(sum.investmentCents, sum.qualifiedLeads) }];
  });

  const totals = zero();
  for (const row of rows) add(totals, row);

  // A comparação só vale quando OS DOIS períodos têm dados completos.
  const covered = previous.from >= dataset.coverage.from && current.to <= dataset.coverage.to;
  const comparison = Object.fromEntries(
    METRIC_KEYS.map((k) => [k, compare(totals[k], previousTotals[k], covered)]),
  ) as TrafficReport["comparison"];

  const spend = PLATFORMS.map((p) => rows.filter((r) => r.platform === p).reduce((s, r) => s + r.investmentCents, 0));
  const percents = wholePercents(spend);
  const distribution = PLATFORMS.map((platform, i) => ({
    platform,
    selected: platforms.includes(platform),
    investmentCents: spend[i]!,
    percent: platforms.includes(platform) ? percents[i]! : null,
  }));

  return {
    rows,
    totals: { ...totals, cplCents: costPerLeadCents(totals.investmentCents, totals.qualifiedLeads) },
    comparison,
    distribution,
    series: buckets,
    bucketDays: Math.max(...buckets.map((b) => b.days)),
    coverageNotice: current.from < dataset.coverage.from ? { dataStartsAt: dataset.coverage.from } : null,
  };
}

/* ---------------------------------------------------------------- ordenação */

export const SORT_KEYS = [
  "name",
  "platform",
  "legalArea",
  "investmentCents",
  "conversations",
  "qualifiedLeads",
  "contracts",
  "cplCents",
  "status",
] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortState = { key: SortKey; direction: "asc" | "desc" };
export const DEFAULT_SORT: SortState = { key: "investmentCents", direction: "desc" };
export const TEXT_SORT_KEYS: readonly SortKey[] = ["name", "platform", "legalArea", "status"];

const collator = new Intl.Collator("pt-BR", { sensitivity: "base", numeric: true });

function sortValue(row: CampaignRow, key: SortKey): string | number | null {
  if (key === "status") return STATUS_LABEL[row.status];
  return row[key];
}

/** Ordenação estável. Valor ausente (sem CPL, sem área) vai para o FIM nas duas direções. Empate: nome. */
export function sortRows(rows: readonly CampaignRow[], sort: SortState): CampaignRow[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, sort.key);
    const vb = sortValue(b, sort.key);
    if (va === null || vb === null) {
      if (va !== vb) return va === null ? 1 : -1;
    } else {
      const diff = typeof va === "number" ? va - (vb as number) : collator.compare(va, vb as string);
      if (diff !== 0) return diff * sign;
    }
    return collator.compare(a.name, b.name) || a.id.localeCompare(b.id);
  });
}
