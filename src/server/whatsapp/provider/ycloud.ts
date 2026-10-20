import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import {
  isRawBodyBytes,
  unsupported,
  VerifiedWebhookBody,
  whatsappContactIdentity,
  type FetchMediaRequest,
  type FetchMediaResult,
  type LookupMessageRequest,
  type LookupMessageResult,
  type NormalizedMessageStatus,
  type NormalizedWhatsAppEvent,
  type NormalizeEventsResult,
  type SendResult,
  type SendTemplateRequest,
  type SendTextRequest,
  type WebhookVerificationInput,
  type WebhookVerificationResult,
  type WhatsAppCapabilities,
  type WhatsAppContactIdentity,
  type WhatsAppContentKind,
  type WhatsAppProvider,
} from "@/server/whatsapp/provider/contract";
import { WHATSAPP_WEBHOOK_MAX_BYTES } from "@/server/whatsapp/webhook";

/**
 * Adaptador PURO da YCloud (B3.2a, docs/decisoes/b3-whatsapp-real.md §15.9).
 *
 * Sem rede, sem credencial real, sem banco, sem log. Faz duas coisas:
 *  1. confere a assinatura do webhook sobre os BYTES exatos do corpo;
 *  2. traduz o evento conferido em FATOS do provedor (tipos do contrato).
 *
 * Contrato oficial (docs.ycloud.com, guia "Implement a webhook receiver" e
 * especificação de webhooks, conferidos em 20/10/2026):
 *  - cabeçalho `YCloud-Signature: t=<unix em segundos>,s=<hex>`;
 *  - HMAC-SHA256 com o segredo do endpoint sobre `<t>.` + bytes brutos;
 *  - comparação em tempo constante; o exemplo oficial aceita qualquer `s`
 *    que confira;
 *  - a tolerância de horário é política da aplicação (o exemplo usa 300 s);
 *  - o `id` do evento é a chave de deduplicação.
 *
 * O adaptador NÃO decide: criação de lead, contato ou conversa; identidade
 * interna; automação; vínculo; origem `chatbot`. A origem que ele relata é
 * só uma candidata (`inbound`, `business_app` ou `external_api`, §15.10), e
 * o `externalId` é um valor opaco de correlação, nunca prova de remetente.
 *
 * Ainda não está ligado na resolução de provedor: a rota é da B3.2c.
 */

export const YCLOUD_SIGNATURE_HEADER = "YCloud-Signature";
/** Padrão do exemplo oficial. */
export const YCLOUD_SIGNATURE_TOLERANCE_SECONDS = 300;
/** Teto da configuração: cobre a janela de reentregas da YCloud (cerca de
 * 5 h 40). Se as reentregas são reassinadas não está documentado. */
export const YCLOUD_SIGNATURE_MAX_TOLERANCE_SECONDS = 21_600;
export const YCLOUD_WEBHOOK_MAX_BYTES = WHATSAPP_WEBHOOK_MAX_BYTES;

const CAPABILITIES: WhatsAppCapabilities = Object.freeze({
  verifyWebhook: true,
  normalizeEvents: true,
  sendText: false,
  sendTemplate: false,
  lookupMessage: false,
  fetchMedia: false,
});

const E164 = /^\+[1-9][0-9]{7,14}$/;
/** `wa_id`: telefone sem o `+` (mensagem de sistema). */
const WA_ID = /^[1-9][0-9]{7,14}$/;
const WABA_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Id do evento: 6 a 128 caracteres (especificação oficial). */
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/;
const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:=+/-]{0,255}$/;
const WAMID = /^wamid\.[A-Za-z0-9._:=+/-]{1,512}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const RFC3339 = z.string().datetime({ offset: true });

const CONTENT_KINDS: ReadonlySet<string> = new Set<WhatsAppContentKind>([
  "text",
  "image",
  "video",
  "audio",
  "document",
  "sticker",
  "location",
  "contacts",
  "interactive",
  "button",
  "reaction",
  "order",
  "request_welcome",
  "template",
  "unsupported",
]);

const STATUSES: ReadonlySet<string> = new Set<NormalizedMessageStatus>(["accepted", "sent", "delivered", "read", "failed"]);

export function signatureTolerance(value: number | undefined): number {
  if (value === undefined) return YCLOUD_SIGNATURE_TOLERANCE_SECONDS;
  if (!Number.isInteger(value) || value < 1 || value > YCLOUD_SIGNATURE_MAX_TOLERANCE_SECONDS) {
    throw new RangeError("ycloud_signature_tolerance_out_of_range");
  }
  return value;
}

/** Chave de roteamento do canal YCloud: conta (WABA) + número do escritório. */
export function ycloudRoutingKey(wabaId: string, businessPhoneE164: string): string {
  if (!WABA_ID.test(wabaId) || !E164.test(businessPhoneE164)) throw new RangeError("invalid_ycloud_routing_key");
  return `${wabaId}:${businessPhoneE164}`;
}

// ---------------------------------------------------------------------
// Leitura defensiva do JSON
// ---------------------------------------------------------------------

class InvalidPayload extends Error {}

function fail(): never {
  throw new InvalidPayload();
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function obj(value: unknown): Obj {
  return isObj(value) ? value : fail();
}

/** Ausente (`undefined` ou `null`) → `null`. Presente e fora do formato
 * (inclusive vazio) → evento inválido: nunca ignorado em silêncio. */
function opt(value: unknown, pattern: RegExp): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !pattern.test(value)) fail();
  return value;
}

function req(value: unknown, pattern: RegExp): string {
  return opt(value, pattern) ?? fail();
}

function optOpaque(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || CONTROL.test(value)) fail();
  return value;
}

function optTime(value: unknown): Date | null {
  if (value === undefined || value === null) return null;
  return RFC3339.safeParse(value).success ? new Date(value as string) : fail();
}

function identity(phone: unknown, bsuid: unknown): WhatsAppContactIdentity | null {
  const p = opt(phone, /^.+$/s);
  const b = opt(bsuid, /^.+$/s);
  if (p === null && b === null) return null;
  return whatsappContactIdentity({ phoneE164: p, bsuid: b }) ?? fail();
}

/** `recipientUserId` e o alias `toUserId`: se vierem os dois, têm de ser iguais. */
function recipientBsuid(message: Obj): unknown {
  const a = message.recipientUserId;
  const b = message.toUserId;
  const present = (v: unknown) => v !== undefined && v !== null;
  if (present(a) && present(b) && a !== b) fail();
  return present(a) ? a : b;
}

function contentKind(type: unknown): WhatsAppContentKind {
  if (type === undefined || type === null) return "other";
  if (typeof type !== "string") fail();
  return CONTENT_KINDS.has(type) ? (type as WhatsAppContentKind) : "other";
}

function textOf(kind: WhatsAppContentKind, message: Obj): string | null {
  if (kind !== "text") return null;
  const body = obj(message.text).body;
  return typeof body === "string" && body.length > 0 ? body : fail();
}

function routing(wabaId: unknown, businessPhone: unknown): string {
  return ycloudRoutingKey(req(wabaId, WABA_ID), req(businessPhone, E164));
}

/** Roteamento só informativo, para eventos ignorados: nunca invalida. */
function routingOrNull(wabaId: unknown, businessPhone: unknown): string | null {
  return typeof wabaId === "string" && typeof businessPhone === "string" && WABA_ID.test(wabaId) && E164.test(businessPhone)
    ? `${wabaId}:${businessPhone}`
    : null;
}

// ---------------------------------------------------------------------
// Normalização por tipo de evento
// ---------------------------------------------------------------------

type Envelope = { id: string; type: string; createdAt: Date; raw: Obj };

const BUSINESS_ACCOUNT_CODE: Readonly<Record<string, string>> = {
  "whatsapp.business_account.deleted": "removedReason",
  "whatsapp.business_account.updated": "updateEvent",
  "whatsapp.business_account.reviewed": "decision",
};

const PHONE_NUMBER_CODE: Readonly<Record<string, readonly string[]>> = {
  "whatsapp.phone_number.deleted": [],
  "whatsapp.phone_number.name_updated": ["nameStatus", "decision"],
  "whatsapp.phone_number.quality_updated": ["qualityRating"],
  "whatsapp.phone_number.business_username_updated": ["businessUsernameStatus"],
};

function normalizeInbound(env: Envelope): NormalizedWhatsAppEvent {
  const m = obj(env.raw.whatsappInboundMessage);
  if (m.groupId !== undefined && m.groupId !== null) {
    return ignored(env, "group_message", routingOrNull(m.wabaId, m.to));
  }
  const routingKey = routing(m.wabaId, m.to);
  const providerMessageId = req(m.id, MESSAGE_ID);
  const waMessageId = opt(m.wamid, WAMID);
  const occurredAt = optTime(m.sendTime) ?? env.createdAt;
  const sender = identity(m.from, m.fromUserId) ?? fail();

  if (m.type === "system") {
    const system = obj(m.system);
    if (system.type === "user_changed_number") {
      const waId = opt(system.wa_id, WA_ID);
      const newWaId = opt(system.new_wa_id, WA_ID);
      if (waId !== null && newWaId !== null && waId !== newWaId) fail();
      const phone = waId ?? newWaId;
      const next = identity(phone === null ? null : `+${phone}`, system.user_id) ?? fail();
      return { kind: "contact.identity_changed", change: "phone_number", providerEventId: env.id, routingKey, occurredAt, previous: sender, next };
    }
    if (system.type === "user_identity_changed") {
      return { kind: "contact.identity_changed", change: "identity", providerEventId: env.id, routingKey, occurredAt, previous: sender, next: null };
    }
    return unsupportedEvent(env, routingKey);
  }

  const kind = contentKind(m.type);
  const profile = isObj(m.customerProfile) ? m.customerProfile.name : undefined;
  return {
    kind: "message.inbound",
    originCandidate: "inbound",
    providerEventId: env.id,
    routingKey,
    providerMessageId,
    waMessageId,
    occurredAt,
    sender,
    senderProfileName: typeof profile === "string" && profile.length > 0 && profile.length <= 256 ? profile : null,
    contentKind: kind,
    text: textOf(kind, m),
  };
}

function normalizeOutboundObserved(env: Envelope): NormalizedWhatsAppEvent {
  const m = obj(env.raw.whatsappMessage);
  const routingKey = routing(m.wabaId, m.from);
  const kind = contentKind(m.type);
  return {
    kind: "message.outbound_observed",
    originCandidate: "business_app",
    providerType: env.type,
    providerEventId: env.id,
    routingKey,
    providerMessageId: req(m.id, MESSAGE_ID),
    waMessageId: opt(m.wamid, WAMID),
    occurredAt: optTime(m.sendTime) ?? optTime(m.createTime) ?? env.createdAt,
    recipient: identity(m.to, recipientBsuid(m)) ?? fail(),
    contentKind: kind,
    text: textOf(kind, m),
  };
}

function normalizeStatus(env: Envelope): NormalizedWhatsAppEvent {
  const m = obj(env.raw.whatsappMessage);
  if (m.bizType !== undefined && m.bizType !== null && m.bizType !== "" && m.bizType !== "whatsapp") {
    return ignored(env, "non_whatsapp_product", routingOrNull(m.wabaId, m.from));
  }
  const routingKey = routing(m.wabaId, m.from);
  const status = m.status;
  if (typeof status !== "string" || !STATUSES.has(status)) fail();
  return {
    kind: "message.status",
    originCandidate: "external_api",
    providerEventId: env.id,
    routingKey,
    providerMessageId: req(m.id, MESSAGE_ID),
    waMessageId: opt(m.wamid, WAMID),
    externalId: optOpaque(m.externalId, 512),
    occurredAt: env.createdAt,
    status: status as NormalizedMessageStatus,
    errorCode: optOpaque(m.errorCode, 64),
    recipient: identity(m.to, recipientBsuid(m)),
  };
}

function normalizeHistory(env: Envelope): NormalizedWhatsAppEvent {
  // Ignorado no piloto: nenhum conteúdo nem identidade sai daqui.
  const inbound = env.raw.whatsappInboundMessage;
  const outbound = env.raw.whatsappMessage;
  const routingKey = isObj(inbound)
    ? routingOrNull(inbound.wabaId, inbound.to)
    : isObj(outbound)
      ? routingOrNull(outbound.wabaId, outbound.from)
      : null;
  return ignored(env, "history", routingKey);
}

function normalizeBusinessAccount(env: Envelope, codeField: string): NormalizedWhatsAppEvent {
  const account = obj(env.raw.whatsappBusinessAccount);
  return {
    kind: "account",
    scope: "business_account",
    providerType: env.type,
    providerEventId: env.id,
    providerAccountRef: req(account.id, WABA_ID),
    businessPhoneE164: null,
    routingKey: null,
    occurredAt: env.createdAt,
    code: optOpaque(account[codeField], 64),
  };
}

function normalizePhoneNumber(env: Envelope, codeFields: readonly string[]): NormalizedWhatsAppEvent {
  const phone = obj(env.raw.whatsappPhoneNumber);
  const wabaId = req(phone.wabaId, WABA_ID);
  const businessPhoneE164 = req(phone.phoneNumber, E164);
  let code: string | null = null;
  for (const field of codeFields) code ??= optOpaque(phone[field], 64);
  return {
    kind: "account",
    scope: "phone_number",
    providerType: env.type,
    providerEventId: env.id,
    providerAccountRef: wabaId,
    businessPhoneE164,
    routingKey: ycloudRoutingKey(wabaId, businessPhoneE164),
    occurredAt: env.createdAt,
    code,
  };
}

function ignored(env: Envelope, reason: "history" | "group_message" | "non_whatsapp_product", routingKey: string | null): NormalizedWhatsAppEvent {
  return { kind: "ignored", reason, providerType: env.type, providerEventId: env.id, routingKey, occurredAt: env.createdAt };
}

function unsupportedEvent(env: Envelope, routingKey: string | null): NormalizedWhatsAppEvent {
  return { kind: "unsupported", providerEventId: env.id, routingKey, occurredAt: env.createdAt, providerType: env.type };
}

function normalizeEvent(json: unknown): NormalizedWhatsAppEvent {
  const raw = obj(json);
  const id = req(raw.id, EVENT_ID);
  const type = raw.type;
  if (typeof type !== "string" || type.length > 128 || !EVENT_TYPE.test(type)) fail();
  const createdAt = optTime(raw.createTime) ?? fail();
  const env: Envelope = { id, type, createdAt, raw };

  switch (type) {
    case "whatsapp.inbound_message.received":
      return normalizeInbound(env);
    case "whatsapp.smb.message.echoes":
    case "whatsapp.smb.message.created":
      return normalizeOutboundObserved(env);
    case "whatsapp.message.updated":
      return normalizeStatus(env);
    case "whatsapp.smb.history":
      return normalizeHistory(env);
  }
  const accountField = BUSINESS_ACCOUNT_CODE[type];
  if (accountField !== undefined) return normalizeBusinessAccount(env, accountField);
  const phoneFields = PHONE_NUMBER_CODE[type];
  if (phoneFields !== undefined) return normalizePhoneNumber(env, phoneFields);
  // Conhecido sem processamento (modelos, chamadas, grupos, contatos, eco de
  // agente da Meta...) ou desconhecido com envelope válido: registrado.
  return unsupportedEvent(env, null);
}

// ---------------------------------------------------------------------
// O adaptador
// ---------------------------------------------------------------------

export class YCloudWhatsAppProvider implements WhatsAppProvider {
  readonly kind = "ycloud" as const;
  readonly #toleranceSeconds: number;

  constructor(options: { signatureToleranceSeconds?: number | undefined } = {}) {
    this.#toleranceSeconds = signatureTolerance(options.signatureToleranceSeconds);
  }

  describeCapabilities(): WhatsAppCapabilities {
    return CAPABILITIES;
  }

  verifyWebhook(input: WebhookVerificationInput): WebhookVerificationResult {
    // Só bytes: texto já decodificado pode ter perdido BOM, quebras de linha
    // ou bytes inválidos que a assinatura cobre.
    if (!isRawBodyBytes(input.rawBody)) return { ok: false, reason: "invalid_body" };
    if (input.rawBody.byteLength > YCLOUD_WEBHOOK_MAX_BYTES) return { ok: false, reason: "body_too_large" };
    if (typeof input.secret !== "string" || input.secret.length === 0) return { ok: false, reason: "invalid_secret" };

    const header = input.headers.get(YCLOUD_SIGNATURE_HEADER);
    if (header === null || header.trim() === "") return { ok: false, reason: "missing_signature" };

    const timestamps: string[] = [];
    const signatures: string[] = [];
    for (const part of header.split(",")) {
      const at = part.indexOf("=");
      if (at <= 0) continue;
      const key = part.slice(0, at).trim();
      const value = part.slice(at + 1).trim();
      if (key === "t") timestamps.push(value);
      else if (key === "s") signatures.push(value);
    }
    const [t] = timestamps;
    if (timestamps.length !== 1 || t === undefined || !/^\d{1,12}$/.test(t)) return { ok: false, reason: "malformed_signature" };
    if (signatures.length === 0 || signatures.some((s) => !/^[0-9a-fA-F]{64}$/.test(s))) {
      return { ok: false, reason: "malformed_signature" };
    }

    const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
    if (Math.abs(nowSeconds - Number(t)) > this.#toleranceSeconds) return { ok: false, reason: "stale_signature" };

    const expected = createHmac("sha256", input.secret).update(`${t}.`).update(input.rawBody).digest();
    let matched = false;
    for (const signature of signatures) {
      // Sem atalho: toda assinatura recebida passa pela comparação constante.
      if (timingSafeEqual(Buffer.from(signature, "hex"), expected)) matched = true;
    }
    if (!matched) return { ok: false, reason: "signature_mismatch" };
    return { ok: true, verified: VerifiedWebhookBody.afterSignatureCheck(input.rawBody) };
  }

  normalizeEvents(body: VerifiedWebhookBody): NormalizeEventsResult {
    if (!VerifiedWebhookBody.is(body)) return { ok: false, reason: "unverified_body" };
    const text = body.decodeUtf8Strict();
    if (text === null) return { ok: false, reason: "invalid_payload" };
    try {
      return { ok: true, events: [normalizeEvent(JSON.parse(text))] };
    } catch {
      // JSON inválido, campo fora do contrato ou identificador malformado:
      // falha controlada, sem detalhe do conteúdo.
      return { ok: false, reason: "invalid_payload" };
    }
  }

  async sendText(_request: SendTextRequest): Promise<SendResult> {
    return unsupported("sendText");
  }

  async sendTemplate(_request: SendTemplateRequest): Promise<SendResult> {
    return unsupported("sendTemplate");
  }

  async lookupMessage(_request: LookupMessageRequest): Promise<LookupMessageResult> {
    return unsupported("lookupMessage");
  }

  async fetchMedia(_request: FetchMediaRequest): Promise<FetchMediaResult> {
    return unsupported("fetchMedia");
  }
}
