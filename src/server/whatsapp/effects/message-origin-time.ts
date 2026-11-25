import { z } from "zod";

import { runWhatsAppInboxOriginTimeRecord, WhatsAppInboxError, type WhatsAppInboxClaim } from "@/server/whatsapp/inbox";
import type { WhatsAppMessageOriginTime } from "@/server/whatsapp/provider/contract";

/**
 * Horário de ORIGEM da mensagem (docs/decisoes/conversas-horario-origem.md). Chamado pelo despachante
 * logo depois do efeito de mensagem recebida ou de saída observada, com o MESMO claim.
 *
 * Quem decide é o banco (`whatsapp_record_message_origin_time`): limites (futuro, antigo demais),
 * contradição entre eventos e a regra "só o evento que criou a mensagem preenche a origem
 * desconhecida". Este módulo só repassa o que o EVENTO trouxe — nunca `createdAt`, `now()` nem o
 * horário de um status — e nunca escolhe a mensagem, a fonte ou o veredito. A chamada é idempotente:
 * repeti-la cura uma gravação perdida sem mudar uma já feita.
 */

export type WhatsAppMessageOriginTimeErrorCode =
  | "invalid_origin_time"
  | "inbox_claim_untrusted"
  | "whatsapp_environment_required"
  | "invalid_response"
  | "unknown";

export class WhatsAppMessageOriginTimeError extends Error {
  constructor(public readonly code: WhatsAppMessageOriginTimeErrorCode) {
    super(code);
    this.name = "WhatsAppMessageOriginTimeError";
  }
}

const DB_CODES: ReadonlySet<string> = new Set(["invalid_origin_time", "whatsapp_environment_required"]);

export const WHATSAPP_MESSAGE_ORIGIN_TIME_OUTCOMES = ["recorded", "unverified", "unchanged", "contradictory", "not_found", "not_applicable"] as const;
export type WhatsAppMessageOriginTimeOutcome = (typeof WHATSAPP_MESSAGE_ORIGIN_TIME_OUTCOMES)[number];

const responseSchema = z
  .object({
    outcome: z.enum(WHATSAPP_MESSAGE_ORIGIN_TIME_OUTCOMES),
    issue: z.string().nullable().optional(),
  })
  .strict();

export async function recordWhatsAppMessageOriginTime(
  claim: WhatsAppInboxClaim,
  originTime: WhatsAppMessageOriginTime,
): Promise<{ outcome: WhatsAppMessageOriginTimeOutcome }> {
  let args: { p_origin_at: string | null; p_origin_issue: "missing" | null };
  // Evento sem o campo (ou com algo que não é objeto) falha fechado, com código fixo: nunca vira
  // `missing` em silêncio nem um erro solto.
  if (typeof originTime !== "object" || originTime === null) throw new WhatsAppMessageOriginTimeError("invalid_origin_time");
  if (originTime.kind === "provider_send_time") {
    // Date inválida não chega aqui (o adaptador só a produz de RFC 3339 conferido); se chegar,
    // falha fechada em vez de virar "ausente" em silêncio.
    if (!(originTime.at instanceof Date) || Number.isNaN(originTime.at.getTime())) throw new WhatsAppMessageOriginTimeError("invalid_origin_time");
    args = { p_origin_at: originTime.at.toISOString(), p_origin_issue: null };
  } else if (originTime.kind === "missing") {
    args = { p_origin_at: null, p_origin_issue: "missing" };
  } else {
    throw new WhatsAppMessageOriginTimeError("invalid_origin_time");
  }

  let response: { data: unknown; error: { message?: string } | null };
  try {
    response = await runWhatsAppInboxOriginTimeRecord(claim, args);
  } catch (error) {
    if (error instanceof WhatsAppInboxError && error.code === "inbox_claim_untrusted") throw new WhatsAppMessageOriginTimeError("inbox_claim_untrusted");
    throw new WhatsAppMessageOriginTimeError("unknown");
  }
  if (response.error) {
    const code = response.error.message ?? "";
    throw new WhatsAppMessageOriginTimeError(DB_CODES.has(code) ? (code as WhatsAppMessageOriginTimeErrorCode) : "unknown");
  }
  const parsed = responseSchema.safeParse(response.data);
  if (!parsed.success) throw new WhatsAppMessageOriginTimeError("invalid_response");
  return { outcome: parsed.data.outcome };
}
