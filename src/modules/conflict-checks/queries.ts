import { createServerSupabaseClient } from "@/server/supabase/server";
import type { Database } from "@/server/types/database";

export type ConflictCheckStatus = Database["public"]["Enums"]["conflict_check_status"];

export type ConflictCheck = {
  id: string | null;
  status: ConflictCheckStatus;
  note: string | null;
  checkedBy: string | null;
  checkedAt: string | null;
  lockVersion: number | null;
};

export class ConflictCheckLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictCheckLoadError";
  }
}

/** Nunca 404: ausência de verificação é um estado legítimo
 * ("não verificado"), não um erro — get_conflict_check() sempre devolve
 * um objeto, mesmo sem nenhum registro em conflict_checks ainda. */
export async function getConflictCheck(leadId: string): Promise<ConflictCheck> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_conflict_check", { p_lead_id: leadId });

  if (error) {
    throw new ConflictCheckLoadError(`Falha ao carregar a verificação de conflito do lead ${leadId}: ${error.message}`);
  }

  const row = (data as unknown as Record<string, unknown>) ?? {};
  return {
    id: (row.id as string | null) ?? null,
    status: (row.status as ConflictCheckStatus) ?? "nao_verificado",
    note: (row.note as string | null) ?? null,
    checkedBy: (row.checked_by as string | null) ?? null,
    checkedAt: (row.checked_at as string | null) ?? null,
    lockVersion: (row.lock_version as number | null) ?? null,
  };
}
