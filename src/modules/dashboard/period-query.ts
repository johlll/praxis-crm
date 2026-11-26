import { DataLoadError } from "@/server/data/load-error";
import type { DateRange } from "./period";

/** O período nas duas consultas da Visão geral (painel e origem): sempre o mesmo, do mesmo jeito. */
export type PeriodFilter = { periodDays: number; range?: DateRange | null | undefined };

/**
 * Atalho continua indo exatamente como antes (só `p_period_days`), então funciona também num banco que ainda
 * não tem o período personalizado. Com datas, vão as duas datas.
 */
export const periodArgs = ({ periodDays, range }: PeriodFilter) =>
  range ? { p_start_date: range.from, p_end_date: range.to } : { p_period_days: periodDays };

/**
 * Problemas que só o intervalo personalizado pode ter, e que a página explica em vez de tratar como falha:
 *  - `unavailable`: o banco deste ambiente ainda não tem a função com datas (migration não aplicada);
 *  - `rejected`: o banco recusou as datas (por exemplo, o dia virou entre a página e a consulta).
 */
export class PeriodRangeError extends DataLoadError {
  constructor(
    readonly reason: "unavailable" | "rejected",
    cause: unknown,
  ) {
    super("o período personalizado", cause);
    this.name = "PeriodRangeError";
  }
}

type QueryError = { message?: string | null; code?: string | null };

export function throwIfRangeProblem(error: QueryError, filter: PeriodFilter): void {
  if (!filter.range) return;
  // PGRST202: o PostgREST não encontrou função com esses nomes de parâmetro.
  if (error.code === "PGRST202") throw new PeriodRangeError("unavailable", error);
  if (error.message === "invalid_period") throw new PeriodRangeError("rejected", error);
}
