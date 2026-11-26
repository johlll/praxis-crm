import type { SupabaseClient } from "@supabase/supabase-js";

import {
  StatusAutomationError,
  applyStatusTrackAutomation,
  type StatusAutomationProposal,
  type StatusAutomationResult,
} from "@/server/status-automation/apply";
import { ExtractionContextError, loadExtractionContext } from "@/server/status-extractor/context";
import type { ExtractionModelEnv, StatusExtractionModel } from "@/server/status-extractor/model";
import { deriveProposals, parseModelOutput, type ProposalRejection } from "@/server/status-extractor/output";
import { buildExtractionPrompt } from "@/server/status-extractor/prompt";
import type { Database } from "@/server/types/database";

/**
 * Extrator de propostas de status (docs/decisoes/conversas-extrator.md). DESLIGADO por padrão, em três camadas:
 *   1. `STATUS_EXTRACTOR_ENABLED` diferente de "true" → não lê nada nem chama ninguém (`disabled`);
 *   2. o portão do aplicador no banco fechado → o contexto é recusado (`disabled`);
 *   3. sem modelo configurado → para antes de qualquer chamada (`no_model`).
 * Aplicar é um quarto interruptor: sem `STATUS_EXTRACTOR_APPLY_ENABLED = "true"` as propostas só são devolvidas
 * (`dry_run`). Mesmo aplicando, quem decide é o aplicador no banco.
 *
 * O extrator só lê o contexto e chama o aplicador: não envia mensagem, não escreve status, não guarda o texto das
 * mensagens nem o devolve no resultado (só ids, códigos e contagens).
 */

export type ExtractionRunInput = {
  client: Pick<SupabaseClient<Database>, "rpc">;
  workspaceId: string;
  conversationId: string;
  model: StatusExtractionModel | null;
  env: ExtractionModelEnv;
};

export type ExtractionRunResult =
  | { status: "disabled" | "no_model" | "no_messages" }
  | { status: "context_error"; code: string }
  | { status: "model_error" }
  | { status: "invalid_model_output"; reason: "not_json" | "schema" }
  | {
      status: "dry_run" | "applied";
      proposals: StatusAutomationProposal[];
      rejected: { index: number; reason: ProposalRejection }[];
      results: ({ ok: true; result: StatusAutomationResult } | { ok: false; code: string })[];
    };

export function extractorEnabled(env: ExtractionModelEnv): boolean {
  return env.STATUS_EXTRACTOR_ENABLED === "true";
}
export function extractorApplyEnabled(env: ExtractionModelEnv): boolean {
  return env.STATUS_EXTRACTOR_APPLY_ENABLED === "true";
}

function sanitizeRef(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 120) || "extrator";
}

export async function runStatusExtraction(input: ExtractionRunInput): Promise<ExtractionRunResult> {
  if (!extractorEnabled(input.env)) return { status: "disabled" };

  let context;
  try {
    context = await loadExtractionContext(input.client, input.workspaceId, input.conversationId);
  } catch (e) {
    const code = e instanceof ExtractionContextError ? e.code : "unknown";
    return code === "automation_disabled" ? { status: "disabled" } : { status: "context_error", code };
  }
  if (!input.model) return { status: "no_model" };
  if (context.messages.length === 0) return { status: "no_messages" };

  const prompt = buildExtractionPrompt(context);
  let raw: string;
  try {
    raw = await input.model.complete({ system: prompt.system, user: prompt.user });
  } catch {
    return { status: "model_error" };
  }
  const parsed = parseModelOutput(raw);
  if (!parsed.ok) return { status: "invalid_model_output", reason: parsed.reason };

  const extractorRef = sanitizeRef(`${input.model.id}:${prompt.promptVersion}`);
  const { proposals, rejected } = deriveProposals(context, parsed.output, extractorRef);
  if (!extractorApplyEnabled(input.env)) return { status: "dry_run", proposals, rejected, results: [] };

  const results: ({ ok: true; result: StatusAutomationResult } | { ok: false; code: string })[] = [];
  for (const proposal of proposals) {
    try {
      results.push({ ok: true, result: await applyStatusTrackAutomation(input.client, proposal) });
    } catch (e) {
      results.push({ ok: false, code: e instanceof StatusAutomationError ? e.code : "unknown" });
    }
  }
  return { status: "applied", proposals, rejected, results };
}
