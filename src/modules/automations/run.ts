import { after } from "next/server";

import { createServerSupabaseClient } from "@/server/supabase/server";

/**
 * Processamento das automações logo DEPOIS de uma operação de origem (lead
 * criado, oportunidade movida de etapa).
 *
 * O evento já foi gravado, junto da operação, pelo próprio banco (trigger na
 * mesma transação); aqui só se pede uma rodada do workspace para a atividade
 * aparecer sem esperar. É melhor esforço e NUNCA afeta a operação original:
 *  - roda em `after()`, depois de a resposta ser enviada;
 *  - qualquer erro (inclusive `after` indisponível, como em testes) é engolido —
 *    o evento continua pendente e é consumido na próxima rodada (nova operação,
 *    "Processar agora" ou a rota de cron);
 *  - a RPC é idempotente: processar duas vezes nunca duplica atividade.
 *
 * Não envia nada para fora: o resultado é só uma atividade interna.
 */
export function scheduleAutomationRun(workspaceId: string): void {
  try {
    after(async () => {
      try {
        const supabase = await createServerSupabaseClient();
        await supabase.rpc("process_automation_events", { p_workspace_id: workspaceId, p_limit: 20 });
      } catch {
        // Fica para a próxima rodada.
      }
    });
  } catch {
    // Fora de uma requisição (ou sem suporte): fica para a próxima rodada.
  }
}
