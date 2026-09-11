import type { MessageStatus } from "@/modules/conversations/queries";

export const MESSAGE_STATUS_LABEL: Record<MessageStatus, string> = {
  queued: "Enviando…",
  sent: "Enviada",
  delivered: "Entregue",
  read: "Lida",
  failed: "Falhou",
};

export const MESSAGE_STATUS_CLASS: Record<MessageStatus, string> = {
  queued: "bg-neutral-bg text-neutral",
  sent: "bg-neutral-bg text-neutral",
  delivered: "bg-info-bg text-info",
  read: "bg-success-bg text-success",
  failed: "bg-danger-bg text-danger",
};

export const CONSENT_LEGAL_BASIS_LABEL: Record<string, string> = {
  consentimento: "Consentimento",
  legitimo_interesse: "Legítimo interesse",
  execucao_de_contrato: "Execução de contrato",
  obrigacao_legal: "Obrigação legal",
  outro: "Outro",
};
