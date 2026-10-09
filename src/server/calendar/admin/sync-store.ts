import { createCalendarAdminSupabaseClient } from "@/server/calendar/admin/supabase";
import type { Json } from "@/server/types/database";
import type { LinkRecord, LinkState, OpenCreateIntent, SyncStore } from "@/server/calendar/sync/types";

/**
 * Adaptador de persistência da sincronização: só chama as RPCs de
 * calendário (GRANT só a service_role), sempre em nome do usuário que a
 * sessão já autorizou. Banco e ambiente decidem por dentro (papel, alcance,
 * dono da conexão, ambiente autenticado).
 */
export function createSupabaseSyncStore(actorUserId: string): SyncStore {
  const admin = createCalendarAdminSupabaseClient();

  return {
    async getLink(activityId) {
      const { data, error } = await admin.rpc("get_calendar_link", {
        p_activity_id: activityId,
        p_actor_user_id: actorUserId,
      });
      if (error) throw new Error(error.message);
      return (data as unknown as LinkRecord | null) ?? null;
    },

    async beginEffect({ connectionId, activityId, operation, expected, target }) {
      const { data, error } = await admin.rpc("begin_calendar_effect", {
        p_connection_id: connectionId,
        p_activity_id: activityId,
        p_actor_user_id: actorUserId,
        p_operation: operation,
        p_expected: expected as Json,
        ...(target ? { p_calendar_id: target.calendarId, p_event_id: target.eventId } : {}),
      });
      if (error) throw new Error(error.message);
      return data;
    },

    async getOpenCreateIntent(activityId) {
      const { data, error } = await admin.rpc("get_open_calendar_create", {
        p_activity_id: activityId,
        p_actor_user_id: actorUserId,
      });
      if (error) throw new Error(error.message);
      return (data as unknown as OpenCreateIntent | null) ?? null;
    },

    async resolveEffect({ intentId, status, errorCode, state, syncState }) {
      const { data, error } = await admin.rpc("resolve_calendar_effect", {
        p_intent_id: intentId,
        p_actor_user_id: actorUserId,
        p_status: status,
        p_error_code: errorCode ?? "",
        p_state: { ...(state ?? {}), ...(syncState ? { syncState } : {}) } as unknown as Json,
      });
      if (error) throw new Error(error.message);
      return data ?? null;
    },

    async markLinkPending({ activityId, reason }) {
      const { data, error } = await admin.rpc("mark_calendar_link_pending", {
        p_activity_id: activityId,
        p_actor_user_id: actorUserId,
        p_reason: reason,
      });
      if (error) throw new Error(error.message);
      return data === true;
    },

    async recordConflict({ linkId, field, crmValue, googleValue, resolution }) {
      const { error } = await admin.rpc("record_calendar_conflict", {
        p_link_id: linkId,
        p_actor_user_id: actorUserId,
        p_field: field,
        p_crm_value: (crmValue ?? null) as Json,
        p_google_value: (googleValue ?? null) as Json,
        p_resolution: resolution,
      });
      if (error) throw new Error(error.message);
    },

    async applyGoogleToActivity({ activityId, expectedVersion, title, dueAt, conflicts }) {
      const { data, error } = await admin.rpc("apply_google_values_to_activity", {
        p_activity_id: activityId,
        p_actor_user_id: actorUserId,
        p_expected_version: expectedVersion,
        p_title: title ?? "",
        p_due_at: dueAt ?? (null as unknown as string),
        p_conflicts: conflicts.map((c) => ({
          field: c.field,
          crmValue: c.crmValue ?? null,
          googleValue: c.googleValue ?? null,
        })) as unknown as Json,
      });
      if (error) throw new Error(error.message);
      // `null`: a atividade mudou depois da leitura e nada foi aplicado.
      return data ?? null;
    },
  };
}

export type { LinkState };
