/**
 * Datas civis "AAAA-MM-DD" (sem hora e sem fuso): a aritmética é feita em dias inteiros em UTC, então não há
 * horário de verão nem deslocamento. Quem decide "que dia é hoje" é o chamador, no fuso do escritório
 * (`dateTimeInputParts` em src/lib/timezone.ts). Meses são "AAAA-MM".
 */

const DAY_MS = 86_400_000;

/** Dia inteiro desde 1970 de um "AAAA-MM-DD" REAL; texto malformado ou data inexistente (30/02) → null. */
export function civilDayNumber(iso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return ms / DAY_MS;
}

export function addCivilDays(iso: string, delta: number): string {
  return new Date((civilDayNumber(iso)! + delta) * DAY_MS).toISOString().slice(0, 10);
}

export const monthOf = (iso: string) => iso.slice(0, 7);

export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Dia `day` do mês, limitado ao intervalo que o mês tem. */
export function dayOfMonth(month: string, day: number): string {
  const clamped = Math.min(Math.max(day, 1), daysInMonth(month));
  return `${month}-${String(clamped).padStart(2, "0")}`;
}

const MONTH_NAMES = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
] as const;

export const monthName = (month: string) => MONTH_NAMES[Number(month.slice(5, 7)) - 1]!;

/** "2026-11" → "Novembro de 2026". */
export function monthLabel(month: string): string {
  const name = monthName(month);
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} de ${month.slice(0, 4)}`;
}
