import { z } from "zod";

/**
 * C3b — retenção e anonimização (parte pura, sem servidor): códigos fechados, rótulos em
 * linguagem clara e o formato validado do estado devolvido pelo banco.
 *
 * Regra fixa desta etapa: leads arquivados são retidos por 12 MESES, contados do momento em
 * que o lead foi arquivado (leads.archived_at, gravado pelo banco). Nenhum prazo configurável.
 */

export const RETENTION_MONTHS = 12;

/** Motivos pelos quais a anonimização não pode acontecer (códigos fechados do banco). */
export const BLOCK_REASON_CODES = [
  "no_lead",
  "active_lead",
  "retention_period_open",
  "client_present",
  "open_or_won_opportunity",
  "open_proposal",
  "legal_hold_active",
  "merge_history_present",
  "proposal_document_present",
  "calendar_link_present",
  "pending_outbound_message",
  "unlinked_whatsapp_conversation",
] as const;
export type BlockReasonCode = (typeof BLOCK_REASON_CODES)[number];

/** Motivos de preservação legal (códigos fechados; nunca texto livre). */
export const HOLD_REASON_CODES = [
  "judicial_process",
  "legal_obligation",
  "case_in_progress",
  "regulatory_inquiry",
  "other_legal",
] as const;
export type HoldReasonCode = (typeof HOLD_REASON_CODES)[number];

export const HOLD_REASON_LABEL: Record<HoldReasonCode, string> = {
  judicial_process: "Processo judicial",
  legal_obligation: "Obrigação legal de guarda",
  case_in_progress: "Caso em andamento",
  regulatory_inquiry: "Apuração regulatória",
  other_legal: "Outro motivo jurídico",
};

/** Frase digitada para confirmar a anonimização (confirmação forte; o servidor repete a checagem). */
export const ANONYMIZE_CONFIRMATION = "ANONIMIZAR";

const timestamp = z.string().min(10);

export const retentionStatusSchema = z.object({
  state: z.enum(["eligible", "blocked", "anonymized"]),
  eligible: z.boolean(),
  reasons: z.array(z.enum(BLOCK_REASON_CODES)),
  lead_count: z.number().int().nonnegative(),
  archived_lead_count: z.number().int().nonnegative(),
  retention_due_at: timestamp.nullable(),
  anonymized_at: timestamp.nullable(),
  retention_months: z.number().int().optional(),
  holds: z
    .array(
      z.object({
        id: z.string().min(1),
        reason_code: z.enum(HOLD_REASON_CODES),
        status: z.enum(["active", "released"]),
        created_at: timestamp,
        released_at: timestamp.nullable(),
      }),
    )
    .default([]),
});
export type RetentionStatus = z.infer<typeof retentionStatusSchema>;

/** Valida o que o banco devolveu; qualquer formato inesperado vira erro (nunca dado parcial na tela). */
export function parseRetentionStatus(raw: unknown): RetentionStatus {
  return retentionStatusSchema.parse(raw);
}

const DATE_FORMAT = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short" });

export function formatRetentionDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : DATE_FORMAT.format(date);
}

/** Texto claro de cada motivo de bloqueio. O vencimento do prazo entra no texto do prazo em aberto. */
export function describeBlockReason(code: BlockReasonCode, dueAt: string | null): string {
  switch (code) {
    case "no_lead":
      return "O contato não tem lead; não há prazo de retenção em andamento.";
    case "active_lead":
      return "Há lead ativo: o prazo só começa quando todos os leads estiverem arquivados.";
    case "retention_period_open":
      return dueAt
        ? `Prazo de retenção de ${RETENTION_MONTHS} meses em andamento; vence em ${formatRetentionDate(dueAt)}.`
        : `Prazo de retenção de ${RETENTION_MONTHS} meses em andamento.`;
    case "client_present":
      return "O contato é cliente; clientes não são anonimizados automaticamente.";
    case "open_or_won_opportunity":
      return "Há oportunidade em aberto ou ganha (caso em andamento).";
    case "open_proposal":
      return "Há proposta enviada ou aceita ainda sem desfecho (processo comercial em andamento).";
    case "legal_hold_active":
      return "Há preservação legal ativa.";
    case "merge_history_present":
      return "Há histórico de mesclagem com outro contato; é necessária revisão humana.";
    case "proposal_document_present":
      return "Há proposta com PDF ou e-mail enviado, guardados fora do banco; é necessária revisão humana.";
    case "calendar_link_present":
      return "Há atividade ligada à agenda externa; é necessária revisão humana.";
    case "unlinked_whatsapp_conversation":
      return "Existe conversa de WhatsApp que precisa ser vinculada ou revisada antes da anonimização.";
    case "pending_outbound_message":
      return "Há mensagem de WhatsApp de saída ainda em andamento.";
  }
}
