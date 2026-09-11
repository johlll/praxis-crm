import type {
  NormalizedInboundMessage,
  NormalizedStatusEvent,
  NormalizedWhatsAppEvent,
  WhatsAppWebhookPayload,
} from "./types";

/**
 * Extrai eventos normalizados, planos, de um payload no formato bruto da
 * Cloud API — sozinho, não decide nada de negócio (não cria contato, não
 * verifica permissão, não toca no banco). É a peça que o simulador E a
 * conexão real (marco B3) compartilham: os dois produzem um
 * WhatsAppWebhookPayload; só isto aqui muda de "quem produziu" para
 * "o que fazer com o conteúdo" continuar idêntico.
 *
 * Um único payload pode carregar várias mensagens e vários status ao mesmo
 * tempo (batch real da Meta) — por isso devolve uma lista, nunca um único
 * evento.
 */
export function normalizeWebhookPayload(payload: WhatsAppWebhookPayload): NormalizedWhatsAppEvent[] {
  const events: NormalizedWhatsAppEvent[] = [];

  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      const { value } = change;
      const phoneNumberId = value.metadata.phone_number_id;
      const profileByWaId = new Map((value.contacts ?? []).map((c) => [c.wa_id, c.profile.name ?? null]));

      for (const message of value.messages ?? []) {
        const inbound: NormalizedInboundMessage = {
          kind: "inbound_message",
          phoneNumberId,
          fromWaIdRaw: message.from,
          waMessageId: message.id,
          timestamp: new Date(Number(message.timestamp) * 1000),
          bodyText: message.text.body,
          profileName: profileByWaId.get(message.from) ?? null,
        };
        events.push(inbound);
      }

      for (const status of value.statuses ?? []) {
        const firstError = status.errors?.[0];
        const statusEvent: NormalizedStatusEvent = {
          kind: "status_event",
          phoneNumberId,
          waMessageId: status.id,
          status: status.status,
          timestamp: new Date(Number(status.timestamp) * 1000),
          errorCode: firstError ? String(firstError.code) : null,
          errorMessage: firstError?.message ?? firstError?.title ?? null,
        };
        events.push(statusEvent);
      }
    }
  }

  return events;
}
