import { Inngest } from "inngest";

import { getIngestConfig } from "@/server/ingest/config";

/**
 * Publicação do evento no Inngest (A11).
 *
 * API conferida na documentação oficial antes de escrever:
 * `new Inngest({ id })`, `send({ id, name, data })`, onde `id` é a chave
 * de deduplicação do próprio Inngest (24 h).
 *
 * `webhook_event_id` é o identificador estável enviado: se o envio der
 * certo mas a resposta se perder, o reconciliador republica o MESMO id e
 * o Inngest não duplica a execução. Passadas as 24 h de deduplicação, uma
 * republicação gera execução nova — e isso continua seguro, porque o
 * worker é idempotente por construção (o evento já estará `processed`).
 *
 * A publicação acontece DEPOIS do commit da ingestão. Falhar aqui não
 * desfaz nada: a outbox já está gravada e o cron recupera.
 */

export const FORM_EVENT_NAME = "praxis/form.submission.received";

export type EventPublisher = (input: { webhookEventId: string; workspaceId: string }) => Promise<void>;

let cachedClient: Inngest | undefined;

/**
 * Construir o cliente NÃO exige configuração: `new Inngest({ id })` é
 * inerte, e o SDK lê as chaves do ambiente na hora de enviar ou servir.
 *
 * Isso é deliberado e foi um achado do build: exigir a configuração aqui
 * fazia o Next falhar ao coletar os dados da rota `/api/inngest` em tempo
 * de BUILD, derrubando o aplicativo inteiro num ambiente que ainda não
 * tem as variáveis. A falha fechada continua existindo — só que no lugar
 * certo: na PUBLICAÇÃO e no atendimento da rota, por requisição.
 */
export function inngestClient(): Inngest {
  if (cachedClient) return cachedClient;
  cachedClient = new Inngest({ id: "praxis-crm" });
  return cachedClient;
}

export const inngestPublisher: EventPublisher = async ({ webhookEventId, workspaceId }) => {
  // Falha fechada: sem INNGEST_EVENT_KEY/SIGNING_KEY, nada é publicado.
  getIngestConfig();
  await inngestClient().send({
    id: webhookEventId,
    name: FORM_EVENT_NAME,
    data: { webhookEventId, workspaceId },
  });
};

/** Só para teste: descarta o cliente memoizado. */
export function resetInngestClientCache(): void {
  cachedClient = undefined;
}
