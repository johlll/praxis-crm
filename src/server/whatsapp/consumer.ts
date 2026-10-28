import { createHash, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";
import type { WhatsAppChannelStatus } from "@/server/whatsapp/admin/channels";
import {
  claimWhatsAppInboxEntry,
  disposeWhatsAppInboxClaim,
  failWhatsAppInboxClaim,
  releaseWhatsAppInboxClaim,
  WhatsAppInboxError,
  type WhatsAppInboxClaim,
  type WhatsAppInboxDisposition,
  type WhatsAppInboxFinishOutcome,
} from "@/server/whatsapp/inbox";
import { WHATSAPP_INBOX_RECEIVED_EVENT } from "@/server/whatsapp/inbox-events";
import { resolveWhatsAppProvider } from "@/server/whatsapp/provider";
import { VerifiedWebhookBody, type NormalizedWhatsAppEvent } from "@/server/whatsapp/provider/contract";

/**
 * Consumidor da inbox do WhatsApp (B3.2d-2a, docs/decisoes/b3-whatsapp-real.md
 * §20). Só a orquestração segura: NADA aqui escreve no domínio (contato,
 * lead, oportunidade, atividade, conversa, mensagem ou status da A7).
 *
 * O evento interno traz SÓ o `inboxId`. Ambiente, workspace, canal, estado
 * do canal, provedor, routing key, hash e cifra saem do banco, pelo claim.
 *
 * Todo o ciclo acontece numa ÚNICA chamada de `processWhatsAppInboxEntry`,
 * que a função do Inngest executa dentro de UM `step.run`:
 *   claim → decifração e hash (no claim) → hash conferido de novo →
 *   adaptador do provedor GRAVADO no canal → envelope → exatamente um
 *   evento normalizado → roteamento → estado do canal → decisão → UMA
 *   finalização (dispose, fail ou release).
 * O objeto do claim nunca sai daqui: o retorno é só `{ outcome, code }`.
 *
 * Nenhum log. Erros viram códigos fixos; falha de infraestrutura vira
 * `WhatsAppConsumerRetryableError` (nova tentativa do Inngest), sem a
 * mensagem original.
 */

export const WHATSAPP_INBOX_CONSUMER_STEP_ID = "process-inbox-entry";

/** Falhas TERMINAIS: a entrada vai para `failed` (fail). */
export const WHATSAPP_CONSUMER_TERMINAL_CODES = [
  "inbox_decrypt_failed",
  "inbox_integrity_failed",
  "payload_invalid",
  "unsupported_version",
  "event_count_invalid",
  "event_mismatch",
  "routing_mismatch",
  "event_impossible",
  "provider_invalid",
] as const;

/** Falhas RECUPERÁVEIS: a entrada volta a `pending` (release) e fica
 * preservada para a republicação da B3.2e. */
export const WHATSAPP_CONSUMER_RECOVERABLE_CODES = [
  "inbox_crypto_not_configured",
  "inbox_key_version_unknown",
  "provider_unavailable",
  "consumer_transient_error",
  "channel_paused",
  "channel_disconnected",
  "channel_disabled",
  "domain_effect_not_implemented",
] as const;

export type WhatsAppConsumerTerminalCode = (typeof WHATSAPP_CONSUMER_TERMINAL_CODES)[number];
export type WhatsAppConsumerRecoverableCode = (typeof WHATSAPP_CONSUMER_RECOVERABLE_CODES)[number];
export type WhatsAppConsumerCode = WhatsAppConsumerTerminalCode | WhatsAppConsumerRecoverableCode | WhatsAppInboxDisposition;

export type WhatsAppConsumerOutcome =
  | "processed"
  | "released"
  | "failed"
  | "busy"
  | "already_processed"
  | "terminal_failed"
  | "expired"
  | "not_found"
  | "claim_lost";

/** Retorno do step: dado puro, serializável, sem claim, token, contexto,
 * corpo ou identidade. */
export type WhatsAppConsumerResult = Readonly<{ outcome: WhatsAppConsumerOutcome; code: WhatsAppConsumerCode | null }>;

export type WhatsAppConsumerDecision =
  | Readonly<{ action: "dispose"; code: WhatsAppInboxDisposition }>
  | Readonly<{ action: "fail"; code: WhatsAppConsumerTerminalCode }>
  | Readonly<{ action: "release"; code: WhatsAppConsumerRecoverableCode }>;

/** Falha de infraestrutura (banco indisponível no claim ou na finalização).
 * Só o código: nem a mensagem original nem a pilha saem para o Inngest. */
export class WhatsAppConsumerRetryableError extends Error {
  constructor(public readonly code: "inbox_unavailable" | "inbox_finalize_unavailable") {
    super(code);
    this.name = "WhatsAppConsumerRetryableError";
    this.stack = `${this.name}: ${code}`;
  }
}

// ---------------------------------------------------------------------
// Evento interno
// ---------------------------------------------------------------------

const receivedEventSchema = z.object({
  name: z.literal(WHATSAPP_INBOX_RECEIVED_EVENT),
  // `data` é exatamente { inboxId }: qualquer contexto a mais é recusado.
  data: z.object({ inboxId: uuidSchema }).strict(),
  id: z.string().optional(),
});

/** Aceita só `{ name: "praxis/whatsapp.inbox.received", data: { inboxId } }`.
 * O `id` do evento, quando vier, é o próprio `inboxId` (contrato do
 * publicador). Campos do envelope do Inngest (como `ts`) não são lidos. */
export function parseWhatsAppInboxReceivedEvent(event: unknown): { ok: true; inboxId: string } | { ok: false } {
  const parsed = receivedEventSchema.safeParse(event);
  if (!parsed.success) return { ok: false };
  const inboxId = parsed.data.data.inboxId.toLowerCase();
  if (parsed.data.id !== undefined && parsed.data.id.toLowerCase() !== inboxId) return { ok: false };
  return { ok: true, inboxId };
}

// ---------------------------------------------------------------------
// Decisão (pura)
// ---------------------------------------------------------------------

const release = (code: WhatsAppConsumerRecoverableCode): WhatsAppConsumerDecision => ({ action: "release", code });
const fail = (code: WhatsAppConsumerTerminalCode): WhatsAppConsumerDecision => ({ action: "fail", code });
const dispose = (code: WhatsAppInboxDisposition): WhatsAppConsumerDecision => ({ action: "dispose", code });

/** Tipos que EXIGEM routing key (o contrato do adaptador a declara
 * obrigatória). */
const ROUTED_KINDS: ReadonlySet<string> = new Set(["message.inbound", "message.outbound_observed", "message.status", "contact.identity_changed"]);
/** Tipos que, a partir da B3.2d-2b, terão efeito no domínio. */
const DOMAIN_KINDS: ReadonlySet<string> = new Set([...ROUTED_KINDS, "account"]);
const IGNORED_DISPOSITIONS: Readonly<Record<string, WhatsAppInboxDisposition>> = {
  history: "ignored_history",
  group_message: "ignored_group_message",
  non_whatsapp_product: "ignored_non_whatsapp_product",
};

const CHANNEL_RELEASE: Readonly<Record<Exclude<WhatsAppChannelStatus, "active">, WhatsAppConsumerRecoverableCode>> = {
  paused: "channel_paused",
  disconnected: "channel_disconnected",
  disabled: "channel_disabled",
};

/**
 * Decide o destino de UM evento normalizado, nesta ordem:
 *  1. tipo conhecido (senão `event_impossible`);
 *  2. roteamento: routing key presente tem de ser IGUAL à do canal da linha
 *     (`routing_mismatch`; nunca serve para procurar outro canal). Mensagem,
 *     eco, status, troca de identidade e evento do NÚMERO exigem routing
 *     key; evento da conta (WABA), ignorado e não suportado podem vir sem —
 *     o canal é o da linha, e nenhuma routing key é inventada;
 *  3. estado ATUAL do canal: pausado, desconectado ou desativado → release
 *     com o código do estado (a entrada fica pendente, nunca descartada);
 *  4. tipo: o que um dia terá efeito no domínio → release
 *     `domain_effect_not_implemented`; ignorado e não suportado → dispose.
 * A falha terminal de conteúdo prevalece sobre o estado do canal.
 */
export function decideWhatsAppInboxEvent(params: {
  channelRoutingKey: string;
  channelStatus: WhatsAppChannelStatus;
  event: NormalizedWhatsAppEvent;
}): WhatsAppConsumerDecision {
  const event = params.event as unknown as Record<string, unknown>;
  const kind = event.kind;
  if (typeof kind !== "string" || !(DOMAIN_KINDS.has(kind) || kind === "ignored" || kind === "unsupported")) return fail("event_impossible");
  if (kind === "account" && event.scope !== "business_account" && event.scope !== "phone_number") return fail("event_impossible");

  const routingRequired = ROUTED_KINDS.has(kind) || (kind === "account" && event.scope === "phone_number");
  const routingKey = event.routingKey;
  if (routingKey === null || routingKey === undefined) {
    if (routingRequired) return fail("event_impossible");
  } else {
    if (typeof routingKey !== "string" || routingKey === "") return fail("event_impossible");
    if (routingKey !== params.channelRoutingKey) return fail("routing_mismatch");
  }

  if (params.channelStatus !== "active") {
    return release(Object.hasOwn(CHANNEL_RELEASE, params.channelStatus) ? CHANNEL_RELEASE[params.channelStatus] : "consumer_transient_error");
  }

  if (DOMAIN_KINDS.has(kind)) return release("domain_effect_not_implemented");
  if (kind === "ignored") {
    const reason = event.reason;
    if (typeof reason !== "string" || !Object.hasOwn(IGNORED_DISPOSITIONS, reason)) return fail("event_impossible");
    return dispose(IGNORED_DISPOSITIONS[reason]!);
  }
  return dispose("unsupported_event");
}

// ---------------------------------------------------------------------
// Ciclo completo de uma entrada
// ---------------------------------------------------------------------

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** O hash da linha, conferido de novo sobre os bytes que o claim devolveu. */
function bodyMatchesHash(claim: WhatsAppInboxClaim): boolean {
  if (typeof claim.bodySha256 !== "string" || !SHA256_HEX.test(claim.bodySha256)) return false;
  const expected = Buffer.from(claim.bodySha256, "hex");
  const actual = createHash("sha256").update(claim.verified.copyBytes()).digest();
  return timingSafeEqual(actual, expected);
}

function decideClaim(claim: WhatsAppInboxClaim): WhatsAppConsumerDecision {
  if (!VerifiedWebhookBody.is(claim.verified)) return fail("event_impossible");
  if (!bodyMatchesHash(claim)) return fail("inbox_integrity_failed");

  // O adaptador é o do provedor GRAVADO no canal da linha.
  const resolution = resolveWhatsAppProvider({ channelProvider: claim.provider });
  if (resolution.status !== "enabled") {
    return resolution.reason === "invalid_channel_provider" || resolution.reason === "provider_mismatch"
      ? fail("provider_invalid")
      : release("provider_unavailable");
  }
  const adapter = resolution.provider;
  if (!adapter.describeCapabilities().normalizeEvents) return release("provider_unavailable");

  const envelope = adapter.inspectEnvelope(claim.verified);
  if (!envelope.ok) {
    switch (envelope.reason) {
      case "unsupported_envelope_version":
        return fail("unsupported_version");
      case "batch_not_supported":
        return fail("event_count_invalid");
      case "unverified_body":
        return fail("event_impossible");
      default:
        return fail("payload_invalid");
    }
  }
  if (envelope.envelope.providerEventId !== claim.providerEventId || envelope.envelope.providerEventType !== claim.providerEventType) {
    return fail("event_mismatch");
  }

  const normalized = adapter.normalizeEvents(claim.verified);
  if (!normalized.ok) {
    if (normalized.reason === "unsupported") return release("provider_unavailable");
    return fail(normalized.reason === "unverified_body" ? "event_impossible" : "payload_invalid");
  }
  if (normalized.events.length !== 1) return fail("event_count_invalid");
  const [event] = normalized.events;
  if (!event || event.providerEventId !== claim.providerEventId) return fail("event_mismatch");

  return decideWhatsAppInboxEvent({ channelRoutingKey: claim.routingKey, channelStatus: claim.channelStatus, event });
}

/** Erros que o próprio claim já finalizou (fail ou release); o resto é
 * infraestrutura. */
function claimErrorResult(error: unknown): WhatsAppConsumerResult {
  if (error instanceof WhatsAppInboxError) {
    switch (error.code) {
      case "inbox_decrypt_failed":
      case "inbox_integrity_failed":
        return { outcome: "failed", code: error.code };
      case "inbox_crypto_not_configured":
      case "inbox_key_version_unknown":
        return { outcome: "released", code: error.code };
    }
  }
  throw new WhatsAppConsumerRetryableError("inbox_unavailable");
}

/** UMA finalização. Se ela própria falhar, nenhuma outra é tentada: a lease
 * vence e a entrada volta a ser reclamável. `claim_lost` também encerra. */
async function finalize(claim: WhatsAppInboxClaim, decision: WhatsAppConsumerDecision): Promise<WhatsAppConsumerResult> {
  let result: { outcome: WhatsAppInboxFinishOutcome };
  try {
    if (decision.action === "dispose") result = await disposeWhatsAppInboxClaim(claim, decision.code);
    else if (decision.action === "fail") result = await failWhatsAppInboxClaim(claim, decision.code);
    else result = await releaseWhatsAppInboxClaim(claim, decision.code);
  } catch {
    throw new WhatsAppConsumerRetryableError("inbox_finalize_unavailable");
  }
  switch (result.outcome) {
    case "completed":
      return { outcome: "processed", code: decision.code };
    case "failed":
    case "released":
    case "claim_lost":
      return { outcome: result.outcome, code: decision.code };
    default:
      return { outcome: result.outcome, code: null };
  }
}

/**
 * Processa UMA entrada da inbox pelo `inboxId` — e SÓ por ele: qualquer
 * outro campo do chamador é ignorado. Resultados do claim sem posse (busy,
 * already_processed, terminal_failed, expired, not_found) encerram sem
 * finalização. Com o claim, decide e finaliza exatamente uma vez.
 */
export async function processWhatsAppInboxEntry(params: { inboxId: string }): Promise<WhatsAppConsumerResult> {
  const inboxId = params?.inboxId;
  let claimed;
  try {
    claimed = await claimWhatsAppInboxEntry({ inboxId });
  } catch (error) {
    return claimErrorResult(error);
  }
  if (claimed.outcome !== "claimed") return { outcome: claimed.outcome, code: null };

  const claim = claimed.claim;
  let decision: WhatsAppConsumerDecision;
  try {
    decision = decideClaim(claim);
  } catch {
    // Adaptador ou normalização falhando por dentro: falha transitória.
    decision = release("consumer_transient_error");
  }
  return finalize(claim, decision);
}
