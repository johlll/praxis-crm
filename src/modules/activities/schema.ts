import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";
import { LEAD_PRIORITIES } from "@/modules/leads/schema";

export const ACTIVITY_TYPES = ["call", "meeting", "task", "email", "deadline"] as const;

/** Chips da Central de Atividades — um só selecionado por vez, nunca
 * combinados (mesmo modelo de aba do protótipo aprovado). */
export const ACTIVITY_FILTERS = ["overdue", "today", "tomorrow", "week", "unassigned"] as const;

export const ACTIVITY_ASSIGNEE_RULES = ["unassigned", "lead_owner"] as const;

// Mesma versão esperada obrigatória da A4/A5 — nunca omitida, sempre vem
// de um hidden field preenchido com o lock_version que a tela carregou.
const lockVersionSchema = z.coerce.number().int().min(0);

// "YYYY-MM-DD" do <input type="date"> nativo — nunca parseado no
// cliente, só repassado como string pro servidor montar o instante com o
// fuso certo (ver comentário em supabase/migrations/20260911120200).
const dueDateSchema = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Informe uma data válida.");
// "HH:MM" do <input type="time">, opcional — ausente = atividade só de
// data (has_time=false).
const dueTimeSchema = z
  .string()
  .trim()
  .regex(/^\d{2}:\d{2}$/, "Informe um horário válido.")
  .optional()
  .or(z.literal(""));

export const createActivitySchema = z.object({
  leadId: uuidSchema,
  opportunityId: uuidSchema.optional().or(z.literal("")),
  type: z.enum(ACTIVITY_TYPES),
  title: z.string().trim().min(1, "Informe o título.").max(160),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
  assignedTo: uuidSchema.optional().or(z.literal("")),
  priority: z.enum(LEAD_PRIORITIES).default("media"),
  dueDate: dueDateSchema,
  dueTime: dueTimeSchema,
});

export const updateActivitySchema = z.object({
  activityId: uuidSchema,
  lockVersion: lockVersionSchema,
  type: z.enum(ACTIVITY_TYPES).optional().or(z.literal("")),
  title: z.string().trim().max(160).optional().or(z.literal("")),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
  clearNotes: z.coerce.boolean().default(false),
  priority: z.enum(LEAD_PRIORITIES).optional().or(z.literal("")),
});

export const rescheduleActivitySchema = z.object({
  activityId: uuidSchema,
  lockVersion: lockVersionSchema,
  dueDate: dueDateSchema,
  dueTime: dueTimeSchema,
});

export const reassignActivitySchema = z.object({
  activityId: uuidSchema,
  lockVersion: lockVersionSchema,
  assignedTo: uuidSchema.optional().or(z.literal("")),
});

export const completeActivitySchema = z.object({
  activityId: uuidSchema,
  lockVersion: lockVersionSchema,
});

export const deleteActivitySchema = z.object({
  activityId: uuidSchema,
});

export const setStageAutoActivityRuleSchema = z.object({
  stageId: uuidSchema,
  activityType: z.enum(ACTIVITY_TYPES),
  title: z.string().trim().min(1, "Informe o título da atividade.").max(160),
  dueOffsetHours: z.coerce.number().int().min(0).max(720).default(24),
  assigneeRule: z.enum(ACTIVITY_ASSIGNEE_RULES).default("lead_owner"),
});

export const deleteStageAutoActivityRuleSchema = z.object({
  stageId: uuidSchema,
});

export const listActivitiesFiltersSchema = z.object({
  filter: z.enum(ACTIVITY_FILTERS).optional().or(z.literal("")),
  leadId: uuidSchema.optional().or(z.literal("")),
  opportunityId: uuidSchema.optional().or(z.literal("")),
  status: z.enum(["pending", "done"]).optional().or(z.literal("")),
  sort: z.enum(["due_at_asc", "due_at_desc"]).default("due_at_asc"),
  page: z.coerce.number().int().min(1).default(1),
});
