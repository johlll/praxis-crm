import type { WhatsAppWebhookPayload } from "./types";

/**
 * Simulador interno — monta um payload no MESMO formato da Cloud API real
 * (ver types.ts), só que fabricado aqui em vez de recebido de um webhook
 * de verdade. Nada aqui toca o banco; quem consome o resultado é sempre
 * `normalizeWebhookPayload()` (adaptador, compartilhado com a conexão
 * real futura), nunca a Server Action direto.
 *
 * Suporta os 4 cenários pedidos: número conhecido ou desconhecido, o
 * MESMO evento repetido (basta chamar de novo com o mesmo waMessageId —
 * quem decide "repetido" é o banco, por idempotência, nunca o simulador),
 * status de entrega/leitura/falha, e entrega fora de ordem (o timestamp do
 * evento é sempre o que o CHAMADOR decide, nunca "agora" — permite montar
 * um evento "tardio" de propósito).
 */

export function buildSimulatedInboundMessage(params: {
  phoneNumberId: string;
  fromWaId: string;
  waMessageId: string;
  bodyText: string;
  profileName?: string | undefined;
  timestamp?: Date | undefined;
}): WhatsAppWebhookPayload {
  const timestamp = params.timestamp ?? new Date();
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: `simulated-waba-${params.phoneNumberId}`,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: params.phoneNumberId, phone_number_id: params.phoneNumberId },
              contacts: [{ profile: { name: params.profileName }, wa_id: params.fromWaId }],
              messages: [
                {
                  from: params.fromWaId,
                  id: params.waMessageId,
                  timestamp: String(Math.floor(timestamp.getTime() / 1000)),
                  type: "text",
                  text: { body: params.bodyText },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export function buildSimulatedStatusEvent(params: {
  phoneNumberId: string;
  waMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  recipientWaId: string;
  timestamp?: Date | undefined;
  errorCode?: number | undefined;
  errorMessage?: string | undefined;
}): WhatsAppWebhookPayload {
  const timestamp = params.timestamp ?? new Date();
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: `simulated-waba-${params.phoneNumberId}`,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: params.phoneNumberId, phone_number_id: params.phoneNumberId },
              statuses: [
                {
                  id: params.waMessageId,
                  status: params.status,
                  timestamp: String(Math.floor(timestamp.getTime() / 1000)),
                  recipient_id: params.recipientWaId,
                  ...(params.status === "failed"
                    ? { errors: [{ code: params.errorCode ?? 0, title: params.errorMessage ?? "Falha simulada" }] }
                    : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}
