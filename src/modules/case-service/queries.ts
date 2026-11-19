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

/** Posição no histórico: o último evento já mostrado. O horário volta ao banco exatamente como veio dele
 * (com microssegundos) — convertê-lo em Date cortaria a precisão e pularia ou repetiria eventos. */
export type CaseServiceHistoryCursor = { before: string; beforeId: string };

export type CaseServiceHistoryPage = {
  items: CaseServiceEvent[];
  hasMore: boolean;
  /** Cursor da próxima página (o evento mais antigo desta), ou null. */
  next: CaseServiceHistoryCursor | null;
};

export const CASE_SERVICE_HISTORY_PAGE = 50;

/** Uma página do histórico do roteiro, do mais novo ao mais antigo (horário, id), a partir do cursor. */
export async function listCaseServiceHistory(
  opportunityId: string,
  opts: { cursor?: CaseServiceHistoryCursor; limit?: number } = {},
): Promise<CaseServiceHistoryPage | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_case_service_history", {
    p_opportunity_id: opportunityId,
    ...(opts.cursor ? { p_before: opts.cursor.before, p_before_id: opts.cursor.beforeId } : {}),
    p_limit: opts.limit ?? CASE_SERVICE_HISTORY_PAGE,
  });
  if (error) {
    if (isExpectedAbsence(error, ABSENCE)) return null;
    throw new CaseServiceLoadError(`o histórico do roteiro do caso ${opportunityId}`, error);
  }
  const row = (Array.isArray(data) ? data[0] : data) as { items?: unknown; has_more?: unknown } | undefined;
  if (!row || !Array.isArray(row.items)) throw new CaseServiceLoadError(`o histórico do roteiro do caso ${opportunityId}`);
  const items = (row.items as Record<string, unknown>[]).map(mapCaseServiceEvent);
  const hasMore = row.has_more === true;
  const last = items.at(-1);
  return { items, hasMore, next: hasMore && last ? { before: last.occurredAt, beforeId: last.id } : null };
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
