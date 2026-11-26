import type { Route } from "next";

/**
 * Tráfego Pago — filtros (docs/decisoes/trafego-pago.md). Puro: nada aqui lê banco, rede ou relógio.
 * Datas são texto "AAAA-MM-DD" no fuso do escritório; a aritmética é feita em dias inteiros (UTC), sem fuso.
 */

export const PLATFORMS = ["meta", "google"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const PLATFORM_LABEL: Record<Platform, string> = { meta: "Meta", google: "Google" };

export const PERIOD_PRESETS = ["7", "30", "90", "mes", "mes-anterior", "personalizado"] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];
export const PERIOD_LABEL: Record<PeriodPreset, string> = {
  "7": "Últimos 7 dias",
  "30": "Últimos 30 dias",
  "90": "Últimos 90 dias",
  mes: "Este mês",
  "mes-anterior": "Mês passado",
  personalizado: "Personalizado",
};
export const DEFAULT_PRESET: PeriodPreset = "30";

/** Maior intervalo personalizado aceito (um ano, contando um bissexto). */
export const MAX_CUSTOM_DAYS = 366;
const MIN_DATE = "2000-01-01";

export type TrafficFilters = {
  platforms: Platform[];
  preset: PeriodPreset;
  /** Só no personalizado: o que veio digitado, mesmo inválido (volta para os campos). */
  from: string;
  to: string;
};

export type DateRange = { from: string; to: string; days: number };

type RawParams = Record<string, string | string[] | undefined>;

const single = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
const many = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/** Lista de plataformas na ordem fixa; sem nenhuma válida, as duas. */
export function normalizePlatforms(values: readonly string[]): Platform[] {
  const chosen = PLATFORMS.filter((p) => values.includes(p));
  return chosen.length > 0 ? [...chosen] : [...PLATFORMS];
}

/**
 * searchParams → filtros. Plataforma ou atalho desconhecido caem no padrão. As datas do personalizado NÃO são
 * corrigidas: quem decide é resolvePeriod, que recusa com mensagem (nunca troca o período em silêncio).
 */
export function parseTrafficFilters(params: RawParams): TrafficFilters {
  const preset = single(params.periodo);
  return {
    platforms: normalizePlatforms(many(params.plataforma)),
    preset: (PERIOD_PRESETS as readonly string[]).includes(preset) ? (preset as PeriodPreset) : DEFAULT_PRESET,
    from: single(params.de).slice(0, 10),
    to: single(params.ate).slice(0, 10),
  };
}

export function trafficHref(filters: TrafficFilters): Route {
  const params = new URLSearchParams();
  if (filters.platforms.length === 1) params.set("plataforma", filters.platforms[0]!);
  if (filters.preset !== DEFAULT_PRESET) params.set("periodo", filters.preset);
  if (filters.preset === "personalizado") {
    params.set("de", filters.from);
    params.set("ate", filters.to);
  }
  const query = params.toString();
  // "as Route": a rota é fixa (/trafego-pago); só a query string varia.
  return (query ? `/trafego-pago?${query}` : "/trafego-pago") as Route;
}

/* ---------------------------------------------------------------- datas */

const DAY_MS = 86_400_000;

/** Dia inteiro desde 1970 de um "AAAA-MM-DD" REAL; texto malformado ou data inexistente (30/02) → null. */
export function dayNumber(iso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return ms / DAY_MS;
}

export function isoOfDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(iso: string, delta: number): string {
  return isoOfDay(dayNumber(iso)! + delta);
}

export function rangeOf(from: string, to: string): DateRange {
  return { from, to, days: dayNumber(to)! - dayNumber(from)! + 1 };
}

export type PeriodError =
  | "missing_from"
  | "missing_to"
  | "invalid_from"
  | "invalid_to"
  | "inverted"
  | "future"
  | "too_old"
  | "too_long";

export const PERIOD_ERROR_MESSAGE: Record<PeriodError, string> = {
  missing_from: "Informe a data de início.",
  missing_to: "Informe a data de fim.",
  invalid_from: "A data de início não existe. Use o formato dia/mês/ano.",
  invalid_to: "A data de fim não existe. Use o formato dia/mês/ano.",
  inverted: "A data de início precisa ser igual ou anterior à data de fim.",
  future: "A data de fim não pode ser depois de hoje.",
  too_old: "A data de início precisa ser a partir de 01/01/2000.",
  too_long: `O período personalizado pode ter no máximo ${MAX_CUSTOM_DAYS} dias.`,
};

export function validateCustomRange(from: string, to: string, today: string): PeriodError | null {
  if (from === "") return "missing_from";
  if (to === "") return "missing_to";
  const start = dayNumber(from);
  if (start === null) return "invalid_from";
  const end = dayNumber(to);
  if (end === null) return "invalid_to";
  if (start > end) return "inverted";
  if (end > dayNumber(today)!) return "future";
  if (start < dayNumber(MIN_DATE)!) return "too_old";
  if (end - start + 1 > MAX_CUSTOM_DAYS) return "too_long";
  return null;
}

export type PeriodResolution =
  | { ok: true; current: DateRange; previous: DateRange }
  | { ok: false; error: PeriodError };

/**
 * Período atual (datas inclusivas) e o anterior de IGUAL duração, imediatamente antes. "Últimos N dias" termina
 * hoje; "Este mês" vai do dia 1 até hoje; "Mês passado" é o mês civil anterior inteiro.
 */
export function resolvePeriod(filters: TrafficFilters, today: string): PeriodResolution {
  let from: string;
  let to: string = today;
  if (filters.preset === "personalizado") {
    const error = validateCustomRange(filters.from, filters.to, today);
    if (error) return { ok: false, error };
    from = filters.from;
    to = filters.to;
  } else if (filters.preset === "mes") {
    from = `${today.slice(0, 7)}-01`;
  } else if (filters.preset === "mes-anterior") {
    to = addDays(`${today.slice(0, 7)}-01`, -1);
    from = `${to.slice(0, 7)}-01`;
  } else {
    from = addDays(today, -(Number(filters.preset) - 1));
  }
  const current = rangeOf(from, to);
  const previousTo = addDays(from, -1);
  return { ok: true, current, previous: rangeOf(addDays(previousTo, -(current.days - 1)), previousTo) };
}
