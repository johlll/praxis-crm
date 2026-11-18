import type { MessageStatus } from "@/modules/conversations/queries";
import type { AttendanceStatus, CaseProgressStatus } from "@/modules/status-tracks/schema";

export const MESSAGE_STATUS_LABEL: Record<MessageStatus, string> = {
  queued: "Enviando…",
  // B3.2d-2b1: aceita pelo provedor, ainda sem `sent`.
  accepted: "Aceita",
  sent: "Enviada",
  delivered: "Entregue",
  read: "Lida",
  failed: "Falhou",
};

export const MESSAGE_STATUS_CLASS: Record<MessageStatus, string> = {
  queued: "bg-neutral-bg text-neutral",
  accepted: "bg-neutral-bg text-neutral",
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


/**
 * Cores das situações. "Não informado" é dado legado e se diferencia por
 * contorno tracejado (não é uma situação escolhida por ninguém).
 */
export const ATTENDANCE_STATUS_CLASS: Record<AttendanceStatus, string> = {
  nao_informado: "border border-dashed border-border-strong bg-transparent text-text-muted",
  novo: "bg-info-bg text-info",
  aguardando_escritorio: "bg-warning-bg text-warning",
  aguardando_cliente: "bg-purple-bg text-purple",
  encerrado: "bg-neutral-bg text-neutral",
};

export const CASE_PROGRESS_STATUS_CLASS: Record<CaseProgressStatus, string> = {
  nao_informado: "border border-dashed border-border-strong bg-transparent text-text-muted",
  aguardando_documentos: "bg-warning-bg text-warning",
  documentos_recebidos: "bg-info-bg text-info",
  em_analise: "bg-info-bg text-info",
  aguardando_cliente: "bg-purple-bg text-purple",
  aguardando_terceiros: "bg-purple-bg text-purple",
  em_execucao: "bg-success-bg text-success",
  concluido: "bg-success-bg text-success",
  suspenso: "bg-neutral-bg text-neutral",
};
