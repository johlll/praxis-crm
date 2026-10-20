/**
 * Contrato do provedor de WhatsApp (B3.1, docs/decisoes/b3-whatsapp-real.md
 * §3, §6 B3.1).
 *
 * Tipos PRÓPRIOS do CRM: nada aqui vem do formato da Meta nem da YCloud.
 * Cada adaptador traduz o formato do seu provedor para estes tipos, e o
 * domínio só conhece estes tipos.
 *
 * Nesta etapa só existe o provedor SIMULADO. Capacidades que ainda não
 * existem respondem `unsupported` explicitamente — nunca um sucesso
 * fingido.
 */

export type WhatsAppProviderKind = "simulated" | "ycloud" | "meta";

export const WHATSAPP_CAPABILITIES = [
  "verifyWebhook",
  "normalizeEvents",
  "sendText",
  "sendTemplate",
  "lookupMessage",
  "fetchMedia",
] as const;

export type WhatsAppCapability = (typeof WHATSAPP_CAPABILITIES)[number];

export type WhatsAppCapabilities = Readonly<Record<WhatsAppCapability, boolean>>;

/** Resposta de uma capacidade que este provedor (ainda) não tem. */
export type UnsupportedCapability = {
  ok: false;
  reason: "unsupported";
  capability: WhatsAppCapability;
};

export function unsupported(capability: WhatsAppCapability): UnsupportedCapability {
  return { ok: false, reason: "unsupported", capability };
}

// ---------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------

export type WebhookVerificationInput = {
  /** Corpo BRUTO, exatamente como chegou: a assinatura é sobre os bytes. */
  rawBody: string;
  headers: Headers;
  /** Segredo do canal, já decifrado pelo servidor. */
  secret: string;
  nowMs?: number;
};

export type WebhookVerificationResult =
  | { ok: true }
  | { ok: false; reason: "missing_signature" | "malformed_signature" | "stale_signature" | "signature_mismatch" }
  | UnsupportedCapability;

// ---------------------------------------------------------------------
// Eventos normalizados
// ---------------------------------------------------------------------

export type NormalizedMessageStatus = "sent" | "delivered" | "read" | "failed";

export type NormalizedInboundText = {
  kind: "message.inbound";
  providerEventId: string;
  routingKey: string;
  providerMessageId: string;
  occurredAt: Date;
  senderPhoneE164: string;
  text: string;
};

export type NormalizedStatusUpdate = {
  kind: "message.status";
  providerEventId: string;
  routingKey: string;
  providerMessageId: string;
  occurredAt: Date;
  status: NormalizedMessageStatus;
  errorCode: string | null;
};

/** Evento reconhecido como válido, mas de um tipo que o CRM ainda não
 * processa: registrado, nunca descartado em silêncio. */
export type NormalizedUnsupportedEvent = {
  kind: "unsupported";
  providerEventId: string;
  routingKey: string;
  occurredAt: Date;
  providerType: string;
};

export type NormalizedWhatsAppEvent = NormalizedInboundText | NormalizedStatusUpdate | NormalizedUnsupportedEvent;

export type NormalizeEventsResult =
  | { ok: true; events: NormalizedWhatsAppEvent[] }
  | { ok: false; reason: "invalid_payload" }
  | UnsupportedCapability;

// ---------------------------------------------------------------------
// Saída, consulta e mídia (só declaradas nesta etapa)
// ---------------------------------------------------------------------

export type SendTextRequest = {
  routingKey: string;
  recipientPhoneE164: string;
  text: string;
  /** Correlação com o registro interno. Não é chave de idempotência. */
  correlationId: string;
};

export type SendTemplateRequest = {
  routingKey: string;
  recipientPhoneE164: string;
  templateName: string;
  templateLanguage: string;
  parameters: string[];
  correlationId: string;
};

export type SendResult =
  | { ok: true; providerMessageId: string; state: "accepted" }
  | { ok: false; reason: "rejected"; errorCode: string }
  | { ok: false; reason: "uncertain" }
  | UnsupportedCapability;

export type LookupMessageRequest = { routingKey: string; providerMessageId: string };

export type LookupMessageResult =
  | { ok: true; status: NormalizedMessageStatus | "accepted" }
  | { ok: false; reason: "not_found" }
  | UnsupportedCapability;

export type FetchMediaRequest = { routingKey: string; providerMediaRef: string };

export type FetchMediaResult =
  | { ok: true; mimeType: string; bytes: Uint8Array; sha256Hex: string }
  | { ok: false; reason: "expired" | "not_found" }
  | UnsupportedCapability;

// ---------------------------------------------------------------------
// O contrato
// ---------------------------------------------------------------------

export interface WhatsAppProvider {
  readonly kind: WhatsAppProviderKind;
  describeCapabilities(): WhatsAppCapabilities;
  verifyWebhook(input: WebhookVerificationInput): WebhookVerificationResult;
  normalizeEvents(rawBody: string): NormalizeEventsResult;
  sendText(request: SendTextRequest): Promise<SendResult>;
  sendTemplate(request: SendTemplateRequest): Promise<SendResult>;
  lookupMessage(request: LookupMessageRequest): Promise<LookupMessageResult>;
  fetchMedia(request: FetchMediaRequest): Promise<FetchMediaResult>;
}
