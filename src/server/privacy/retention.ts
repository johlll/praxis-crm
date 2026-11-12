import type { SupabaseClient } from "@supabase/supabase-js";

import { requirePermissionSafe } from "@/server/authz/safe";
import { createPrivacyAdminSupabaseClient } from "@/server/privacy/admin/supabase";
import type { Database } from "@/server/types/database";
import { parseRetentionStatus, type HoldReasonCode, type RetentionStatus } from "@/modules/privacy/retention";

/**
 * C3b — orquestra a consulta da retenção, a preservação legal e a anonimização manual de UM
 * contato. Mesmo desenho da exportação (C3a): as RPCs só executam para service_role; o ATOR e o
 * WORKSPACE ATIVO saem do contexto já validado por `requirePermissionSafe("privacy.manage")` e
 * vão como parâmetros — o banco os confere de novo. Nada vem da requisição além do id do contato
 * e da ação pedida.
 *
 * Nada é logado: nem conteúdo, nem mensagem de erro do banco, nem stack. NENHUMA exceção sai
 * daqui; todo desfecho vira um resultado com código fechado.
 */

export type RetentionFailure = {
  ok: false;
  status: 403 | 404 | 500;
  error: "forbidden" | "not_found" | "retention_failed";
};

export type AnonymizeOutcome = "anonymized" | "already_anonymized" | "refused" | "failed";

export type RetentionResult = { ok: true; status: RetentionStatus; outcome?: AnonymizeOutcome } | RetentionFailure;

const FAILED: RetentionFailure = { ok: false, status: 500, error: "retention_failed" };

type Admin = SupabaseClient<Database>;
type Scope = { actorUserId: string; workspaceId: string };

function classify(error: { message?: string } | null): RetentionFailure | null {
  if (!error) return null;
  const message = error.message ?? "";
  if (
    message.includes("contact_not_found") ||
    message.includes("legal_hold_not_found") ||
    message.includes("contact_already_anonymized")
  ) {
    return { ok: false, status: 404, error: "not_found" };
  }
  if (message.includes("insufficient_permission")) return { ok: false, status: 403, error: "forbidden" };
  return FAILED;
}

async function authorize(): Promise<{ admin: Admin; scope: Scope } | RetentionFailure> {
  const guard = await requirePermissionSafe("privacy.manage");
  if ("error" in guard) return { ok: false, status: 403, error: "forbidden" };
  return {
    admin: createPrivacyAdminSupabaseClient(),
    scope: { actorUserId: guard.ctx.userId, workspaceId: guard.ctx.workspaceId },
  };
}

async function fetchStatus(admin: Admin, scope: Scope, contactId: string): Promise<RetentionResult> {
  const { data, error } = await admin.rpc("get_privacy_retention_status", {
    p_actor_user_id: scope.actorUserId,
    p_workspace_id: scope.workspaceId,
    p_contact_id: contactId,
  });
  const refused = classify(error);
  if (refused) return refused;
  return { ok: true, status: parseRetentionStatus(data) };
}

async function guarded(work: (admin: Admin, scope: Scope) => Promise<RetentionResult>): Promise<RetentionResult> {
  try {
    const auth = await authorize();
    if ("ok" in auth) return auth;
    return await work(auth.admin, auth.scope);
  } catch {
    // Cliente, rede, formato inesperado ou qualquer outra exceção: código fechado, sem detalhe.
    return FAILED;
  }
}

/** Estado da retenção do contato (sem conteúdo pessoal). */
export function getRetentionStatus(contactId: string): Promise<RetentionResult> {
  return guarded((admin, scope) => fetchStatus(admin, scope, contactId));
}

/** Cria a preservação legal (motivo em código fechado) e devolve o estado atualizado. */
export function createLegalHold(contactId: string, reasonCode: HoldReasonCode): Promise<RetentionResult> {
  return guarded(async (admin, scope) => {
    const { error } = await admin.rpc("create_privacy_legal_hold", {
      p_actor_user_id: scope.actorUserId,
      p_workspace_id: scope.workspaceId,
      p_contact_id: contactId,
      p_reason_code: reasonCode,
    });
    const refused = classify(error);
    if (refused) return refused;
    return fetchStatus(admin, scope, contactId);
  });
}

/** Encerra a preservação legal e devolve o estado atualizado do contato da tela. */
export function releaseLegalHold(contactId: string, holdId: string): Promise<RetentionResult> {
  return guarded(async (admin, scope) => {
    const { error } = await admin.rpc("release_privacy_legal_hold", {
      p_actor_user_id: scope.actorUserId,
      p_workspace_id: scope.workspaceId,
      p_hold_id: holdId,
    });
    const refused = classify(error);
    if (refused) return refused;
    return fetchStatus(admin, scope, contactId);
  });
}

/**
 * Anonimização manual. O banco reavalia a elegibilidade DENTRO da transação; recusa (a situação
 * mudou desde a prévia) e falha voltam como resultado, com o estado atualizado para a tela.
 */
export function anonymizeContact(contactId: string): Promise<RetentionResult> {
  return guarded(async (admin, scope) => {
    const { data, error } = await admin.rpc("anonymize_privacy_contact", {
      p_actor_user_id: scope.actorUserId,
      p_workspace_id: scope.workspaceId,
      p_contact_id: contactId,
    });
    const refused = classify(error);
    if (refused) return refused;

    const result = (data as { result?: string } | null)?.result;
    const outcome: AnonymizeOutcome | null =
      result === "anonymized" || result === "already_anonymized" || result === "refused" || result === "failed"
        ? result
        : null;
    if (!outcome) return FAILED;

    const fresh = await fetchStatus(admin, scope, contactId);
    if (!fresh.ok) return fresh;
    return { ok: true, status: fresh.status, outcome };
  });
}
