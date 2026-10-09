import { after } from "next/server";

import { listCalendarConnections } from "@/modules/calendar/queries";
import { createSupabaseInboundStore } from "@/server/calendar/admin/inbound-store";
import { loadConnectionContext } from "@/server/calendar/connection-context";
import { getCalendarEnvironment } from "@/server/calendar/environment";
import { getCalendarProvider } from "@/server/calendar/provider";
import { syncOwnCalendarsOnDemand } from "@/server/calendar/sync/on-demand";

/**
 * Disparo da sincronização sob demanda pela SESSÃO (B2, etapa 3b). Só
 * chamado por páginas e ações que já conferiram a sessão. Sem provedor
 * configurado (hoje, em Preview e Production), não toca em nada.
 */

type Session = { userId: string; workspaceId: string };

function logCode(event: string, error: unknown) {
  // Só o código: a mensagem original não sai daqui.
  console.error(JSON.stringify({ event, code: error instanceof Error ? error.name : "unknown" }));
}

/**
 * Sincronização sob demanda (§9.2, item 3) DEPOIS da resposta: a tela não
 * espera o Google. Lê a conexão pela sessão antes (o `after` roda fora da
 * requisição) e só chama o Google pelas RPCs do dono.
 */
export async function scheduleOnDemandCalendarSync(session: Session): Promise<void> {
  const provider = await getCalendarProvider();
  if (!provider) return;
  let mine;
  try {
    mine = (await listCalendarConnections(session.workspaceId)).find((c) => c.isMine && c.status === "active" && c.calendarId);
  } catch (error) {
    logCode("calendar_on_demand_unavailable", error);
    return;
  }
  if (!mine) return;
  const connection = { id: mine.id, calendarId: mine.calendarId, status: mine.status };

  try {
    after(async () => {
      try {
        const ctx = await loadConnectionContext({ provider, connection, workspaceId: session.workspaceId, actorUserId: session.userId });
        await syncOwnCalendarsOnDemand(
          { api: provider, store: createSupabaseInboundStore(), environment: getCalendarEnvironment(), now: () => new Date() },
          { connectionId: ctx.connectionId, userId: session.userId, accessToken: ctx.accessToken },
        );
      } catch (error) {
        logCode("calendar_on_demand_failed", error);
      }
    });
  } catch (error) {
    // Fora de uma requisição (não deveria acontecer): só não agenda.
    logCode("calendar_on_demand_not_scheduled", error);
  }
}
