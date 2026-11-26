import type { Comparison } from "./report";

/** Formatação da tela e do CSV de Tráfego Pago. Moeda sempre com centavos (gasto de anúncio é conferido ao centavo). */

export function formatMoney(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export const formatCount = (n: number) => n.toLocaleString("pt-BR");

/** "2026-11-25" → "25/11/2026". */
export function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/** "2026-11-25" → "25/11". */
export function formatDayShort(iso: string): string {
  return formatDay(iso).slice(0, 5);
}

export function formatRange(from: string, to: string): string {
  return from === to ? formatDay(from) : `${formatDay(from)} a ${formatDay(to)}`;
}

export function formatChange(comparison: Extract<Comparison, { kind: "change" }>): string {
  const { percent } = comparison;
  if (percent === 0) return "0,0%";
  const text = Math.abs(percent).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${percent > 0 ? "+" : "−"}${text}%`;
}
