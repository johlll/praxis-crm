import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";
import { parseMoneyBRToCents } from "@/lib/money";

export const LEAD_PRIORITIES = ["baixa", "media", "alta"] as const;
export const LEAD_STATUSES = ["ativo", "arquivado"] as const;

const legalAreaSchema = z.string().trim().min(1, "Informe a área jurídica.").max(120);

const summarySchema = z.string().trim().max(2000).optional().or(z.literal(""));

const tagsInputSchema = z
  .string()
  .trim()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0),
  )
  .refine((tags) => tags.length <= 15, "No máximo 15 etiquetas.")
  .refine((tags) => tags.every((tag) => tag.length <= 40), "Cada etiqueta pode ter até 40 caracteres.");

const moneyInputSchema = z.string().transform((value, ctx) => {
  const result = parseMoneyBRToCents(value);
  if (result === undefined) {
    ctx.addIssue({ code: "custom", message: "Valor inválido. Use um número, ex.: 5.500,00." });
    return z.NEVER;
  }
  return result;
});

export const createLeadSchema = z.object({
  workspaceId: uuidSchema,
  contactId: uuidSchema,
  legalArea: legalAreaSchema,
  summary: summarySchema,
  tags: tagsInputSchema,
  priority: z.enum(LEAD_PRIORITIES).default("media"),
  assignedTo: uuidSchema.optional().or(z.literal("")),
  estimatedValue: moneyInputSchema.optional(),
});

export const updateLeadBasicFieldsSchema = z.object({
  leadId: uuidSchema,
  legalArea: legalAreaSchema,
  summary: summarySchema,
  tags: tagsInputSchema,
  priority: z.enum(LEAD_PRIORITIES).default("media"),
  expectedUpdatedAt: z.string().optional().or(z.literal("")),
});

export const assignLeadSchema = z.object({
  leadId: uuidSchema,
  assignedTo: uuidSchema.optional().or(z.literal("")),
  expectedUpdatedAt: z.string().optional().or(z.literal("")),
});

export const setLeadStatusSchema = z.object({
  leadId: uuidSchema,
  status: z.enum(LEAD_STATUSES),
  expectedUpdatedAt: z.string().optional().or(z.literal("")),
});

export const setLeadValueSchema = z.object({
  leadId: uuidSchema,
  estimatedValue: moneyInputSchema.optional(),
  expectedUpdatedAt: z.string().optional().or(z.literal("")),
});

export const listLeadsFiltersSchema = z.object({
  search: z.string().trim().max(160).optional().or(z.literal("")),
  status: z.enum(LEAD_STATUSES).optional().or(z.literal("")),
  priority: z.enum(LEAD_PRIORITIES).optional().or(z.literal("")),
  assignedTo: uuidSchema.optional().or(z.literal("")),
  legalArea: z.string().trim().max(120).optional().or(z.literal("")),
  sort: z.enum(["created_at_desc", "created_at_asc"]).default("created_at_desc"),
  page: z.coerce.number().int().min(1).default(1),
});
