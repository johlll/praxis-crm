import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";
import { validateWhatsAppMessageContent } from "@/server/whatsapp/domain-model";
import { WhatsAppEffectIdentityError, whatsappEffectIdentityArgs } from "@/server/whatsapp/effects/identity-args";
import { runWhatsAppInboxClaimEffect, WhatsAppInboxError, type WhatsAppInboxClaim } from "@/server/whatsapp/inbox";

/**
 * Efeito atômico de mensagem de SAÍDA OBSERVADA (B3.2d-2b2b1,
 * docs/decisoes/b3-whatsapp-real.md §23): registra no CRM uma mensagem que
 * o escritório já enviou pelo WhatsApp Business App. Não envia nada e não
 * chama o provedor.
 *
 * Recebe o claim emitido por `claimWhatsAppInboxEntry` e os dados já
 * normalizados do eco. Ao banco vão só o id da entrada e o token do claim
 * (pela inbox) e os dados do efeito; workspace, canal, ambiente, provedor e
 * id do evento o banco lê da própria linha da inbox. O destinatário vai
 * como telefone e/ou índices cegos e cifra do BSUID
 * (`whatsappEffectIdentityArgs`, o mesmo da 2b2a).
 *
 * Origem, classificação e autoria não são escolhidas aqui: a RPC grava
 * outbound/business_app/internal, sem autor. Nada é inferido do texto.
 *
 * Ainda não é chamado pelo consumidor da B3.2d-2a (B3.2d-2b3). Nenhum log;
 * erros são códigos fixos.
 */

export const WHATSAPP_OUTBOUND_OBSERVED_ERROR_CODES = [
  "invalid_outbound_message",
  "identity_keys_not_configured",
  "whatsapp_environment_required",
  "inbox_claim_untrusted",
  "invalid_response",
] as const;

export type WhatsAppOutboundObservedErrorCode = (typeof WHATSAPP_OUTBOUND_OBSERVED_ERROR_CODES)[number] | "unknown";

export class WhatsAppOutboundObservedError extends Error {
  constructor(public readonly code: WhatsAppOutboundObservedErrorCode) {
    super(code);
    this.name = "WhatsAppOutboundObservedError";
  }
}

const DB_CODES: ReadonlySet<string> = new Set(["invalid_outbound_message", "whatsapp_environment_required"]);

export type WhatsAppOutboundObservedInput = {
  providerMessageId: string;
  waMessageId: string | null;
  contentKind: string;
  text: string | null;
  occurredAt: string;
  recipient: { phoneE164: string | null; bsuid: string | null };
};

export type WhatsAppOutboundObservedResult =
  | { outcome: "applied"; messageId: string; conversationId: string }
  | {
      outcome:
        | "duplicate"
        | "already_processed"
        | "terminal_failed"
        | "claim_lost"
        | "not_found"
        | "identity_conflict"
        | "message_conflict"
        | "effect_conflict";
    }
  | {
      /** O canal deixou de estar ativo depois do claim: nada gravado, o
       * claim continua para quem chamou liberar (B3.2d-2b3). */
      outcome: "channel_paused" | "channel_disconnected" | "channel_disabled";
    };

const inputSchema = z
  .object({
    providerMessageId: z.string().regex(/^\S{1,255}$/),
    waMessageId: z
      .string()
      .regex(/^wamid\.[A-Za-z0-9._:=+/-]{1,512}$/)
      .nullable(),
    contentKind: z.string(),
    text: z.string().nullable(),
    occurredAt: z.string().refine((v) => !Number.isNaN(Date.parse(v))),
    recipient: z.object({ phoneE164: z.string().nullable(), bsuid: z.string().nullable() }).strict(),
  })
  .strict();

const appliedSchema = z
  .object({
    outcome: z.literal("applied"),
    message_id: uuidSchema,
    conversation_id: uuidSchema,
  })
  .strict();

const otherSchema = z
  .object({
    outcome: z.enum([
      "duplicate",
      "already_processed",
      "terminal_failed",
      "claim_lost",
      "not_found",
      "identity_conflict",
      "message_conflict",
      "effect_conflict",
      "channel_paused",
      "channel_disconnected",
      "channel_disabled",
    ]),
  })
  .strict();

/** Registra a mensagem observada numa transação só. Os resultados do banco
 * voltam como vieram; nos conflitos e com o canal não ativo nada foi
 * gravado e o claim continua com quem chamou. */
export async function applyWhatsAppOutboundObserved(
  claim: WhatsAppInboxClaim,
  input: WhatsAppOutboundObservedInput,
): Promise<WhatsAppOutboundObservedResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new WhatsAppOutboundObservedError("invalid_outbound_message");
  const message = parsed.data;

  const content = validateWhatsAppMessageContent({ contentKind: message.contentKind, text: message.text });
  if (!content.ok) throw new WhatsAppOutboundObservedError("invalid_outbound_message");
  let identityArgs: ReturnType<typeof whatsappEffectIdentityArgs>;
  try {
    identityArgs = whatsappEffectIdentityArgs(claim, message.recipient);
  } catch (error) {
    if (error instanceof WhatsAppEffectIdentityError && error.code === "identity_keys_not_configured") {
      throw new WhatsAppOutboundObservedError("identity_keys_not_configured");
    }
    throw new WhatsAppOutboundObservedError("invalid_outbound_message");
  }

  const args = {
    p_provider_message_id: message.providerMessageId,
    p_wa_message_id: message.waMessageId,
    p_content_kind: content.contentKind,
    p_body_text: content.text,
    p_occurred_at: message.occurredAt,
    ...identityArgs,
  };

  let response: { data: unknown; error: { message?: string } | null };
  try {
    response = await runWhatsAppInboxClaimEffect(claim, "whatsapp_effect_outbound_observed", args);
  } catch (error) {
    if (error instanceof WhatsAppInboxError && error.code === "inbox_claim_untrusted") throw new WhatsAppOutboundObservedError("inbox_claim_untrusted");
    throw new WhatsAppOutboundObservedError("unknown");
  }
  if (response.error) {
    const code = response.error.message ?? "";
    throw new WhatsAppOutboundObservedError(DB_CODES.has(code) ? (code as WhatsAppOutboundObservedErrorCode) : "unknown");
  }

  const applied = appliedSchema.safeParse(response.data);
  if (applied.success) {
    return { outcome: "applied", messageId: applied.data.message_id, conversationId: applied.data.conversation_id };
  }
  const other = otherSchema.safeParse(response.data);
  if (other.success) return { outcome: other.data.outcome };
  throw new WhatsAppOutboundObservedError("invalid_response");
}
