/**
 * Documentos por caso — trava do recebimento NO SERVIDOR (a primeira de duas; a outra é o portão no banco,
 * `public.case_document_upload_gate`, fechado aos papéis de API, que também nasce fechado).
 *
 * O recebimento de arquivos só abre depois da ativação do backup dos documentos e do teste de recuperação
 * (docs/decisoes/conversas-documentos-caso.md). Até lá: variável AUSENTE, vazia ou com qualquer valor que não
 * seja exatamente "true" = FECHADO. Não há exceção por escritório, papel ou ambiente. Lida a cada chamada (sem
 * cache), em todos os caminhos de envio e finalização — nunca só na tela.
 */
export function caseDocumentsUploadEnabledByServer(): boolean {
  return process.env.CASE_DOCUMENTS_UPLOAD_ENABLED === "true";
}

export const UPLOAD_DISABLED_MESSAGE =
  "O recebimento de documentos aguarda a ativação do backup dos arquivos. Até lá, não é possível anexar.";
