/**
 * Formato dos eventos de webhook da Cloud API do WhatsApp — só os campos
 * que este projeto lê, confirmados contra a documentação oficial vigente
 * em https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 * (consultada na A7). NÃO é o envelope completo do Graph API (que carrega
 * muito além disto) — só o suficiente para normalizar mensagem/status.
 *
 * Este tipo é o contrato entre o adaptador (simulador nesta fase; webhook
 * real da Meta no marco B3) e `normalize-event.ts` — a conexão real troca
 * SÓ quem produz este JSON, nunca o que acontece depois dele.
 */
export type WhatsAppWebhookPayload = {
  object: "whatsapp_business_account";
  entry: Array<{
    id: string;
    changes: Array<{
      field: "messages";
      value: {
        messaging_product: "whatsapp";
        metadata: { display_phone_number: string; phone_number_id: string };
        contacts?: Array<{ profile: { name?: string | undefined }; wa_id: string }>;
        messages?: Array<{
          from: string;
          id: string;
          timestamp: string;
          type: "text";
          text: { body: string };
        }>;
        statuses?: Array<{
          id: string;
          status: "sent" | "delivered" | "read" | "failed";
          timestamp: string;
          recipient_id: string;
          errors?: Array<{ code: number; title: string; message?: string }>;
        }>;
      };
    }>;
  }>;
};

export type NormalizedInboundMessage = {
  kind: "inbound_message";
  phoneNumberId: string;
  fromWaIdRaw: string;
  waMessageId: string;
  timestamp: Date;
  bodyText: string;
  profileName: string | null;
};

export type NormalizedStatusEvent = {
  kind: "status_event";
  phoneNumberId: string;
  waMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: Date;
  errorCode: string | null;
  errorMessage: string | null;
};

export type NormalizedWhatsAppEvent = NormalizedInboundMessage | NormalizedStatusEvent;
