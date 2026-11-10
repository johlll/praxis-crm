import type { SupabaseClient } from "@supabase/supabase-js";

import { requirePermissionSafe } from "@/server/authz/safe";
import { decryptCpfCnpj } from "@/server/crypto/contact-sensitive";
import { createPrivacyAdminSupabaseClient } from "@/server/privacy/admin/supabase";
import type { Database } from "@/server/types/database";
import {
  buildSubjectExport,
  exportFileName,
  PrivacyExportDataError,
  type PrivacyExportFailure,
} from "@/modules/privacy/export-format";

/**
 * C3a — orquestra a exportação dos dados de um titular.
 *
 * Fluxo: abrir o registro → ler os dados (uma leitura consistente no banco) →
 * decifrar o CPF/CNPJ aqui, no servidor → montar o arquivo → fechar o registro
 * como concluído → só então devolver o conteúdo. Qualquer falha antes do último
 * passo fecha o registro como FALHA (código fechado) e NÃO devolve arquivo —
 * nunca existe saída parcial nem registro "concluído" sem arquivo entregue.
 *
 * Quem chama o banco: as três RPCs só executam para service_role, então usam o cliente
 * administrativo da feature. O ATOR sai do contexto já validado por
 * `requirePermissionSafe("privacy.manage")` e vai como parâmetro; o banco o confere de
 * novo (existência, membership ativa, papel, dono do registro). Nada vem da requisição.
 *
 * Nada é persistido (sem bucket, sem disco, sem e-mail) e nada é escrito em log: nem
 * conteúdo, nem mensagem de erro do banco, nem stack. NENHUMA exceção de transporte,
 * de cliente ou de qualquer etapa sai desta função.
 */

export type ExportSubjectResult =
  | { ok: true; body: string; fileName: string }
  | { ok: false; status: 403 | 404 | 500; error: "forbidden" | "not_found" | "export_failed" };

const FAILED: ExportSubjectResult = { ok: false, status: 500, error: "export_failed" };

type Admin = SupabaseClient<Database>;

function classify(error: { message?: string } | null): ExportSubjectResult | null {
  if (!error) return null;
  const message = error.message ?? "";
  if (message.includes("contact_not_found") || message.includes("privacy_export_not_found")) {
    return { ok: false, status: 404, error: "not_found" };
  }
  if (message.includes("insufficient_permission")) return { ok: false, status: 403, error: "forbidden" };
  return FAILED;
}

/**
 * Tentativa de fechar o registro como falha. Observa a exceção E o campo `error`; se
 * qualquer um acontecer, o registro segue "solicitado" (visível como não concluído) e quem
 * chamou continua falhando fechado, sem arquivo. Nada a vazar aqui.
 */
async function closeAsFailed(admin: Admin, actorUserId: string, exportId: string, code: PrivacyExportFailure): Promise<boolean> {
  try {
    const { error } = await admin.rpc("finish_privacy_export", {
      p_actor_user_id: actorUserId,
      p_export_id: exportId,
      p_failure_code: code,
    });
    return !error;
  } catch {
    return false;
  }
}

async function run(contactId: string): Promise<ExportSubjectResult> {
  const guard = await requirePermissionSafe("privacy.manage");
  if ("error" in guard) return { ok: false, status: 403, error: "forbidden" };
  const actorUserId = guard.ctx.userId;

  const admin = createPrivacyAdminSupabaseClient();
  let exportId: string | null = null;

  try {
    // O workspace sai do contato, no banco — nunca do cliente.
    const requested = await admin.rpc("request_privacy_export", { p_actor_user_id: actorUserId, p_contact_id: contactId });
    const refused = classify(requested.error);
    if (refused) return refused;
    if (!requested.data) return FAILED;
    exportId = requested.data;

    const loaded = await admin.rpc("get_privacy_export_payload", { p_actor_user_id: actorUserId, p_export_id: exportId });
    if (loaded.error || !loaded.data) {
      await closeAsFailed(admin, actorUserId, exportId, "data_unavailable");
      return classify(loaded.error) ?? FAILED;
    }

    const payload = loaded.data as unknown as {
      data: unknown;
      sensitive: { ciphertext_base64: string; key_version: string } | null;
    };

    let cpfCnpj: string | null = null;
    if (payload.sensitive) {
      try {
        cpfCnpj = decryptCpfCnpj(payload.sensitive.ciphertext_base64, payload.sensitive.key_version);
      } catch {
        await closeAsFailed(admin, actorUserId, exportId, "decryption_failed");
        return FAILED;
      }
    }

    const generatedAt = new Date();
    let body: string;
    try {
      body = JSON.stringify(buildSubjectExport({ contactId, generatedAt, data: payload.data, cpfCnpj }), null, 2);
    } catch (error) {
      const code: PrivacyExportFailure = error instanceof PrivacyExportDataError ? error.code : "internal_error";
      await closeAsFailed(admin, actorUserId, exportId, code);
      return FAILED;
    }

    // O registro só vira "concluído" com confirmação do banco — e só depois disso o conteúdo
    // sai. Se o fechamento devolver erro, o arquivo é descartado.
    const finished = await admin.rpc("finish_privacy_export", { p_actor_user_id: actorUserId, p_export_id: exportId });
    if (finished.error) return FAILED;

    return { ok: true, body, fileName: exportFileName(contactId, generatedAt) };
  } catch {
    // Exceção de transporte em qualquer etapa depois de abrir o registro: tenta fechá-lo como
    // falha (se isso também falhar, segue falhando fechado) e não entrega arquivo.
    if (exportId) await closeAsFailed(admin, actorUserId, exportId, "internal_error");
    return FAILED;
  }
}

export async function exportSubjectData(contactId: string): Promise<ExportSubjectResult> {
  try {
    return await run(contactId);
  } catch {
    // Criação do cliente, autorização inesperada ou qualquer outra exceção: código fechado,
    // sem mensagem, sem stack, sem log.
    return FAILED;
  }
}
