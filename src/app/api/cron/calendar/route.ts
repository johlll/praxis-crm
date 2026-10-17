import { NextResponse } from "next/server";

import { runScheduledCalendarMaintenance } from "@/server/calendar/background";
import { isAuthorizedCalendarCron } from "@/server/calendar/cron-auth";
import type { SchedulerSource } from "@/server/calendar/sync/scheduled";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Manutenção do Google Agenda (B2, etapa 3; §9.2): sincronização Google →
 * CRM dos eventos vinculados, canais de notificação (criar, renovar,
 * encerrar) e reconciliação. Idempotente — as travas do banco garantem uma
 * sincronização e uma renovação por vez —, então pode ser chamada por mais
 * de um agendador. Mesmo segredo dos crons da A11 (`CRON_SECRET`), mas lido
 * sozinho (`cron-auth.ts`): a rota não depende do resto da configuração da
 * A11. Quem chamará esta rota é definido na validação.
 *
 * Sem provedor configurado (hoje, em Preview e Production) não toca em nada.
 * A resposta tem só contagens, nunca conteúdo de evento.
 *
 * `?source=` diz quem chamou, para o batimento (§9.3): `github` (a
 * recuperação adicional, que também confere o agendador principal —
 * Detector 1) ou `manual` (padrão). O agendador principal (Inngest) não usa
 * esta rota: chama a mesma rotina por dentro.
 */

function sourceOf(request: Request): SchedulerSource {
  const source = new URL(request.url).searchParams.get("source");
  return source === "github" ? "github" : "manual";
}

export async function POST(request: Request) {
  if (!isAuthorizedCalendarCron(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await runScheduledCalendarMaintenance(sourceOf(request));
    if (!result) return NextResponse.json({ enabled: false });
    // `outcome`: ok | partial | failed (rodada desta chamada); `detector`: o
    // agendador principal (só com source=github). Rodada que falhou responde
    // 503 — com as contagens — para quem chamou não a tomar por sucesso.
    return NextResponse.json(
      { enabled: true, outcome: result.outcome, detector: result.detector, ...(result.report ?? {}) },
      { status: result.outcome === "failed" ? 503 : 200 },
    );
  } catch (error) {
    // Só o código: a mensagem original não sai daqui.
    console.error(JSON.stringify({ event: "calendar_maintenance_failed", code: error instanceof Error ? error.name : "unknown" }));
    return NextResponse.json({ error: "maintenance_failed" }, { status: 503 });
  }
}
