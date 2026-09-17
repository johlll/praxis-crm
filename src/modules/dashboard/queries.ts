import { createServerSupabaseClient } from "@/server/supabase/server";
import { DataLoadError, isExpectedAbsence } from "@/server/data/load-error";
import type { Role } from "@/lib/roles";
import type { ActivityType } from "@/modules/activities/queries";
import type { DashboardFilters } from "./schema";

/**
 * Visão geral (A10) — uma única RPC, public.get_dashboard, calcula tudo
 * no banco (definições em docs/decisoes/a10-dashboard.md).
 *
 * Campos em dinheiro são SEMPRE opcionais: a projeção por papel do
 * servidor decide se a chave existe. Para sales e viewer ela simplesmente
 * não chega aqui — esconder na tela não é a proteção.
 */

export type PeriodValue<T> = { current: T; previous: T };

export type AttentionItem = {
  id: string;
  leadId: string;
  contactName: string;
  legalArea: string;
  stageName: string;
  assignedToName: string | null;
  stageEnteredAt: string;
  isStalled: boolean;
  isUnassigned: boolean;
  overdueActivitiesCount: number;
  nextAction: { type: ActivityType; title: string; dueAt: string; hasTime: boolean } | null;
  valueCents?: number | null;
  valueBand?: string;
};

export type AgendaItem = {
  id: string;
  leadId: string;
  opportunityId: string | null;
  contactName: string;
  type: ActivityType;
  title: string;
  dueAt: string;
  hasTime: boolean;
  status: "pending" | "done";
  assignedToName: string | null;
  lockVersion: number;
};

export type SeriesBucket = {
  startDate: string;
  lastDate: string;
  count: number;
  valueCents?: number;
};

export type FunnelStage = {
  stageId: string;
  name: string;
  position: number;
  openNow: number;
  /** Oportunidades da coorte que passaram por esta etapa (registro efetivo, uma vez cada). */
  visited: number;
  /** Das que passaram por esta etapa, quantas seguiram adiante (etapa posterior ou ganho). */
  advanced: number;
  cohortOpenHere: number;
  cohortLostHere: number;
  cohortWonHere: number;
  valueSumCents?: number;
};

export type TeamRow = {
  userId: string | null;
  fullName: string | null;
  /** Responsável sem membership ativa: saiu do escritório e os registros dele continuam atribuídos. */
  isFormer: boolean;
  leadsReceived: number;
  consultationsDone: number;
  opportunitiesWon: number;
  overdueActivities: number;
};

export type Dashboard = {
  role: Role;
  isDemo: boolean;
  generatedAt: string;
  stalledDays: number;
  period: {
    days: number;
    currentStart: string;
    currentEnd: string;
    previousStart: string;
    previousEnd: string;
    today: string;
  };
  legalAreas: string[];
  pipelines: { id: string; name: string; isDefault: boolean }[];
  metrics: {
    leadsReceived: PeriodValue<number>;
    consultationsDone: PeriodValue<number>;
    proposalsSent: PeriodValue<number>;
    opportunitiesWon: PeriodValue<number>;
    daysToWin: PeriodValue<number | null>;
    wonValueCents?: PeriodValue<number>;
  };
  cohort: { leads: number; leadsWithWon: number };
  positions: {
    openOpportunities: number;
    stalledOpportunities: number;
    unassignedOpenOpportunities: number;
    openWithoutNextAction: number;
    overdueActivities: number;
    opportunitiesWithOverdue: number;
    attentionOpportunities: number;
    todayActivities: number;
    todayActivitiesPending: number;
    openValueCents?: number;
    openWithoutValue?: number;
    attentionValueCents?: number;
  };
  attention: { total: number; items: AttentionItem[] };
  agendaToday: { total: number; items: AgendaItem[] };
  series: {
    bucketDays: number;
    won: SeriesBucket[];
    forecast?: {
      buckets: SeriesBucket[];
      pastDue: number;
      withoutDate: number;
      withoutValue: number;
    };
  };
  team: TeamRow[];
  funnel: {
    pipelineId: string;
    pipelineName: string;
    cohortSize: number;
    cohortWon: number;
    cohortLost: number;
    cohortOpen: number;
    stages: FunnelStage[];
  } | null;
  insightData: {
    stalledTopStage: { stageName: string; count: number } | null;
    cohortLostTopReason: { label: string; count: number } | null;
    cohortLostTotal: number;
  };
};

type Raw = Record<string, unknown>;

const num = (value: unknown): number => Number(value ?? 0);
const obj = (value: unknown): Raw => (value ?? {}) as Raw;
const arr = (value: unknown): Raw[] => (Array.isArray(value) ? (value as Raw[]) : []);

function periodValue(raw: unknown): PeriodValue<number> {
  const r = obj(raw);
  return { current: num(r.current), previous: num(r.previous) };
}

function mapBucket(raw: Raw): SeriesBucket {
  return {
    startDate: String(raw.start_date),
    lastDate: String(raw.last_date),
    count: num(raw.count),
    ...("value_cents" in raw ? { valueCents: num(raw.value_cents) } : {}),
  };
}

export function mapDashboard(raw: Raw): Dashboard {
  const period = obj(raw.period);
  const pm = obj(raw.period_metrics);
  const pos = obj(raw.positions);
  const series = obj(raw.series);
  const forecast = series.forecast === undefined ? undefined : obj(series.forecast);
  const funnel = raw.funnel ? obj(raw.funnel) : null;
  const insight = obj(raw.insight_data);
  const daysToWin = obj(pm.days_to_win);
  const stalledTop = insight.stalled_top_stage ? obj(insight.stalled_top_stage) : null;
  const lostTop = insight.cohort_lost_top_reason ? obj(insight.cohort_lost_top_reason) : null;

  return {
    role: raw.role as Role,
    isDemo: raw.is_demo === true,
    generatedAt: String(raw.generated_at),
    stalledDays: num(raw.stalled_days),
    period: {
      days: num(period.days),
      currentStart: String(period.current_start),
      currentEnd: String(period.current_end),
      previousStart: String(period.previous_start),
      previousEnd: String(period.previous_end),
      today: String(period.today),
    },
    legalAreas: (Array.isArray(raw.legal_areas) ? raw.legal_areas : []).map(String),
    pipelines: arr(raw.pipelines).map((p) => ({ id: String(p.id), name: String(p.name), isDefault: p.is_default === true })),
    metrics: {
      leadsReceived: periodValue(pm.leads_received),
      consultationsDone: periodValue(pm.consultations_done),
      proposalsSent: periodValue(pm.proposals_sent),
      opportunitiesWon: periodValue(pm.opportunities_won),
      daysToWin: {
        current: daysToWin.current === null || daysToWin.current === undefined ? null : Number(daysToWin.current),
        previous: daysToWin.previous === null || daysToWin.previous === undefined ? null : Number(daysToWin.previous),
      },
      ...("won_value_cents" in pm ? { wonValueCents: periodValue(pm.won_value_cents) } : {}),
    },
    cohort: { leads: num(obj(raw.cohort).leads), leadsWithWon: num(obj(raw.cohort).leads_with_won) },
    positions: {
      openOpportunities: num(pos.open_opportunities),
      stalledOpportunities: num(pos.stalled_opportunities),
      unassignedOpenOpportunities: num(pos.unassigned_open_opportunities),
      openWithoutNextAction: num(pos.open_without_next_action),
      overdueActivities: num(pos.overdue_activities),
      opportunitiesWithOverdue: num(pos.opportunities_with_overdue),
      attentionOpportunities: num(pos.attention_opportunities),
      todayActivities: num(pos.today_activities),
      todayActivitiesPending: num(pos.today_activities_pending),
      ...("open_value_cents" in pos
        ? {
            openValueCents: num(pos.open_value_cents),
            openWithoutValue: num(pos.open_without_value),
            attentionValueCents: num(pos.attention_value_cents),
          }
        : {}),
    },
    attention: {
      total: num(obj(raw.attention).total),
      items: arr(obj(raw.attention).items).map((item) => {
        const next = item.next_action ? obj(item.next_action) : null;
        return {
          id: String(item.id),
          leadId: String(item.lead_id),
          contactName: String(item.contact_name),
          legalArea: String(item.legal_area),
          stageName: String(item.stage_name),
          assignedToName: (item.assigned_to_name as string | null) ?? null,
          stageEnteredAt: String(item.stage_entered_at),
          isStalled: item.is_stalled === true,
          isUnassigned: item.is_unassigned === true,
          overdueActivitiesCount: num(item.overdue_activities_count),
          nextAction: next
            ? {
                type: next.type as ActivityType,
                title: String(next.title),
                dueAt: String(next.due_at),
                hasTime: next.has_time === true,
              }
            : null,
          ...("value_cents" in item ? { valueCents: (item.value_cents as number | null) ?? null } : {}),
          ...("value_band" in item ? { valueBand: String(item.value_band) } : {}),
        };
      }),
    },
    agendaToday: {
      total: num(obj(raw.agenda_today).total),
      items: arr(obj(raw.agenda_today).items).map((item) => ({
        id: String(item.id),
        leadId: String(item.lead_id),
        opportunityId: (item.opportunity_id as string | null) ?? null,
        contactName: String(item.contact_name),
        type: item.type as ActivityType,
        title: String(item.title),
        dueAt: String(item.due_at),
        hasTime: item.has_time === true,
        status: item.status === "done" ? "done" : "pending",
        assignedToName: (item.assigned_to_name as string | null) ?? null,
        lockVersion: num(item.lock_version),
      })),
    },
    series: {
      bucketDays: num(series.bucket_days),
      won: arr(series.won).map(mapBucket),
      ...(forecast
        ? {
            forecast: {
              buckets: arr(forecast.buckets).map(mapBucket),
              pastDue: num(forecast.past_due),
              withoutDate: num(forecast.without_date),
              withoutValue: num(forecast.without_value),
            },
          }
        : {}),
    },
    team: arr(raw.team).map((row) => ({
      userId: (row.user_id as string | null) ?? null,
      fullName: (row.full_name as string | null) ?? null,
      isFormer: row.is_former === true,
      leadsReceived: num(row.leads_received),
      consultationsDone: num(row.consultations_done),
      opportunitiesWon: num(row.opportunities_won),
      overdueActivities: num(row.overdue_activities),
    })),
    funnel: funnel
      ? {
          pipelineId: String(funnel.pipeline_id),
          pipelineName: String(funnel.pipeline_name),
          cohortSize: num(funnel.cohort_size),
          cohortWon: num(funnel.cohort_won),
          cohortLost: num(funnel.cohort_lost),
          cohortOpen: num(funnel.cohort_open),
          stages: arr(funnel.stages).map((s) => ({
            stageId: String(s.stage_id),
            name: String(s.name),
            position: num(s.position),
            openNow: num(s.open_now),
            visited: num(s.visited),
            advanced: num(s.advanced),
            cohortOpenHere: num(s.cohort_open_here),
            cohortLostHere: num(s.cohort_lost_here),
            cohortWonHere: num(s.cohort_won_here),
            ...("value_sum_cents" in s ? { valueSumCents: num(s.value_sum_cents) } : {}),
          })),
        }
      : null,
    insightData: {
      stalledTopStage: stalledTop ? { stageName: String(stalledTop.stage_name), count: num(stalledTop.count) } : null,
      cohortLostTopReason: lostTop ? { label: String(lostTop.label), count: num(lostTop.count) } : null,
      cohortLostTotal: num(insight.cohort_lost_total),
    },
  };
}

export class DashboardLoadError extends DataLoadError {
  constructor(resource: string, cause?: unknown) {
    super(resource, cause);
    this.name = "DashboardLoadError";
  }
}

async function callDashboard(workspaceId: string, filters: DashboardFilters, pipelineId: string | null) {
  const supabase = await createServerSupabaseClient();
  return supabase.rpc("get_dashboard", {
    p_workspace_id: workspaceId,
    p_period_days: filters.periodDays,
    ...(filters.assignedTo ? { p_assigned_to: filters.assignedTo } : {}),
    p_only_unassigned: filters.onlyUnassigned,
    ...(filters.legalArea ? { p_legal_area: filters.legalArea } : {}),
    ...(pipelineId ? { p_pipeline_id: pipelineId } : {}),
  });
}

/**
 * Falha de consulta nunca vira zero ou painel vazio: lança
 * DashboardLoadError e a rota mostra o erro com "Tentar novamente".
 * Única ausência esperada: um pipeline da URL que não existe (mais) neste
 * escritório — aí o painel volta para o pipeline padrão.
 */
export async function getDashboard(workspaceId: string, filters: DashboardFilters): Promise<Dashboard> {
  let { data, error } = await callDashboard(workspaceId, filters, filters.pipelineId);

  if (error && filters.pipelineId && isExpectedAbsence(error, ["pipeline_not_found"])) {
    ({ data, error } = await callDashboard(workspaceId, filters, null));
  }

  if (error || !data || typeof data !== "object") {
    throw new DashboardLoadError(`a visão geral do workspace ${workspaceId}`, error ?? "resposta vazia");
  }

  return mapDashboard(data as Raw);
}
