import { createServerSupabaseClient } from "@/server/supabase/server";
import { requirePermissionSafe } from "@/server/authz/safe";
import { decryptCpfCnpj } from "@/server/crypto/contact-sensitive";
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
 * Nada é persistido (sem bucket, sem disco, sem e-mail) e nada é escrito em
 * log: nem conteúdo, nem mensagem de erro do banco, nem stack.
 */

export type ExportSubjectResult =
  | { ok: true; body: string; fileName: string }
  | { ok: false; status: 403 | 404 | 500; error: "forbidden" | "not_found" | "export_failed" };

const FAILED: ExportSubjectResult = { ok: false, status: 500, error: "export_failed" };

type Supabase = Awaited<ReturnType<typeof createServerSupabaseClient>>;

function classify(error: { message?: string } | null): ExportSubjectResult | null {
  if (!error) return null;
  const message = error.message ?? "";
  if (message.includes("contact_not_found") || message.includes("privacy_export_not_found")) {
    return { ok: false, status: 404, error: "not_found" };
  }
  if (message.includes("insufficient_permission")) return { ok: false, status: 403, error: "forbidden" };
  return FAILED;
}

async function closeAsFailed(supabase: Supabase, exportId: string, code: PrivacyExportFailure): Promise<void> {
  try {
    await supabase.rpc("finish_privacy_export", { p_export_id: exportId, p_failure_code: code });
  } catch {
    // O registro continua "solicitado" — visível como não concluído. Nada a vazar aqui.
  }
}

export async function exportSubjectData(contactId: string): Promise<ExportSubjectResult> {
  const guard = await requirePermissionSafe("privacy.manage");
  if ("error" in guard) return { ok: false, status: 403, error: "forbidden" };

  const supabase = await createServerSupabaseClient();

  // O workspace sai do contato, no banco — nunca do cliente.
  const requested = await supabase.rpc("request_privacy_export", { p_contact_id: contactId });
  const refused = classify(requested.error);
  if (refused) return refused;
  const exportId = requested.data;
  if (!exportId) return FAILED;

  const loaded = await supabase.rpc("get_privacy_export_payload", { p_export_id: exportId });
  if (loaded.error || !loaded.data) {
    await closeAsFailed(supabase, exportId, "data_unavailable");
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
      await closeAsFailed(supabase, exportId, "decryption_failed");
      return FAILED;
    }
  }

  const generatedAt = new Date();
  let body: string;
  try {
    body = JSON.stringify(buildSubjectExport({ contactId, generatedAt, data: payload.data, cpfCnpj }), null, 2);
  } catch (error) {
    const code: PrivacyExportFailure = error instanceof PrivacyExportDataError ? error.code : "internal_error";
    await closeAsFailed(supabase, exportId, code);
    return FAILED;
  }

  // O registro só vira "concluído" se o fechamento der certo — e só depois disso
  // o conteúdo sai. Se o fechamento falhar, o arquivo é descartado.
  const finished = await supabase.rpc("finish_privacy_export", { p_export_id: exportId });
  if (finished.error) return FAILED;

  return { ok: true, body, fileName: exportFileName(contactId, generatedAt) };
}
