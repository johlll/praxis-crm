import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import {
  unsupported,
  type FetchMediaRequest,
  type FetchMediaResult,
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
 *    de `<t>.<corpo bruto>` com o segredo do canal) — não copia o formato
 *    de nenhum provedor real;
 *  - normaliza um payload simulado para os tipos do contrato.
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

export function signSimulatedWebhook(rawBody: string, secret: string, timestampSeconds: number): string {
  const signature = createHmac("sha256", secret).update(`${timestampSeconds}.`).update(rawBody, "utf8").digest("hex");
  return `t=${timestampSeconds},s=${signature}`;
}

const e164 = z.string().regex(/^\+[1-9][0-9]{7,14}$/);
const isoDate = z.string().datetime({ offset: true });

const simulatedEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message.inbound"),
    id: z.string().min(1).max(128),
    routingKey: z.string().min(1).max(128),
    messageId: z.string().min(1).max(128),
    occurredAt: isoDate,
    from: e164,
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

export class SimulatedWhatsAppProvider implements WhatsAppProvider {
  readonly kind = "simulated" as const;

  describeCapabilities(): WhatsAppCapabilities {
    return CAPABILITIES;
  }

  verifyWebhook(input: WebhookVerificationInput): WebhookVerificationResult {
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

    const expected = createHmac("sha256", input.secret).update(`${t}.`).update(input.rawBody, "utf8").digest();
    const received = Buffer.from(s, "hex");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      return { ok: false, reason: "signature_mismatch" };
    }
    return { ok: true };
  }

  normalizeEvents(rawBody: string): NormalizeEventsResult {
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return { ok: false, reason: "invalid_payload" };
    }
    const parsed = simulatedPayloadSchema.safeParse(json);
    if (!parsed.success) return { ok: false, reason: "invalid_payload" };

    const events: NormalizedWhatsAppEvent[] = parsed.data.events.map((event) => {
      switch (event.type) {
        case "message.inbound":
          return {
            kind: "message.inbound",
            providerEventId: event.id,
            routingKey: event.routingKey,
            providerMessageId: event.messageId,
            occurredAt: new Date(event.occurredAt),
            senderPhoneE164: event.from,
            text: event.text,
          };
        case "message.status":
          return {
            kind: "message.status",
            providerEventId: event.id,
            routingKey: event.routingKey,
            providerMessageId: event.messageId,
            occurredAt: new Date(event.occurredAt),
            status: event.status,
            errorCode: event.errorCode ?? null,
          };
        case "other":
          return {
            kind: "unsupported",
            providerEventId: event.id,
            routingKey: event.routingKey,
            occurredAt: new Date(event.occurredAt),
            providerType: event.providerType,
          };
      }
    });
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
