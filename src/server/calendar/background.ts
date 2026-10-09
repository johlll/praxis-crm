import { createSupabaseInboundStore } from "@/server/calendar/admin/inbound-store";
import { createResendAlertSender, createSupabaseSchedulerStore } from "@/server/calendar/admin/scheduler-store";
import { calendarAlertsEnabled, calendarSchedulerEnabled } from "@/server/calendar/automation-flags";
import { runScheduledMaintenance, type ScheduledResult, type SchedulerSource } from "@/server/calendar/sync/scheduled";
import { loadConnectionContext } from "@/server/calendar/connection-context";
import { getCalendarEnvironment } from "@/server/calendar/environment";
import { getCalendarProvider, type CalendarProvider } from "@/server/calendar/provider";
import { runCalendarMaintenance, type MaintenanceReport, type OpenedConnection } from "@/server/calendar/sync/maintenance";

/**
 * Montagem de produção da sincronização Google → CRM (sem sessão). Sem
 * provedor configurado — hoje, em Preview e Production — nada daqui toca no
 * banco nem no Google: a rotina devolve `null`.
 */

/** Endereço público do webhook do ambiente. Sem ele (ou inválido), só polling. */
export function calendarWebhookAddress(): string | null {
  const value = process.env.CALENDAR_WEBHOOK_URL?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Abre a conexão em nome do DONO (só ele obtém os tokens). Refresh token
 * inválido vira "a reautorizar"; qualquer outra falha, "indisponível agora". */
export async function openOwnerConnection(
  provider: CalendarProvider,
  owner: { connectionId: string; userId: string; workspaceId: string; calendarId: string },
): Promise<OpenedConnection> {
  try {
    const ctx = await loadConnectionContext({
      provider,
      connection: { id: owner.connectionId, calendarId: owner.calendarId, status: "active" },
      workspaceId: owner.workspaceId,
      actorUserId: owner.userId,
    });
    return { accessToken: ctx.accessToken };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return /refresh_token_invalid|invalid_grant/.test(message) ? "needs_reauth" : null;
  }
}

export async function runEnvironmentCalendarMaintenance(): Promise<MaintenanceReport | null> {
  const provider = await getCalendarProvider();
  if (!provider) return null;
  return maintenanceWith(provider);
}

function maintenanceWith(provider: CalendarProvider): Promise<MaintenanceReport> {
  return runCalendarMaintenance({
    api: provider,
    store: createSupabaseInboundStore(),
    environment: getCalendarEnvironment(),
    now: () => new Date(),
    openConnection: (owner) => openOwnerConnection(provider, owner),
    webhookAddress: calendarWebhookAddress(),
  });
}

/**
 * Rodada agendada (Inngest, recuperação adicional ou chamada manual): a
 * manutenção, o batimento de quem chamou e, na recuperação adicional, o
 * Detector 1. Sem provedor configurado, `null` sem tocar em nada — nem no
 * batimento (as tabelas da B2 podem nem existir no banco).
 */
export async function runScheduledCalendarMaintenance(source: SchedulerSource): Promise<ScheduledResult | null> {
  const provider = await getCalendarProvider();
  if (!provider) return null;
  const alertsEnabled = calendarAlertsEnabled();
  return runScheduledMaintenance(
    {
      maintenance: () => maintenanceWith(provider),
      store: createSupabaseSchedulerStore(),
      now: () => new Date(),
      schedulerEnabled: calendarSchedulerEnabled(),
      alertsEnabled,
      sendAlert: alertsEnabled ? createResendAlertSender() : null,
    },
    source,
  );
}
