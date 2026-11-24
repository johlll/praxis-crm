import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";

/**
 * Documentos por caso (docs/decisoes/conversas-documentos-caso.md) — parte pura, sem servidor: limites,
 * códigos fechados, rótulos e o formato validado do que o banco devolve. Serve à tela, às ações e aos testes.
 *
 * Um documento pertence à OPORTUNIDADE (o caso), nunca ao contato inteiro. A conferência é humana e
 * explícita; "Conferido" não é aprovação jurídica automática, e nada aqui muda andamento, roteiro, situação do
 * atendimento ou etapa comercial.
 */

/** Limite por arquivo: o mesmo do bucket (10 MiB) e das propostas. */
export const CASE_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const CASE_DOCUMENT_NAME_MAX = 180;
export const CASE_DOCUMENT_NOTE_MAX = 1000;

export const CASE_DOCUMENT_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export type CaseDocumentType = (typeof CASE_DOCUMENT_TYPES)[number];

export const CASE_DOCUMENT_TYPE_LABEL: Record<CaseDocumentType, string> = {
  "application/pdf": "PDF",
  "image/jpeg": "JPEG",
  "image/png": "PNG",
};

/** O que o seletor de arquivo oferece (a extensão só ajuda a escolher; quem decide é o conteúdo, no servidor). */
export const CASE_DOCUMENT_ACCEPT = ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png";

/**
 * Arquivo recusado ou envio interrompido: "Nada foi guardado" SÓ com a confirmação do banco e do Storage
 * (cancelamento concluído). Sem ela, a tela diz exatamente o que se sabe.
 */
export const DISCARD_CONFIRMED = "Nada foi guardado.";
export const DISCARD_PENDING =
  "O arquivo não ficou visível no caso; a exclusão do que chegou ao armazenamento ficou registrada para a limpeza.";
export const DISCARD_UNCONFIRMED =
  "O arquivo não ficou visível no caso, mas não foi possível confirmar a exclusão agora; ela ficou registrada para a limpeza.";

export const REVIEW_STATUSES = ["recebido", "conferido", "com_pendencia"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  recebido: "Recebido",
  conferido: "Conferido",
  com_pendencia: "Com pendência",
};

export const REMOVAL_REASONS = [
  "enviado_por_engano",
  "duplicado",
  "arquivo_errado",
  "solicitacao_do_titular",
  "outro",
] as const;
export type RemovalReason = (typeof REMOVAL_REASONS)[number];

export const REMOVAL_REASON_LABEL: Record<RemovalReason, string> = {
  enviado_por_engano: "Enviado por engano",
  duplicado: "Duplicado",
  arquivo_errado: "Arquivo errado ou ilegível",
  solicitacao_do_titular: "Pedido do titular",
  outro: "Outro motivo",
};

export type CaseDocumentStatus = "ready" | "removing";

export type CaseDocument = {
  id: string;
  opportunityId: string;
  status: CaseDocumentStatus;
  name: string;
  contentType: CaseDocumentType;
  byteSize: number;
  uploadedByName: string | null;
  uploadedAt: string;
  reviewStatus: ReviewStatus;
  reviewNote: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewVersion: number;
  removalRequestedAt: string | null;
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function isCaseDocumentType(v: unknown): v is CaseDocumentType {
  return typeof v === "string" && (CASE_DOCUMENT_TYPES as readonly string[]).includes(v);
}

export function isReviewStatus(v: unknown): v is ReviewStatus {
  return typeof v === "string" && (REVIEW_STATUSES as readonly string[]).includes(v);
}

/** Linha do banco → modelo da tela. Estrutura inesperada lança (nunca vira documento "vazio"). */
export function mapCaseDocument(row: Record<string, unknown>): CaseDocument {
  const id = str(row.id);
  const opportunityId = str(row.opportunity_id);
  const status = row.status === "ready" || row.status === "removing" ? row.status : null;
  const contentType = isCaseDocumentType(row.content_type) ? row.content_type : null;
  const reviewStatus = isReviewStatus(row.review_status) ? row.review_status : null;
  const name = str(row.name);
  const uploadedAt = str(row.uploaded_at);
  if (!id || !opportunityId || !status || !contentType || !reviewStatus || !name || !uploadedAt || typeof row.byte_size !== "number" || typeof row.review_version !== "number") {
    throw new Error("case_document_malformed");
  }
  return {
    id,
    opportunityId,
    status,
    name,
    contentType,
    byteSize: row.byte_size,
    uploadedByName: str(row.uploaded_by_name),
    uploadedAt,
    reviewStatus,
    reviewNote: str(row.review_note),
    reviewedByName: str(row.reviewed_by_name),
    reviewedAt: str(row.reviewed_at),
    reviewVersion: row.review_version,
    removalRequestedAt: str(row.removal_requested_at),
  };
}

/** "1,4 MB", "820 KB", "512 bytes" — tamanho legível, sem casas inúteis. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} bytes`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.max(1, Math.round(kb))} KB`;
  const mb = kb / 1024;
  return `${mb.toLocaleString("pt-BR", { maximumFractionDigits: 1, minimumFractionDigits: 0 })} MB`;
}

/**
 * Nome só para exibição (o mesmo critério do banco): sem caminho, sem caracteres de controle nem marcas de
 * direção de texto, espaços normalizados, até 180 caracteres. Nunca vira caminho no Storage.
 */
export function cleanDocumentName(raw: string): string {
  let v = raw.normalize("NFC");
  v = v.replace(/^.*[/\\]/, "");
  v = v.replace(/\s+/g, " ");
  v = v.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "").trim();
  if (v.length > CASE_DOCUMENT_NAME_MAX) v = v.slice(0, CASE_DOCUMENT_NAME_MAX);
  if (v === "" || v === "." || v === "..") v = "documento";
  return v;
}

/** Pré-conferência na tela (só para avisar cedo; o servidor confere o CONTEÚDO de novo, sempre). */
export function precheckFile(file: { name: string; size: number; type: string }): { ok: true; type: CaseDocumentType } | { ok: false; error: string } {
  if (file.size <= 0) return { ok: false, error: "O arquivo está vazio." };
  if (file.size > CASE_DOCUMENT_MAX_BYTES) return { ok: false, error: "O arquivo passa de 10 MB, o limite por documento." };
  const ext = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const byExt: Record<string, CaseDocumentType> = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" };
  const type = isCaseDocumentType(file.type) ? file.type : byExt[ext];
  if (!type) return { ok: false, error: "Formato não aceito. Envie PDF, JPEG ou PNG." };
  return { ok: true, type };
}

export const beginUploadSchema = z.object({
  opportunityId: uuidSchema,
  name: z.string().min(1, "Arquivo sem nome.").max(1000),
  type: z.enum(CASE_DOCUMENT_TYPES, { message: "Formato não aceito. Envie PDF, JPEG ou PNG." }),
  size: z
    .number()
    .int()
    .min(1, "O arquivo está vazio.")
    .max(CASE_DOCUMENT_MAX_BYTES, "O arquivo passa de 10 MB, o limite por documento."),
  idempotencyKey: uuidSchema,
});

export const documentIdSchema = z.object({ documentId: uuidSchema });

export const reviewSchema = z
  .object({
    documentId: uuidSchema,
    status: z.enum(REVIEW_STATUSES),
    note: z.string().max(CASE_DOCUMENT_NOTE_MAX, `A observação passa de ${CASE_DOCUMENT_NOTE_MAX} caracteres.`).default(""),
    expectedVersion: z.number().int().min(0),
  })
  .refine((v) => v.status !== "com_pendencia" || v.note.trim().length > 0, {
    message: "Descreva a pendência para registrar “Com pendência”.",
    path: ["note"],
  });

export const removalSchema = z.object({
  documentId: uuidSchema,
  reason: z.enum(REMOVAL_REASONS, { message: "Escolha o motivo da remoção." }),
});
