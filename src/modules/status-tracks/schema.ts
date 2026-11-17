import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";

/**
 * Conversas + IA (PR 1) — vocabulários e validação das trilhas de status
 * (docs/decisoes/conversas-ia-fundacao.md). Os valores são os códigos do banco
 * (enums), na ordem em que aparecem; "nao_informado" é a condição explícita de
 * dado legado e nunca é uma escolha manual.
 */

export const STATUS_TRACKS = ["attendance", "case_progress", "commercial_stage"] as const;
export type StatusTrack = (typeof STATUS_TRACKS)[number];

export const ATTENDANCE_STATUSES = [
  "nao_informado",
  "novo",
  "aguardando_escritorio",
  "aguardando_cliente",
  "encerrado",
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const CASE_PROGRESS_STATUSES = [
  "nao_informado",
  "aguardando_documentos",
  "documentos_recebidos",
  "em_analise",
  "aguardando_cliente",
  "aguardando_terceiros",
  "em_execucao",
  "concluido",
  "suspenso",
] as const;
export type CaseProgressStatus = (typeof CASE_PROGRESS_STATUSES)[number];

export const ATTENDANCE_STATUS_LABEL: Record<AttendanceStatus, string> = {
  nao_informado: "Não informado",
  novo: "Novo",
  aguardando_escritorio: "Aguardando o escritório",
  aguardando_cliente: "Aguardando o cliente",
  encerrado: "Encerrado",
};

export const CASE_PROGRESS_STATUS_LABEL: Record<CaseProgressStatus, string> = {
  nao_informado: "Não informado",
  aguardando_documentos: "Aguardando documentos",
  documentos_recebidos: "Documentos recebidos, ainda não analisados",
  em_analise: "Em análise",
  aguardando_cliente: "Aguardando cliente",
  aguardando_terceiros: "Aguardando terceiros",
  em_execucao: "Em execução",
  concluido: "Concluído",
  suspenso: "Suspenso",
};

/** Só os valores escolhíveis numa correção manual (sem "nao_informado"). */
const manualAttendance = z.enum(ATTENDANCE_STATUSES).refine((s) => s !== "nao_informado", {
  message: "Escolha um dos valores disponíveis.",
});
const manualCaseProgress = z.enum(CASE_PROGRESS_STATUSES).refine((s) => s !== "nao_informado", {
  message: "Escolha um dos valores disponíveis.",
});

/** Mesmo formato do uuidSchema do projeto, com a mensagem em português do campo. */
const id = (message: string) => z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, message);

const version = z.number({ message: "Recarregue a página e tente de novo." }).int().min(0);

/** Até 20 mensagens distintas; o servidor confere escritório, conversa, alcance e alvo. */
const evidence = z
  .array(uuidSchema)
  .max(20, { message: "No máximo 20 mensagens como evidência." })
  .refine((ids) => new Set(ids).size === ids.length, { message: "Evidência repetida." })
  .default([]);

const idempotencyKey = uuidSchema.optional();

export const setAttendanceSchema = z.object({
  conversationId: id("Conversa inválida."),
  status: manualAttendance,
  expectedVersion: version,
  evidenceMessageIds: evidence,
  idempotencyKey,
});

export const setCaseProgressSchema = z.object({
  opportunityId: id("Oportunidade inválida."),
  status: manualCaseProgress,
  expectedVersion: version,
  evidenceMessageIds: evidence,
  idempotencyKey,
});

export const setTrackAutomationSchema = z.object({
  track: z.enum(STATUS_TRACKS),
  targetId: id("Alvo inválido."),
  paused: z.boolean(),
  expectedVersion: version,
});

export const caseSelectionSchema = z.object({
  conversationId: id("Conversa inválida."),
  opportunityId: id("Caso inválido."),
});

/**
 * Permissão de correção/pausa de cada trilha (o banco repete a regra):
 * situação do atendimento → conversation.attendance_edit; andamento →
 * case.progress_edit; etapa comercial → opportunity.edit.
 */
export const TRACK_EDIT_PERMISSION = {
  attendance: "conversation.attendance_edit",
  case_progress: "case.progress_edit",
  commercial_stage: "opportunity.edit",
} as const satisfies Record<StatusTrack, string>;
