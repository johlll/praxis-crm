import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";
import {
  sanitizeWhatsAppProviderCost,
  whatsappCostForStatus,
} from "@/server/whatsapp/domain-model";
import {
  WhatsAppEffectIdentityError,
  whatsappEffectIdentityArgs,
  type WhatsAppEffectIdentityArgs,
} from "@/server/whatsapp/effects/identity-args";
import {
  runWhatsAppInboxClaimEffect,
  WhatsAppInboxError,
  type WhatsAppInboxClaim,
} from "@/server/whatsapp/inbox";

/**
 * Efeito atômico de STATUS e CUSTO de uma mensagem de saída já gravada
 * (B3.2d-2b2b2, docs/decisoes/b3-whatsapp-real.md §24). Não envia nada e
 * não chama o provedor.
 *
 * Recebe o claim emitido por `claimWhatsAppInboxEntry` e os dados já
 * normalizados do status. Ao banco vão só o id da entrada e o token do
 * claim (pela inbox) e os dados do status; workspace, canal, ambiente,
 * provedor e id do evento o banco lê da própria linha da inbox.
 *
 * - O erro do provedor vai só como código opaco bem formado, e só junto de
 *   `failed`; qualquer outro texto vira `unrecognized`, nunca a mensagem.
 * - O custo vai completo ou não vai, com as regras do domínio (categoria
 *   malformada vira nula sem perder o valor; custo de `failed` é
 *   estimativa); final só com a prova de entrega.
 * - O `externalId` vai como veio: correlação opaca, nunca prova de origem.
 * - O destinatário é opcional e vai como telefone e/ou índices cegos e
 *   cifra do BSUID (`whatsappEffectIdentityArgs`, o mesmo da 2b2a).
 *
 * Ainda não é chamado pelo consumidor da B3.2d-2a (B3.2d-2b3). Nenhum log;
 * erros são códigos fixos.
 */

export const WHATSAPP_MESSAGE_STATUS_ERROR_CODES = [
  "invalid_status_update",
  "identity_keys_not_configured",
  "whatsapp_environment_required",
  "inbox_claim_untrusted",
  "invalid_response",
] as const;

export type WhatsAppMessageStatusErrorCode =
  (typeof WHATSAPP_MESSAGE_STATUS_ERROR_CODES)[number] | "unknown";

export class WhatsAppMessageStatusError extends Error {
  constructor(public readonly code: WhatsAppMessageStatusErrorCode) {
    super(code);
    this.name = "WhatsAppMessageStatusError";
  }
}

const DB_CODES: ReadonlySet<string> = new Set([
  "invalid_status_update",
  "whatsapp_environment_required",
]);

/** Código do provedor que o banco aceita; o resto vira `unrecognized`. */
const ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Dados do status como o normalizador entrega; tudo é conferido aqui. */
export type WhatsAppMessageStatusInput = {
  providerMessageId: string;
  waMessageId: string | null;
  externalId: string | null;
  status: string;
  errorCode: string | null;
  occurredAt: string;
  recipient: { phoneE164: string | null; bsuid: string | null } | null;
  providerCost: { source: string; category: string | null; amount: number; currency: string; finality: string } | null;
};

export type WhatsAppMessageStatusResult =
  | { outcome: "applied"; messageId: string }
  | {
      outcome:
        | "duplicate"
        | "already_processed"
        | "terminal_failed"
        | "claim_lost"
        | "not_found"
        | "message_conflict"
        | "cost_conflict"
        | "effect_conflict";
    }
  | {
      /** A mensagem ainda não existe: nada foi gravado e o claim continua
       * com quem chamou; o status pode ser reaplicado depois. */
      outcome: "message_not_found";
    }
  | {
      /** O canal deixou de estar ativo depois do claim: nada gravado, o
       * claim continua para quem chamou liberar (B3.2d-2b3). */
      outcome: "channel_paused" | "channel_disconnected" | "channel_disabled";
    };

const costSchema = z
  .object({
    source: z.literal("provider"),
    category: z.string().nullable(),
    amount: z.number().finite().nonnegative().lt(1e12),
    currency: z.string().regex(/^[A-Z]{3}$/),
    finality: z.enum(["estimated", "final"]),
  })
  .strict();

const inputSchema = z
  .object({
    providerMessageId: z.string().regex(/^\S{1,255}$/),
    waMessageId: z
      .string()
      .regex(/^wamid\.[A-Za-z0-9._:=+/-]{1,512}$/)
      .nullable(),
    externalId: z
      .string()
      .min(1)
      .max(512)
      .refine((v) => !CONTROL.test(v))
      .nullable(),
    status: z.enum(["accepted", "sent", "delivered", "read", "failed"]),
    errorCode: z.string().nullable(),
    occurredAt: z.string().refine((v) => !Number.isNaN(Date.parse(v))),
    recipient: z
      .object({
        phoneE164: z.string().nullable(),
        bsuid: z.string().nullable(),
      })
      .strict()
      .nullable(),
    providerCost: costSchema.nullable(),
  })
  .strict();

const appliedSchema = z
  .object({
    outcome: z.literal("applied"),
    message_id: uuidSchema,
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
      "message_not_found",
      "message_conflict",
      "cost_conflict",
      "effect_conflict",
      "channel_paused",
      "channel_disconnected",
      "channel_disabled",
    ]),
  })
  .strict();

const NO_IDENTITY: WhatsAppEffectIdentityArgs = {
  p_phone_e164: null,
  p_bsuid_lookup: null,
  p_bsuid_ciphertext: null,
  p_bsuid_key_version: null,
};

/** Aplica o status numa transação só. Os resultados do banco voltam como
 * vieram; em message_not_found, nos conflitos e com o canal não ativo nada
 * foi gravado e o claim continua com quem chamou. */
export async function applyWhatsAppMessageStatus(
  claim: WhatsAppInboxClaim,
  input: WhatsAppMessageStatusInput,
): Promise<WhatsAppMessageStatusResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success)
    throw new WhatsAppMessageStatusError("invalid_status_update");
  const update = parsed.data;

  // Categoria pela regra do domínio; failed nunca é cobrado; final só com a
  // prova de entrega (o normalizador nunca produz outro).
  const cost = whatsappCostForStatus(
    update.status,
    sanitizeWhatsAppProviderCost(update.providerCost),
  );
  if (update.providerCost !== null && cost === null)
    throw new WhatsAppMessageStatusError("invalid_status_update");
  if (
    cost?.finality === "final" &&
    update.status !== "delivered" &&
    update.status !== "read"
  ) {
    throw new WhatsAppMessageStatusError("invalid_status_update");
  }

  let identityArgs = NO_IDENTITY;
  if (update.recipient !== null) {
    try {
      identityArgs = whatsappEffectIdentityArgs(claim, update.recipient);
    } catch (error) {
      if (
        error instanceof WhatsAppEffectIdentityError &&
        error.code === "identity_keys_not_configured"
      ) {
        throw new WhatsAppMessageStatusError("identity_keys_not_configured");
      }
      throw new WhatsAppMessageStatusError("invalid_status_update");
    }
  }

  const errorCode =
    update.status !== "failed" || update.errorCode === null
      ? null
      : ERROR_CODE.test(update.errorCode)
        ? update.errorCode
        : "unrecognized";

  const args = {
    p_provider_message_id: update.providerMessageId,
    p_wa_message_id: update.waMessageId,
    p_external_id: update.externalId,
    p_status: update.status,
    p_error_code: errorCode,
    p_occurred_at: update.occurredAt,
    ...identityArgs,
    p_cost_amount: cost?.amount ?? null,
    p_cost_currency: cost?.currency ?? null,
    p_cost_category: cost?.category ?? null,
    p_cost_finality: cost?.finality ?? null,
  };

  let response: { data: unknown; error: { message?: string } | null };
  try {
    response = await runWhatsAppInboxClaimEffect(
      claim,
      "whatsapp_effect_message_status",
      args,
    );
  } catch (error) {
    if (
      error instanceof WhatsAppInboxError &&
      error.code === "inbox_claim_untrusted"
    )
      throw new WhatsAppMessageStatusError("inbox_claim_untrusted");
    throw new WhatsAppMessageStatusError("unknown");
  }
  if (response.error) {
    const code = response.error.message ?? "";
    throw new WhatsAppMessageStatusError(
      DB_CODES.has(code) ? (code as WhatsAppMessageStatusErrorCode) : "unknown",
    );
  }

  const applied = appliedSchema.safeParse(response.data);
  if (applied.success)
    return { outcome: "applied", messageId: applied.data.message_id };
  const other = otherSchema.safeParse(response.data);
  if (other.success)
    return { outcome: other.data.outcome } as WhatsAppMessageStatusResult;
  throw new WhatsAppMessageStatusError("invalid_response");
}
