import { createCaseDocumentsAdminSupabaseClient } from "@/server/case-documents/admin/supabase";

/**
 * Único ponto de contato com o bucket `case-documents` e com as funções de documento que só o service_role
 * executa. Todo chamador PRECISA já ter conferido a sessão e a permissão; o banco repete papel, escritório,
 * alcance, anonimização e o portão de recebimento. Nada aqui grava em log o nome do arquivo, o caminho, o
 * conteúdo nem a mensagem crua do provedor.
 */

const BUCKET = "case-documents";
/** Links de abertura/download: curtos, gerados a cada clique, nunca reaproveitados. */
export const DOWNLOAD_URL_TTL_SECONDS = 60;

export class CaseDocumentAdminError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "CaseDocumentAdminError";
  }
}

/** Código fechado do banco (mensagem do erro do Postgres), sem detalhe. */
function dbCode(error: { message?: string } | null): string {
  const m = error?.message ?? "";
  return /^[a-z_]{3,60}$/.test(m) ? m : "database_error";
}

export type BeginResult = {
  documentId: string;
  storagePath: string;
  status: "pending" | "ready" | "removing";
  replayed: boolean;
  document: Record<string, unknown>;
};

export async function adminBeginCaseDocument(params: {
  opportunityId: string;
  actorUserId: string;
  name: string;
  declaredType: string;
  declaredSize: number;
  idempotencyKey: string;
}): Promise<BeginResult> {
  const admin = createCaseDocumentsAdminSupabaseClient();
  const { data, error } = await admin.rpc("begin_case_document", {
    p_opportunity_id: params.opportunityId,
    p_actor_user_id: params.actorUserId,
    p_name: params.name,
    p_declared_type: params.declaredType,
    p_declared_size: params.declaredSize,
    p_idempotency_key: params.idempotencyKey,
  });
  if (error) throw new CaseDocumentAdminError(dbCode(error));
  const row = (data ?? {}) as Record<string, unknown>;
  if (typeof row.document_id !== "string" || typeof row.storage_path !== "string") {
    throw new CaseDocumentAdminError("begin_malformed");
  }
  return {
    documentId: row.document_id,
    storagePath: row.storage_path,
    status: row.status as BeginResult["status"],
    replayed: row.replayed === true,
    document: (row.document ?? {}) as Record<string, unknown>,
  };
}

/**
 * Link de ENVIO para um caminho que o banco gerou: o navegador sobe o arquivo direto ao Storage (sem passar
 * pelo limite de corpo da função), sem sobrescrever objeto existente. O Storage aplica o limite de 10 MiB e
 * os tipos do bucket; o servidor confere o conteúdo depois, na finalização. Limitação do provedor: o token de
 * envio vale por 2 horas e só serve para ESTE caminho.
 */
export async function adminCreateUploadToken(storagePath: string): Promise<{ path: string; token: string }> {
  const admin = createCaseDocumentsAdminSupabaseClient();
  const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(storagePath, { upsert: false });
  if (error || !data?.token) throw new CaseDocumentAdminError("upload_token_failed");
  return { path: data.path ?? storagePath, token: data.token };
}

/** Bytes do objeto recebido, para conferir o conteúdo. Ausente → null. */
export async function adminDownloadObject(storagePath: string): Promise<Uint8Array | null> {
  const admin = createCaseDocumentsAdminSupabaseClient();
  const { data, error } = await admin.storage.from(BUCKET).download(storagePath);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

/** Apaga o objeto (idempotente: objeto ausente também é sucesso). Falha → false, sem lançar. */
export async function adminRemoveObject(storagePath: string): Promise<boolean> {
  try {
    const admin = createCaseDocumentsAdminSupabaseClient();
    const { error } = await admin.storage.from(BUCKET).remove([storagePath]);
    return !error;
  } catch {
    return false;
  }
}

export async function adminFinalizeCaseDocument(params: {
  documentId: string;
  actorUserId: string;
  contentType: string;
  byteSize: number;
  checksumSha256: string;
}): Promise<Record<string, unknown>> {
  const admin = createCaseDocumentsAdminSupabaseClient();
  const { data, error } = await admin.rpc("finalize_case_document", {
    p_document_id: params.documentId,
    p_actor_user_id: params.actorUserId,
    p_content_type: params.contentType,
    p_byte_size: params.byteSize,
    p_checksum_sha256: params.checksumSha256,
  });
  if (error) throw new CaseDocumentAdminError(dbCode(error));
  return (data ?? {}) as Record<string, unknown>;
}

/**
 * Envio que não se completou: tenta apagar o objeto e tira a linha pendente. Se o objeto não sair agora, o
 * gatilho do banco põe o caminho na fila de limpeza — nunca fica arquivo sem registro em algum lugar.
 */
export async function adminAbandonCaseDocument(params: {
  documentId: string;
  storagePath: string | null;
  actorUserId: string;
  errorCode: string;
}): Promise<void> {
  if (params.storagePath) await adminRemoveObject(params.storagePath);
  const admin = createCaseDocumentsAdminSupabaseClient();
  await admin.rpc("abandon_case_document", {
    p_document_id: params.documentId,
    p_actor_user_id: params.actorUserId,
    p_error_code: params.errorCode,
  });
}

/** Caminho da linha pendente (para conferir e abandonar), só para quem iniciou o envio. */
export async function adminBeginRemoval(params: { documentId: string; actorUserId: string; reason: string }): Promise<{ storagePath: string }> {
  const admin = createCaseDocumentsAdminSupabaseClient();
  const { data, error } = await admin.rpc("begin_case_document_removal", {
    p_document_id: params.documentId,
    p_actor_user_id: params.actorUserId,
    p_reason: params.reason,
  });
  if (error) throw new CaseDocumentAdminError(dbCode(error));
  const row = (data ?? {}) as Record<string, unknown>;
  if (typeof row.storage_path !== "string") throw new CaseDocumentAdminError("removal_malformed");
  return { storagePath: row.storage_path };
}

export async function adminFinalizeRemoval(params: { documentId: string; actorUserId: string | null }): Promise<boolean> {
  const admin = createCaseDocumentsAdminSupabaseClient();
  const { data, error } = await admin.rpc("finalize_case_document_removal", {
    p_document_id: params.documentId,
    p_actor_user_id: params.actorUserId as string,
  });
  if (error) throw new CaseDocumentAdminError(dbCode(error));
  return data === true;
}

/**
 * Nome do arquivo BAIXADO: o original sem acentos e só com letras, números, espaço, ponto, hífen e sublinhado.
 * Motivo: o cliente do Storage codifica duas vezes o parâmetro `download` (URLSearchParams + encodeURI), e um
 * nome com acento chegaria como "Matr%C3%ADcula…". O nome original completo continua na tela e no banco.
 */
export function downloadFileName(name: string): string {
  const ascii = name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/_+/g, "_").trim();
  return ascii.replace(/^[._ -]+/, "") || "documento";
}

/** Link temporário (60 s) para abrir no navegador ou baixar (com o nome original sem acentos). */
export async function adminCreateDownloadUrl(params: { storagePath: string; name: string; mode: "abrir" | "baixar" }): Promise<string> {
  const admin = createCaseDocumentsAdminSupabaseClient();
  const { data, error } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(params.storagePath, DOWNLOAD_URL_TTL_SECONDS, params.mode === "baixar" ? { download: downloadFileName(params.name) } : undefined);
  if (error || !data?.signedUrl) throw new CaseDocumentAdminError("signed_url_failed");
  return data.signedUrl;
}

/**
 * Limpeza oportunista, limitada, que nunca falha quem chamou: envios abandonados há mais de 3 horas, remoções
 * interrompidas e objetos da fila (linha apagada por exclusão administrativa). Só tira da fila o que o banco
 * confirma que já não existe no Storage. Devolve contagens (sem caminhos).
 */
export async function adminRunCaseDocumentCleanup(limit = 10): Promise<{ removals: number; objects: number; pending: number }> {
  const out = { removals: 0, objects: 0, pending: 0 };
  try {
    const admin = createCaseDocumentsAdminSupabaseClient();
    const { data, error } = await admin.rpc("case_document_cleanup_claim", { p_limit: limit });
    if (error || !data) return out;
    const claim = data as { removals?: { document_id: string; storage_path: string }[]; objects?: { cleanup_id: string; storage_path: string }[] };
    for (const r of claim.removals ?? []) {
      if (!(await adminRemoveObject(r.storage_path))) { out.pending += 1; continue; }
      try {
        if (await adminFinalizeRemoval({ documentId: r.document_id, actorUserId: null })) out.removals += 1;
      } catch {
        out.pending += 1;
      }
    }
    for (const o of claim.objects ?? []) {
      if (!(await adminRemoveObject(o.storage_path))) { out.pending += 1; continue; }
      const { data: done } = await admin.rpc("case_document_cleanup_complete", { p_cleanup_id: o.cleanup_id });
      if (done === true) out.objects += 1;
      else out.pending += 1;
    }
  } catch {
    // Melhor esforço: a fila continua registrada no banco e é retomada na próxima chamada.
  }
  return out;
}
