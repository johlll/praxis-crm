import { NonRetriableError } from "inngest";

import { isWhatsAppEnvironmentConfigured } from "@/server/whatsapp/environment";
import { purgeExpiredWhatsAppWebhookInbox } from "@/server/whatsapp/inbox";

/**
 * Expurgo agendado da inbox do WhatsApp (docs/decisoes/b3-whatsapp-real.md
 * §28.15), no app PRÓPRIO `praxis-crm-whatsapp` (rota `/api/inngest/whatsapp`).
 * Sem nenhum cliente, validador ou variável da A11 ou da agenda.
 *
 * Só chama a operação existente (`purgeExpiredWhatsAppWebhookInbox`, §17.6): o
 * banco apaga a cifra das entradas vencidas do ambiente ASSINADO e deixa o
 * tombstone. Nada de retenção, inbox ou reconciliador muda aqui.
 *
 * Só é oferecida ao Inngest com `WHATSAPP_INBOX_PURGE_ENABLED=true` (só esse
 * valor exato liga). ATENÇÃO: desligar a variável não retira do Inngest uma
 * função já sincronizada sem uma nova sincronização.
 *
 * De hora em hora: a retenção vai de 60 s a 30 dias e o plano não fixa uma
 * frequência, então a cifra vencida dura no máximo cerca de 1 hora além do
 * prazo. Um lote do teto da operação (5.000) por execução; o que sobrar fica
 * para a próxima.
 *
 * UM `step.run`, que devolve só a contagem. Sem nova tentativa e sem log: uma
 * falha aparece como falha da execução, só com o código, e o próximo ciclo
 * (ou um "Rerun" no painel) repete com segurança, porque o expurgo é idempotente.
 */

export const WHATSAPP_INBOX_PURGE_STEP_ID = "purge-expired-inbox";
export const WHATSAPP_INBOX_PURGE_BATCH_LIMIT = 5000;

export const WHATSAPP_INBOX_PURGE_FUNCTION_CONFIG = {
  id: "b3-whatsapp-inbox-purge" as const,
  name: "B3 — expurgo da inbox do WhatsApp",
  // Uma execução por vez; o banco ainda pula linhas travadas (SKIP LOCKED).
  concurrency: { limit: 1 },
  retries: 0 as const,
  // Minuto 17, fora do minuto cheio do reconciliador (*/5).
  triggers: [{ cron: "TZ=UTC 17 * * * *" }],
};

export function whatsappInboxPurgeEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.WHATSAPP_INBOX_PURGE_ENABLED === "true";
}

export type WhatsAppInboxPurgeFailureCode = "inbox_purge_not_configured" | "inbox_purge_failed";

/** Falha da execução no Inngest, só com o código: nem mensagem original nem pilha. */
export class WhatsAppInboxPurgeFailed extends NonRetriableError {
  constructor(public readonly code: WhatsAppInboxPurgeFailureCode) {
    super(code);
    this.name = "WhatsAppInboxPurgeFailed";
    this.stack = `${this.name}: ${code}`;
  }
}

export type WhatsAppInboxPurgeSummary = Readonly<{ purged: number }>;

export async function runWhatsAppInboxPurge(): Promise<WhatsAppInboxPurgeSummary> {
  if (!isWhatsAppEnvironmentConfigured()) throw new WhatsAppInboxPurgeFailed("inbox_purge_not_configured");
  let purged: number;
  try {
    ({ purged } = await purgeExpiredWhatsAppWebhookInbox({ limit: WHATSAPP_INBOX_PURGE_BATCH_LIMIT }));
  } catch {
    throw new WhatsAppInboxPurgeFailed("inbox_purge_failed");
  }
  return { purged };
}

type Step = { run: (id: string, fn: () => Promise<WhatsAppInboxPurgeSummary>) => Promise<unknown> };

export async function handleWhatsAppInboxPurge({ step }: { step: Step }) {
  return step.run(WHATSAPP_INBOX_PURGE_STEP_ID, runWhatsAppInboxPurge);
}
