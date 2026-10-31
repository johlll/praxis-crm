import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";
import { WhatsAppEffectIdentityError, whatsappEffectIdentityArgs } from "@/server/whatsapp/effects/identity-args";
import { runWhatsAppInboxClaimEffect, WhatsAppInboxError, type WhatsAppInboxClaim } from "@/server/whatsapp/inbox";

/**
 * Efeito atômico de IDENTIDADE ALTERADA e TROCA DE NÚMERO (B3.2d-2b2b3a,
 * docs/decisoes/b3-whatsapp-real.md §25). Não envia nada e não chama o
 * provedor.
 *
 * Recebe o claim emitido por `claimWhatsAppInboxEntry` e a mudança já
 * normalizada (`NormalizedIdentityChange`). Ao banco vão só o id da entrada
 * e o token do claim (pela inbox) e os dados da mudança; workspace, canal,
 * ambiente, provedor e id do evento o banco lê da própria linha da inbox.
 *
 * A identidade anterior e a nova vão com materiais SEPARADOS, pelo módulo
 * comum de identidade (`whatsappEffectIdentityArgs`, o mesmo da 2b2a): a
 * anterior só com o telefone e os índices cegos (o banco só a procura,
 * nunca a grava); a nova com o telefone, os índices e a cifra da versão
 * ativa. Nenhum BSUID em claro sai daqui.
 *
 * `phone_number` exige a identidade nova com telefone; `identity` não
 * aceita a identidade nova (o provedor não a informa, e nada é inventado).
 *
 * Ainda não é chamado pelo consumidor da B3.2d-2a (B3.2d-2b3). Nenhum log;
 * erros são códigos fixos.
 */

export const WHATSAPP_IDENTITY_CHANGE_ERROR_CODES = [
  "invalid_identity_change",
  "identity_keys_not_configured",
  "whatsapp_environment_required",
  "inbox_claim_untrusted",
  "invalid_response",
] as const;

export type WhatsAppIdentityChangeErrorCode = (typeof WHATSAPP_IDENTITY_CHANGE_ERROR_CODES)[number] | "unknown";

export class WhatsAppIdentityChangeError extends Error {
  constructor(public readonly code: WhatsAppIdentityChangeErrorCode) {
    super(code);
    this.name = "WhatsAppIdentityChangeError";
  }
}

const DB_CODES: ReadonlySet<string> = new Set(["invalid_identity_change", "whatsapp_environment_required"]);

/** A mudança como o normalizador entrega; tudo é conferido aqui. */
export type WhatsAppIdentityChangeInput = {
  change: string;
  occurredAt: string;
  previous: { phoneE164: string | null; bsuid: string | null };
  next: { phoneE164: string | null; bsuid: string | null } | null;
};

export type WhatsAppIdentityChangeResult =
  | {
      /** applied: o telefone (e o BSUID que faltava) da mesma identidade
       * mudou. review_required: identity sem a nova; a conversa foi para
       * revisão humana. */
      outcome: "applied" | "review_required";
      identityId: string;
    }
  | {
      outcome:
        | "duplicate"
        | "identity_conflict"
        | "effect_conflict"
        | "already_processed"
        | "terminal_failed"
        | "claim_lost"
        | "not_found";
    }
  | {
      /** A identidade anterior ainda não existe no canal: nada foi gravado
       * e o claim continua com quem chamou (reconciliação). */
      outcome: "identity_not_found";
    }
  | {
      /** O canal deixou de estar ativo depois do claim: nada gravado, o
       * claim continua para quem chamou liberar (B3.2d-2b3). */
      outcome: "channel_paused" | "channel_disconnected" | "channel_disabled";
    };

const contactSchema = z.object({ phoneE164: z.string().nullable(), bsuid: z.string().nullable() }).strict();

const inputSchema = z
  .object({
    change: z.enum(["phone_number", "identity"]),
    occurredAt: z.string().refine((v) => !Number.isNaN(Date.parse(v))),
    previous: contactSchema,
    next: contactSchema.nullable(),
  })
  .strict()
  .refine((v) => (v.change === "identity" ? v.next === null : v.next !== null && v.next.phoneE164 !== null));

const identifiedSchema = z
  .object({
    outcome: z.enum(["applied", "review_required"]),
    identity_id: uuidSchema,
  })
  .strict();

const otherSchema = z
  .object({
    outcome: z.enum([
      "duplicate",
      "identity_not_found",
      "identity_conflict",
      "effect_conflict",
      "already_processed",
      "terminal_failed",
      "claim_lost",
      "not_found",
      "channel_paused",
      "channel_disconnected",
      "channel_disabled",
    ]),
  })
  .strict();

function identityArgs(claim: WhatsAppInboxClaim, contact: { phoneE164: string | null; bsuid: string | null }) {
  try {
    return whatsappEffectIdentityArgs(claim, contact);
  } catch (error) {
    if (error instanceof WhatsAppEffectIdentityError && error.code === "identity_keys_not_configured") {
      throw new WhatsAppIdentityChangeError("identity_keys_not_configured");
    }
    throw new WhatsAppIdentityChangeError("invalid_identity_change");
  }
}

/** Aplica a mudança numa transação só. Os resultados do banco voltam como
 * vieram; em identity_not_found, nos conflitos e com o canal não ativo nada
 * foi gravado e o claim continua com quem chamou. */
export async function applyWhatsAppIdentityChange(
  claim: WhatsAppInboxClaim,
  input: WhatsAppIdentityChangeInput,
): Promise<WhatsAppIdentityChangeResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new WhatsAppIdentityChangeError("invalid_identity_change");
  const change = parsed.data;

  // Materiais separados: a anterior só é procurada (sem cifra); a nova
  // pode ser gravada (índices e cifra na versão ativa).
  const previous = identityArgs(claim, change.previous);
  const next = change.next === null ? null : identityArgs(claim, change.next);

  const args = {
    p_change: change.change,
    p_occurred_at: change.occurredAt,
    p_previous_phone_e164: previous.p_phone_e164,
    p_previous_bsuid_lookup: previous.p_bsuid_lookup,
    p_previous_bsuid_key_version: previous.p_bsuid_key_version,
    p_next_phone_e164: next?.p_phone_e164 ?? null,
    p_next_bsuid_lookup: next?.p_bsuid_lookup ?? null,
    p_next_bsuid_ciphertext: next?.p_bsuid_ciphertext ?? null,
    p_next_bsuid_key_version: next?.p_bsuid_key_version ?? null,
  };

  let response: { data: unknown; error: { message?: string } | null };
  try {
    response = await runWhatsAppInboxClaimEffect(claim, "whatsapp_effect_identity_change", args);
  } catch (error) {
    if (error instanceof WhatsAppInboxError && error.code === "inbox_claim_untrusted") throw new WhatsAppIdentityChangeError("inbox_claim_untrusted");
    throw new WhatsAppIdentityChangeError("unknown");
  }
  if (response.error) {
    const code = response.error.message ?? "";
    throw new WhatsAppIdentityChangeError(DB_CODES.has(code) ? (code as WhatsAppIdentityChangeErrorCode) : "unknown");
  }

  const identified = identifiedSchema.safeParse(response.data);
  if (identified.success) return { outcome: identified.data.outcome, identityId: identified.data.identity_id };
  const other = otherSchema.safeParse(response.data);
  if (other.success) return { outcome: other.data.outcome } as WhatsAppIdentityChangeResult;
  throw new WhatsAppIdentityChangeError("invalid_response");
}
