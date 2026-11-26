import { monthName } from "@/lib/civil-date";
import type { Comparison, MonthView } from "./ledger";

/** Reais para a tela: centavos só quando existem; negativo com o sinal de menos ("−R$ 1.200"). */
export function formatMoney(cents: number): string {
  const text = (Math.abs(cents) / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return cents < 0 ? `−${text}` : text;
}

/** Eixo do gráfico: "R$ 0", "R$ 600", "R$ 4 mil", "R$ 1,5 mil", "R$ 2 mi". */
export function formatAxisMoney(cents: number): string {
  const reais = cents / 100;
  const short = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
  if (Math.abs(reais) >= 1_000_000) return `R$ ${short(reais / 1_000_000)} mi`;
  if (Math.abs(reais) >= 1_000) return `R$ ${short(reais / 1_000)} mil`;
  return `R$ ${short(reais)}`;
}

/** "2026-11-26" → "26/11". */
export const formatDayMonth = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
/** "2026-11-26" → "26/11/2026". */
export const formatDate = (date: string) => `${formatDayMonth(date)}/${date.slice(0, 4)}`;
/** "2026-11-06" → "06 nov". */
export const formatShortDate = (date: string) => `${date.slice(8, 10)} ${monthName(date.slice(0, 7)).slice(0, 3)}`;

export function formatPercentChange(percent: number): string {
  if (percent === 0) return "0,0%";
  const text = Math.abs(percent).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${percent > 0 ? "+" : "−"}${text}%`;
}

/** Com o que o mês está sendo comparado: "outubro" (mês fechado) ou "1 a 26/10" (mês em curso). */
export function comparisonTarget(view: Pick<MonthView, "comparisonWindow">): string {
  const window = view.comparisonWindow;
  if (!window) return "";
  if (!window.partial) return monthName(window.month);
  const day = Number(window.to.slice(8, 10));
  return day === 1 ? formatDayMonth(window.to) : `1 a ${formatDayMonth(window.to)}`;
}

export const NO_BASE_REASON: Record<Extract<Comparison, { kind: "no_base" }>["reason"], string> = {
  zero: "o valor anterior foi zero",
  negative: "o resultado anterior foi negativo",
  no_data: "não há dados do período anterior",
  future: "o mês ainda não começou",
};
