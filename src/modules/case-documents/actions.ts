"use server";

import { revalidatePath } from "next/cache";

import { requirePermissionSafe } from "@/server/authz/safe";
import { createServerSupabaseClient } from "@/server/supabase/server";
import { caseDocumentsUploadEnabledByServer, UPLOAD_DISABLED_MESSAGE } from "@/server/case-documents/gate";
import { checkUploadedContent } from "@/server/case-documents/content";
import {
  CaseDocumentAdminError,
  adminAbandonCaseDocument,
  adminBeginCaseDocument,
  adminBeginRemoval,
  adminCreateUploadToken,
  adminDownloadObject,
  adminFinalizeCaseDocument,
  adminFinalizeRemoval,
  adminRemoveObject,
  adminRunCaseDocumentCleanup,
} from "@/server/case-documents/admin/documents";

import {
  beginUploadSchema,
  documentIdSchema,
  isCaseDocumentType,
  mapCaseDocument,
  removalSchema,
  reviewSchema,
  type CaseDocument,
} from "./schema";

/**
 * Documentos por caso (docs/decisoes/conversas-documentos-caso.md). Cada ação confere a sessão e a permissão
 * AQUI e o banco confere de novo (papel, escritório, alcance do caso, anonimização). O envio e a finalização
 * passam por DUAS travas fechadas por padrão — a variável do servidor e o portão do banco — até a ativação do
 * backup dos documentos. Nenhuma ação muda andamento, roteiro, situação do atendimento, etapa comercial,
 * automações ou integrações. Mensagens para a tela são sempre códigos traduzidos, nunca texto do banco.
 */

const MESSAGES: Record<string, string> = {
  case_documents_upload_disabled: UPLOAD_DISABLED_MESSAGE,
  insufficient_permission: "Você não tem permissão para fazer isso.",
  opportunity_not_found: "Caso não encontrado ou fora do seu alcance.",
  document_not_found: "Documento não encontrado ou fora do seu alcance.",
  contact_anonymized: "Este contato foi anonimizado: o caso só pode ser consultado.",
  idempotency_conflict: "Este envio já foi usado para outro arquivo. Escolha o arquivo de novo.",
  case_document_type_not_allowed: "Formato não aceito. Envie PDF, JPEG ou PNG.",
  case_document_empty: "O arquivo está vazio.",
  case_document_too_large: "O arquivo passa de 10 MB, o limite por documento.",
  case_document_content_invalid: "O arquivo não é um PDF, JPEG ou PNG válido (ou chegou incompleto). Nada foi guardado.",
  case_document_content_mismatch: "O conteúdo do arquivo não corresponde ao formato informado. Nada foi guardado.",
  document_object_missing_or_size_mismatch: "O arquivo não chegou completo ao armazenamento. Tente enviar de novo.",
  document_not_pending: "Este envio já foi concluído ou cancelado.",
  case_document_review_conflict: "Outra pessoa registrou a conferência deste documento antes. Veja a situação atual e decida de novo.",
  case_document_note_required: "Descreva a pendência para registrar “Com pendência”.",
  case_document_note_too_long: "A observação passa de 1000 caracteres.",
  document_not_removing: "Este documento não está em remoção.",
  storage_object_still_present: "O arquivo ainda não saiu do armazenamento. A remoção ficou pendente e será retomada.",
};

function message(code: string, fallback = "Não foi possível concluir. Tente de novo."): string {
  return MESSAGES[code] ?? fallback;
}

function codeOf(error: unknown): string {
  if (error instanceof CaseDocumentAdminError) return error.code;
  const m = error && typeof error === "object" && "message" in error ? String((error as { message: unknown }).message) : "";
  return /^[a-z_]{3,60}$/.test(m) ? m : "unknown";
}

function firstIssue(issues: { message: string }[]): string {
  return issues[0]?.message ?? "Dados inválidos.";
}

/** Limpeza oportunista depois de uma escrita: nunca atrasa nem derruba a resposta além do lote pequeno. */
async function cleanupQuietly(): Promise<void> {
  await adminRunCaseDocumentCleanup(10).catch(() => undefined);
}

export type BeginUploadState =
  | { ok: true; documentId: string; path: string; token: string | null; alreadyReady: CaseDocument | null }
  | { ok: false; error: string };

/**
 * 1ª fase do envio: reserva o documento (linha pendente + caminho gerado pelo banco) e devolve o link de envio
 * daquele caminho. A chave de idempotência vem da tela, uma por arquivo escolhido: repetir o pedido devolve o
 * MESMO documento (nunca duplica); se ele já ficou pronto, a tela só mostra o resultado.
 */
export async function beginCaseDocumentUploadAction(input: {
  opportunityId: string;
  name: string;
  type: string;
  size: number;
  idempotencyKey: string;
}): Promise<BeginUploadState> {
  const guard = await requirePermissionSafe("case_document.upload");
  if ("error" in guard) return { ok: false, error: guard.error };
  if (!caseDocumentsUploadEnabledByServer()) return { ok: false, error: UPLOAD_DISABLED_MESSAGE };
  const parsed = beginUploadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error.issues) };

  try {
    const begun = await adminBeginCaseDocument({
      opportunityId: parsed.data.opportunityId,
      actorUserId: guard.ctx.userId,
      name: parsed.data.name,
      declaredType: parsed.data.type,
      declaredSize: parsed.data.size,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    if (begun.status === "ready") {
      return { ok: true, documentId: begun.documentId, path: begun.storagePath, token: null, alreadyReady: mapCaseDocument(begun.document) };
    }
    const { token, path } = await adminCreateUploadToken(begun.storagePath);
    return { ok: true, documentId: begun.documentId, path, token, alreadyReady: null };
  } catch (error) {
    return { ok: false, error: message(codeOf(error)) };
  }
}

export type FinalizeUploadState = { ok: true; document: CaseDocument; replayed: boolean } | { ok: false; error: string; abandoned: boolean };

/**
 * 2ª fase: baixa o objeto recebido, confere o CONTEÚDO (não é antivírus), calcula o hash e só então o banco
 * torna o documento visível — depois de conferir no Storage o mesmo tamanho. Conteúdo inválido: apaga o objeto
 * e a linha pendente (nada fica visível nem órfão sem registro).
 */
export async function finalizeCaseDocumentUploadAction(input: { documentId: string; declaredType: string }): Promise<FinalizeUploadState> {
  const guard = await requirePermissionSafe("case_document.upload");
  if ("error" in guard) return { ok: false, error: guard.error, abandoned: false };
  if (!caseDocumentsUploadEnabledByServer()) return { ok: false, error: UPLOAD_DISABLED_MESSAGE, abandoned: false };
  const parsed = documentIdSchema.safeParse({ documentId: input.documentId });
  if (!parsed.success || !isCaseDocumentType(input.declaredType)) return { ok: false, error: "Dados inválidos.", abandoned: false };

  const supabase = await createServerSupabaseClient();
  // O caminho vem do banco (nunca do navegador): a leitura confere alcance; o documento ainda pendente só é
  // devolvido a quem iniciou o envio.
  const { data: pending, error: pendingError } = await supabase.rpc("get_pending_case_document", { p_document_id: parsed.data.documentId });
  if (pendingError || !pending) return { ok: false, error: message(codeOf(pendingError), "Envio não encontrado."), abandoned: false };
  const info = pending as { storagePath: string; declaredType: string; status: string };
  if (info.status === "ready") {
    // Repetição depois de uma resposta perdida: o documento já está pronto.
    return { ok: false, error: message("document_not_pending"), abandoned: false };
  }

  const bytes = await adminDownloadObject(info.storagePath);
  if (!bytes) return { ok: false, error: message("document_object_missing_or_size_mismatch"), abandoned: false };

  const declared = isCaseDocumentType(info.declaredType) ? info.declaredType : input.declaredType;
  const check = checkUploadedContent(bytes, declared);
  if (!check.ok) {
    await adminAbandonCaseDocument({ documentId: parsed.data.documentId, storagePath: info.storagePath, actorUserId: guard.ctx.userId, errorCode: check.code });
    await cleanupQuietly();
    return { ok: false, error: message(check.code), abandoned: true };
  }

  try {
    const row = await adminFinalizeCaseDocument({
      documentId: parsed.data.documentId,
      actorUserId: guard.ctx.userId,
      contentType: check.type,
      byteSize: check.byteSize,
      checksumSha256: check.checksumSha256,
    });
    revalidatePath("/conversas", "layout");
    await cleanupQuietly();
    return { ok: true, document: mapCaseDocument(row), replayed: row.replayed === true };
  } catch (error) {
    return { ok: false, error: message(codeOf(error)), abandoned: false };
  }
}

/**
 * Envio interrompido na tela (falha de rede ao subir, arquivo recusado pelo Storage, desistência): apaga o que
 * tiver chegado e a linha pendente. Idempotente. Sem a trava do recebimento — cancelar nunca fica bloqueado.
 */
export async function abandonCaseDocumentUploadAction(input: { documentId: string; reason: string }): Promise<{ ok: boolean }> {
  const guard = await requirePermissionSafe("case_document.upload");
  if ("error" in guard) return { ok: false };
  const parsed = documentIdSchema.safeParse({ documentId: input.documentId });
  if (!parsed.success) return { ok: false };
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.rpc("get_pending_case_document", { p_document_id: parsed.data.documentId });
  const info = (data ?? null) as { storagePath: string; status: string } | null;
  if (!info || info.status !== "pending") return { ok: true };
  const reason = /^[a-z_]{1,60}$/.test(input.reason) ? input.reason : "upload_interrupted";
  try {
    await adminAbandonCaseDocument({ documentId: parsed.data.documentId, storagePath: info.storagePath, actorUserId: guard.ctx.userId, errorCode: reason });
  } catch {
    // A linha pendente expira sozinha (3 horas) e o objeto vai para a fila de limpeza.
  }
  return { ok: true };
}

export type ReviewState = { ok: true; document: CaseDocument } | { ok: false; error: string; conflict: boolean };

/** Conferência humana: Recebido, Conferido ou Com pendência (observação obrigatória). Versão contra sobrescrita. */
export async function reviewCaseDocumentAction(input: {
  documentId: string;
  status: string;
  note: string;
  expectedVersion: number;
}): Promise<ReviewState> {
  const guard = await requirePermissionSafe("case_document.review");
  if ("error" in guard) return { ok: false, error: guard.error, conflict: false };
  const parsed = reviewSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error.issues), conflict: false };

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("set_case_document_review", {
    p_document_id: parsed.data.documentId,
    p_review_status: parsed.data.status,
    p_note: parsed.data.note,
    p_expected_version: parsed.data.expectedVersion,
  });
  if (error) {
    const code = codeOf(error);
    return { ok: false, error: message(code), conflict: code === "case_document_review_conflict" };
  }
  revalidatePath("/conversas", "layout");
  return { ok: true, document: mapCaseDocument((data ?? {}) as Record<string, unknown>) };
}

export type RemovalState = { ok: true } | { ok: false; error: string; pending: boolean };

/**
 * Remoção controlada em duas fases: marca o documento em remoção (some da abertura), apaga o arquivo do
 * Storage e só então o banco apaga o registro — conferindo que o objeto saiu. Falha no meio: a remoção fica
 * PENDENTE e visível, e é retomada (por aqui ou pela limpeza). Não se promete exclusão concluída antes disso.
 */
export async function removeCaseDocumentAction(input: { documentId: string; reason: string }): Promise<RemovalState> {
  const guard = await requirePermissionSafe("case_document.remove");
  if ("error" in guard) return { ok: false, error: guard.error, pending: false };
  const parsed = removalSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error.issues), pending: false };

  let storagePath: string;
  try {
    ({ storagePath } = await adminBeginRemoval({ documentId: parsed.data.documentId, actorUserId: guard.ctx.userId, reason: parsed.data.reason }));
  } catch (error) {
    return { ok: false, error: message(codeOf(error)), pending: false };
  }
  revalidatePath("/conversas", "layout");

  if (!(await adminRemoveObject(storagePath))) {
    return { ok: false, error: message("storage_object_still_present"), pending: true };
  }
  try {
    await adminFinalizeRemoval({ documentId: parsed.data.documentId, actorUserId: guard.ctx.userId });
  } catch (error) {
    return { ok: false, error: message(codeOf(error)), pending: true };
  }
  await cleanupQuietly();
  return { ok: true };
}
