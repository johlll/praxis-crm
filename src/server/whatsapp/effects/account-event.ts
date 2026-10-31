import { z } from "zod";

import { runWhatsAppInboxClaimEffect, WhatsAppInboxError, type WhatsAppInboxClaim } from "@/server/whatsapp/inbox";
import type { NormalizedAccountEvent } from "@/server/whatsapp/provider/contract";

/**
 * Efeito atômico dos eventos OPERACIONAIS da conta e do número (B3.2d-2b2b3b,
 * docs/decisoes/b3-whatsapp-real.md §26). Não envia nada e não chama o
 * provedor.
 *
 * Recebe o claim emitido por `claimWhatsAppInboxEntry` e o evento já
 * normalizado (`NormalizedAccountEvent`, o contrato NEUTRO do provedor: este
 * módulo não conhece nenhum adaptador). Ao banco vão só o id da entrada e o
 * token do claim (pela inbox) e os dados do evento; workspace, canal,
 * ambiente, provedor e id do evento o banco lê da própria linha da inbox.
 *
 * O telefone do escritório (`businessPhoneE164`) é só VALIDADO aqui: não vai
 * ao banco. A routing key vai inteira, como veio: nada a divide nem deduz a
 * conta a partir dela. O banco confere a routing key e a referência da conta
 * contra as do canal e decide; divergência não é recusada aqui, volta como
 * resultado (routing_mismatch, account_reference_mismatch,
 * account_reference_unverified).
 *
 * Só dois tipos mudam o canal (a exclusão do número e a da conta); os demais
 * apenas são registrados, e o `code` do provedor é um valor opaco.
 *
 * Ainda não é chamado pelo consumidor da B3.2d-2a (B3.2d-2b3). Nenhum log;
 * erros são códigos fixos.
 */

export const WHATSAPP_ACCOUNT_EVENT_OUTCOMES = [
  "applied",
  "recorded",
  "stale_event",
  "duplicate",
  "routing_mismatch",
  "account_reference_mismatch",
  "account_reference_unverified",
  "effect_conflict",
  "already_processed",
  "terminal_failed",
  "claim_lost",
  "not_found",
] as const;

export type WhatsAppAccountEventOutcome = (typeof WHATSAPP_ACCOUNT_EVENT_OUTCOMES)[number];

/** Nada além do resultado sai daqui: nenhum telefone, routing key, conta ou
 * código. Em `routing_mismatch`, nas duas divergências de conta e em
 * `effect_conflict` nada foi gravado e o claim continua com quem chamou (a
 * B3.2d-2b3 decide falhar ou liberar). */
export type WhatsAppAccountEventResult = { outcome: WhatsAppAccountEventOutcome };

export const WHATSAPP_ACCOUNT_EVENT_ERROR_CODES = [
  "invalid_account_event",
  "whatsapp_environment_required",
  "inbox_claim_untrusted",
  "invalid_response",
] as const;

export type WhatsAppAccountEventErrorCode = (typeof WHATSAPP_ACCOUNT_EVENT_ERROR_CODES)[number] | "unknown";

export class WhatsAppAccountEventError extends Error {
  constructor(public readonly code: WhatsAppAccountEventErrorCode) {
    super(code);
    this.name = "WhatsAppAccountEventError";
  }
}

const DB_CODES: ReadonlySet<string> = new Set(["invalid_account_event", "whatsapp_environment_required"]);

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const noControl = (value: string) => !CONTROL.test(value);

const eventSchema = z
  .object({
    kind: z.literal("account"),
    scope: z.enum(["business_account", "phone_number"]),
    providerType: z
      .string()
      .max(128)
      .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/),
    providerEventId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    providerAccountRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    businessPhoneE164: z
      .string()
      .regex(/^\+[1-9][0-9]{7,14}$/)
      .nullable(),
    routingKey: z.string().min(1).max(128).refine(noControl).nullable(),
    occurredAt: z.date(),
    code: z.string().min(1).max(64).refine(noControl).nullable(),
  })
  .strict()
  .refine((v) =>
    v.scope === "phone_number"
      ? v.businessPhoneE164 !== null && v.routingKey !== null && v.providerType.startsWith("whatsapp.phone_number.")
      : v.businessPhoneE164 === null && v.routingKey === null && v.providerType.startsWith("whatsapp.business_account."),
  );

const responseSchema = z.object({ outcome: z.enum(WHATSAPP_ACCOUNT_EVENT_OUTCOMES) }).strict();

/** Aplica o evento numa transação só. O resultado do banco volta como veio;
 * qualquer falha desfaz tudo e a entrada continua com quem chamou. */
export async function applyWhatsAppAccountEvent(
  claim: WhatsAppInboxClaim,
  event: NormalizedAccountEvent,
): Promise<WhatsAppAccountEventResult> {
  const parsed = eventSchema.safeParse(event);
  if (!parsed.success) throw new WhatsAppAccountEventError("invalid_account_event");
  const data = parsed.data;

  // O evento tem de ser o da entrada do claim (o banco lê o id e o tipo da
  // linha da inbox; aqui só se confere que não são de outra entrada).
  const entry = claim as { providerEventId?: unknown; providerEventType?: unknown } | null | undefined;
  if (entry === null || entry === undefined || typeof entry !== "object") throw new WhatsAppAccountEventError("inbox_claim_untrusted");
  if (data.providerEventId !== entry.providerEventId || data.providerType !== entry.providerEventType) {
    throw new WhatsAppAccountEventError("invalid_account_event");
  }

  const args = {
    p_scope: data.scope,
    p_provider_type: data.providerType,
    p_provider_account_ref: data.providerAccountRef,
    p_routing_key: data.routingKey,
    p_occurred_at: data.occurredAt.toISOString(),
    p_code: data.code,
  };

  let response: { data: unknown; error: { message?: string } | null };
  try {
    response = await runWhatsAppInboxClaimEffect(claim, "whatsapp_effect_account_event", args);
  } catch (error) {
    if (error instanceof WhatsAppInboxError && error.code === "inbox_claim_untrusted") throw new WhatsAppAccountEventError("inbox_claim_untrusted");
    throw new WhatsAppAccountEventError("unknown");
  }
  if (response.error) {
    const code = response.error.message ?? "";
    throw new WhatsAppAccountEventError(DB_CODES.has(code) ? (code as WhatsAppAccountEventErrorCode) : "unknown");
  }

  const result = responseSchema.safeParse(response.data);
  if (!result.success) throw new WhatsAppAccountEventError("invalid_response");
  return { outcome: result.data.outcome };
}
