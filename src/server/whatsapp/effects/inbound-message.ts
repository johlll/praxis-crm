import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";
import { validateWhatsAppMessageContent } from "@/server/whatsapp/domain-model";
import { encryptWhatsAppBsuid, whatsappBsuidBlindIndexes, WhatsAppIdentityCryptoError } from "@/server/whatsapp/identity-crypto";
import { runWhatsAppInboxClaimEffect, WhatsAppInboxError, type WhatsAppInboxClaim } from "@/server/whatsapp/inbox";
import { whatsappContactIdentity } from "@/server/whatsapp/provider/contract";

/**
 * Efeito atômico de mensagem RECEBIDA (B3.2d-2b2a,
 * docs/decisoes/b3-whatsapp-real.md §22).
 *
 * Recebe o claim emitido por `claimWhatsAppInboxEntry` e os dados já
 * normalizados da mensagem. Ao banco vão só o id da entrada e o token do
 * claim (pela inbox) e os dados do efeito; workspace, canal, ambiente,
 * provedor e id do evento o banco lê da própria linha da inbox.
 *
 * O BSUID vai só como índice cego em cada versão de chave conhecida (para
 * achar a identidade mesmo gravada numa versão anterior) e texto cifrado na
 * versão ativa, no escopo do claim (ambiente, workspace e canal).
 *
 * Nada aqui classifica o remetente ou decide criar contato e lead: isso é
 * do banco, pelo casamento com as identidades internas ativas — nunca pelo
 * texto ou pelo nome do perfil, que só são repassados.
 *
 * Ainda não é chamado pelo consumidor da B3.2d-2a (B3.2d-2b3). Nenhum log;
 * erros são códigos fixos.
 */

export const WHATSAPP_INBOUND_EFFECT_ERROR_CODES = [
  "invalid_inbound_message",
  "identity_keys_not_configured",
  "whatsapp_environment_required",
  "inbox_claim_untrusted",
  "invalid_response",
] as const;

export type WhatsAppInboundEffectErrorCode = (typeof WHATSAPP_INBOUND_EFFECT_ERROR_CODES)[number] | "unknown";

export class WhatsAppInboundEffectError extends Error {
  constructor(public readonly code: WhatsAppInboundEffectErrorCode) {
    super(code);
    this.name = "WhatsAppInboundEffectError";
  }
}

const DB_CODES: ReadonlySet<string> = new Set(["invalid_inbound_message", "whatsapp_environment_required"]);

export type WhatsAppInboundMessageInput = {
  providerMessageId: string;
  contentKind: string;
  text: string | null;
  occurredAt: string;
  sender: { phoneE164: string | null; bsuid: string | null };
  profileName?: string | null;
};

export type WhatsAppInboundEffectResult =
  | {
      outcome: "applied";
      messageId: string;
      conversationId: string;
      senderClassification: "external" | "internal" | "unresolved";
      contactCreated: boolean;
      leadCreated: boolean;
    }
  | {
      outcome: "duplicate" | "already_processed" | "terminal_failed" | "claim_lost" | "not_found" | "identity_conflict" | "effect_conflict";
    };

const inputSchema = z
  .object({
    providerMessageId: z.string().regex(/^\S{1,255}$/),
    contentKind: z.string(),
    text: z.string().nullable(),
    occurredAt: z.string().refine((v) => !Number.isNaN(Date.parse(v))),
    sender: z.object({ phoneE164: z.string().nullable(), bsuid: z.string().nullable() }).strict(),
    profileName: z.string().max(160).nullish(),
  })
  .strict();

const appliedSchema = z
  .object({
    outcome: z.literal("applied"),
    message_id: uuidSchema,
    conversation_id: uuidSchema,
    sender_classification: z.enum(["external", "internal", "unresolved"]),
    contact_created: z.boolean(),
    lead_created: z.boolean(),
  })
  .strict();

const otherSchema = z
  .object({
    outcome: z.enum(["duplicate", "already_processed", "terminal_failed", "claim_lost", "not_found", "identity_conflict", "effect_conflict"]),
  })
  .strict();

function bsuidArgs(claim: WhatsAppInboxClaim, bsuid: string | null) {
  if (bsuid === null) return { p_bsuid_lookup: null, p_bsuid_ciphertext: null, p_bsuid_key_version: null };
  const scope = { environment: claim.environment, workspaceId: claim.workspaceId, channelId: claim.channelId };
  try {
    const encrypted = encryptWhatsAppBsuid(scope, bsuid);
    const lookup = Object.fromEntries(whatsappBsuidBlindIndexes(scope, bsuid).map((i) => [i.keyVersion, i.blindIndexBase64]));
    if (lookup[encrypted.keyVersion] !== encrypted.blindIndexBase64) throw new WhatsAppInboundEffectError("identity_keys_not_configured");
    return { p_bsuid_lookup: lookup, p_bsuid_ciphertext: encrypted.ciphertextBase64, p_bsuid_key_version: encrypted.keyVersion };
  } catch (error) {
    if (error instanceof WhatsAppIdentityCryptoError && error.code !== "not_configured" && error.code !== "unknown_key_version") {
      throw new WhatsAppInboundEffectError("invalid_inbound_message");
    }
    throw new WhatsAppInboundEffectError("identity_keys_not_configured");
  }
}

/** Aplica a mensagem recebida ao domínio numa transação só. Os resultados
 * do banco voltam como vieram; nos conflitos nada foi gravado e o claim
 * continua com quem chamou. */
export async function applyWhatsAppInboundMessage(
  claim: WhatsAppInboxClaim,
  input: WhatsAppInboundMessageInput,
): Promise<WhatsAppInboundEffectResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new WhatsAppInboundEffectError("invalid_inbound_message");
  const message = parsed.data;

  const content = validateWhatsAppMessageContent({ contentKind: message.contentKind, text: message.text });
  if (!content.ok) throw new WhatsAppInboundEffectError("invalid_inbound_message");
  // Falha fechada: um identificador presente e malformado invalida tudo.
  const identity = whatsappContactIdentity(message.sender);
  if (
    !identity ||
    (message.sender.phoneE164 !== null && identity.phoneE164 === null) ||
    (message.sender.bsuid !== null && identity.bsuid === null)
  ) {
    throw new WhatsAppInboundEffectError("invalid_inbound_message");
  }
  const profileName = typeof message.profileName === "string" && message.profileName.trim() !== "" ? message.profileName : null;

  const args = {
    p_provider_message_id: message.providerMessageId,
    p_content_kind: content.contentKind,
    p_body_text: content.text,
    p_occurred_at: message.occurredAt,
    p_phone_e164: identity.phoneE164,
    ...bsuidArgs(claim, identity.bsuid),
    p_profile_name: profileName,
  };

  let response: { data: unknown; error: { message?: string } | null };
  try {
    response = await runWhatsAppInboxClaimEffect(claim, "whatsapp_effect_inbound_message", args);
  } catch (error) {
    if (error instanceof WhatsAppInboxError && error.code === "inbox_claim_untrusted") throw new WhatsAppInboundEffectError("inbox_claim_untrusted");
    throw new WhatsAppInboundEffectError("unknown");
  }
  if (response.error) {
    const code = response.error.message ?? "";
    throw new WhatsAppInboundEffectError(DB_CODES.has(code) ? (code as WhatsAppInboundEffectErrorCode) : "unknown");
  }

  const applied = appliedSchema.safeParse(response.data);
  if (applied.success) {
    return {
      outcome: "applied",
      messageId: applied.data.message_id,
      conversationId: applied.data.conversation_id,
      senderClassification: applied.data.sender_classification,
      contactCreated: applied.data.contact_created,
      leadCreated: applied.data.lead_created,
    };
  }
  const other = otherSchema.safeParse(response.data);
  if (other.success) return { outcome: other.data.outcome };
  throw new WhatsAppInboundEffectError("invalid_response");
}
