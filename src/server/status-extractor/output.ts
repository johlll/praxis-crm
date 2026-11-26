import { createHash } from "node:crypto";

import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";
import type { StatusAutomationProposal } from "@/server/status-automation/apply";
import type { ContextMessage, ExtractionContext } from "@/server/status-extractor/context";

/**
 * Resposta do modelo → propostas estritas para o aplicador (docs/decisoes/conversas-extrator.md).
 *
 * A resposta é lida com esquema ESTRITO (campo extra, tipo errado, texto fora do JSON = resposta inválida, nenhuma
 * proposta). Depois, cada proposta é conferida contra o CONTEXTO (não contra o que o modelo diz):
 *   - só o catálogo do aplicador; nunca etapa comercial, ganho, perda, concluir etapa ou estados humanos;
 *   - evidências só da conversa do contexto e elegíveis no tempo para a trilha; toda evidência tem de ser "fact"
 *     (pedido, hipótese, negação e citação não sustentam proposta);
 *   - autor e tipo de conteúdo do contexto (calculados pelo banco): "enviei" em texto não vira arquivo recebido;
 *   - caso só o do contexto (inequívoco e ganho); etapa só pendente e posterior à atual;
 *   - escritório, conversa, caso, VERSÃO esperada e chave de idempotência vêm do contexto e do conteúdo — nunca do
 *     modelo. A chave é derivada do pedido: a mesma proposta sobre o mesmo estado gera a mesma chave (repetição
 *     devolve a mesma decisão no aplicador).
 */

export const EXTRACTOR_STATEMENTS = ["fact", "request", "hypothesis", "negation", "quotation"] as const;

export const modelOutputSchema = z
  .object({
    proposals: z
      .array(
        z
          .object({
            track: z.enum(["attendance", "case_progress"]),
            change: z.enum(["set_status", "set_current_step"]),
            to_status: z.string().max(40).nullable(),
            step_id: uuidSchema.nullable(),
            evidence: z
              .array(z.object({ message_id: uuidSchema, statement: z.enum(EXTRACTOR_STATEMENTS) }).strict())
              .min(1)
              .max(20),
          })
          .strict(),
      )
      .max(5),
  })
  .strict();

export type ModelOutput = z.infer<typeof modelOutputSchema>;

export type OutputParseResult = { ok: true; output: ModelOutput } | { ok: false; reason: "not_json" | "schema" };

/** Aceita só um objeto JSON (opcionalmente dentro de um único bloco ```json). Qualquer outra coisa é inválida. */
export function parseModelOutput(raw: string): OutputParseResult {
  let text = raw.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text);
  if (fenced) text = (fenced[1] ?? "").trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return { ok: false, reason: "not_json" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  const parsed = modelOutputSchema.safeParse(value);
  return parsed.success ? { ok: true, output: parsed.data } : { ok: false, reason: "schema" };
}

export type ProposalRejection =
  | "not_in_catalog"
  | "no_unambiguous_case"
  | "evidence_not_in_context"
  | "evidence_repeated"
  | "evidence_not_eligible"
  | "non_fact_evidence"
  | "evidence_kind_insufficient"
  | "step_not_pending_after_current"
  | "status_unchanged"
  | "track_paused"
  | "duplicate";

const ATTENDANCE_RULES: Record<string, { from: readonly string[]; kinds: readonly ("client" | "client_file" | "office")[] }> = {
  aguardando_escritorio: { from: ["nao_informado", "novo", "aguardando_cliente"], kinds: ["client", "client_file"] },
  aguardando_cliente: { from: ["nao_informado", "novo", "aguardando_escritorio"], kinds: ["office"] },
};
const CASE_RULES: Record<string, { from: readonly string[]; kinds: readonly ("client" | "client_file" | "office")[] }> = {
  aguardando_documentos: { from: ["nao_informado", "em_analise", "aguardando_cliente", "em_execucao"], kinds: ["office"] },
  aguardando_cliente: { from: ["nao_informado", "em_analise", "em_execucao", "aguardando_terceiros"], kinds: ["office"] },
  documentos_recebidos: { from: ["aguardando_documentos"], kinds: ["client_file"] },
};

function kindOf(m: ContextMessage): "client" | "client_file" | "office" | "other" {
  if (m.author === "office") return "office";
  if (m.author === "client") return m.content_kind === "document" || m.content_kind === "image" ? "client_file" : "client";
  return "other";
}

/** UUID determinístico (formato v5) a partir do conteúdo do pedido. */
export function deterministicKey(parts: readonly string[]): string {
  const h = createHash("sha256").update(["praxis.extrator.v1", ...parts].join("|")).digest("hex");
  const variant = ((parseInt(h.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type DerivedProposals = {
  proposals: StatusAutomationProposal[];
  rejected: { index: number; reason: ProposalRejection }[];
};

export function deriveProposals(context: ExtractionContext, output: ModelOutput, extractorRef: string): DerivedProposals {
  const byId = new Map(context.messages.map((m) => [m.message_id, m]));
  const proposals: StatusAutomationProposal[] = [];
  const rejected: DerivedProposals["rejected"] = [];
  const seen = new Set<string>();

  output.proposals.forEach((p, index) => {
    const reject = (reason: ProposalRejection) => rejected.push({ index, reason });
    const ids = p.evidence.map((e) => e.message_id);
    if (new Set(ids).size !== ids.length) return reject("evidence_repeated");

    // Catálogo: forma da mudança.
    const isAttendance = p.track === "attendance";
    if (isAttendance && (p.change !== "set_status" || p.step_id !== null)) return reject("not_in_catalog");
    if (p.change === "set_status" && (p.to_status === null || p.step_id !== null)) return reject("not_in_catalog");
    if (p.change === "set_current_step" && (p.to_status !== null || p.step_id === null)) return reject("not_in_catalog");
    const rule = p.change === "set_status" ? (isAttendance ? ATTENDANCE_RULES : CASE_RULES)[p.to_status as string] : undefined;
    if (p.change === "set_status" && !rule) return reject("not_in_catalog");

    // Caso só o do contexto.
    if (!isAttendance && context.case === null) return reject("no_unambiguous_case");
    const track = isAttendance ? context.attendance : context.case!;
    if (track.paused) return reject("track_paused");

    // Evidências: do contexto, elegíveis, só fatos, do tipo certo.
    const msgs = ids.map((id) => byId.get(id));
    if (msgs.some((m) => m === undefined)) return reject("evidence_not_in_context");
    const evidence = msgs as ContextMessage[];
    if (evidence.some((m) => !(isAttendance ? m.eligible_attendance : m.eligible_case))) return reject("evidence_not_eligible");
    if (p.evidence.some((e) => e.statement !== "fact")) return reject("non_fact_evidence");

    if (p.change === "set_status") {
      if (track.status === p.to_status) return reject("status_unchanged");
      if (!rule!.from.includes(track.status)) return reject("not_in_catalog");
      if (evidence.some((m) => !rule!.kinds.includes(kindOf(m) as "client"))) return reject("evidence_kind_insufficient");
    } else {
      const plan = context.case!.plan;
      const step = plan?.steps.find((s) => s.step_id === p.step_id);
      const current = plan?.steps.find((s) => s.step_id === plan.current_step_id);
      if (!plan || !step || step.completed || (current && step.position <= current.position)) return reject("step_not_pending_after_current");
      if (evidence.some((m) => kindOf(m) === "other")) return reject("evidence_kind_insufficient");
    }

    const sortedIds = [...ids].sort();
    const key = deterministicKey([
      context.workspace_id, context.conversation_id, p.track, p.change, p.to_status ?? "-", p.step_id ?? "-",
      String(track.version), sortedIds.join(","),
    ]);
    if (seen.has(key)) return reject("duplicate");
    seen.add(key);

    proposals.push({
      workspaceId: context.workspace_id,
      conversationId: context.conversation_id,
      change: p.change,
      track: p.track,
      opportunityId: isAttendance ? null : context.case!.opportunity_id,
      toStatus: p.to_status,
      stepId: p.step_id,
      expectedVersion: track.version,
      evidenceMessageIds: sortedIds,
      idempotencyKey: key,
      extractorRef,
    });
  });

  return { proposals, rejected };
}
