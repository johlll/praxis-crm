import type { Inngest } from "inngest";

import {
  parseWhatsAppInboxReceivedEvent,
  processWhatsAppInboxEntry,
  WHATSAPP_INBOX_CONSUMER_STEP_ID,
  type WhatsAppConsumerResult,
} from "@/server/whatsapp/consumer";
import { WHATSAPP_INBOX_RECEIVED_EVENT } from "@/server/whatsapp/inbox-events";
import { handleWhatsAppInboxPurge, WHATSAPP_INBOX_PURGE_FUNCTION_CONFIG, whatsappInboxPurgeEnabled } from "@/server/whatsapp/inngest-purge";
import {
  handleWhatsAppInboxReconciler,
  WHATSAPP_RECONCILER_FUNCTION_CONFIG,
  whatsappReconcilerEnabled,
} from "@/server/whatsapp/inngest-reconciler";

/**
 * Função do Inngest que consome a inbox do WhatsApp (B3.2d-2a,
 * docs/decisoes/b3-whatsapp-real.md §20), no app PRÓPRIO
 * `praxis-crm-whatsapp` (rota `/api/inngest/whatsapp`).
 *
 * Disparada só por `praxis/whatsapp.inbox.received`. O evento é validado
 * de forma estrita (`data` exatamente `{ inboxId }`); inválido → resultado
 * fixo, sem step e sem banco.
 *
 * UM `step.run` faz todo o ciclo (claim, decisão e finalização) e devolve
 * só `{ outcome, code }`: o claim nunca é retornado, serializado, enviado
 * para fila nem reaproveitado em outra execução. Uma nova tentativa do
 * Inngest (só por falha de infraestrutura) começa de novo pelo claim.
 *
 * Não publica eventos e não usa a chave de evento.
 */

export const WHATSAPP_INBOX_CONSUMER_FUNCTION_CONFIG = {
  id: "b3-whatsapp-inbox-consumer" as const,
  name: "B3 — consumidor da inbox do WhatsApp",
  // Só falha de infraestrutura chega aqui; o resto é finalizado no banco.
  retries: 3 as const,
  // Teto atual do plano Hobby da organização: acima dele o Inngest recusa a
  // sincronização do app. Aumentar exige confirmar antes a mudança de plano (§28.14).
  concurrency: { limit: 5 },
  triggers: [{ event: WHATSAPP_INBOX_RECEIVED_EVENT }],
};

type Step = { run: (id: string, fn: () => Promise<WhatsAppConsumerResult>) => Promise<unknown> };

export async function handleWhatsAppInboxReceived({ event, step }: { event: unknown; step: Step }) {
  const parsed = parseWhatsAppInboxReceivedEvent(event);
  if (!parsed.ok) return { outcome: "invalid_event", code: null } as const;
  return step.run(WHATSAPP_INBOX_CONSUMER_STEP_ID, () => processWhatsAppInboxEntry({ inboxId: parsed.inboxId }));
}

/** O consumidor sempre; o reconciliador (B3.2e) e o expurgo (§28.15), cada um
 * só com a sua variável própria. */
export function whatsappInngestFunctions(client: Inngest) {
  const consumer = client.createFunction(WHATSAPP_INBOX_CONSUMER_FUNCTION_CONFIG, async ({ event, step }) => handleWhatsAppInboxReceived({ event, step }));
  const reconciler = whatsappReconcilerEnabled()
    ? [client.createFunction(WHATSAPP_RECONCILER_FUNCTION_CONFIG, async ({ step }) => handleWhatsAppInboxReconciler({ step }))]
    : [];
  const purge = whatsappInboxPurgeEnabled()
    ? [client.createFunction(WHATSAPP_INBOX_PURGE_FUNCTION_CONFIG, async ({ step }) => handleWhatsAppInboxPurge({ step }))]
    : [];
  return [consumer, ...reconciler, ...purge];
}
