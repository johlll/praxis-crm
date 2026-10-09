import { listCalendarConnections } from "@/modules/calendar/queries";
import { loadActivityFromSession } from "@/modules/calendar/appointment-service";
import { syncHealthNotices, type CalendarSyncHealth, type HealthNotice } from "@/modules/calendar/health";
import { createSupabaseInboundStore } from "@/server/calendar/admin/inbound-store";
import { createSupabaseSyncStore } from "@/server/calendar/admin/sync-store";
import { calendarSchedulerEnabled } from "@/server/calendar/automation-flags";
import { loadConnectionContext } from "@/server/calendar/connection-context";
import { getCalendarEnvironment } from "@/server/calendar/environment";
import { getCalendarProvider } from "@/server/calendar/provider";
import { recoverLinksAfterReconnect, type ReconnectReport } from "@/server/calendar/sync/reconnect";
import { createServerSupabaseClient } from "@/server/supabase/server";

/**
 * Automação da agenda ligada à SESSÃO (B2, etapa 3b): saúde e reconexão. A
 * sincronização sob demanda fica em `on-demand.ts` (o serviço de
 * compromissos a importa, e este arquivo importa o serviço). Não é "use
 * server": só é chamada por páginas e ações que já conferiram a sessão, e
 * nunca recebe usuário/workspace de formulário. Integração desligada (sem
 * provedor — hoje, em Preview e Production): nada daqui toca no banco nem
 * no Google.
 */

type Session = { userId: string; workspaceId: string };

function logCode(event: string, error: unknown) {
  // Só o código: a mensagem original não sai daqui.
  console.error(JSON.stringify({ event, code: error instanceof Error ? error.name : "unknown" }));
}

/** Detector 2 (§9.3): avisos para owner/admin. Sem provedor, nenhum. */
export async function loadCalendarHealthNotices(workspaceId: string): Promise<HealthNotice[]> {
  const provider = await getCalendarProvider();
  if (!provider) return [];
  try {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.rpc("get_calendar_sync_health", { p_workspace_id: workspaceId });
    if (error) throw new Error(error.message);
    return syncHealthNotices(data as unknown as CalendarSyncHealth, { now: new Date(), schedulerEnabled: calendarSchedulerEnabled() });
  } catch (error) {
    // O aviso é informativo: falha de leitura não derruba a tela.
    logCode("calendar_health_unavailable", error);
    return [];
  }
}

/**
 * Reconexão (§6.5): reencontra os compromissos de uma desconexão anterior
 * DESTE usuário. Precisa da conexão ativa e com agenda escolhida. Nunca
 * lança: o resultado vira aviso.
 */
export async function recoverOwnCalendarLinks(session: Session): Promise<ReconnectReport | null> {
  const provider = await getCalendarProvider();
  if (!provider) return null;
  try {
    const mine = (await listCalendarConnections(session.workspaceId)).find((c) => c.isMine && c.status === "active" && c.calendarId);
    if (!mine) return null;
    const ctx = await loadConnectionContext({
      provider,
      connection: { id: mine.id, calendarId: mine.calendarId, status: mine.status },
      workspaceId: session.workspaceId,
      actorUserId: session.userId,
    });
    const environment = getCalendarEnvironment();
    return await recoverLinksAfterReconnect(
      {
        inbound: { api: provider, store: createSupabaseInboundStore(), environment, now: () => new Date() },
        outbound: { api: provider, store: createSupabaseSyncStore(session.userId), environment, loadActivity: loadActivityFromSession },
      },
      { connectionId: ctx.connectionId, userId: session.userId, accessToken: ctx.accessToken },
    );
  } catch (error) {
    logCode("calendar_reconnect_recovery_failed", error);
    return null;
  }
}

/**
 * Texto do resultado da recuperação, para a tela de Integrações. Conta o que
 * de fato terminou: revincular sem concluir a sincronização é "pendente".
 */
export function describeRecovery(report: ReconnectReport | null): string | null {
  if (!report || (report.candidates === 0 && report.resumed === 0)) return null;
  const parts: string[] = [];
  if (report.relinked > 0) parts.push(`${report.relinked} compromisso(s) reencontrado(s) no Google Agenda e vinculado(s) de novo.`);
  if (report.resumed > 0) parts.push(`${report.resumed} recuperação(ões) pendente(s) de uma tentativa anterior retomada(s).`);
  if (report.completed > 0) {
    parts.push(`${report.completed} recuperação(ões) concluída(s): o que mudou no Google e no CRM durante a desconexão foi sincronizado.`);
  }
  if (report.pending > 0) {
    parts.push(
      `${report.pending} ficou(aram) pendente(s): o Google não respondeu ou outra sincronização estava em andamento. Use “Reencontrar compromissos” de novo para concluir.`,
    );
  }
  if (report.accessLost > 0) {
    parts.push(
      `${report.accessLost} ficou(aram) pendente(s) porque esta conta não alcança a agenda; com o acesso de volta, use “Reencontrar compromissos”.`,
    );
  }
  if (report.gone > 0) parts.push(`${report.gone} não existe(m) mais no Google: a atividade continua no CRM.`);
  if (report.unreachable > 0) parts.push(`${report.unreachable} está(ão) numa agenda que esta conta não alcança.`);
  if (report.refused > 0) parts.push(`${report.refused} não foi(ram) vinculado(s): o evento no Google não é deste compromisso.`);
  if (report.failed > 0) parts.push(`${report.failed} não pôde(puderam) ser conferido(s) agora; use “Reencontrar compromissos” de novo.`);
  if (report.notAppointment > 0) parts.push(`${report.notAppointment} deixou(aram) de ser reunião com horário e não volta(m) à agenda.`);
  return parts.length > 0 ? parts.join(" ") : null;
}
