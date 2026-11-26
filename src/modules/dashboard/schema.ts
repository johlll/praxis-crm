import type { Route } from "next";

import { dateTimeInputParts } from "@/lib/timezone";
import { uuidSchema } from "@/lib/uuid";
import { checkRange, type DateRange } from "./period";
import {
  DEFAULT_ATTRIBUTION_MODEL,
  parseAttributionModel,
  type AttributionModel,
} from "@/modules/forms/schema";

const isUuid = (value: string) => uuidSchema.safeParse(value).success;

export const DASHBOARD_PERIODS = [7, 30, 90] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];

/** Valor do filtro de responsável que significa "leads sem responsável". */
export const UNASSIGNED_FILTER = "sem";

/** Valor de `periodo` na URL quando as datas são escolhidas no calendário. */
export const CUSTOM_PERIOD = "personalizado";

export type DashboardFilters = {
  /** Atalho em uso. Com `range`, fica no padrão e não vale. */
  periodDays: DashboardPeriod;
  /** Intervalo escolhido no calendário (datas civis do escritório, as duas inclusivas). */
  range?: DateRange | null;
  /** O endereço pediu um intervalo que não vale: a página mostra o motivo e NENHUM número. */
  rangeError?: string | null;
  assignedTo: string | null;
  onlyUnassigned: boolean;
  legalArea: string | null;
  pipelineId: string | null;
  /**
   * A11 — modelo de atribuição e filtro de origem. Ficam EXPLÍCITOS na
   * URL para que aplicar, limpar, voltar e avançar continuem
   * sincronizados, como todo o resto dos filtros.
   */
  attributionModel: AttributionModel;
  source: string | null;
  /** Oportunidade aberta no painel lateral (não filtra nada). */
  selectedOpportunityId: string | null;
};

type RawParams = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * searchParams → filtros válidos. Valor desconhecido nunca vira erro nem
 * consulta estranha: cai no padrão (30 dias, todos, todas, pipeline padrão).
 *
 * Exceção: quem pede um intervalo de datas (`periodo=personalizado`, `de` ou
 * `ate`) e erra recebe `rangeError` — trocar em silêncio por outro período
 * mostraria números que a pessoa não pediu.
 */
export function parseDashboardFilters(params: RawParams, today = dateTimeInputParts(new Date().toISOString(), false).date): DashboardFilters {
  const rawPeriod = single(params.periodo);
  const period = Number(rawPeriod);
  const from = single(params.de)?.trim();
  const to = single(params.ate)?.trim();
  const asksRange = rawPeriod === CUSTOM_PERIOD || from !== undefined || to !== undefined;
  const checked = asksRange ? checkRange(from, to, today) : null;
  const responsavel = single(params.responsavel)?.trim() ?? "";
  const area = single(params.area)?.trim() ?? "";
  const pipeline = single(params.pipeline)?.trim() ?? "";
  const op = single(params.op)?.trim() ?? "";
  const origem = single(params.origem)?.trim() ?? "";

  return {
    periodDays: !asksRange && (DASHBOARD_PERIODS as readonly number[]).includes(period) ? (period as DashboardPeriod) : 30,
    ...(checked ? (checked.ok ? { range: checked.range } : { rangeError: checked.error }) : {}),
    assignedTo: isUuid(responsavel) ? responsavel : null,
    onlyUnassigned: responsavel === UNASSIGNED_FILTER,
    legalArea: area !== "" && area.length <= 120 ? area : null,
    pipelineId: isUuid(pipeline) ? pipeline : null,
    attributionModel: parseAttributionModel(single(params.modelo)?.trim()),
    source: origem !== "" && origem.length <= 160 ? origem : null,
    selectedOpportunityId: isUuid(op) ? op : null,
  };
}

/** Filtros → endereço da própria página (sem os valores padrão). */
export function dashboardHref(filters: DashboardFilters, overrides: Partial<DashboardFilters> = {}): Route {
  const f = { ...filters, ...overrides };
  const params = new URLSearchParams();
  if (f.range) {
    params.set("periodo", CUSTOM_PERIOD);
    params.set("de", f.range.from);
    params.set("ate", f.range.to);
  } else if (f.periodDays !== 30) params.set("periodo", String(f.periodDays));
  if (f.onlyUnassigned) params.set("responsavel", UNASSIGNED_FILTER);
  else if (f.assignedTo) params.set("responsavel", f.assignedTo);
  if (f.legalArea) params.set("area", f.legalArea);
  if (f.pipelineId) params.set("pipeline", f.pipelineId);
  if (f.attributionModel !== DEFAULT_ATTRIBUTION_MODEL) params.set("modelo", f.attributionModel);
  if (f.source) params.set("origem", f.source);
  if (f.selectedOpportunityId) params.set("op", f.selectedOpportunityId);
  const query = params.toString();
  // "as Route": a rota é fixa (/visao-geral); só a query string varia.
  return (query ? `/visao-geral?${query}` : "/visao-geral") as Route;
}
