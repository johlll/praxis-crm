import { createServerSupabaseClient } from "@/server/supabase/server";
import { DataLoadError, isExpectedAbsence } from "@/server/data/load-error";
import { listProposalsForLead } from "@/modules/proposals/queries";
import { listProposalDocuments } from "@/modules/proposals/documents-queries";

import { mapCaseDocument, type CaseDocument } from "./schema";

/**
 * Documentos por caso — leitura no servidor. Contrato de erro do painel: ausência legítima (caso inexistente,
 * fora do alcance, outro escritório) → `null`; qualquer outra falha sobe como `CaseDocumentsLoadError` — NUNCA
 * vira "nenhum documento".
 */

export class CaseDocumentsLoadError extends DataLoadError {
  constructor(resource: string, cause?: unknown) {
    super(resource, cause);
    this.name = "CaseDocumentsLoadError";
  }
}

const ABSENCE = ["opportunity_not_found", "insufficient_permission"] as const;

export type CaseDocumentsData = {
  items: CaseDocument[];
  /** Portão do banco (o servidor ainda soma a trava da variável de ambiente). */
  uploadGateOpen: boolean;
};

export async function listCaseDocuments(opportunityId: string): Promise<CaseDocumentsData | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_case_documents", { p_opportunity_id: opportunityId });
  if (error) {
    if (isExpectedAbsence(error, ABSENCE)) return null;
    throw new CaseDocumentsLoadError(`os documentos do caso ${opportunityId}`, error);
  }
  const row = (data ?? null) as { items?: unknown; upload_gate_open?: unknown } | null;
  if (!row || !Array.isArray(row.items)) throw new CaseDocumentsLoadError(`os documentos do caso ${opportunityId}`);
  return {
    items: (row.items as Record<string, unknown>[]).map(mapCaseDocument),
    uploadGateOpen: row.upload_gate_open === true,
  };
}

/** PDF de proposta já gerado pelo Praxis, ligado a este caso pela proposta (vínculo existente). */
export type CaseProposalPdf = {
  documentId: string;
  proposalNumber: string;
  version: number;
  generatedAt: string;
  canDownload: boolean;
};

/**
 * Propostas do lead cuja oportunidade é ESTE caso, com as versões de PDF prontas. Só leitura e só pelo que já
 * existe: nenhum arquivo é copiado, e o download continua sendo o das propostas (com a permissão delas).
 */
export async function listCaseProposalPdfs(leadId: string, opportunityId: string): Promise<CaseProposalPdf[]> {
  const proposals = (await listProposalsForLead(leadId)).filter((p) => p.opportunityId === opportunityId);
  const perProposal = await Promise.all(
    proposals.map(async (p) => {
      const docs = await listProposalDocuments(p.id);
      return docs
        .filter((d) => d.status === "ready")
        .map((d) => ({
          documentId: d.id,
          proposalNumber: p.number,
          version: d.version,
          generatedAt: d.resolvedAt ?? d.requestedAt,
          canDownload: d.canDownload,
        }));
    }),
  );
  return perProposal.flat().sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}
