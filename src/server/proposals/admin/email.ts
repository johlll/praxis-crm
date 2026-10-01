import { createProposalsAdminSupabaseClient } from "@/server/proposals/admin/supabase";
import { getResendConfig } from "@/server/proposals/env";

/**
 * Mesma regra de src/server/proposals/admin/documents.ts: só chamado
 * depois que a sessão do usuário já foi verificada e autorizada. As RPCs
 * de resultado (mark_proposal_email_sent/failed) têm GRANT só para
 * service_role — nenhum usuário autenticado consegue forjar "e-mail
 * aceito pelo provedor" chamando a RPC direto (B1, correção 3).
 */

export type QueueProposalEmailResult = {
  sendId: string;
  status: "queued" | "accepted" | "failed";
  isNew: boolean;
};

export async function adminQueueProposalEmail(params: {
  proposalId: string;
  documentId: string;
  toEmail: string;
  idempotencyKey: string;
  actorUserId: string;
}): Promise<QueueProposalEmailResult> {
  const admin = createProposalsAdminSupabaseClient();
  const { data, error } = await admin.rpc("queue_proposal_email", {
    p_proposal_id: params.proposalId,
    p_document_id: params.documentId,
    p_to_email: params.toEmail,
    p_idempotency_key: params.idempotencyKey,
    p_actor_user_id: params.actorUserId,
  });

  if (error) throw new Error(error.message);
  const row = data?.[0];
  if (!row) throw new Error("queue_proposal_email_no_row");

  return { sendId: row.send_id, status: row.status, isNew: row.is_new };
}

/**
 * Marca um envio já enfileirado como falho sem nunca ter chamado o
 * provedor — usado quando a checagem do anexo recusa a versão antes do
 * despacho. Evita a linha ficar presa em `queued` (estado ambíguo que
 * não é reprocessado por ninguém).
 */
export async function adminFailProposalEmail(sendId: string, errorCode: string): Promise<void> {
  const admin = createProposalsAdminSupabaseClient();
  await admin.rpc("mark_proposal_email_failed", {
    p_send_id: sendId,
    p_error_code: errorCode.slice(0, 100),
  });
}

/**
 * Só chamado quando queue retornou isNew=true — é isso que garante que a
 * MESMA intenção (mesma idempotency_key), repetida por retry de rede ou
 * duplo clique, nunca chega a chamar o Resend duas vezes (B1, correção 1).
 * A idempotency_key também vai no cabeçalho da API do Resend, que a
 * documentação do provedor honra por 24h — segunda camada, não a única.
 *
 * "accepted" (nunca "sent"/"failed" depois que o provedor já aceitou):
 * uma vez que o Resend confirma, NUNCA chamamos mark_failed depois disso
 * — isso mentiria sobre o que já aconteceu (B1, correção 2). Se o
 * registro de "accepted" no nosso banco falhar depois da confirmação do
 * provedor, a linha fica 'queued' (estado ambíguo, nunca reenviada
 * automaticamente) para conferência manual.
 */
export async function adminDispatchProposalEmail(params: {
  sendId: string;
  toEmail: string;
  idempotencyKey: string;
  pdfBytes: Buffer;
  pdfFileName: string;
  subject: string;
  bodyText: string;
}): Promise<{ providerMessageId: string }> {
  const admin = createProposalsAdminSupabaseClient();
  const resendConfig = getResendConfig();

  if (!resendConfig) {
    await admin.rpc("mark_proposal_email_failed", {
      p_send_id: params.sendId,
      p_error_code: "resend_not_configured",
    });
    throw new Error("resend_not_configured");
  }

  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendConfig.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": params.idempotencyKey,
      },
      body: JSON.stringify({
        from: resendConfig.fromEmail,
        to: [params.toEmail],
        subject: params.subject,
        text: params.bodyText,
        attachments: [{ filename: params.pdfFileName, content: params.pdfBytes.toString("base64") }],
      }),
    });
  } catch (networkError) {
    await admin.rpc("mark_proposal_email_failed", {
      p_send_id: params.sendId,
      p_error_code: "network_error",
    });
    throw networkError instanceof Error ? networkError : new Error("network_error");
  }

  if (!response.ok) {
    await admin.rpc("mark_proposal_email_failed", {
      p_send_id: params.sendId,
      p_error_code: `resend_http_${response.status}`,
    });
    throw new Error(`resend_rejected_${response.status}`);
  }

  const body = (await response.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) {
    await admin.rpc("mark_proposal_email_failed", {
      p_send_id: params.sendId,
      p_error_code: "resend_missing_message_id",
    });
    throw new Error("resend_missing_message_id");
  }

  const { error: markError } = await admin.rpc("mark_proposal_email_sent", {
    p_send_id: params.sendId,
    p_provider_message_id: body.id,
  });
  if (markError) {
    throw new Error("mark_proposal_email_sent_failed_after_provider_accepted");
  }

  return { providerMessageId: body.id };
}
