import { createCalendarAdminSupabaseClient } from "@/server/calendar/admin/supabase";
import type { ConsumeResult, OAuthStateStore } from "@/server/calendar/google/oauth-flow";

/**
 * Estado da autorização OAuth no banco (`begin/consume_calendar_oauth`, GRANT
 * só a service_role, com o cabeçalho de ambiente assinado). Só hashes e o
 * verificador PKCE cifrado chegam ao banco.
 */
export function createSupabaseOAuthStateStore(): OAuthStateStore {
  const admin = createCalendarAdminSupabaseClient();
  return {
    async begin(p) {
      const { error } = await admin.rpc("begin_calendar_oauth", {
        p_workspace_id: p.session.workspaceId,
        p_actor_user_id: p.session.userId,
        p_state_hash: p.stateHash,
        p_browser_hash: p.browserHash,
        p_nonce_hash: p.nonceHash,
        p_verifier_ciphertext: p.verifierCiphertext,
        p_key_version: p.keyVersion,
      });
      if (error) throw new Error(error.message);
    },

    async consume(p) {
      const { data, error } = await admin.rpc("consume_calendar_oauth", {
        p_state_hash: p.stateHash,
        p_actor_user_id: p.session.userId,
        p_workspace_id: p.session.workspaceId,
        p_browser_hash: p.browserHash ?? "",
      });
      if (error) throw new Error(error.message);
      return data as unknown as ConsumeResult;
    },
  };
}
