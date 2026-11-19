import { createServerSupabaseClient } from "@/server/supabase/server";
import { DataLoadError, isExpectedAbsence } from "@/server/data/load-error";

import { CASE_NOTES_PAGE, mapCaseNote, type CaseNotesCursor, type CaseNotesPage } from "./schema";

/**
 * Observações por caso — leitura paginada no servidor (`list_case_notes`), da mais recente para a mais antiga
 * por (created_at, id). Contrato de erro do painel: ausência legítima (inexistente, fora do alcance, outro
 * escritório) → `null`; qualquer outra falha sobe como `CaseNotesLoadError` — NUNCA vira "nenhuma observação".
 */

export class CaseNotesLoadError extends DataLoadError {
  constructor(resource: string, cause?: unknown) {
    super(resource, cause);
    this.name = "CaseNotesLoadError";
  }
}

const ABSENCE = ["opportunity_not_found", "insufficient_permission"] as const;

export async function listCaseNotes(
  opportunityId: string,
  opts: { cursor?: CaseNotesCursor; limit?: number } = {},
): Promise<CaseNotesPage | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_case_notes", {
    p_opportunity_id: opportunityId,
    ...(opts.cursor ? { p_before: opts.cursor.before, p_before_id: opts.cursor.beforeId } : {}),
    p_limit: opts.limit ?? CASE_NOTES_PAGE,
  });
  if (error) {
    if (isExpectedAbsence(error, ABSENCE)) return null;
    throw new CaseNotesLoadError(`as observações do caso ${opportunityId}`, error);
  }
  const row = (Array.isArray(data) ? data[0] : data) as { items?: unknown; has_more?: unknown } | undefined;
  if (!row || !Array.isArray(row.items)) throw new CaseNotesLoadError(`as observações do caso ${opportunityId}`);
  const items = (row.items as Record<string, unknown>[]).map(mapCaseNote);
  const hasMore = row.has_more === true;
  const last = items.at(-1);
  return { items, hasMore, next: hasMore && last ? { before: last.createdAt, beforeId: last.id } : null };
}
