import { applyWhatsAppAccountEvent, WhatsAppAccountEventError } from "@/server/whatsapp/effects/account-event";
import { applyWhatsAppIdentityChange, WhatsAppIdentityChangeError } from "@/server/whatsapp/effects/identity-change";
import { applyWhatsAppInboundMessage, WhatsAppInboundEffectError } from "@/server/whatsapp/effects/inbound-message";
import { applyWhatsAppMessageStatus, WhatsAppMessageStatusError } from "@/server/whatsapp/effects/message-status";
import { applyWhatsAppOutboundObserved, WhatsAppOutboundObservedError } from "@/server/whatsapp/effects/outbound-observed";
import type { WhatsAppInboxClaim } from "@/server/whatsapp/inbox";
import type {
  NormalizedAccountEvent,
  NormalizedIdentityChange,
  NormalizedInboundMessage,
  NormalizedOutboundObserved,
  NormalizedStatusUpdate,
} from "@/server/whatsapp/provider/contract";

/**
 * Despachante dos cinco efeitos do domínio (B3.2d-2b3,
 * docs/decisoes/b3-whatsapp-real.md §27). Recebe o claim EXATAMENTE como a
 * inbox o emitiu e UM evento normalizado, chama o efeito do tipo dele — uma
 * única vez — e traduz o resultado numa disposição para o consumidor:
 *
 *  - `done`: o banco já deixou a entrada concluída (`processed`) ou ela não
 *    é mais deste claim (já processada, terminal, claim perdido, inexistente).
 *    O consumidor NÃO finaliza de novo;
 *  - `release` / `fail`: o claim continua com o consumidor, que finaliza
 *    exatamente uma vez;
 *  - `retry`: falha de infraestrutura ou resposta fora do contrato — nada é
 *    finalizado e o Inngest tenta de novo (a nova execução recomeça no claim).
 *
 * Este módulo NÃO finaliza a entrada, não copia nem serializa o claim, não
 * consulta o relógio, não lê variável de ambiente, não fala com o banco (só
 * os efeitos falam) e não registra log. O horário do provedor vai ao efeito
 * como veio: quem julga o horário é o banco. A disposição só carrega códigos
 * fixos — nunca ids, telefone, BSUID, conta, routing key, token ou conteúdo.
 */

/** Resultados do efeito que encerram a entrada com sucesso no banco. */
export const WHATSAPP_EFFECT_PROCESSED_CODES = ["applied", "recorded", "stale_event", "review_required", "duplicate"] as const;
/** Falhas TERMINAIS do conteúdo ou do estado: o claim vai para `fail`. */
export const WHATSAPP_EFFECT_TERMINAL_CODES = [
  "identity_conflict",
  "message_conflict",
  "cost_conflict",
  "effect_conflict",
  "account_reference_mismatch",
  "invalid_inbound_message",
  "invalid_outbound_message",
  "invalid_status_update",
  "invalid_identity_change",
  "invalid_account_event",
] as const;
/** Resultados RECUPERÁVEIS: o claim vai para `release` (reconciliação). */
export const WHATSAPP_EFFECT_RECOVERABLE_CODES = [
  "identity_not_found",
  "message_not_found",
  "account_reference_unverified",
  "identity_keys_not_configured",
] as const;

export type WhatsAppEffectProcessedCode = (typeof WHATSAPP_EFFECT_PROCESSED_CODES)[number];
type EffectTerminalCode = (typeof WHATSAPP_EFFECT_TERMINAL_CODES)[number];
type EffectRecoverableCode = (typeof WHATSAPP_EFFECT_RECOVERABLE_CODES)[number];
/** Códigos que o consumidor já tinha e que também saem dos efeitos. */
type SharedTerminalCode = "routing_mismatch";
type SharedRecoverableCode = "channel_paused" | "channel_disconnected" | "channel_disabled";

export type WhatsAppDomainEvent =
  | NormalizedInboundMessage
  | NormalizedOutboundObserved
  | NormalizedStatusUpdate
  | NormalizedIdentityChange
  | NormalizedAccountEvent;

export type WhatsAppEffectDisposition =
  | Readonly<{ action: "done"; outcome: "processed"; code: WhatsAppEffectProcessedCode }>
  | Readonly<{ action: "done"; outcome: "already_processed" | "terminal_failed" | "claim_lost" | "not_found"; code: null }>
  | Readonly<{ action: "release"; code: EffectRecoverableCode | SharedRecoverableCode }>
  | Readonly<{ action: "fail"; code: EffectTerminalCode | SharedTerminalCode }>
  | Readonly<{ action: "retry" }>;

const RETRY: WhatsAppEffectDisposition = { action: "retry" };
const processed = (code: WhatsAppEffectProcessedCode): WhatsAppEffectDisposition => ({ action: "done", outcome: "processed", code });
const release = (code: EffectRecoverableCode | SharedRecoverableCode): WhatsAppEffectDisposition => ({ action: "release", code });
const fail = (code: EffectTerminalCode | SharedTerminalCode): WhatsAppEffectDisposition => ({ action: "fail", code });

/** Já terminal ou sem posse: nada a finalizar, o resultado é o equivalente. */
const NO_OWNERSHIP: readonly (readonly [string, WhatsAppEffectDisposition])[] = [
  ["already_processed", { action: "done", outcome: "already_processed", code: null }],
  ["terminal_failed", { action: "done", outcome: "terminal_failed", code: null }],
  ["claim_lost", { action: "done", outcome: "claim_lost", code: null }],
  ["not_found", { action: "done", outcome: "not_found", code: null }],
];

/** Tabela fechada resultado do banco → disposição, por tipo de efeito. O que
 * não está na tabela falha fechado (nova tentativa), nunca vira sucesso. */
function outcomes(spec: {
  processed: readonly WhatsAppEffectProcessedCode[];
  fail: readonly (EffectTerminalCode | SharedTerminalCode)[];
  release: readonly (EffectRecoverableCode | SharedRecoverableCode)[];
}): ReadonlyMap<string, WhatsAppEffectDisposition> {
  return new Map<string, WhatsAppEffectDisposition>([
    ...NO_OWNERSHIP,
    ...spec.processed.map((code) => [code, processed(code)] as const),
    ...spec.fail.map((code) => [code, fail(code)] as const),
    ...spec.release.map((code) => [code, release(code)] as const),
  ]);
}

const CHANNEL_RELEASES = ["channel_paused", "channel_disconnected", "channel_disabled"] as const;

const INBOUND_OUTCOMES = outcomes({
  processed: ["applied", "duplicate"],
  fail: ["identity_conflict", "effect_conflict"],
  release: CHANNEL_RELEASES,
});
const OUTBOUND_OUTCOMES = outcomes({
  processed: ["applied", "duplicate"],
  fail: ["identity_conflict", "message_conflict", "effect_conflict"],
  release: CHANNEL_RELEASES,
});
const STATUS_OUTCOMES = outcomes({
  processed: ["applied", "duplicate"],
  fail: ["message_conflict", "cost_conflict", "effect_conflict"],
  release: [...CHANNEL_RELEASES, "message_not_found"],
});
const IDENTITY_OUTCOMES = outcomes({
  processed: ["applied", "review_required", "duplicate"],
  fail: ["identity_conflict", "effect_conflict"],
  release: [...CHANNEL_RELEASES, "identity_not_found"],
});
// O evento da conta não depende do estado do canal: não há channel_* aqui.
const ACCOUNT_OUTCOMES = outcomes({
  processed: ["applied", "recorded", "stale_event", "duplicate"],
  fail: ["routing_mismatch", "account_reference_mismatch", "effect_conflict"],
  release: ["account_reference_unverified"],
});

function fromOutcome(table: ReadonlyMap<string, WhatsAppEffectDisposition>, result: unknown): WhatsAppEffectDisposition {
  const outcome = typeof result === "object" && result !== null ? (result as { outcome?: unknown }).outcome : undefined;
  return (typeof outcome === "string" ? table.get(outcome) : undefined) ?? RETRY;
}

/** Erro lançado pelo efeito: só o conteúdo inválido do próprio tipo falha a
 * entrada, e só a falta das chaves de identidade a libera. Todo o resto
 * (desconhecido, fora do contrato, ambiente, claim não confiável, rede) é
 * infraestrutura: nada é finalizado. */
function fromError(error: unknown, errorClass: new (code: never) => Error, invalid: EffectTerminalCode, usesIdentityKeys: boolean): WhatsAppEffectDisposition {
  if (!(error instanceof errorClass)) return RETRY;
  const code = (error as Error & { code?: unknown }).code;
  if (code === invalid) return fail(invalid);
  if (usesIdentityKeys && code === "identity_keys_not_configured") return release("identity_keys_not_configured");
  return RETRY;
}

/** Horário como o efeito o recebe (ISO); `null` se a data não existe. */
function iso(value: unknown): string | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null;
}

const contact = (identity: { phoneE164: string | null; bsuid: string | null }) => ({ phoneE164: identity.phoneE164, bsuid: identity.bsuid });

/** Chamada de um efeito já com o dado convertido. */
async function settle(call: () => Promise<unknown>, table: ReadonlyMap<string, WhatsAppEffectDisposition>, onError: (error: unknown) => WhatsAppEffectDisposition) {
  try {
    return fromOutcome(table, await call());
  } catch (error) {
    return onError(error);
  }
}

async function dispatch(claim: WhatsAppInboxClaim, event: WhatsAppDomainEvent): Promise<WhatsAppEffectDisposition> {
  switch (event.kind) {
    case "message.inbound": {
      const occurredAt = iso(event.occurredAt);
      if (occurredAt === null) return fail("invalid_inbound_message");
      const input = {
        providerMessageId: event.providerMessageId,
        contentKind: event.contentKind,
        text: event.text,
        occurredAt,
        sender: contact(event.sender),
        profileName: event.senderProfileName,
      };
      return settle(() => applyWhatsAppInboundMessage(claim, input), INBOUND_OUTCOMES, (e) => fromError(e, WhatsAppInboundEffectError, "invalid_inbound_message", true));
    }
    case "message.outbound_observed": {
      const occurredAt = iso(event.occurredAt);
      if (occurredAt === null) return fail("invalid_outbound_message");
      const input = {
        providerMessageId: event.providerMessageId,
        waMessageId: event.waMessageId,
        contentKind: event.contentKind,
        text: event.text,
        occurredAt,
        recipient: contact(event.recipient),
      };
      return settle(() => applyWhatsAppOutboundObserved(claim, input), OUTBOUND_OUTCOMES, (e) => fromError(e, WhatsAppOutboundObservedError, "invalid_outbound_message", true));
    }
    case "message.status": {
      const occurredAt = iso(event.occurredAt);
      if (occurredAt === null) return fail("invalid_status_update");
      const cost = event.providerCost;
      const input = {
        providerMessageId: event.providerMessageId,
        waMessageId: event.waMessageId,
        externalId: event.externalId,
        status: event.status,
        errorCode: event.errorCode,
        occurredAt,
        recipient: event.recipient === null ? null : contact(event.recipient),
        providerCost:
          cost === null ? null : { source: cost.source, category: cost.category, amount: cost.amount, currency: cost.currency, finality: cost.finality },
      };
      return settle(() => applyWhatsAppMessageStatus(claim, input), STATUS_OUTCOMES, (e) => fromError(e, WhatsAppMessageStatusError, "invalid_status_update", true));
    }
    case "contact.identity_changed": {
      const occurredAt = iso(event.occurredAt);
      if (occurredAt === null) return fail("invalid_identity_change");
      const input = {
        change: event.change,
        occurredAt,
        previous: contact(event.previous),
        next: event.next === null ? null : contact(event.next),
      };
      return settle(() => applyWhatsAppIdentityChange(claim, input), IDENTITY_OUTCOMES, (e) => fromError(e, WhatsAppIdentityChangeError, "invalid_identity_change", true));
    }
    case "account":
      // O efeito valida o evento (inclusive a data) e o banco julga o horário.
      return settle(() => applyWhatsAppAccountEvent(claim, event), ACCOUNT_OUTCOMES, (e) => fromError(e, WhatsAppAccountEventError, "invalid_account_event", false));
    default:
      // Inalcançável: o consumidor só despacha os cinco tipos de domínio.
      return RETRY;
  }
}

/**
 * Aplica UM evento de domínio com o claim recebido. Nunca lança: qualquer
 * falha inesperada é `retry`. A conversão de um evento malformado (campos
 * ausentes, data inválida) é falha terminal do próprio tipo, antes do efeito.
 */
export async function applyWhatsAppDomainEffect(claim: WhatsAppInboxClaim, event: WhatsAppDomainEvent): Promise<WhatsAppEffectDisposition> {
  try {
    return await dispatch(claim, event);
  } catch {
    // Só a conversão do evento chega aqui (os efeitos são tratados em `settle`).
    return conversionFailure(event);
  }
}

function conversionFailure(event: WhatsAppDomainEvent): WhatsAppEffectDisposition {
  switch (event?.kind) {
    case "message.inbound":
      return fail("invalid_inbound_message");
    case "message.outbound_observed":
      return fail("invalid_outbound_message");
    case "message.status":
      return fail("invalid_status_update");
    case "contact.identity_changed":
      return fail("invalid_identity_change");
    case "account":
      return fail("invalid_account_event");
    default:
      return RETRY;
  }
}
