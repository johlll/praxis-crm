import type { Route } from "next";

import { uuidSchema } from "@/lib/uuid";
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

export type DashboardFilters = {
  periodDays: DashboardPeriod;
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
 */
export function parseDashboardFilters(params: RawParams): DashboardFilters {
  const period = Number(single(params.periodo));
  const responsavel = single(params.responsavel)?.trim() ?? "";
  const area = single(params.area)?.trim() ?? "";
  const pipeline = single(params.pipeline)?.trim() ?? "";
  const op = single(params.op)?.trim() ?? "";
  const origem = single(params.origem)?.trim() ?? "";

  return {
    periodDays: (DASHBOARD_PERIODS as readonly number[]).includes(period) ? (period as DashboardPeriod) : 30,
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
  if (f.periodDays !== 30) params.set("periodo", String(f.periodDays));
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
