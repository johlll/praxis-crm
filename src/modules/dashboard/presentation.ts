import type { Dashboard } from "./queries";

/**
 * Regras de apresentação da Visão geral — puras, sem acesso a dados,
 * testadas em tests/unit/a10-dashboard-presentation.test.ts.
 */

export type Delta =
  | { kind: "none" } // período anterior sem base (zero): mostra "—"
  | { kind: "change"; percent: number };

/** Variação percentual contra o período anterior. Base zero → sem variação calculável. */
export function computeDelta(current: number, previous: number): Delta {
  if (previous === 0) return { kind: "none" };
  return { kind: "change", percent: Math.round(((current - previous) / previous) * 100) };
}

export function formatDelta(delta: Delta): string {
  if (delta.kind === "none") return "—";
  if (delta.percent === 0) return "0%";
  return `${delta.percent > 0 ? "+" : "−"}${Math.abs(delta.percent)}%`;
}

/** Centavos → "R$ 184.500" (centavos só quando existem). */
export function formatBRL(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

/** Centavos → "41k" / "1,2 mi" para rótulos curtos de barra. */
export function formatBRLShort(cents: number): string {
  const reais = cents / 100;
  if (reais >= 1_000_000) return `${(reais / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
  if (reais >= 1_000) return `${Math.round(reais / 1_000)}k`;
  return reais.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
}

export function formatPercent(numerator: number, denominator: number): string | null {
  if (denominator === 0) return null;
  return `${((numerator / denominator) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

export function formatDays(days: number | null): string {
  if (days === null) return "—";
  const rounded = days.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
  return `${rounded} ${days === 1 ? "dia" : "dias"}`;
}

/** "2026-09-01" → "01/09". */
function shortDate(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `${day}/${month}`;
}

export function bucketLabel(startDate: string, lastDate: string): string {
  return startDate === lastDate ? shortDate(startDate) : `${shortDate(startDate)}–${shortDate(lastDate)}`;
}

/** Rótulo curto do eixo do gráfico: o primeiro dia da faixa ("01/09"). A faixa inteira fica no tooltip e na tabela. */
export function bucketTick(startDate: string): string {
  return shortDate(startDate);
}

export type SeriesPoint = {
  key: string;
  tick: string;
  /** Faixa por extenso, igual à da tela anterior ("01/09–05/09" ou "16/09"). */
  range: string;
  count: number;
  /** Centavos — só existe quando o servidor mandou valor (papéis com dinheiro). */
  valueCents?: number;
};

/**
 * Faixas da RPC → pontos do gráfico, um por faixa e na mesma ordem. Nada é
 * redistribuído entre dias nem interpolado: cada ponto é exatamente o que o
 * banco contou naquela faixa.
 */
export function buildSeriesPoints(
  buckets: { startDate: string; lastDate: string; count: number; valueCents?: number }[],
): SeriesPoint[] {
  return buckets.map((b) => ({
    key: b.startDate,
    tick: bucketTick(b.startDate),
    range: bucketLabel(b.startDate, b.lastDate),
    count: b.count,
    ...(b.valueCents !== undefined ? { valueCents: b.valueCents } : {}),
  }));
}

/** Série sem nenhum registro: o gráfico daria uma linha no zero — a tela diz isso em texto. */
export function seriesIsEmpty(points: SeriesPoint[]): boolean {
  return points.every((p) => p.count === 0 && (p.valueCents ?? 0) === 0);
}

/** Cores da paleta categórica validada (tokens chart1…chart6) e o neutro de "sem origem". */
export type OriginColor = "chart1" | "chart2" | "chart3" | "chart4" | "chart5" | "chart6" | "neutral";
const ORIGIN_SLOTS = ["chart1", "chart2", "chart3", "chart4", "chart5", "chart6"] as const;

/** Rótulo de quem não tem origem — o mesmo da tabela anterior. */
export const NO_SOURCE_LABEL = "Não informada";
export const OTHER_SOURCES_LABEL = "Outras origens";

/**
 * Identidade interna de cada fatia (seleção e destaque na rosca e na tabela).
 * Origem real e categoria especial usam prefixos diferentes ("real:" e
 * "especial:"), então nenhum texto digitado como origem colide com a
 * categoria "Não informada" ou com o agrupamento "Outras origens".
 */
const segmentKeyOfSource = (source: string) => `real:${source}`;
const SEGMENT_KEY_NO_SOURCE = "especial:nao-informada";
const SEGMENT_KEY_OTHERS = "especial:outras";

export type OriginRow = {
  source: string | null;
  label: string;
  created: number;
  won: number;
  /** created ÷ total criado no período; null quando o total é zero. */
  share: number | null;
  /** Fatia da rosca a que a linha pertence; null quando não criou nada no período. */
  segmentKey: string | null;
  color: OriginColor | null;
};

export type OriginSegment = { key: string; label: string; created: number; share: number; color: OriginColor };

export type OriginBreakdown = {
  /** Denominador: oportunidades criadas no período, cada uma em exatamente uma origem do modelo escolhido. */
  totalCreated: number;
  rows: OriginRow[];
  segments: OriginSegment[];
  /** Rosca só com duas fatias ou mais: uma fatia única não compara nada. */
  showDonut: boolean;
};

/**
 * Origem das oportunidades (A11) → linhas da tabela e fatias da rosca.
 *
 * - Unidade: oportunidade. A RPC já resolve UM toque por oportunidade no
 *   modelo escolhido, então cada oportunidade criada no período está em
 *   exatamente uma linha — a soma de "criadas" é o denominador.
 * - A rosca mostra só "criadas"; "ganhas" (outra população: ganhas no
 *   período) continua na tabela, nunca na mesma conta.
 * - Cor por posição na ordem de tamanho, na ordem fixa da paleta. Mais de
 *   seis origens: as cinco maiores mantêm cor e o resto vira uma fatia
 *   "Outras origens" (cada uma continua na tabela, com o próprio número).
 * - "Não informada" (sem origem registrada) usa o neutro, sempre por último.
 */
export function buildOriginBreakdown(sources: { source: string | null; created: number; won: number }[]): OriginBreakdown {
  const totalCreated = sources.reduce((sum, row) => sum + row.created, 0);
  const share = (n: number) => (totalCreated === 0 ? null : n / totalCreated);
  const byLabel = (a: string, b: string) => a.localeCompare(b, "pt-BR");

  const named = sources
    .filter((row) => row.source !== null && row.created > 0)
    .sort((a, b) => b.created - a.created || b.won - a.won || byLabel(a.source!, b.source!));
  const unknown = sources.find((row) => row.source === null && row.created > 0) ?? null;
  const idle = sources
    .filter((row) => row.created === 0)
    .sort((a, b) => b.won - a.won || byLabel(a.source ?? NO_SOURCE_LABEL, b.source ?? NO_SOURCE_LABEL));

  const fold = named.length > ORIGIN_SLOTS.length;
  const colored = fold ? named.slice(0, ORIGIN_SLOTS.length - 1) : named;
  const folded = fold ? named.slice(ORIGIN_SLOTS.length - 1) : [];

  const rows: OriginRow[] = [];
  const segments: OriginSegment[] = [];

  colored.forEach((row, index) => {
    const color = ORIGIN_SLOTS[index]!;
    const key = segmentKeyOfSource(row.source!);
    rows.push({ source: row.source, label: row.source!, created: row.created, won: row.won, share: share(row.created), segmentKey: key, color });
    segments.push({ key, label: row.source!, created: row.created, share: share(row.created)!, color });
  });

  if (folded.length > 0) {
    const color = ORIGIN_SLOTS[ORIGIN_SLOTS.length - 1]!;
    const key = SEGMENT_KEY_OTHERS;
    for (const row of folded) {
      rows.push({ source: row.source, label: row.source!, created: row.created, won: row.won, share: share(row.created), segmentKey: key, color });
    }
    const created = folded.reduce((sum, row) => sum + row.created, 0);
    segments.push({ key, label: OTHER_SOURCES_LABEL, created, share: share(created)!, color });
  }

  if (unknown) {
    const key = SEGMENT_KEY_NO_SOURCE;
    rows.push({ source: null, label: NO_SOURCE_LABEL, created: unknown.created, won: unknown.won, share: share(unknown.created), segmentKey: key, color: "neutral" });
    segments.push({ key, label: NO_SOURCE_LABEL, created: unknown.created, share: share(unknown.created)!, color: "neutral" });
  }

  for (const row of idle) {
    rows.push({ source: row.source, label: row.source ?? NO_SOURCE_LABEL, created: 0, won: row.won, share: share(0), segmentKey: null, color: null });
  }

  return { totalCreated, rows, segments, showDonut: totalCreated > 0 && segments.length >= 2 };
}

/** Instante (timestamptz) → "18/08" no fuso do escritório. */
export function formatDayMonth(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });
}

/** Dias inteiros desde um instante (para "parada há N dias"). */
export function daysSince(iso: string, now: string): number {
  return Math.max(0, Math.floor((new Date(now).getTime() - new Date(iso).getTime()) / 86_400_000));
}

export type Insight = { id: string; text: string; basis: string };

/** Mínimos de casos para cada insight aparecer — abaixo disso, nada é dito. */
export const INSIGHT_MINIMUMS = {
  openWithoutNextAction: { open: 3, without: 1 },
  stalledStage: { stalled: 3, inStage: 2 },
  lostReason: { lost: 3, withReason: 2 },
} as const;

/**
 * Insights só a partir de números já calculados pelo banco, cada um com a
 * base que o sustenta. Nenhum texto fixo, nenhuma comparação que o banco
 * não permita reconstruir.
 */
export function buildInsights(d: Dashboard): Insight[] {
  const insights: Insight[] = [];
  const p = d.positions;

  if (
    p.openOpportunities >= INSIGHT_MINIMUMS.openWithoutNextAction.open &&
    p.openWithoutNextAction >= INSIGHT_MINIMUMS.openWithoutNextAction.without
  ) {
    insights.push({
      id: "sem-proxima-acao",
      text: `${p.openWithoutNextAction} de ${p.openOpportunities} oportunidades abertas estão sem próxima atividade agendada.`,
      basis: "Posição atual",
    });
  }

  const stalled = d.insightData.stalledTopStage;
  if (
    stalled &&
    p.stalledOpportunities >= INSIGHT_MINIMUMS.stalledStage.stalled &&
    stalled.count >= INSIGHT_MINIMUMS.stalledStage.inStage
  ) {
    insights.push({
      id: "etapa-parada",
      text: `A etapa "${stalled.stageName}" concentra ${stalled.count} das ${p.stalledOpportunities} oportunidades paradas há mais de ${d.stalledDays} dias.`,
      basis: "Posição atual",
    });
  }

  const lost = d.insightData.cohortLostTopReason;
  if (
    lost &&
    d.insightData.cohortLostTotal >= INSIGHT_MINIMUMS.lostReason.lost &&
    lost.count >= INSIGHT_MINIMUMS.lostReason.withReason
  ) {
    insights.push({
      id: "motivo-perda",
      text: `Motivo de perda mais registrado entre as oportunidades criadas no período: "${lost.label}" (${lost.count} de ${d.insightData.cohortLostTotal}).`,
      basis: `Oportunidades criadas nos últimos ${d.period.days} dias`,
    });
  }

  return insights;
}

export function greeting(now: Date, firstName: string): string {
  const hour = Number(now.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false }));
  const salute = hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
  return `${salute}, ${firstName}`;
}
