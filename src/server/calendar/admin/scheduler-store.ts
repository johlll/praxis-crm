import { createCalendarAdminSupabaseClient } from "@/server/calendar/admin/supabase";
import type { AlertClaim, AlertMessage, Heartbeat, SchedulerStore } from "@/server/calendar/sync/scheduled";
import type { Json } from "@/server/types/database";
import { getResendConfig } from "@/server/proposals/env";

/**
 * Batimento e alertas do agendador (B2, etapa 3b): RPCs de calendário (GRANT
 * só a service_role), com o cabeçalho de ambiente assinado.
 */
export function createSupabaseSchedulerStore(): SchedulerStore {
  const admin = createCalendarAdminSupabaseClient();
  const check = (error: { message: string } | null) => {
    if (error) throw new Error(error.message);
  };

  return {
    async recordHeartbeat(scheduler, outcome, report) {
      const { error } = await admin.rpc("record_calendar_scheduler_heartbeat", {
        p_scheduler: scheduler,
        p_outcome: outcome,
        p_report: report as unknown as Json,
      });
      check(error);
    },

    async listHeartbeats() {
      const { data, error } = await admin.rpc("list_calendar_scheduler_heartbeats");
      check(error);
      return (data as unknown as Heartbeat[] | null) ?? [];
    },

    async claimAlert(kind, scheduler, cooldownMinutes) {
      const { data, error } = await admin.rpc("claim_calendar_scheduler_alert", {
        p_kind: kind,
        p_scheduler: scheduler,
        p_cooldown_minutes: cooldownMinutes,
      });
      check(error);
      return (data as unknown as AlertClaim | null) ?? null;
    },

    async finishAlert(alertId, status, error) {
      const { error: rpcError } = await admin.rpc("finish_calendar_scheduler_alert", {
        p_alert_id: alertId,
        p_status: status,
        p_error: error ?? "",
      });
      check(rpcError);
    },
  };
}

/**
 * Envio do alerta pelo Resend (mesma conta das propostas). `null` sem Resend
 * configurado. Só é chamado com `CALENDAR_ALERTS_ENABLED` ligado — quem
 * decide é `runScheduledMaintenance`.
 */
export function createResendAlertSender(): ((message: AlertMessage) => Promise<void>) | null {
  const config = getResendConfig();
  if (!config) return null;
  return async (message) => {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": message.idempotencyKey,
      },
      body: JSON.stringify({ from: config.fromEmail, to: [message.to], subject: message.subject, text: message.text }),
    });
    if (!response.ok) throw new Error(`resend_http_${response.status}`);
  };
}
