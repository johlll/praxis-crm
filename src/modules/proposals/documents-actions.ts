"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requirePermissionSafe } from "@/server/authz/safe";
import { createServerSupabaseClient } from "@/server/supabase/server";
import { decryptCpfCnpj } from "@/server/crypto/contact-sensitive";
import { toUserMessage } from "@/lib/errors";
import { uuidSchema } from "@/lib/uuid";
import {
  adminBeginProposalDocument,
  adminUploadAndFinalizeProposalDocument,
  adminDownloadProposalDocumentBytes,
} from "@/server/proposals/admin/documents";
import { adminQueueProposalEmail, adminDispatchProposalEmail } from "@/server/proposals/admin/email";
import { renderProposalPdf, type ProposalPdfData } from "@/server/proposals/pdf-template";
import type { FeeModel } from "./queries";

export type ProposalDocumentActionState = {
  ok: boolean;
  error?: string;
  documentId?: string;
  version?: number;
};

export type SendProposalEmailActionState = {
  ok: boolean;
  error?: string;
  status?: "accepted" | "queued";
};

/**
 * Dados para o template do PDF, sob a SESSÃO do usuário (RLS de verdade) —
 * nunca sob o cliente admin. `get_proposal` já devolve `{}` financeiro
 * para quem não pode ver o valor exato; como só quem tem
 * `proposal_document.manage` chega aqui, `value_cents`/`fee_model`
 * sempre vêm preenchidos — a checagem abaixo é defesa em profundidade,
 * não o mecanismo principal.
 */
async function loadProposalPdfContext(proposalId: string): Promise<{
  workspaceId: string;
  legalArea: string | null;
  pdfData: ProposalPdfData;
}> {
  const supabase = await createServerSupabaseClient();

  const { data: proposalJson, error: proposalError } = await supabase.rpc("get_proposal", {
    p_proposal_id: proposalId,
  });
  if (proposalError || !proposalJson) throw new Error(toUserMessage(proposalError));

  const proposal = proposalJson as unknown as {
    lead_id?: string;
    number: string;
    value_cents?: number;
    fee_model?: FeeModel;
    created_at: string;
  };
  if (proposal.value_cents === undefined || proposal.fee_model === undefined) {
    throw new Error("insufficient_permission");
  }

  if (!proposal.lead_id) throw new Error("insufficient_permission");

  // leads é RLS deny-all direto (mesmo padrão de proposals) — leitura só
  // por get_lead, que já projeta contact_name junto (evita uma consulta a
  // mais em contacts).
  const { data: leadJson, error: leadError } = await supabase.rpc("get_lead", { p_lead_id: proposal.lead_id });
  if (leadError || !leadJson) throw new Error(toUserMessage(leadError));

  const lead = leadJson as unknown as {
    workspace_id: string;
    contact_id: string;
    contact_name: string;
    legal_area: string | null;
  };

  const { data: workspace, error: workspaceError } = await supabase
    .from("workspaces")
    .select("legal_name, cnpj, oab_uf, oab_number, address_line, address_city, address_uf, address_zip")
    .eq("id", lead.workspace_id)
    .single();
  if (workspaceError || !workspace) throw new Error(toUserMessage(workspaceError));

  let cpfCnpj: string | null = null;
  const { data: hasSensitive } = await supabase.rpc("contact_has_sensitive", { p_contact_id: lead.contact_id });
  if (hasSensitive) {
    const { data: revealed } = await supabase.rpc("reveal_contact_cpf_cnpj", {
      p_contact_id: lead.contact_id,
      p_reason: "Geração de PDF de proposta",
    });
    const row = revealed?.[0];
    if (row) cpfCnpj = decryptCpfCnpj(row.ciphertext_base64, row.key_version);
  }

  return {
    workspaceId: lead.workspace_id,
    legalArea: lead.legal_area,
    pdfData: {
      office: {
        legalName: workspace.legal_name,
        cnpj: workspace.cnpj,
        oabUf: workspace.oab_uf,
        oabNumber: workspace.oab_number,
        addressLine: workspace.address_line,
        addressCity: workspace.address_city,
        addressUf: workspace.address_uf,
        addressZip: workspace.address_zip,
      },
      client: { name: lead.contact_name, cpfCnpj },
      proposal: {
        number: proposal.number,
        valueCents: proposal.value_cents,
        feeModel: proposal.fee_model,
        createdAt: proposal.created_at,
      },
      legalArea: lead.legal_area,
    },
  };
}

export async function generateProposalDocumentAction(
  leadId: string,
  _prevState: ProposalDocumentActionState,
  formData: FormData,
): Promise<ProposalDocumentActionState> {
  const guard = await requirePermissionSafe("proposal_document.manage");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsedProposalId = uuidSchema.safeParse(formData.get("proposalId"));
  if (!parsedProposalId.success) return { ok: false, error: "Dados inválidos." };
  const proposalId = parsedProposalId.data;

  let context: Awaited<ReturnType<typeof loadProposalPdfContext>>;
  try {
    context = await loadProposalPdfContext(proposalId);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Não foi possível carregar a proposta." };
  }

  let begun;
  try {
    begun = await adminBeginProposalDocument(proposalId, guard.ctx.userId);
  } catch (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  try {
    const pdfBytes = await renderProposalPdf(context.pdfData);
    await adminUploadAndFinalizeProposalDocument({
      documentId: begun.documentId,
      storagePath: begun.storagePath,
      pdfBytes,
      actorUserId: guard.ctx.userId,
    });
  } catch {
    return { ok: false, error: "Não foi possível gerar o PDF. Tente novamente." };
  }

  revalidatePath(`/leads/${leadId}`);
  return { ok: true, documentId: begun.documentId, version: begun.version };
}

const dispatchEmailSchema = z.object({
  proposalId: uuidSchema,
  documentId: uuidSchema,
  toEmail: z.string().trim().email(),
  idempotencyKey: uuidSchema,
});

/**
 * "Enviar por e-mail" real (B1). idempotencyKey vem do CLIENTE, gerado uma
 * única vez por abertura do diálogo de envio (mesmo truque de
 * remount-por-key já usado em CreateProposalDialog) — reenviar o MESMO
 * clique (duplo clique, retry de formulário) chega aqui com a MESMA
 * chave, e queue_proposal_email garante que só quem CRIA a linha chama o
 * Resend (B1, correção 1).
 */
export async function dispatchProposalEmailAction(
  leadId: string,
  _prevState: SendProposalEmailActionState,
  formData: FormData,
): Promise<SendProposalEmailActionState> {
  const guard = await requirePermissionSafe("proposal_document.manage");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsed = dispatchEmailSchema.safeParse({
    proposalId: formData.get("proposalId"),
    documentId: formData.get("documentId"),
    toEmail: formData.get("toEmail"),
    idempotencyKey: formData.get("idempotencyKey"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  let queued;
  try {
    queued = await adminQueueProposalEmail({
      proposalId: parsed.data.proposalId,
      documentId: parsed.data.documentId,
      toEmail: parsed.data.toEmail,
      idempotencyKey: parsed.data.idempotencyKey,
      actorUserId: guard.ctx.userId,
    });
  } catch (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  if (!queued.isNew) {
    // Mesma intenção já registrada por uma chamada anterior (retry/duplo
    // clique) — nunca chama o Resend de novo a partir daqui.
    if (queued.status === "accepted") return { ok: true, status: "accepted" };
    if (queued.status === "failed") return { ok: false, error: "O envio anterior falhou. Tente novamente." };
    return { ok: true, status: "queued" };
  }

  // Anexa os bytes EXATOS já armazenados (nunca re-renderiza a partir do
  // estado atual dos dados) — é isso que garante que o e-mail carrega a
  // MESMA versão imutável que finalize_proposal_document conferiu contra
  // storage.objects, nunca uma reconstrução que poderia divergir do
  // checksum gravado (B1, correção 1).
  const supabase = await createServerSupabaseClient();
  const { data: proposalJson, error: proposalError } = await supabase.rpc("get_proposal", {
    p_proposal_id: parsed.data.proposalId,
  });
  if (proposalError || !proposalJson) return { ok: false, error: toUserMessage(proposalError) };
  const proposalNumber = (proposalJson as unknown as { number: string }).number;

  const { data: downloadInfo, error: downloadInfoError } = await supabase.rpc("get_proposal_document_for_download", {
    p_document_id: parsed.data.documentId,
  });
  if (downloadInfoError || !downloadInfo) return { ok: false, error: toUserMessage(downloadInfoError) };
  const storagePath = (downloadInfo as unknown as { storagePath: string }).storagePath;

  let pdfBytes: Buffer;
  try {
    pdfBytes = await adminDownloadProposalDocumentBytes(storagePath);
  } catch {
    return { ok: false, error: "Não foi possível preparar o anexo. Tente novamente." };
  }

  try {
    await adminDispatchProposalEmail({
      sendId: queued.sendId,
      toEmail: parsed.data.toEmail,
      idempotencyKey: parsed.data.idempotencyKey,
      pdfBytes,
      pdfFileName: `${proposalNumber}.pdf`,
      subject: `Proposta de honorários ${proposalNumber}`,
      bodyText: `Segue em anexo a proposta de honorários ${proposalNumber}.`,
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? toUserMessage(error) : "Não foi possível enviar o e-mail." };
  }

  revalidatePath(`/leads/${leadId}`);
  return { ok: true, status: "accepted" };
}
