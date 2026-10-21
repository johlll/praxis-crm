import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import {
  isRawBodyBytes,
  unsupported,
  VerifiedWebhookBody,
  whatsappContactIdentity,
  type FetchMediaRequest,
  type FetchMediaResult,
  type InspectEnvelopeResult,
  type LookupMessageRequest,
  type LookupMessageResult,
  type NormalizedWhatsAppEvent,
  type NormalizeEventsResult,
  type SendResult,
  type SendTemplateRequest,
  type SendTextRequest,
  type WebhookVerificationInput,
  type WebhookVerificationResult,
  type WhatsAppCapabilities,
  type WhatsAppProvider,
} from "@/server/whatsapp/provider/contract";

/**
 * Provedor SIMULADO do WhatsApp (B3.1). Não fala com ninguém: serve para
 * provar, com testes, o contrato que o adaptador real vai cumprir.
 *
 * O que ele faz de verdade:
 *  - verifica a assinatura de um webhook SIMULADO (esquema próprio do
 *    simulador, `X-Praxis-Simulated-Signature: t=<s>,s=<hex>`, HMAC-SHA256
 *    de `<t>.` seguido dos BYTES exatos do corpo, com o segredo do canal) —
 *    não copia o formato de nenhum provedor real;
 *  - lê só o envelope mínimo (versão, id e tipo de UM evento), sem
 *    interpretar o conteúdo, para a caixa de entrada (B3.2b);
 *  - normaliza, só depois da assinatura, um payload simulado para os tipos
 *    do contrato (UTF-8 estrita; contato por telefone, BSUID ou ambos).
 *
 * O que ele NÃO faz: enviar, consultar mensagem, buscar mídia. Essas
 * capacidades respondem `unsupported` — nunca um sucesso fingido.
 */

export const SIMULATED_SIGNATURE_HEADER = "X-Praxis-Simulated-Signature";
export const SIMULATED_SIGNATURE_TOLERANCE_SECONDS = 300;

const CAPABILITIES: WhatsAppCapabilities = Object.freeze({
  verifyWebhook: true,
  normalizeEvents: true,
  sendText: false,
  sendTemplate: false,
  lookupMessage: false,
  fetchMedia: false,
});

export function signSimulatedWebhook(rawBody: Uint8Array, secret: string, timestampSeconds: number): string {
  const signature = createHmac("sha256", secret).update(`${timestampSeconds}.`).update(rawBody).digest("hex");
  return `t=${timestampSeconds},s=${signature}`;
}

const isoDate = z.string().datetime({ offset: true });

const simulatedEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message.inbound"),
    id: z.string().min(1).max(128),
    routingKey: z.string().min(1).max(128),
    messageId: z.string().min(1).max(128),
    occurredAt: isoDate,
    // Telefone, BSUID ou os dois; a identidade é conferida na normalização.
    from: z.string().max(32).optional(),
    fromBsuid: z.string().max(128).optional(),
    text: z.string().min(1).max(4096),
  }),
  z.object({
    type: z.literal("message.status"),
    id: z.string().min(1).max(128),
    routingKey: z.string().min(1).max(128),
    messageId: z.string().min(1).max(128),
    occurredAt: isoDate,
    status: z.enum(["sent", "delivered", "read", "failed"]),
    errorCode: z.string().max(64).nullable().optional(),
  }),
  z.object({
    type: z.literal("other"),
    id: z.string().min(1).max(128),
    routingKey: z.string().min(1).max(128),
    occurredAt: isoDate,
    providerType: z.string().min(1).max(64),
  }),
]);

const simulatedPayloadSchema = z.object({
  version: z.literal(1),
  events: z.array(simulatedEventSchema).min(1).max(100),
});

const ENVELOPE_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ENVELOPE_EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

/** Envelope mínimo do simulador: `version`, e `id` e `type` do ÚNICO evento
 * da lista. Nada do conteúdo do evento é lido. */
function inspectSimulatedEnvelope(json: unknown): InspectEnvelopeResult {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return { ok: false, reason: "invalid_envelope" };
  const { version, events } = json as Record<string, unknown>;
  if (typeof version !== "number") return { ok: false, reason: "invalid_envelope" };
  if (version !== 1) return { ok: false, reason: "unsupported_envelope_version" };
  if (!Array.isArray(events) || events.length === 0) return { ok: false, reason: "invalid_envelope" };
  if (events.length > 1) return { ok: false, reason: "batch_not_supported" };
  const event: unknown = events[0];
  if (typeof event !== "object" || event === null || Array.isArray(event)) return { ok: false, reason: "invalid_envelope" };
  const { id, type } = event as Record<string, unknown>;
  if (typeof id !== "string" || !ENVELOPE_EVENT_ID.test(id)) return { ok: false, reason: "invalid_envelope" };
  if (typeof type !== "string" || type.length > 128 || !ENVELOPE_EVENT_TYPE.test(type)) return { ok: false, reason: "invalid_envelope" };
  return { ok: true, envelope: Object.freeze({ providerEventId: id, providerEventType: type, envelopeVersion: "1", eventCount: 1 }) };
}

export class SimulatedWhatsAppProvider implements WhatsAppProvider {
  readonly kind = "simulated" as const;

  describeCapabilities(): WhatsAppCapabilities {
    return CAPABILITIES;
  }

  verifyWebhook(input: WebhookVerificationInput): WebhookVerificationResult {
    // Só bytes: texto já decodificado pode ter perdido BOM, quebras de linha
    // ou bytes inválidos que a assinatura cobre.
    if (!isRawBodyBytes(input.rawBody)) return { ok: false, reason: "invalid_body" };
    const header = input.headers.get(SIMULATED_SIGNATURE_HEADER);
    if (!header) return { ok: false, reason: "missing_signature" };

    const parts = header.split(",").map((part) => part.trim().split("="));
    const timestamps = parts.filter(([k]) => k === "t").map(([, v]) => v);
    const signatures = parts.filter(([k]) => k === "s").map(([, v]) => v);
    if (timestamps.length !== 1 || signatures.length !== 1) return { ok: false, reason: "malformed_signature" };
    const [t] = timestamps;
    const [s] = signatures;
    if (!t || !/^\d{1,12}$/.test(t) || !s || !/^[0-9a-f]{64}$/.test(s)) {
      return { ok: false, reason: "malformed_signature" };
    }

    const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
    if (Math.abs(nowSeconds - Number(t)) > SIMULATED_SIGNATURE_TOLERANCE_SECONDS) {
      return { ok: false, reason: "stale_signature" };
    }

    const expected = createHmac("sha256", input.secret).update(`${t}.`).update(input.rawBody).digest();
    const received = Buffer.from(s, "hex");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      return { ok: false, reason: "signature_mismatch" };
    }
    return { ok: true, verified: VerifiedWebhookBody.afterSignatureCheck(input.rawBody) };
  }

  inspectEnvelope(body: VerifiedWebhookBody): InspectEnvelopeResult {
    if (!VerifiedWebhookBody.is(body)) return { ok: false, reason: "unverified_body" };
    const text = body.decodeUtf8Strict();
    if (text === null) return { ok: false, reason: "invalid_json" };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, reason: "invalid_json" };
    }
    return inspectSimulatedEnvelope(json);
  }

  normalizeEvents(body: VerifiedWebhookBody): NormalizeEventsResult {
    if (!VerifiedWebhookBody.is(body)) return { ok: false, reason: "unverified_body" };
    const text = body.decodeUtf8Strict();
    if (text === null) return { ok: false, reason: "invalid_payload" };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, reason: "invalid_payload" };
    }
    const parsed = simulatedPayloadSchema.safeParse(json);
    if (!parsed.success) return { ok: false, reason: "invalid_payload" };

    const events: NormalizedWhatsAppEvent[] = [];
    for (const event of parsed.data.events) {
      switch (event.type) {
        case "message.inbound": {
          const sender = whatsappContactIdentity({ phoneE164: event.from, bsuid: event.fromBsuid });
          if (!sender) return { ok: false, reason: "invalid_payload" };
          events.push({
            kind: "message.inbound",
            originCandidate: "inbound",
            providerEventId: event.id,
            routingKey: event.routingKey,
            providerMessageId: event.messageId,
            waMessageId: null,
            occurredAt: new Date(event.occurredAt),
            sender,
            senderProfileName: null,
            contentKind: "text",
            text: event.text,
          });
          break;
        }
        case "message.status":
          events.push({
            kind: "message.status",
            originCandidate: "external_api",
            providerEventId: event.id,
            routingKey: event.routingKey,
            providerMessageId: event.messageId,
            waMessageId: null,
            externalId: null,
            occurredAt: new Date(event.occurredAt),
            status: event.status,
            errorCode: event.errorCode ?? null,
            recipient: null,
            providerCost: null,
          });
          break;
        case "other":
          events.push({
            kind: "unsupported",
            providerEventId: event.id,
            routingKey: event.routingKey,
            occurredAt: new Date(event.occurredAt),
            providerType: event.providerType,
          });
          break;
      }
    }
    return { ok: true, events };
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
