import { createServerSupabaseClient } from "@/server/supabase/server";
import { DataLoadError } from "@/server/data/load-error";
import type { Database } from "@/server/types/database";

export type ProposalDocumentStatus = Database["public"]["Enums"]["proposal_document_status"];
export type ProposalEmailSendStatus = Database["public"]["Enums"]["proposal_email_send_status"];

export type ProposalDocumentListItem = {
  id: string;
  version: number;
  status: ProposalDocumentStatus;
  requestedAt: string;
  resolvedAt: string | null;
  canDownload: boolean;
};

export type ProposalEmailSendListItem = {
  id: string;
  documentId: string;
  toEmail: string;
  status: ProposalEmailSendStatus;
  errorCode: string | null;
  requestedAt: string;
  resolvedAt: string | null;
};

export class ProposalDocumentsLoadError extends DataLoadError {
  constructor(resource: string, cause?: unknown) {
    super(resource, cause);
    this.name = "ProposalDocumentsLoadError";
  }
}

function mapDocumentRow(row: Record<string, unknown>): ProposalDocumentListItem {
  return {
    id: row.id as string,
    version: row.version as number,
    status: row.status as ProposalDocumentStatus,
    requestedAt: row.requestedAt as string,
    resolvedAt: (row.resolvedAt as string | null) ?? null,
    canDownload: row.canDownload as boolean,
  };
}

function mapEmailSendRow(row: Record<string, unknown>): ProposalEmailSendListItem {
  return {
    id: row.id as string,
    documentId: row.documentId as string,
    toEmail: row.toEmail as string,
    status: row.status as ProposalEmailSendStatus,
    errorCode: (row.errorCode as string | null) ?? null,
    requestedAt: row.requestedAt as string,
    resolvedAt: (row.resolvedAt as string | null) ?? null,
  };
}

export async function listProposalDocuments(proposalId: string): Promise<ProposalDocumentListItem[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_proposal_documents", { p_proposal_id: proposalId });

  if (error) throw new ProposalDocumentsLoadError(`os documentos da proposta ${proposalId}`, error);

  return ((data as unknown as Array<Record<string, unknown>> | null) ?? []).map(mapDocumentRow);
}

export async function listProposalEmailSends(proposalId: string): Promise<ProposalEmailSendListItem[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_proposal_email_sends", { p_proposal_id: proposalId });

  if (error) throw new ProposalDocumentsLoadError(`os envios por e-mail da proposta ${proposalId}`, error);

  return ((data as unknown as Array<Record<string, unknown>> | null) ?? []).map(mapEmailSendRow);
}

/** E-mails já conhecidos do contato — o destinatário do envio real vem de
 * um destes, nunca de texto livre digitado na hora (B1, correção 6). */
export async function listContactEmailsForProposal(contactId: string): Promise<string[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("contact_emails")
    .select("value_normalized")
    .eq("contact_id", contactId)
    .order("is_primary", { ascending: false });

  if (error) throw new ProposalDocumentsLoadError(`os e-mails do contato ${contactId}`, error);
  return (data ?? []).map((row) => row.value_normalized);
}

/** queue_proposal_email exige workspaces.legal_name preenchido para
 * qualquer envio real (B1, correção 6) — a UI usa isto só para explicar
 * de antemão por que o botão está desabilitado, nunca como a checagem
 * autoritativa (essa é sempre a RPC). */
export async function hasWorkspaceLegalProfile(workspaceId: string): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.from("workspaces").select("legal_name").eq("id", workspaceId).single();

  if (error) throw new ProposalDocumentsLoadError(`o perfil jurídico do workspace ${workspaceId}`, error);
  return Boolean(data?.legal_name);
}
