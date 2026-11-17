import type { Route } from "next";

import { TIMEZONE } from "./timezone";

/**
 * Datas da Agenda mensal. Tudo trabalha com chaves de texto —
 * "YYYY-MM" (mês) e "YYYY-MM-DD" (dia) — e aritmética em UTC, nunca com
 * `new Date("2026-11-17")` interpretado no fuso de quem roda o código (que
 * desloca o dia para trás no Brasil). O "hoje" e o dia de cada atividade
 * vêm sempre do fuso do escritório (America/Sao_Paulo).
 */

export type MonthKey = `${number}-${number}`;

/** Limites aceitos na URL: fora disso, volta para o mês atual. */
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (n: number) => String(n).padStart(2, "0");

function toMonthKey(year: number, month: number): MonthKey {
  return `${year}-${pad(month)}` as MonthKey;
}

function toDayKey(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** "YYYY-MM-DD" de um instante, no fuso do escritório. */
export function dayKeyOf(instant: string | Date): string {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(date);
}

/** Hoje ("YYYY-MM-DD") no fuso do escritório. */
export function todayKey(now: Date = new Date()): string {
  return dayKeyOf(now);
}

/** "YYYY-MM" válido (ano entre 2000 e 2100, mês 01–12) ou `null`. */
export function parseMonthKey(value: unknown): MonthKey | null {
  if (typeof value !== "string") return null;
  const m = MONTH_RE.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12) return null;
  return toMonthKey(year, month);
}

/** "YYYY-MM-DD" de um dia que existe de verdade (31/04 e 29/02 fora do bissexto não) ou `null`. */
export function parseDayKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = DAY_RE.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(toMonthKey(year, month))) return null;
  return toDayKey(year, month, day);
}

function splitMonth(month: MonthKey): [number, number] {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return [y, m];
}

export function daysInMonth(month: MonthKey): number {
  const [y, m] = splitMonth(month);
  // Dia 0 do mês seguinte = último dia deste mês (em UTC, sem fuso).
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function monthOf(dayKey: string): MonthKey {
  return dayKey.slice(0, 7) as MonthKey;
}

export function firstDayOf(month: MonthKey): string {
  return `${month}-01`;
}

export function lastDayOf(month: MonthKey): string {
  return `${month}-${pad(daysInMonth(month))}`;
}

/** Mês anterior/seguinte (delta negativo/positivo), atravessando o ano. */
export function shiftMonth(month: MonthKey, delta: number): MonthKey {
  const [y, m] = splitMonth(month);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return toMonthKey(d.getUTCFullYear(), d.getUTCMonth() + 1);
}

/** Soma dias a uma chave de dia (em UTC, sem fuso). */
export function addDays(dayKey: string, delta: number): string {
  const [y, m, d] = dayKey.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + delta));
  return toDayKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** 1 = segunda … 7 = domingo (ISO 8601, igual ao date_trunc('week') do servidor). */
export function isoWeekday(dayKey: string): number {
  const [y, m, d] = dayKey.split("-").map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/**
 * As semanas do mês, de segunda a domingo. Só os dias reais do mês têm
 * chave; as casas antes do dia 1 e depois do último ficam `null`.
 */
export function monthWeeks(month: MonthKey): Array<Array<string | null>> {
  const total = daysInMonth(month);
  const lead = isoWeekday(firstDayOf(month)) - 1;
  const cells: Array<string | null> = Array.from({ length: lead }, () => null);
  for (let day = 1; day <= total; day++) cells.push(`${month}-${pad(day)}`);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: Array<Array<string | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function utcDate(dayKey: string): Date {
  const [y, m, d] = dayKey.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, 12));
}

const capitalize = (s: string) => s.charAt(0).toLocaleUpperCase("pt-BR") + s.slice(1);

/** "Novembro de 2026". */
export function formatMonthLabel(month: MonthKey): string {
  const text = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    utcDate(firstDayOf(month)),
  );
  return capitalize(text);
}

/** "Terça-feira, 17 de novembro de 2026". */
export function formatFullDate(dayKey: string): string {
  const text = new Intl.DateTimeFormat("pt-BR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(utcDate(dayKey));
  return capitalize(text);
}

export const WEEKDAYS = [
  { short: "Seg", long: "Segunda-feira" },
  { short: "Ter", long: "Terça-feira" },
  { short: "Qua", long: "Quarta-feira" },
  { short: "Qui", long: "Quinta-feira" },
  { short: "Sex", long: "Sexta-feira" },
  { short: "Sáb", long: "Sábado" },
  { short: "Dom", long: "Domingo" },
] as const;

/**
 * Mês exibido a partir da URL: `mes` válido; senão o mês de um `dia`
 * válido; senão o mês de hoje.
 */
export function resolveAgendaMonth(params: { mes?: unknown; dia?: unknown }, today: string): MonthKey {
  const month = parseMonthKey(params.mes);
  if (month) return month;
  const day = parseDayKey(params.dia);
  if (day) return monthOf(day);
  return monthOf(today);
}

/**
 * Dia selecionado dentro do mês exibido: o `dia` da URL quando é um dia
 * real DESTE mês; senão hoje (se hoje está neste mês); senão o dia 1.
 */
export function resolveSelectedDay(dia: unknown, month: MonthKey, today: string): string {
  const day = parseDayKey(dia);
  if (day && monthOf(day) === month) return day;
  if (monthOf(today) === month) return today;
  return firstDayOf(month);
}

/** URL da Agenda para um mês e dia. */
export function agendaHref(month: MonthKey, day: string): Route {
  return `/agenda?mes=${month}&dia=${day}` as Route;
}
