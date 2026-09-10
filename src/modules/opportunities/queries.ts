import { createServerSupabaseClient } from "@/server/supabase/server";
import type { Database } from "@/server/types/database";

export type FeeModel = Database["public"]["Enums"]["fee_model"];
export type OpportunityStatus = Database["public"]["Enums"]["opportunity_status"];
export type StageRequirementType = Database["public"]["Enums"]["stage_requirement_type"];

/**
 * Campos financeiros SEMPRE opcionais no tipo — a projeção por papel do
 * servidor decide quais chaves existem no JSON (nenhuma, faixa, ou
 * exato). Nunca assumir que `valueCents` está presente só porque o tipo
 * TypeScript permite: para o papel errado, a chave nem chega aqui.
 */
export type OpportunityCard = {
  id: string;
  leadId: string;
  contactName: string;
  legalArea: string;
  assignedTo: string | null;
  assignedToName: string | null;
  stageEnteredAt: string;
  lockVersion: number;
  valueCents?: number;
  feeModel?: FeeModel | null;
  probability?: number | null;
  forecastDate?: string | null;
  valueBand?: string;
};

export type PipelineBoardColumn = {
  stageId: string;
  stageName: string;
  position: number;
  color: string | null;
  isWon: boolean;
  isLost: boolean;
  count: number;
  avgSecondsInStage: number | null;
  cards: OpportunityCard[];
  valueSumCents?: number;
};

type BoardColumnJson = {
  stage_id: string;
  stage_name: string;
  position: number;
  color: string | null;
  is_won: boolean;
  is_lost: boolean;
  count: number;
  avg_seconds_in_stage: number | null;
  value_sum_cents?: number;
  cards: Array<{
    id: string;
    lead_id: string;
    contact_name: string;
    legal_area: string;
    assigned_to: string | null;
    assigned_to_name: string | null;
    stage_entered_at: string;
    lock_version: number;
    value_cents?: number;
    fee_model?: FeeModel | null;
    probability?: number | null;
    forecast_date?: string | null;
    value_band?: string;
  }>;
};

function mapCard(row: BoardColumnJson["cards"][number]): OpportunityCard {
  return {
    id: row.id,
    leadId: row.lead_id,
    contactName: row.contact_name,
    legalArea: row.legal_area,
    assignedTo: row.assigned_to,
    assignedToName: row.assigned_to_name,
    stageEnteredAt: row.stage_entered_at,
    lockVersion: row.lock_version,
    ...(row.value_cents !== undefined ? { valueCents: row.value_cents } : {}),
    ...(row.fee_model !== undefined ? { feeModel: row.fee_model } : {}),
    ...(row.probability !== undefined ? { probability: row.probability } : {}),
    ...(row.forecast_date !== undefined ? { forecastDate: row.forecast_date } : {}),
    ...(row.value_band !== undefined ? { valueBand: row.value_band } : {}),
  };
}

export async function getPipelineBoard(pipelineId: string): Promise<PipelineBoardColumn[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_pipeline_board", { p_pipeline_id: pipelineId });
  if (error || !data) return [];

  const columns = data as unknown as BoardColumnJson[];
  return columns.map((col) => ({
    stageId: col.stage_id,
    stageName: col.stage_name,
    position: col.position,
    color: col.color,
    isWon: col.is_won,
    isLost: col.is_lost,
    count: col.count,
    avgSecondsInStage: col.avg_seconds_in_stage,
    cards: col.cards.map(mapCard),
    ...(col.value_sum_cents !== undefined ? { valueSumCents: col.value_sum_cents } : {}),
  }));
}

export type OpportunityDetail = OpportunityCard & {
  workspaceId: string;
  pipelineId: string;
  pipelineName: string;
  stageId: string;
  stageName: string;
  status: OpportunityStatus;
  lostReasonId: string | null;
  lostReasonLabel: string | null;
  lostNote: string | null;
  lostFollowupDate: string | null;
  wonAt: string | null;
  signedAt: string | null;
  createdAt: string;
  updatedAt: string;
  requirementValues: Array<{
    requirementId: string;
    stageId: string;
    label: string;
    fieldType: StageRequirementType;
    valueText: string | null;
    valueBool: boolean | null;
  }>;
  history: Array<{
    fromStageId: string | null;
    toStageId: string;
    actorUserId: string;
    occurredAt: string;
    secondsInPreviousStage: number | null;
  }>;
};

export async function getOpportunity(opportunityId: string): Promise<OpportunityDetail | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_opportunity", { p_opportunity_id: opportunityId });
  if (error || !data) return null;

  const row = data as Record<string, unknown>;
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    leadId: row.lead_id as string,
    contactName: row.contact_name as string,
    legalArea: row.legal_area as string,
    assignedTo: row.assigned_to as string | null,
    assignedToName: row.assigned_to_name as string | null,
    pipelineId: row.pipeline_id as string,
    pipelineName: row.pipeline_name as string,
    stageId: row.stage_id as string,
    stageName: row.stage_name as string,
    stageEnteredAt: row.stage_entered_at as string,
    status: row.status as OpportunityStatus,
    lostReasonId: (row.lost_reason_id as string | null) ?? null,
    lostReasonLabel: (row.lost_reason_label as string | null) ?? null,
    lostNote: (row.lost_note as string | null) ?? null,
    lostFollowupDate: (row.lost_followup_date as string | null) ?? null,
    wonAt: (row.won_at as string | null) ?? null,
    signedAt: (row.signed_at as string | null) ?? null,
    lockVersion: row.lock_version as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    requirementValues: ((row.requirement_values as unknown[]) ?? []).map((r) => {
      const item = r as Record<string, unknown>;
      return {
        requirementId: item.requirement_id as string,
        stageId: item.stage_id as string,
        label: item.label as string,
        fieldType: item.field_type as StageRequirementType,
        valueText: (item.value_text as string | null) ?? null,
        valueBool: (item.value_bool as boolean | null) ?? null,
      };
    }),
    history: ((row.history as unknown[]) ?? []).map((h) => {
      const item = h as Record<string, unknown>;
      return {
        fromStageId: (item.from_stage_id as string | null) ?? null,
        toStageId: item.to_stage_id as string,
        actorUserId: item.actor_user_id as string,
        occurredAt: item.occurred_at as string,
        secondsInPreviousStage: (item.seconds_in_previous_stage as number | null) ?? null,
      };
    }),
    ...(row.value_cents !== undefined ? { valueCents: row.value_cents as number } : {}),
    ...(row.fee_model !== undefined ? { feeModel: row.fee_model as FeeModel | null } : {}),
    ...(row.probability !== undefined ? { probability: row.probability as number | null } : {}),
    ...(row.forecast_date !== undefined ? { forecastDate: row.forecast_date as string | null } : {}),
    ...(row.value_band !== undefined ? { valueBand: row.value_band as string } : {}),
  };
}

export type StageRequirementStatus = {
  requirementId: string;
  stageId: string;
  stageName: string;
  label: string;
  fieldType: StageRequirementType;
  hint: string | null;
  valueText: string | null;
  valueBool: boolean | null;
  filled: boolean;
};

export async function getStageRequirementsStatus(
  opportunityId: string,
  toStageId: string,
): Promise<StageRequirementStatus[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_stage_requirements_status", {
    p_opportunity_id: opportunityId,
    p_to_stage_id: toStageId,
  });
  if (error || !data) return [];

  return (data as unknown[]).map((r) => {
    const item = r as Record<string, unknown>;
    return {
      requirementId: item.requirement_id as string,
      stageId: item.stage_id as string,
      stageName: item.stage_name as string,
      label: item.label as string,
      fieldType: item.field_type as StageRequirementType,
      hint: (item.hint as string | null) ?? null,
      valueText: (item.value_text as string | null) ?? null,
      valueBool: (item.value_bool as boolean | null) ?? null,
      filled: item.filled as boolean,
    };
  });
}

/**
 * Requisitos NECESSÁRIOS PARA GANHAR (required_for_win), de qualquer
 * etapa do pipeline — não só o caminho percorrido, diferente de
 * getStageRequirementsStatus(). Mesmo formato de linha, reaproveitado.
 */
export async function getWinRequirementsStatus(opportunityId: string): Promise<StageRequirementStatus[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_win_requirements_status", {
    p_opportunity_id: opportunityId,
  });
  if (error || !data) return [];

  return (data as unknown[]).map((r) => {
    const item = r as Record<string, unknown>;
    return {
      requirementId: item.requirement_id as string,
      stageId: item.stage_id as string,
      stageName: item.stage_name as string,
      label: item.label as string,
      fieldType: item.field_type as StageRequirementType,
      hint: (item.hint as string | null) ?? null,
      valueText: (item.value_text as string | null) ?? null,
      valueBool: (item.value_bool as boolean | null) ?? null,
      filled: item.filled as boolean,
    };
  });
}

export type PipelineOption = { id: string; name: string; isDefault: boolean };
export type PipelineStageOption = { id: string; pipelineId: string; name: string; position: number };
export type LostReasonOption = { id: string; label: string };

export async function listPipelines(workspaceId: string): Promise<PipelineOption[]> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("pipelines")
    .select("id, name, is_default")
    .eq("workspace_id", workspaceId)
    .order("is_default", { ascending: false })
    .order("name", { ascending: true });

  return (data ?? []).map((p) => ({ id: p.id, name: p.name, isDefault: p.is_default }));
}

export async function getDefaultPipeline(workspaceId: string): Promise<PipelineOption | null> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("pipelines")
    .select("id, name, is_default")
    .eq("workspace_id", workspaceId)
    .eq("is_default", true)
    .maybeSingle();

  return data ? { id: data.id, name: data.name, isDefault: data.is_default } : null;
}

export async function listPipelineStages(pipelineId: string): Promise<PipelineStageOption[]> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("pipeline_stages")
    .select("id, pipeline_id, name, position")
    .eq("pipeline_id", pipelineId)
    .order("position", { ascending: true });

  return (data ?? []).map((s) => ({ id: s.id, pipelineId: s.pipeline_id, name: s.name, position: s.position }));
}

export type StageRequirementDetail = {
  id: string;
  label: string;
  fieldType: StageRequirementType;
  hint: string | null;
  position: number;
  requiredForWin: boolean;
};

export type PipelineStageDetail = {
  id: string;
  pipelineId: string;
  name: string;
  position: number;
  color: string | null;
  isWon: boolean;
  isLost: boolean;
  requirements: StageRequirementDetail[];
};

/**
 * Etapas com detalhe completo (cor, terminal, requisitos) para a tela de
 * configuração — `listPipelineStages` (mais enxuta, só id/nome/posição) é
 * a usada nos formulários de oportunidade, que não precisam do resto.
 */
export async function listPipelineStagesWithDetails(pipelineId: string): Promise<PipelineStageDetail[]> {
  const supabase = await createServerSupabaseClient();
  const { data: stages } = await supabase
    .from("pipeline_stages")
    .select("id, pipeline_id, name, position, color, is_won, is_lost")
    .eq("pipeline_id", pipelineId)
    .order("position", { ascending: true });

  if (!stages || stages.length === 0) return [];

  const stageIds = stages.map((s) => s.id);
  const { data: requirements } = await supabase
    .from("stage_requirements")
    .select("id, stage_id, label, field_type, hint, position, required_for_win")
    .in("stage_id", stageIds)
    .order("position", { ascending: true });

  const requirementsByStage = new Map<string, StageRequirementDetail[]>();
  for (const r of requirements ?? []) {
    const list = requirementsByStage.get(r.stage_id) ?? [];
    list.push({
      id: r.id,
      label: r.label,
      fieldType: r.field_type,
      hint: r.hint,
      position: r.position,
      requiredForWin: r.required_for_win,
    });
    requirementsByStage.set(r.stage_id, list);
  }

  return stages.map((s) => ({
    id: s.id,
    pipelineId: s.pipeline_id,
    name: s.name,
    position: s.position,
    color: s.color,
    isWon: s.is_won,
    isLost: s.is_lost,
    requirements: requirementsByStage.get(s.id) ?? [],
  }));
}

export async function listLostReasons(workspaceId: string): Promise<LostReasonOption[]> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("lost_reasons")
    .select("id, label")
    .eq("workspace_id", workspaceId)
    .eq("active", true)
    .order("position", { ascending: true });

  return (data ?? []).map((r) => ({ id: r.id, label: r.label }));
}

export type OpportunityListItem = OpportunityCard & {
  pipelineId: string;
  stageId: string;
  stageName: string;
  status: OpportunityStatus;
  createdAt: string;
  updatedAt: string;
};

export async function listOpportunities(
  workspaceId: string,
  filters: {
    pipelineId?: string | undefined;
    stageId?: string | undefined;
    status?: OpportunityStatus | undefined;
    search?: string | undefined;
    sort?: "created_at_desc" | "created_at_asc" | undefined;
    page?: number | undefined;
    leadId?: string | undefined;
  } = {},
): Promise<{ items: OpportunityListItem[]; total: number; page: number; pageSize: number }> {
  const supabase = await createServerSupabaseClient();
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = 20;

  const { data, error } = await supabase.rpc("list_opportunities", {
    p_workspace_id: workspaceId,
    ...(filters.pipelineId ? { p_pipeline_id: filters.pipelineId } : {}),
    ...(filters.stageId ? { p_stage_id: filters.stageId } : {}),
    ...(filters.status ? { p_status: filters.status } : {}),
    ...(filters.search ? { p_search: filters.search } : {}),
    p_sort: filters.sort ?? "created_at_desc",
    p_page: page,
    p_page_size: pageSize,
    ...(filters.leadId ? { p_lead_id: filters.leadId } : {}),
  });

  if (error || !data || data.length === 0) {
    return { items: [], total: 0, page, pageSize };
  }

  const row = data[0]!;
  const items = (row.items as unknown as Array<Record<string, unknown>> | null) ?? [];

  return {
    items: items.map((r) => ({
      id: r.id as string,
      leadId: r.lead_id as string,
      contactName: r.contact_name as string,
      legalArea: r.legal_area as string,
      assignedTo: (r.assigned_to as string | null) ?? null,
      assignedToName: (r.assigned_to_name as string | null) ?? null,
      pipelineId: r.pipeline_id as string,
      stageId: r.stage_id as string,
      stageName: r.stage_name as string,
      status: r.status as OpportunityStatus,
      stageEnteredAt: r.stage_entered_at as string,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      lockVersion: r.lock_version as number,
      ...(r.value_cents !== undefined ? { valueCents: r.value_cents as number } : {}),
      ...(r.fee_model !== undefined ? { feeModel: r.fee_model as FeeModel | null } : {}),
      ...(r.probability !== undefined ? { probability: r.probability as number | null } : {}),
      ...(r.forecast_date !== undefined ? { forecastDate: r.forecast_date as string | null } : {}),
      ...(r.value_band !== undefined ? { valueBand: r.value_band as string } : {}),
    })),
    total: row.total_count,
    page,
    pageSize,
  };
}
