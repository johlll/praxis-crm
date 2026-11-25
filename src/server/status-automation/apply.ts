import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";
import type { Database } from "@/server/types/database";

/**
 * Aplicador determinístico de propostas de mudança de status (docs/decisoes/conversas-aplicador.md).
 *
 * Quem decide é o banco (`apply_status_track_automation`, só service_role e só com o portão aberto):
 * escritório, alvo, caso inequívoco, evidências, horário de origem contra a decisão humana, versão,
 * pausa e catálogo fechado são conferidos de novo no momento da gravação. Este módulo só aceita uma
 * proposta ESTRUTURADA e estrita — sem horário, remetente, autoridade, papel ou permissão declarados
 * (qualquer campo extra é recusado aqui, antes de chegar ao banco) — e repassa a resposta em códigos.
 *
 * Não há rota nem tela que o chame: quem chamar no futuro (o processamento interno, com o cliente
 * service_role, que o lint restringe às rotas de jobs) passa o cliente. Nada aqui registra texto de
 * mensagem.
 */

export const STATUS_AUTOMATION_CHANGES = ["set_status", "set_current_step", "complete_step", "commercial_stage", "commercial_outcome"] as const;
export const STATUS_AUTOMATION_TRACKS = ["attendance", "case_progress", "commercial_stage"] as const;

export const statusAutomationProposalSchema = z
  .object({
    workspaceId: uuidSchema,
    conversationId: uuidSchema,
    change: z.enum(STATUS_AUTOMATION_CHANGES),
    track: z.enum(STATUS_AUTOMATION_TRACKS),
    opportunityId: uuidSchema.nullable().default(null),
    toStatus: z.string().regex(/^[a-z_]{3,40}$/).nullable().default(null),
    stepId: uuidSchema.nullable().default(null),
    expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    evidenceMessageIds: z
      .array(uuidSchema)
      .min(1)
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, "evidência repetida"),
    idempotencyKey: uuidSchema,
    extractorRef: z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/).nullable().default(null),
  })
  .strict();

export type StatusAutomationProposal = z.input<typeof statusAutomationProposalSchema>;

export const STATUS_AUTOMATION_REFUSALS = [
  "commercial_manual_only",
  "step_completion_manual_only",
  "evidence_invalid",
  "conversation_link_unresolved",
  "ambiguous_case",
  "target_mismatch",
  "opportunity_not_won",
  "automation_paused",
  "version_stale",
  "evidence_not_eligible",
  "evidence_superseded",
  "status_unchanged",
  "transition_not_automatable",
  "service_plan_missing",
  "step_not_pending",
  "step_not_after_current",
  "sender_not_authorized",
  "evidence_kind_insufficient",
] as const;
export type StatusAutomationRefusal = (typeof STATUS_AUTOMATION_REFUSALS)[number];

export type StatusAutomationErrorCode =
  | "invalid_proposal"
  | "automation_disabled"
  | "target_not_found"
  | "contact_anonymized"
  | "idempotency_conflict"
  | "invalid_response"
  | "unknown";

export class StatusAutomationError extends Error {
  constructor(public readonly code: StatusAutomationErrorCode) {
    super(code);
    this.name = "StatusAutomationError";
  }
}

const DB_CODES: ReadonlySet<string> = new Set(["invalid_proposal", "automation_disabled", "target_not_found", "contact_anonymized", "idempotency_conflict"]);

const responseSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("applied"),
    reason: z.null(),
    decision_id: uuidSchema,
    event_source: z.enum(["status_track_events", "case_service_events"]),
    event_id: uuidSchema,
    replayed: z.boolean(),
  }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.enum(STATUS_AUTOMATION_REFUSALS),
    decision_id: uuidSchema,
    replayed: z.boolean(),
  }),
]);

export type StatusAutomationResult =
  | { outcome: "applied"; decisionId: string; eventSource: "status_track_events" | "case_service_events"; eventId: string; replayed: boolean }
  | { outcome: "refused"; reason: StatusAutomationRefusal; decisionId: string; replayed: boolean };

export async function applyStatusTrackAutomation(
  client: Pick<SupabaseClient<Database>, "rpc">,
  input: unknown,
): Promise<StatusAutomationResult> {
  const parsed = statusAutomationProposalSchema.safeParse(input);
  if (!parsed.success) {
    throw new StatusAutomationError("invalid_proposal");
  }
  const p = parsed.data;
  const { data, error } = await client.rpc("apply_status_track_automation", {
    p_workspace_id: p.workspaceId,
    p_conversation_id: p.conversationId,
    p_change: p.change,
    p_track: p.track,
    p_opportunity_id: p.opportunityId as string,
    p_to_status: p.toStatus as string,
    p_step_id: p.stepId as string,
    p_expected_version: p.expectedVersion,
    p_evidence_message_ids: p.evidenceMessageIds,
    p_idempotency_key: p.idempotencyKey,
    ...(p.extractorRef !== null ? { p_extractor_ref: p.extractorRef } : {}),
  });
  if (error) {
    const code = [...DB_CODES].find((c) => (error.message ?? "").includes(c));
    throw new StatusAutomationError((code as StatusAutomationErrorCode | undefined) ?? "unknown");
  }
  const res = responseSchema.safeParse(data);
  if (!res.success) {
    throw new StatusAutomationError("invalid_response");
  }
  const r = res.data;
  return r.outcome === "applied"
    ? { outcome: "applied", decisionId: r.decision_id, eventSource: r.event_source, eventId: r.event_id, replayed: r.replayed }
    : { outcome: "refused", reason: r.reason, decisionId: r.decision_id, replayed: r.replayed };
}
