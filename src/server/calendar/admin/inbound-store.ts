import { createCalendarAdminSupabaseClient } from "@/server/calendar/admin/supabase";
import type { Json } from "@/server/types/database";
import type {
  ApplyInboundResult,
  ChannelRecord,
  InboundLink,
  InboundStore,
  NotificationResult,
  SyncLease,
  SyncTarget,
} from "@/server/calendar/sync/inbound-types";

/**
 * Adaptador de persistência da sincronização Google → CRM: só RPCs de
 * calendário (GRANT só a service_role), com o cabeçalho de ambiente
 * assinado. Roda sem sessão: o ator é sempre o DONO da conexão, e o banco o
 * confere por dentro (dono, ambiente, alcance).
 */
export function createSupabaseInboundStore(): InboundStore {
  const admin = createCalendarAdminSupabaseClient();
  const check = (error: { message: string } | null) => {
    if (error) throw new Error(error.message);
  };

  return {
    async listMaintenance() {
      const { data, error } = await admin.rpc("list_calendar_maintenance", {});
      check(error);
      const value = (data ?? {}) as unknown as { targets?: SyncTarget[]; channels?: ChannelRecord[] };
      return { targets: value.targets ?? [], channels: value.channels ?? [] };
    },

    async claimSync(actorUserId, connectionId, calendarId, leaseSeconds = 120) {
      const { data, error } = await admin.rpc("claim_calendar_sync", {
        p_connection_id: connectionId,
        p_calendar_id: calendarId,
        p_actor_user_id: actorUserId,
        p_lease_seconds: leaseSeconds,
      });
      check(error);
      return (data as unknown as SyncLease | null) ?? null;
    },

    async resetSyncToken(actorUserId, leaseId) {
      const { data, error } = await admin.rpc("reset_calendar_sync_token", { p_lease_id: leaseId, p_actor_user_id: actorUserId });
      check(error);
      return data === true;
    },

    async finishSync(actorUserId, leaseId, outcome, opts) {
      const { data, error } = await admin.rpc("finish_calendar_sync", {
        p_lease_id: leaseId,
        p_actor_user_id: actorUserId,
        p_outcome: outcome,
        p_sync_token: opts.syncToken ?? (null as unknown as string),
        p_full: opts.full,
        p_error: opts.error ?? "",
      });
      check(error);
      return data === true;
    },

    async listLinks(actorUserId, connectionId, calendarId) {
      const { data, error } = await admin.rpc("list_calendar_links_for_sync", {
        p_connection_id: connectionId,
        p_calendar_id: calendarId,
        p_actor_user_id: actorUserId,
      });
      check(error);
      return (data as unknown as InboundLink[] | null) ?? [];
    },

    async applyInbound(actorUserId, params) {
      const { data, error } = await admin.rpc("apply_google_inbound_change", {
        p_link_id: params.linkId,
        p_actor_user_id: actorUserId,
        p_expected_base_etag: params.expectedBaseEtag as string,
        p_expected_version: params.expectedVersion as number,
        p_title: params.title ?? "",
        p_due_at: params.dueAt ?? (null as unknown as string),
        p_conflicts: params.conflicts as unknown as Json,
        p_state: params.state as unknown as Json,
      });
      check(error);
      return data as unknown as ApplyInboundResult;
    },

    async markNeedsReauth(actorUserId, connectionId, reason) {
      const { error } = await admin.rpc("mark_calendar_connection_needs_reauth", {
        p_connection_id: connectionId,
        p_actor_user_id: actorUserId,
        p_reason: reason,
      });
      check(error);
    },

    async beginChannel(actorUserId, params) {
      const { error } = await admin.rpc("begin_calendar_channel", {
        p_connection_id: params.connectionId,
        p_calendar_id: params.calendarId,
        p_actor_user_id: actorUserId,
        p_channel_id: params.channelId,
        p_token_hash: params.tokenHash,
      });
      check(error);
    },

    async activateChannel(actorUserId, params) {
      const { error } = await admin.rpc("activate_calendar_channel", {
        p_channel_id: params.channelId,
        p_actor_user_id: actorUserId,
        p_resource_id: params.resourceId,
        p_expires_at: params.expiresAt,
        p_renew_at: params.renewAt as string,
        p_polling_only: params.pollingOnly,
      });
      check(error);
    },

    async claimChannelRenewal(actorUserId, channelId) {
      const { data, error } = await admin.rpc("claim_calendar_channel_renewal", {
        p_channel_id: channelId,
        p_actor_user_id: actorUserId,
      });
      check(error);
      return data === true;
    },

    async stopChannel(actorUserId, channelId, reason) {
      const { error } = await admin.rpc("stop_calendar_channel", {
        p_channel_id: channelId,
        p_actor_user_id: actorUserId,
        p_reason: reason,
      });
      check(error);
    },

    async recordNotification(params) {
      const { data, error } = await admin.rpc("record_calendar_notification", {
        p_channel_id: params.channelId,
        p_token_hash: params.tokenHash,
        p_resource_id: params.resourceId as string,
        p_resource_state: params.resourceState,
        p_message_number: params.messageNumber as number,
        p_expires_at: params.expiresAt as string,
      });
      check(error);
      return data as NotificationResult;
    },
  };
}

/** Canais vivos da PRÓPRIA conexão (para encerrá-los no Google ao desconectar). */
export async function adminListOwnChannels(params: {
  connectionId: string;
  actorUserId: string;
}): Promise<Array<{ channelId: string; resourceId: string }>> {
  const admin = createCalendarAdminSupabaseClient();
  const { data, error } = await admin.rpc("list_own_calendar_channels", {
    p_connection_id: params.connectionId,
    p_actor_user_id: params.actorUserId,
  });
  if (error) throw new Error(error.message);
  return (data as unknown as Array<{ channelId: string; resourceId: string }> | null) ?? [];
}
