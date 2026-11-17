"use server";

import { revalidatePath } from "next/cache";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { requirePermissionSafe } from "@/server/authz/safe";
import { toUserMessage } from "@/lib/errors";

import { mapTrackMutation, type TrackActionState, type TrackMutationResult } from "./queries";
import {
  TRACK_EDIT_PERMISSION,
  setAttendanceSchema,
  setCaseProgressSchema,
  setTrackAutomationSchema,
} from "./schema";

/**
 * Conversas + IA (PR 1) — correções HUMANAS das trilhas e pausa/retomada das
 * futuras alterações automáticas (docs/decisoes/conversas-ia-fundacao.md).
 * Nenhuma destas ações envia mensagem, chama serviço externo ou cria atividade.
 * A permissão é conferida aqui e de novo no banco (com o alcance do registro).
 */

function firstIssue(issues: { message: string }[]): string {
  return issues[0]?.message ?? "Dados inválidos.";
}

function revalidateTrack(result: TrackMutationResult) {
  if (result.conversationId) {
    revalidatePath("/conversas");
    revalidatePath(`/conversas/${result.conversationId}`);
  }
  if (result.opportunityId) revalidatePath("/pipeline");
}

export async function setConversationAttendanceAction(input: {
  conversationId: string;
  status: string;
  expectedVersion: number;
  evidenceMessageIds?: string[];
  idempotencyKey?: string;
}): Promise<TrackActionState> {
  const guard = await requirePermissionSafe("conversation.attendance_edit");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsed = setAttendanceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error.issues) };

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("set_conversation_attendance_status", {
    p_conversation_id: parsed.data.conversationId,
    p_status: parsed.data.status,
    p_expected_version: parsed.data.expectedVersion,
    p_evidence_message_ids: parsed.data.evidenceMessageIds,
    ...(parsed.data.idempotencyKey ? { p_idempotency_key: parsed.data.idempotencyKey } : {}),
  });
  if (error || !data) return { ok: false, error: toUserMessage(error) };

  const result = mapTrackMutation(data as Record<string, unknown>);
  revalidateTrack(result);
  return { ok: true, result };
}

export async function setOpportunityCaseProgressAction(input: {
  opportunityId: string;
  status: string;
  expectedVersion: number;
  evidenceMessageIds?: string[];
  idempotencyKey?: string;
}): Promise<TrackActionState> {
  const guard = await requirePermissionSafe("case.progress_edit");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsed = setCaseProgressSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error.issues) };

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("set_opportunity_case_progress", {
    p_opportunity_id: parsed.data.opportunityId,
    p_status: parsed.data.status,
    p_expected_version: parsed.data.expectedVersion,
    p_evidence_message_ids: parsed.data.evidenceMessageIds,
    ...(parsed.data.idempotencyKey ? { p_idempotency_key: parsed.data.idempotencyKey } : {}),
  });
  if (error || !data) return { ok: false, error: toUserMessage(error) };

  const result = mapTrackMutation(data as Record<string, unknown>);
  revalidateTrack(result);
  return { ok: true, result };
}

/** Pausar (`paused: true`) ou retomar as FUTURAS alterações automáticas de uma trilha. */
export async function setStatusTrackAutomationAction(input: {
  track: string;
  targetId: string;
  paused: boolean;
  expectedVersion: number;
}): Promise<TrackActionState> {
  const parsed = setTrackAutomationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error.issues) };

  const guard = await requirePermissionSafe(TRACK_EDIT_PERMISSION[parsed.data.track]);
  if ("error" in guard) return { ok: false, error: guard.error };

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("set_status_track_automation", {
    p_track: parsed.data.track,
    p_target_id: parsed.data.targetId,
    p_paused: parsed.data.paused,
    p_expected_version: parsed.data.expectedVersion,
  });
  if (error || !data) return { ok: false, error: toUserMessage(error) };

  const result = mapTrackMutation(data as Record<string, unknown>);
  revalidateTrack(result);
  return { ok: true, result };
}
