import { uuidSchema } from "@/lib/uuid";
import { inngestClient } from "@/server/ingest/publisher";
import { isTrustedWhatsAppChannelContext, type ResolvedWhatsAppChannelContext } from "@/server/whatsapp/admin/channels";
import { getWhatsAppEnvironment } from "@/server/whatsapp/environment";

/**
 * Evento INTERNO publicado depois que uma entrega foi gravada na caixa de
 * entrada cifrada (B3.2c, docs/decisoes/b3-whatsapp-real.md §18).
 *
 * Só identificadores: o consumidor (B3.2d) lê e decifra a entrada pela
 * inbox, com o contexto confiável. O `id` do evento é o id da inbox: é a
 * chave de deduplicação do Inngest, então republicar a mesma entrada não
 * duplica a execução.
 *
 * FALHA FECHADA: sem `INNGEST_EVENT_KEY`, nada é enviado. A gravação já
 * aconteceu e a entrada continua pendente para o reconciliador (B3.2e).
 */

export const WHATSAPP_INBOX_RECEIVED_EVENT = "praxis/whatsapp.inbox.received";

export type WhatsAppInboxEventErrorCode =
  | "channel_context_untrusted"
  | "channel_environment_mismatch"
  | "invalid_inbox_id"
  | "inbox_event_not_configured"
  | "inbox_event_publish_failed";

export class WhatsAppInboxEventError extends Error {
  constructor(public readonly code: WhatsAppInboxEventErrorCode) {
    super(code);
    this.name = "WhatsAppInboxEventError";
  }
}

export async function publishWhatsAppInboxReceived(params: {
  channel: ResolvedWhatsAppChannelContext;
  inboxId: string;
}): Promise<void> {
  const { channel, inboxId } = params;
  if (!isTrustedWhatsAppChannelContext(channel)) throw new WhatsAppInboxEventError("channel_context_untrusted");
  if (channel.environment !== getWhatsAppEnvironment()) throw new WhatsAppInboxEventError("channel_environment_mismatch");
  if (!uuidSchema.safeParse(inboxId).success) throw new WhatsAppInboxEventError("invalid_inbox_id");
  const eventKey = process.env.INNGEST_EVENT_KEY;
  if (typeof eventKey !== "string" || eventKey.trim() === "") throw new WhatsAppInboxEventError("inbox_event_not_configured");

  try {
    await inngestClient().send({
      id: inboxId,
      name: WHATSAPP_INBOX_RECEIVED_EVENT,
      data: {
        inboxId,
        channelId: channel.channelId,
        workspaceId: channel.workspaceId,
        environment: channel.environment,
        provider: channel.provider,
      },
    });
  } catch {
    throw new WhatsAppInboxEventError("inbox_event_publish_failed");
  }
}
