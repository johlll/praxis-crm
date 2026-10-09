import { createSupabaseInboundStore } from "@/server/calendar/admin/inbound-store";
import { getCalendarProvider } from "@/server/calendar/provider";
import { handleCalendarNotification } from "@/server/calendar/sync/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Webhook do Google Agenda (B2, etapa 3). A notificação não tem corpo; só
 * marca a agenda para sincronizar — o processamento acontece fora da
 * requisição, na manutenção. Canal, segredo e ambiente desconhecidos: 404.
 * Sem provedor configurado (hoje, em Preview e Production): 404, sem tocar
 * no banco.
 */
export async function POST(request: Request) {
  if (!(await getCalendarProvider())) return new Response(null, { status: 404 });
  try {
    const status = await handleCalendarNotification(request.headers, createSupabaseInboundStore());
    return new Response(null, { status });
  } catch {
    // 5xx: o Google tenta de novo; nenhuma informação sai daqui.
    return new Response(null, { status: 503 });
  }
}
