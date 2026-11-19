import { z } from "zod";

/**
 * Observações por caso (docs/decisoes/conversas-observacoes-caso.md). Regras puras: o formato de uma
 * observação, a validação do pedido de escrita e do pedido de página. Sem servidor nem banco aqui.
 */

export const CASE_NOTE_MAX = 4000;
/** Observações mostradas no Resumo (as mais recentes); as anteriores vêm por página, sob pedido. */
export const CASE_NOTES_SUMMARY = 3;
/** Tamanho de cada página de observações anteriores. */
export const CASE_NOTES_PAGE = 10;

export type CaseNote = {
  id: string;
  opportunityId: string;
  /** Texto como foi registrado (quebras de linha preservadas). Exibido SEMPRE como texto, nunca como HTML. */
  body: string;
  authorName: string | null;
  createdAt: string;
};

/** Posição na lista: a última observação mostrada. O horário volta ao banco exatamente como veio (microssegundos). */
export type CaseNotesCursor = { before: string; beforeId: string };

export type CaseNotesPage = { items: CaseNote[]; hasMore: boolean; next: CaseNotesCursor | null };

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function mapCaseNote(row: Record<string, unknown>): CaseNote {
  return {
    id: row.id as string,
    opportunityId: row.opportunity_id as string,
    body: typeof row.body === "string" ? row.body : "",
    authorName: str(row.author_name),
    createdAt: row.created_at as string,
  };
}

/** Mesma normalização do banco: CRLF vira LF; só as bordas são aparadas (as quebras internas ficam). */
export function normalizeNoteBody(body: string): string {
  return body.replace(/\r\n/g, "\n").replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
}

const id = (message: string) => z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, message);

export const addCaseNoteSchema = z.object({
  opportunityId: id("Caso inválido."),
  body: z
    .string()
    .transform(normalizeNoteBody)
    .pipe(
      z
        .string()
        .min(1, "Escreva a observação antes de registrar.")
        .max(CASE_NOTE_MAX, `A observação tem até ${CASE_NOTE_MAX.toLocaleString("pt-BR")} caracteres.`),
    ),
  idempotencyKey: id("Pedido inválido. Recarregue a página."),
});

export const caseNotesPageSchema = z.object({
  opportunityId: id("Caso inválido."),
  before: z.string().refine((v) => !Number.isNaN(Date.parse(v)), { message: "Posição da lista inválida." }),
  beforeId: id("Posição da lista inválida."),
});
