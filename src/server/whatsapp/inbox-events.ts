import { uuidSchema } from "@/lib/uuid";
import { whatsappInngestClient, WhatsAppInngestConfigError } from "@/server/whatsapp/inngest";

/**
 * Evento INTERNO publicado depois que uma entrega foi gravada na caixa de
 * entrada cifrada (B3.2c, docs/decisoes/b3-whatsapp-real.md §18.3).
 *
 * Contrato exato: `{ id: inboxId, name: "praxis/whatsapp.inbox.received",
 * data: { inboxId } }`. Nada de workspace, canal, ambiente, provedor ou
 * routing key: o consumidor (B3.2d) resolve tudo pelo `inboxId` no banco e
 * nunca confia em contexto recebido no evento. O `id` do evento é o id da
 * inbox: a chave de deduplicação do Inngest, então republicar a mesma
 * entrada gera exatamente o mesmo evento.
 *
 * Cliente próprio do WhatsApp (`@/server/whatsapp/inngest`). FALHA FECHADA:
 * sem `WHATSAPP_INNGEST_EVENT_KEY`, nada é enviado. A gravação já aconteceu
 * e a entrada continua pendente para o reconciliador (B3.2e).
 */

export const WHATSAPP_INBOX_RECEIVED_EVENT = "praxis/whatsapp.inbox.received";

export type WhatsAppInboxEventErrorCode = "invalid_inbox_id" | "inbox_event_not_configured" | "inbox_event_publish_failed";

export class WhatsAppInboxEventError extends Error {
  constructor(public readonly code: WhatsAppInboxEventErrorCode) {
    super(code);
    this.name = "WhatsAppInboxEventError";
  }
}

export async function publishWhatsAppInboxReceived(params: { inboxId: string }): Promise<void> {
  const inboxId = params?.inboxId;
  if (typeof inboxId !== "string" || !uuidSchema.safeParse(inboxId).success) throw new WhatsAppInboxEventError("invalid_inbox_id");

  let client;
  try {
    client = whatsappInngestClient();
  } catch (error) {
    if (error instanceof WhatsAppInngestConfigError) throw new WhatsAppInboxEventError("inbox_event_not_configured");
    throw new WhatsAppInboxEventError("inbox_event_publish_failed");
  }
  try {
    await client.send({ id: inboxId, name: WHATSAPP_INBOX_RECEIVED_EVENT, data: { inboxId } });
  } catch {
    throw new WhatsAppInboxEventError("inbox_event_publish_failed");
  }
}
