import { createServerSupabaseClient } from "@/server/supabase/server";
import { DataLoadError, isExpectedAbsence } from "@/server/data/load-error";

import {
  mapCaseService,
  mapCaseServiceEvent,
  mapServiceType,
  type CaseService,
  type CaseServiceEvent,
  type ServiceTypeItem,
} from "./schema";

/**
 * Painel do caso, etapa B — leituras do número interno, do roteiro e do catálogo. Mesmo contrato de erro das
 * trilhas: ausência legítima (inexistente, fora do alcance, outro escritório) → `null`; qualquer outra falha
 * sobe como `CaseServiceLoadError`, nunca "sem dado".
 */

export class CaseServiceLoadError extends DataLoadError {
  constructor(resource: string, cause?: unknown) {
    super(resource, cause);
    this.name = "CaseServiceLoadError";
  }
}

const ABSENCE = ["opportunity_not_found", "insufficient_permission"] as const;

export async function getCaseService(opportunityId: string): Promise<CaseService | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_case_service", { p_opportunity_id: opportunityId });
  if (error) {
    if (isExpectedAbsence(error, ABSENCE)) return null;
    throw new CaseServiceLoadError(`o serviço do caso ${opportunityId}`, error);
  }
  if (!data) return null;
  return mapCaseService(data as Record<string, unknown>);
}

export type CaseServiceHistoryPage = { items: CaseServiceEvent[]; hasMore: boolean };

export async function listCaseServiceHistory(opportunityId: string, limit = 50): Promise<CaseServiceHistoryPage | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_case_service_history", { p_opportunity_id: opportunityId, p_limit: limit });
  if (error) {
    if (isExpectedAbsence(error, ABSENCE)) return null;
    throw new CaseServiceLoadError(`o histórico do roteiro do caso ${opportunityId}`, error);
  }
  const row = (Array.isArray(data) ? data[0] : data) as { items?: unknown; has_more?: unknown } | undefined;
  if (!row || !Array.isArray(row.items)) throw new CaseServiceLoadError(`o histórico do roteiro do caso ${opportunityId}`);
  return { items: (row.items as Record<string, unknown>[]).map(mapCaseServiceEvent), hasMore: row.has_more === true };
}

/** Catálogo do escritório (qualquer membro lê). `null` = sem acesso ao escritório. */
export async function listServiceTypes(workspaceId: string): Promise<ServiceTypeItem[] | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_service_types", { p_workspace_id: workspaceId });
  if (error) {
    if (isExpectedAbsence(error, ["insufficient_permission"])) return null;
    throw new CaseServiceLoadError("o catálogo de tipos de serviço", error);
  }
  if (!Array.isArray(data)) throw new CaseServiceLoadError("o catálogo de tipos de serviço");
  return (data as Record<string, unknown>[]).map(mapServiceType);
}
