import { z } from "zod";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { DataLoadError, isExpectedAbsence } from "@/server/data/load-error";
import { uuidSchema } from "@/lib/uuid";
import { sanitizeAuditDetails, type AuditDetails } from "./catalog";
import { AUDIT_PAGE_SIZE, type AuditCursor, type AuditFilters } from "./schema";

/**
 * Leitura da trilha de auditoria (B5).
 *
 * Passa SÓ pela RPC `list_audit_log` (owner/admin): `audit_logs` não tem
 * grant de tabela para o cliente, então não existe SELECT direto — nem a
 * coluna `metadata` crua chega até aqui. O banco já devolve a projeção
 * sanitizada; esta camada valida o formato de novo e aplica a lista de
 * permissão dos detalhes (segunda barreira).
 *
 * Contrato de erro (docs/decisoes/estabilizacao-pos-a9.md §1):
 *  - `insufficient_permission` (inclusive workspace alheio ou inexistente,
 *    que o banco não distingue) → `null`: a página responde "não encontrado";
 *  - qualquer outra falha, ou linha fora do formato → DataLoadError. Nunca
 *    vira lista vazia.
 */

export type AuditEntry = {
  id: string;
  createdAt: string;
  action: string;
  actorUserId: string | null;
  actorName: string | null;
  targetName: string | null;
  details: AuditDetails;
};

export type AuditPage = {
  items: AuditEntry[];
  hasMore: boolean;
  /** Posição para pedir a página seguinte (registros mais antigos). */
  nextCursor: AuditCursor | null;
};

const rowSchema = z.object({
  id: uuidSchema,
  created_at: z.string().min(1),
  action: z.string().min(1).max(160),
  actor_user_id: uuidSchema.nullable(),
  actor_name: z.string().nullable(),
  target_name: z.string().nullable(),
  details: z.unknown(),
});

export class AuditLoadError extends DataLoadError {}

export async function listAuditLog(
  workspaceId: string,
  filters: AuditFilters,
  cursor: AuditCursor | null,
): Promise<AuditPage | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_audit_log", {
    p_workspace_id: workspaceId,
    ...(filters.action ? { p_action: filters.action } : {}),
    ...(filters.actorUserId ? { p_actor_user_id: filters.actorUserId } : {}),
    ...(filters.from ? { p_from: filters.from } : {}),
    ...(filters.to ? { p_to: filters.to } : {}),
    ...(cursor ? { p_before: cursor.createdAt, p_before_id: cursor.id } : {}),
    p_limit: AUDIT_PAGE_SIZE,
  });

  if (error) {
    if (isExpectedAbsence(error, ["insufficient_permission"])) return null;
    throw new AuditLoadError(`a auditoria do workspace ${workspaceId}`, error);
  }

  const page = data?.[0];
  if (!page) return { items: [], hasMore: false, nextCursor: null };

  const rows = z.array(rowSchema).safeParse(page.items);
  if (!rows.success) {
    throw new AuditLoadError(`a auditoria do workspace ${workspaceId} (formato inesperado)`, rows.error);
  }

  const items = rows.data.map(
    (row): AuditEntry => ({
      id: row.id,
      createdAt: row.created_at,
      action: row.action,
      actorUserId: row.actor_user_id,
      actorName: row.actor_name,
      targetName: row.target_name,
      details: sanitizeAuditDetails(row.details),
    }),
  );

  const last = items[items.length - 1];
  return {
    items,
    hasMore: page.has_more,
    nextCursor: page.has_more && last ? { createdAt: last.createdAt, id: last.id } : null,
  };
}
