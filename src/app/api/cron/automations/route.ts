import { NextResponse } from "next/server";

import { isAuthorizedCalendarCron } from "@/server/calendar/cron-auth";
import { createAdminSupabaseClient } from "@/server/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Rodada das automações (C1) para TODOS os workspaces: transforma os eventos
 * pendentes em execuções e tenta as vencidas (inclusive novas tentativas
 * depois de uma falha). Mesmo padrão da rota de outbox da A11: só o
 * `CRON_SECRET` no cabeçalho `Authorization: Bearer`, comparado em tempo
 * constante, e a resposta carrega apenas contagens.
 *
 * Idempotente (processar de novo nunca duplica atividade) e SEM efeito
 * externo: o resultado é uma atividade interna. As telas já pedem uma rodada
 * do próprio workspace logo depois de criar um lead ou mover uma etapa; esta
 * rota cobre o que nasce fora da interface (ex.: lead vindo de formulário) e
 * as novas tentativas. Quem a chama periodicamente é definido na validação —
 * esta etapa não configura nenhum agendador.
 */
export async function POST(request: Request) {
  if (!isAuthorizedCalendarCron(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const supabase = createAdminSupabaseClient();
    const { data, error } = await supabase.rpc("process_automation_events_system", { p_limit: 100 });
    if (error) return NextResponse.json({ error: "process_failed" }, { status: 503 });
    const result = (data ?? {}) as { events?: number; executions?: number };
    return NextResponse.json({ events: result.events ?? 0, executions: result.executions ?? 0 });
  } catch (error) {
    // Só o código: a mensagem original (que pode citar configuração) não sai daqui.
    console.error(
      JSON.stringify({ event: "automations_cron_failed", code: error instanceof Error ? error.name : "unknown" }),
    );
    return NextResponse.json({ error: "not_available" }, { status: 503 });
  }
}

// GET com o mesmo segredo, para agendadores que só chamam GET.
export const GET = POST;
