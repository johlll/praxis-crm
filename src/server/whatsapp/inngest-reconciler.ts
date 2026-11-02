import { runWhatsAppInboxReconcilerRound, type WhatsAppReconcilerSummary } from "@/server/whatsapp/reconciler";

/**
 * Função agendada do reconciliador da inbox (B3.2e,
 * docs/decisoes/b3-whatsapp-real.md §28), no app PRÓPRIO `praxis-crm-whatsapp`
 * (rota `/api/inngest/whatsapp`). Sem nenhum cliente, validador ou variável da
 * A11 ou da agenda.
 *
 * Só é oferecida ao Inngest com `WHATSAPP_RECONCILER_ENABLED=true` (só esse valor
 * exato liga). Desligada, o consumidor continua registrado: o app nunca fica
 * vazio, que o Inngest recusaria sincronizar. ATENÇÃO: desligar a variável não
 * retira do Inngest uma função já sincronizada sem uma nova sincronização.
 *
 * UM `step.run` executa a rodada inteira, e o token de cada reserva fica dentro
 * dele: o passo devolve só o desfecho e as contagens. Sem nova tentativa: o
 * próximo ciclo recomeça, e uma falha geral aparece como falha da execução.
 */

export const WHATSAPP_RECONCILER_STEP_ID = "reconcile-inbox";

export const WHATSAPP_RECONCILER_FUNCTION_CONFIG = {
  id: "b3-whatsapp-inbox-reconciler" as const,
  name: "B3 — reconciliador da inbox do WhatsApp",
  // Uma rodada por vez; as travas do banco impedem a mesma entrada em duas.
  concurrency: { limit: 1 },
  retries: 0 as const,
  triggers: [{ cron: "TZ=UTC */5 * * * *" }],
};

export function whatsappReconcilerEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.WHATSAPP_RECONCILER_ENABLED === "true";
}

type Step = { run: (id: string, fn: () => Promise<WhatsAppReconcilerSummary>) => Promise<unknown> };

export async function handleWhatsAppInboxReconciler({ step }: { step: Step }) {
  return step.run(WHATSAPP_RECONCILER_STEP_ID, () => runWhatsAppInboxReconcilerRound("inngest"));
}
