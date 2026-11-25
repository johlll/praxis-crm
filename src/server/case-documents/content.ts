import { createHash } from "node:crypto";

import { CASE_DOCUMENT_MAX_BYTES, type CaseDocumentType } from "@/modules/case-documents/schema";

/**
 * Documentos por caso — conferência do CONTEÚDO do arquivo no servidor, depois que ele chegou ao Storage e
 * antes de ficar visível. Decide pelo conteúdo, nunca pela extensão nem pelo tipo que o navegador declarou.
 *
 * O que isto prova: que os bytes têm a estrutura mínima de um PDF, JPEG ou PNG completo (assinatura no
 * início e marca de fim, o que também pega upload truncado). O que NÃO prova: que o arquivo é seguro. Isto
 * NÃO é antivírus nem verificação de conteúdo malicioso — um PDF bem formado pode carregar qualquer coisa.
 * O arquivo nunca é executado nem interpretado pelo app; ele só é guardado e devolvido por link temporário.
 */

export type ContentCheck =
  | { ok: true; type: CaseDocumentType; byteSize: number; checksumSha256: string }
  | { ok: false; code: "case_document_empty" | "case_document_too_large" | "case_document_content_invalid" | "case_document_content_mismatch" };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_IEND = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];

function startsWith(bytes: Uint8Array, sig: readonly number[], at = 0): boolean {
  if (bytes.length < at + sig.length) return false;
  return sig.every((b, i) => bytes[at + i] === b);
}

function lastIndexOfAscii(bytes: Uint8Array, text: string, fromEndWindow: number): number {
  const needle = Array.from(text, (c) => c.charCodeAt(0));
  const start = Math.max(0, bytes.length - fromEndWindow);
  for (let i = bytes.length - needle.length; i >= start; i -= 1) {
    if (needle.every((b, j) => bytes[i + j] === b)) return i;
  }
  return -1;
}

/** Tipo pelo conteúdo, ou null quando não é um PDF/JPEG/PNG completo. */
export function detectContentType(bytes: Uint8Array): CaseDocumentType | null {
  // PDF: "%PDF-" no início (tolerando até 1 KiB de lixo, como os leitores) e "%%EOF" no último 1 KiB.
  const head = Math.min(bytes.length, 1024);
  for (let i = 0; i + 5 <= head; i += 1) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) {
      return lastIndexOfAscii(bytes, "%%EOF", 1024) >= 0 ? "application/pdf" : null;
    }
  }
  // JPEG: FF D8 FF no início e FF D9 no fim (até alguns bytes de preenchimento).
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    for (let i = bytes.length - 2; i >= Math.max(2, bytes.length - 64); i -= 1) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) return "image/jpeg";
    }
    return null;
  }
  // PNG: assinatura de 8 bytes e o bloco IEND (com o CRC fixo) no fim.
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return bytes.length >= 20 && startsWith(bytes, PNG_IEND, bytes.length - PNG_IEND.length) ? "image/png" : null;
  }
  return null;
}

/** Confere o arquivo recebido contra o tipo declarado e o limite. Devolve tipo, tamanho e SHA-256. */
export function checkUploadedContent(bytes: Uint8Array, declaredType: CaseDocumentType): ContentCheck {
  if (bytes.length === 0) return { ok: false, code: "case_document_empty" };
  if (bytes.length > CASE_DOCUMENT_MAX_BYTES) return { ok: false, code: "case_document_too_large" };
  const detected = detectContentType(bytes);
  if (!detected) return { ok: false, code: "case_document_content_invalid" };
  if (detected !== declaredType) return { ok: false, code: "case_document_content_mismatch" };
  return {
    ok: true,
    type: detected,
    byteSize: bytes.length,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
