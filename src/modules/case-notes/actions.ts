"use server";

import { revalidatePath } from "next/cache";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { requirePermissionSafe } from "@/server/authz/safe";
import { toUserMessage } from "@/lib/errors";

import { listCaseNotes } from "./queries";
import { addCaseNoteSchema, caseNotesPageSchema, mapCaseNote, type CaseNote, type CaseNotesPage } from "./schema";

/**
 * Observações por caso (docs/decisoes/conversas-observacoes-caso.md). Acrescentar é uma decisão HUMANA que
 * só grava a observação: não muda situação do atendimento, andamento, roteiro, etapa comercial, versões das
 * trilhas nem o vínculo da conversa; não envia mensagem nem dispara automação. A permissão é conferida aqui e
 * de novo no banco, com o escritório, o alcance do caso e o bloqueio de contato anonimizado. A chave de
 * idempotência vem da tela (uma por intenção): clique duplo e resposta perdida devolvem o mesmo registro.
 */

export type AddCaseNoteState = { ok: true; note: CaseNote; replayed: boolean } | { ok: false; error: string };

function firstIssue(issues: { message: string }[]): string {
  return issues[0]?.message ?? "Dados inválidos.";
}

export async function addCaseNoteAction(input: {
  opportunityId: string;
  body: string;
  idempotencyKey: string;
}): Promise<AddCaseNoteState> {
  const guard = await requirePermissionSafe("case_note.add");
  if ("error" in guard) return { ok: false, error: guard.error };
  const parsed = addCaseNoteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error.issues) };

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("add_case_note", {
    p_opportunity_id: parsed.data.opportunityId,
    p_body: parsed.data.body,
    p_idempotency_key: parsed.data.idempotencyKey,
  });
  if (error) return { ok: false, error: toUserMessage(error) };
  const row = (data ?? {}) as Record<string, unknown>;
  revalidatePath("/conversas", "layout");
  return { ok: true, note: mapCaseNote(row), replayed: row.replayed === true };
}

/**
 * Observações anteriores (Resumo), pelo cursor da última mostrada. Leitura: permissão e alcance são os do banco
 * (quem enxerga o caso lê). Fora do alcance volta como erro, nunca como lista vazia. Não grava nada.
 */
export async function loadCaseNotesAction(input: {
  opportunityId: string;
  before: string;
  beforeId: string;
}): Promise<{ ok: true; page: CaseNotesPage } | { ok: false; error: string }> {
  const parsed = caseNotesPageSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error.issues) };
  try {
    const page = await listCaseNotes(parsed.data.opportunityId, {
      cursor: { before: parsed.data.before, beforeId: parsed.data.beforeId },
    });
    if (!page) return { ok: false, error: "Não foi possível carregar as observações." };
    return { ok: true, page };
  } catch {
    return { ok: false, error: "Não foi possível carregar as observações. Tente de novo." };
  }
}
