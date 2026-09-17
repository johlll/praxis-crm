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
