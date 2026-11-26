import { addCivilDays, civilDayNumber, daysInMonth, monthName } from "@/lib/civil-date";

/**
 * Período da Visão geral — regras puras (docs/decisoes/a10-dashboard.md, "Período"). Datas civis
 * "AAAA-MM-DD" do fuso do escritório; "hoje" é sempre calculado no servidor e vem de quem chama.
 * O banco valida de novo, com as mesmas regras.
 */

/** Limite do intervalo personalizado, contando o primeiro e o último dia. */
export const MAX_RANGE_DAYS = 366;

export type DateRange = { from: string; to: string };

/** Dias do intervalo, contando as duas pontas. */
export const rangeLength = ({ from, to }: DateRange) => civilDayNumber(to)! - civilDayNumber(from)! + 1;

/** Os mesmos dias de um atalho: os N dias terminando hoje. */
export const presetRange = (days: number, today: string): DateRange => ({ from: addCivilDays(today, -(days - 1)), to: today });

export type RangeCheck = { ok: true; range: DateRange } | { ok: false; error: string };

export function checkRange(from: string | undefined, to: string | undefined, today: string): RangeCheck {
  const fail = (error: string): RangeCheck => ({ ok: false, error });
  if (!from || !to) return fail("Informe a data inicial e a data final do período.");
  if (civilDayNumber(from) === null || civilDayNumber(to) === null) return fail("Uma das datas do período não existe.");
  if (from > to) return fail("A data inicial é depois da data final.");
  if (to > today) return fail("O período não pode ter datas futuras.");
  if (rangeLength({ from, to }) > MAX_RANGE_DAYS) return fail(`O período pode ter no máximo ${MAX_RANGE_DAYS} dias.`);
  return { ok: true, range: { from, to } };
}

/* ---------------------------------------------------------------- seleção no calendário */

/** `to === null` com `from` preenchido = aguardando a data final. */
export type Selection = { from: string; to: string | null } | null;

export const isPending = (selection: Selection) => selection !== null && selection.to === null;

/** Último dia que pode fechar um intervalo iniciado em `from`: respeita o limite e não passa de hoje. */
export function lastSelectableEnd(from: string, today: string): string {
  const limit = addCivilDays(from, MAX_RANGE_DAYS - 1);
  return limit < today ? limit : today;
}

/** Pode clicar neste dia? Nunca no futuro; esperando o fim, nunca além do limite. */
export function canPick(selection: Selection, day: string, today: string): boolean {
  if (day > today) return false;
  return !(isPending(selection) && day > lastSelectableEnd(selection!.from, today));
}

/**
 * Um clique:
 *  - sem seleção ou com intervalo completo → começa uma seleção nova;
 *  - esperando o fim e o dia é ANTERIOR ao início → passa a ser o novo início, ainda esperando o fim;
 *  - esperando o fim → fecha o intervalo (o mesmo dia fecha um período de um dia).
 * Dia que não pode ser escolhido não muda nada.
 */
export function pickDay(selection: Selection, day: string, today: string): Selection {
  if (!canPick(selection, day, today)) return selection;
  if (!selection || selection.to !== null || day < selection.from) return { from: day, to: null };
  return { from: selection.from, to: day };
}

/* ---------------------------------------------------------------- textos */

const shortMonth = (iso: string) => monthName(iso.slice(0, 7)).slice(0, 3);
const day = (iso: string) => Number(iso.slice(8, 10));
const year = (iso: string) => iso.slice(0, 4);

/** "26 nov 2026". */
export const formatDayLabel = (iso: string) => `${day(iso)} ${shortMonth(iso)} ${year(iso)}`;

/** "22–26 nov 2026" · "28 out – 3 nov 2026" · "28 dez 2025 – 3 jan 2026" · "26 nov 2026". */
export function formatRangeLabel({ from, to }: DateRange): string {
  if (from === to) return formatDayLabel(from);
  if (from.slice(0, 7) === to.slice(0, 7)) return `${day(from)}–${day(to)} ${shortMonth(to)} ${year(to)}`;
  if (year(from) === year(to)) return `${day(from)} ${shortMonth(from)} – ${formatDayLabel(to)}`;
  return `${formatDayLabel(from)} – ${formatDayLabel(to)}`;
}

export const formatDayCount = (days: number) => `${days} ${days === 1 ? "dia" : "dias"}`;

/** "22 de novembro de 2026" (nome acessível de um dia do calendário). */
export const formatLongDay = (iso: string) => `${day(iso)} de ${monthName(iso.slice(0, 7))} de ${year(iso)}`;

/* ---------------------------------------------------------------- grade do mês */

/** Semana começando no domingo. */
export const weekdayOf = (iso: string) => new Date(civilDayNumber(iso)! * 86_400_000).getUTCDay();

/** Sempre 6 semanas (42 posições), para o painel não mudar de altura; fora do mês = null. */
export function monthGrid(month: string): (string | null)[] {
  const lead = weekdayOf(`${month}-01`);
  const total = daysInMonth(month);
  return Array.from({ length: 42 }, (_, i) => {
    const n = i - lead + 1;
    return n >= 1 && n <= total ? `${month}-${String(n).padStart(2, "0")}` : null;
  });
}
