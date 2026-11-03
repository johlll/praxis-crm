import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";
import { whatsappInngestClient, WhatsAppInngestConfigError } from "@/server/whatsapp/inngest";

/**
 * Evento INTERNO publicado depois que uma entrega foi gravada na caixa de
 * entrada cifrada (B3.2c, docs/decisoes/b3-whatsapp-real.md §18.3).
 *
 * Contrato exato: `{ id, name: "praxis/whatsapp.inbox.received", data: { inboxId } }`.
 * Nada de workspace, canal, ambiente, provedor, routing key ou tentativa no
 * `data`: o consumidor (B3.2d) resolve tudo pelo `inboxId` no banco e nunca
 * confia em contexto recebido no evento.
 *
 * O `id` é a chave de deduplicação do Inngest, que guarda sem disparar nada um
 * evento com o id repetido em 24 horas (§28.8). Por isso quem o constrói é sempre
 * este módulo, nunca o chamador: `inboxId` na publicação inicial (a rota do
 * webhook) e `inboxId:r<tentativa>` em cada reserva do reconciliador. É só
 * transporte: contra efeito duplicado valem o claim, o ledger e os efeitos.
 *
 * Cliente próprio do WhatsApp (`@/server/whatsapp/inngest`). FALHA FECHADA:
 * sem `WHATSAPP_INNGEST_EVENT_KEY`, nada é enviado. A gravação já aconteceu
 * e a entrada continua pendente para o reconciliador (B3.2e).
 */

export const WHATSAPP_INBOX_RECEIVED_EVENT = "praxis/whatsapp.inbox.received";

/** O maior valor de `reconcile_attempts` (integer do Postgres). */
export const WHATSAPP_RECONCILIATION_ATTEMPT_MAX = 2147483647;

export const whatsappReconciliationAttemptSchema = z.number().int().min(1).max(WHATSAPP_RECONCILIATION_ATTEMPT_MAX);

export type WhatsAppInboxEventErrorCode = "invalid_inbox_id" | "invalid_reconciliation_attempt" | "inbox_event_not_configured" | "inbox_event_publish_failed";

export class WhatsAppInboxEventError extends Error {
  constructor(public readonly code: WhatsAppInboxEventErrorCode) {
    super(code);
    this.name = "WhatsAppInboxEventError";
  }
}

/** Só o que o publicador produz: `inboxId` ou `inboxId:r<inteiro canônico>`, sem
 * sinal nem zero à esquerda, de 1 até o máximo. Comparação exata com o `data`. */
export function isWhatsAppInboxEventIdFor(id: string, inboxId: string): boolean {
  if (id === inboxId) return true;
  const prefix = `${inboxId}:r`;
  if (!id.startsWith(prefix)) return false;
  const attempt = id.slice(prefix.length);
  return /^[1-9][0-9]{0,9}$/.test(attempt) && Number(attempt) <= WHATSAPP_RECONCILIATION_ATTEMPT_MAX;
}

export async function publishWhatsAppInboxReceived(params: { inboxId: string; reconciliationAttempt?: number }): Promise<void> {
  const inboxId = params?.inboxId;
  if (typeof inboxId !== "string" || !uuidSchema.safeParse(inboxId).success) throw new WhatsAppInboxEventError("invalid_inbox_id");
  const attempt = params.reconciliationAttempt;
  if (attempt !== undefined && !whatsappReconciliationAttemptSchema.safeParse(attempt).success) throw new WhatsAppInboxEventError("invalid_reconciliation_attempt");

  let client;
  try {
    client = whatsappInngestClient();
  } catch (error) {
    if (error instanceof WhatsAppInngestConfigError) throw new WhatsAppInboxEventError("inbox_event_not_configured");
    throw new WhatsAppInboxEventError("inbox_event_publish_failed");
  }
  try {
    await client.send({ id: attempt === undefined ? inboxId : `${inboxId}:r${attempt}`, name: WHATSAPP_INBOX_RECEIVED_EVENT, data: { inboxId } });
  } catch {
    throw new WhatsAppInboxEventError("inbox_event_publish_failed");
  }
}
