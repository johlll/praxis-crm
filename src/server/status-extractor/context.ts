import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";
import type { Database } from "@/server/types/database";

/**
 * Contexto autorizado do extrator (docs/decisoes/conversas-extrator.md), lido pela função do banco
 * `get_status_automation_context` (só service_role, só com o portão do aplicador aberto).
 *
 * O banco decide o que entra: só a conversa pedida, deste escritório; autor calculado pelo banco; texto cortado;
 * elegibilidade temporal por trilha; o caso só quando inequívoco e ganho. Não há horário, telefone, nome, papel
 * nem permissão — nada que o extrator pudesse repassar como fato.
 */

export const contextMessageSchema = z
  .object({
    message_id: uuidSchema,
    author: z.enum(["client", "office", "other"]),
    content_kind: z.string().min(1).max(40),
    text: z.string().max(1500).nullable(),
    eligible_attendance: z.boolean(),
    eligible_case: z.boolean(),
  })
  .strict();

const stepSchema = z
  .object({ step_id: uuidSchema, position: z.number().int().min(1), name: z.string().min(1).max(80), completed: z.boolean() })
  .strict();

export const extractionContextSchema = z
  .object({
    workspace_id: uuidSchema,
    conversation_id: uuidSchema,
    attendance: z.object({ status: z.string().min(1), version: z.number().int().min(0), paused: z.boolean() }).strict(),
    case: z
      .object({
        opportunity_id: uuidSchema,
        status: z.string().min(1),
        version: z.number().int().min(0),
        paused: z.boolean(),
        plan: z.object({ current_step_id: uuidSchema.nullable(), steps: z.array(stepSchema).max(30) }).strict().nullable(),
      })
      .strict()
      .nullable(),
    case_unavailable_reason: z
      .enum(["conversation_link_unresolved", "no_case", "ambiguous_case", "opportunity_not_won", "contact_anonymized"])
      .nullable(),
    messages: z.array(contextMessageSchema).max(50),
  })
  .strict();

export type ExtractionContext = z.infer<typeof extractionContextSchema>;
export type ContextMessage = z.infer<typeof contextMessageSchema>;

export type ExtractionContextErrorCode =
  | "automation_disabled"
  | "target_not_found"
  | "contact_anonymized"
  | "invalid_request"
  | "context_mismatch"
  | "invalid_response"
  | "unknown";

export class ExtractionContextError extends Error {
  constructor(public readonly code: ExtractionContextErrorCode) {
    super(code);
    this.name = "ExtractionContextError";
  }
}

const DB_CODES = ["automation_disabled", "target_not_found", "contact_anonymized", "invalid_request"] as const;

export async function loadExtractionContext(
  client: Pick<SupabaseClient<Database>, "rpc">,
  workspaceId: string,
  conversationId: string,
  limit = 30,
): Promise<ExtractionContext> {
  const { data, error } = await client.rpc("get_status_automation_context", {
    p_workspace_id: workspaceId,
    p_conversation_id: conversationId,
    p_limit: limit,
  });
  if (error) {
    const code = DB_CODES.find((c) => (error.message ?? "").includes(c));
    throw new ExtractionContextError(code ?? "unknown");
  }
  const parsed = extractionContextSchema.safeParse(data);
  if (!parsed.success) {
    throw new ExtractionContextError("invalid_response");
  }
  // Isolamento conferido também aqui: o contexto tem de ser exatamente o pedido.
  if (parsed.data.workspace_id !== workspaceId || parsed.data.conversation_id !== conversationId) {
    throw new ExtractionContextError("context_mismatch");
  }
  return parsed.data;
}
