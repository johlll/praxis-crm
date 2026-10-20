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
// Identidade do contato
// ---------------------------------------------------------------------

/**
 * Identidade do contato no WhatsApp: telefone, BSUID (identificador do
 * usuário por empresa, que a Meta pode mandar SEM telefone), ou os dois —
 * nunca nenhum (docs/decisoes/b3-whatsapp-real.md §4). O domínio não pode
 * presumir que todo contato tem telefone.
 */
export type WhatsAppContactIdentity =
  | { readonly kind: "phone"; readonly phoneE164: string; readonly bsuid: null }
  | { readonly kind: "bsuid"; readonly phoneE164: null; readonly bsuid: string }
  | { readonly kind: "phone_and_bsuid"; readonly phoneE164: string; readonly bsuid: string };

const E164 = /^\+[1-9][0-9]{7,14}$/;
/** Formato exato do BSUID a confirmar na B3.2; por ora, um identificador
 * opaco, sem espaços, de até 128 caracteres. */
const BSUID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Monta a identidade, ou `null` quando não há nenhum identificador válido.
 * FALHA FECHADA: um identificador presente e malformado invalida tudo, em
 * vez de ser ignorado. */
export function whatsappContactIdentity(input: {
  phoneE164?: string | null | undefined;
  bsuid?: string | null | undefined;
}): WhatsAppContactIdentity | null {
  const phone = input.phoneE164 ? input.phoneE164 : null;
  const bsuid = input.bsuid ? input.bsuid : null;
  if (phone !== null && !E164.test(phone)) return null;
  if (bsuid !== null && !BSUID.test(bsuid)) return null;
  if (phone !== null && bsuid !== null) return Object.freeze({ kind: "phone_and_bsuid", phoneE164: phone, bsuid });
  if (phone !== null) return Object.freeze({ kind: "phone", phoneE164: phone, bsuid: null });
  if (bsuid !== null) return Object.freeze({ kind: "bsuid", phoneE164: null, bsuid });
  return null;
}

// ---------------------------------------------------------------------
// Webhook: bytes → assinatura → decodificação e normalização
// ---------------------------------------------------------------------

/**
 * Corpo do webhook cuja assinatura JÁ foi conferida sobre os bytes exatos.
 * Só existe por `afterSignatureCheck`, que o adaptador chama depois de
 * conferir; `normalizeEvents` recusa qualquer outra coisa. Guarda uma cópia
 * dos bytes: mexer no buffer original depois não muda o que foi verificado.
 */
export class VerifiedWebhookBody {
  readonly #bytes: Uint8Array;

  private constructor(bytes: Uint8Array) {
    this.#bytes = bytes.slice();
    Object.freeze(this);
  }

  static afterSignatureCheck(bytes: Uint8Array): VerifiedWebhookBody {
    return new VerifiedWebhookBody(bytes);
  }

  static is(value: unknown): value is VerifiedWebhookBody {
    return typeof value === "object" && value !== null && #bytes in value;
  }

  get byteLength(): number {
    return this.#bytes.byteLength;
  }

  /** UTF-8 ESTRITA: byte inválido → `null`; BOM não é removido em silêncio. */
  decodeUtf8Strict(): string | null {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(this.#bytes);
    } catch {
      return null;
    }
  }
}

export function isRawBodyBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array || Object.prototype.toString.call(value) === "[object Uint8Array]";
}

export type WebhookVerificationInput = {
  /** Bytes EXATOS do corpo, como chegaram — nunca texto já decodificado. */
  rawBody: Uint8Array;
  headers: Headers;
  /** Segredo do canal, já decifrado pelo servidor. */
  secret: string;
  nowMs?: number;
};

export type WebhookVerificationResult =
  | { ok: true; verified: VerifiedWebhookBody }
  | {
      ok: false;
      reason: "invalid_body" | "missing_signature" | "malformed_signature" | "stale_signature" | "signature_mismatch";
    }
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
  sender: WhatsAppContactIdentity;
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
  | { ok: false; reason: "unverified_body" | "invalid_payload" }
  | UnsupportedCapability;

// ---------------------------------------------------------------------
// Saída, consulta e mídia (só declaradas nesta etapa)
// ---------------------------------------------------------------------

export type SendTextRequest = {
  routingKey: string;
  recipient: WhatsAppContactIdentity;
  text: string;
  /** Correlação com o registro interno. Não é chave de idempotência. */
  correlationId: string;
};

export type SendTemplateRequest = {
  routingKey: string;
  recipient: WhatsAppContactIdentity;
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
  /** Confere a assinatura sobre os bytes; só o sucesso devolve o corpo
   * verificado. */
  verifyWebhook(input: WebhookVerificationInput): WebhookVerificationResult;
  /** Decodifica e normaliza SÓ um corpo devolvido por `verifyWebhook`. */
  normalizeEvents(body: VerifiedWebhookBody): NormalizeEventsResult;
  sendText(request: SendTextRequest): Promise<SendResult>;
  sendTemplate(request: SendTemplateRequest): Promise<SendResult>;
  lookupMessage(request: LookupMessageRequest): Promise<LookupMessageResult>;
  fetchMedia(request: FetchMediaRequest): Promise<FetchMediaResult>;
}
