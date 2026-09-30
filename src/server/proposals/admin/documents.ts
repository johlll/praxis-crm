import { createHash } from "node:crypto";

import { createProposalsAdminSupabaseClient } from "@/server/proposals/admin/supabase";

/**
 * Único ponto de contato com o Storage/RPCs de proposal_documents que têm
 * GRANT restrito a service_role — importável só daqui (regra de lint em
 * eslint.config.mjs). Todo chamador PRECISA já ter verificado a
 * autorização (requirePermissionSafe + requireUser) antes de invocar
 * qualquer função deste arquivo; nada aqui repete essa checagem por conta
 * própria além do que o próprio SQL já faz — a defesa real é o GRANT.
 */

const BUCKET = "proposal-documents";
const DOWNLOAD_URL_TTL_SECONDS = 60;

export type BeginProposalDocumentResult = {
  documentId: string;
  version: number;
  storagePath: string;
};

export async function adminBeginProposalDocument(
  proposalId: string,
  actorUserId: string,
): Promise<BeginProposalDocumentResult> {
  const admin = createProposalsAdminSupabaseClient();
  const { data, error } = await admin.rpc("begin_proposal_document", {
    p_proposal_id: proposalId,
    p_actor_user_id: actorUserId,
  });

  if (error) throw new Error(error.message);
  const row = data?.[0];
  if (!row) throw new Error("begin_proposal_document_no_row");

  return { documentId: row.document_id, version: row.version, storagePath: row.storage_path };
}

export async function adminFailProposalDocument(
  documentId: string,
  errorCode: string,
  actorUserId: string,
): Promise<void> {
  const admin = createProposalsAdminSupabaseClient();
  // Best-effort: se isto também falhar, o documento fica 'pending' e
  // aparece como travado na listagem — nunca como 'ready' sem arquivo.
  await admin.rpc("fail_proposal_document", {
    p_document_id: documentId,
    p_error_code: errorCode,
    p_actor_user_id: actorUserId,
  });
}

/**
 * Upload (nunca sobrescreve — upsert:false) seguido de finalize, que só
 * confirma 'ready' depois de reconferir existência/tamanho no Storage
 * (B1, correção 5). Qualquer falha em qualquer passo chama
 * fail_proposal_document, para nunca deixar a linha presa em 'pending'
 * sem explicação visível na UI.
 */
export async function adminUploadAndFinalizeProposalDocument(params: {
  documentId: string;
  storagePath: string;
  pdfBytes: Buffer;
  actorUserId: string;
}): Promise<void> {
  const admin = createProposalsAdminSupabaseClient();
  const checksum = createHash("sha256").update(params.pdfBytes).digest("hex");

  const { error: uploadError } = await admin.storage.from(BUCKET).upload(params.storagePath, params.pdfBytes, {
    contentType: "application/pdf",
    upsert: false,
  });

  if (uploadError) {
    await adminFailProposalDocument(params.documentId, `upload_failed: ${uploadError.message}`.slice(0, 100), params.actorUserId);
    throw new Error("proposal_document_upload_failed");
  }

  const { error: finalizeError } = await admin.rpc("finalize_proposal_document", {
    p_document_id: params.documentId,
    p_checksum_sha256: checksum,
    p_byte_size: params.pdfBytes.byteLength,
    p_actor_user_id: params.actorUserId,
  });

  if (finalizeError) {
    await adminFailProposalDocument(params.documentId, finalizeError.message.slice(0, 100), params.actorUserId);
    throw new Error("proposal_document_finalize_failed");
  }
}

/**
 * Bytes exatos já armazenados — usado para anexar ao e-mail real (B1,
 * correção 1: o que é enviado é a versão imutável exata, nunca uma
 * re-renderização a partir do estado atual dos dados, que poderia
 * divergir do checksum gravado em finalize_proposal_document).
 */
export async function adminDownloadProposalDocumentBytes(storagePath: string): Promise<Buffer> {
  const admin = createProposalsAdminSupabaseClient();
  const { data, error } = await admin.storage.from(BUCKET).download(storagePath);
  if (error || !data) throw new Error("proposal_document_download_failed");
  return Buffer.from(await data.arrayBuffer());
}

export async function adminCreateProposalDocumentDownloadUrl(storagePath: string): Promise<string> {
  const admin = createProposalsAdminSupabaseClient();
  const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(storagePath, DOWNLOAD_URL_TTL_SECONDS);
  if (error || !data) {
    throw new Error("proposal_document_signed_url_failed");
  }
  return data.signedUrl;
}
