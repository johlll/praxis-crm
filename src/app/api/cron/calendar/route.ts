import { NextResponse } from "next/server";

import { runEnvironmentCalendarMaintenance } from "@/server/calendar/background";
import { getIngestConfig, IngestConfigError } from "@/server/ingest/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Manutenção do Google Agenda (B2, etapa 3; §9.2): sincronização Google →
 * CRM dos eventos vinculados, canais de notificação (criar, renovar,
 * encerrar) e reconciliação. Idempotente — as travas do banco garantem uma
 * sincronização e uma renovação por vez —, então pode ser chamada por mais
 * de um agendador. Mesmo segredo dos crons da A11 (o workflow da A11 não
 * muda; quem chamará esta rota é definido na validação).
 *
 * Sem provedor configurado (hoje, em Preview e Production) não toca em nada.
 * A resposta tem só contagens, nunca conteúdo de evento.
 */

function authorized(request: Request): boolean {
  let secret: string;
  try {
    secret = getIngestConfig().CRON_SECRET;
  } catch (error) {
    if (error instanceof IngestConfigError) return false;
    throw error;
  }
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const report = await runEnvironmentCalendarMaintenance();
    if (!report) return NextResponse.json({ enabled: false });
    return NextResponse.json({ enabled: true, ...report });
  } catch (error) {
    // Só o código: a mensagem original não sai daqui.
    console.error(JSON.stringify({ event: "calendar_maintenance_failed", code: error instanceof Error ? error.name : "unknown" }));
    return NextResponse.json({ error: "maintenance_failed" }, { status: 503 });
  }
}
