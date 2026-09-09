import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";
import { normalizeEmail, normalizePhoneBR } from "@/lib/normalize";

export const CONTACT_TYPES = ["pf", "pj"] as const;
export const CONTACT_CHANNELS = ["whatsapp", "email", "telefone", "presencial"] as const;

const phoneInputSchema = z
  .string()
  .trim()
  .min(1, "Informe um telefone.")
  .transform((value, ctx) => {
    const normalized = normalizePhoneBR(value);
    if (!normalized) {
      ctx.addIssue({ code: "custom", message: "Telefone inválido." });
      return z.NEVER;
    }
    return normalized;
  });

const emailInputSchema = z
  .string()
  .trim()
  .min(1, "Informe um e-mail.")
  .transform((value, ctx) => {
    const normalized = normalizeEmail(value);
    if (!normalized) {
      ctx.addIssue({ code: "custom", message: "E-mail inválido." });
      return z.NEVER;
    }
    return normalized;
  });

// CPF (11 dígitos) ou CNPJ (14 dígitos) — só a contagem de dígitos depois
// de normalizar; não valida dígito verificador (fora de escopo desta fase,
// e nunca é um bloqueio de negócio real aqui).
const cpfCnpjInputSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/\D/g, ""))
  .refine((digits) => digits.length === 11 || digits.length === 14, {
    message: "CPF precisa ter 11 dígitos, CNPJ 14.",
  });

export const createContactSchema = z.object({
  workspaceId: uuidSchema,
  type: z.enum(CONTACT_TYPES),
  name: z.string().trim().min(1, "Informe um nome.").max(160),
  city: z.string().trim().max(120).optional().or(z.literal("")),
  uf: z
    .string()
    .trim()
    .toUpperCase()
    .length(2, "UF precisa ter 2 letras.")
    .optional()
    .or(z.literal("")),
  preferredChannel: z.enum(CONTACT_CHANNELS).optional(),
  phones: z.array(phoneInputSchema).max(10).default([]),
  emails: z.array(emailInputSchema).max(10).default([]),
  // Opcional de propósito — CPF nunca é exigido, e a interface não insiste
  // em coletar quando não é necessário (aprovação explícita do usuário).
  cpfCnpj: cpfCnpjInputSchema.optional().or(z.literal("")),
});

export const updateContactBasicFieldsSchema = z.object({
  contactId: uuidSchema,
  name: z.string().trim().min(1, "Informe um nome.").max(160),
  city: z.string().trim().max(120).optional().or(z.literal("")),
  uf: z
    .string()
    .trim()
    .toUpperCase()
    .length(2, "UF precisa ter 2 letras.")
    .optional()
    .or(z.literal("")),
  preferredChannel: z.enum(CONTACT_CHANNELS).optional(),
});

export const addPhoneSchema = z.object({
  contactId: uuidSchema,
  value: phoneInputSchema,
  isPrimary: z.boolean().default(false),
});

export const updatePhoneSchema = z.object({
  phoneId: uuidSchema,
  value: phoneInputSchema,
  isPrimary: z.boolean().optional(),
});

export const removePhoneSchema = z.object({ phoneId: uuidSchema });

export const addEmailSchema = z.object({
  contactId: uuidSchema,
  value: emailInputSchema,
  isPrimary: z.boolean().default(false),
});

export const updateEmailSchema = z.object({
  emailId: uuidSchema,
  value: emailInputSchema,
  isPrimary: z.boolean().optional(),
});

export const removeEmailSchema = z.object({ emailId: uuidSchema });

export const setCpfCnpjSchema = z.object({
  contactId: uuidSchema,
  value: cpfCnpjInputSchema,
});

export const clearCpfCnpjSchema = z.object({ contactId: uuidSchema });

export const revealCpfCnpjSchema = z.object({
  contactId: uuidSchema,
  reason: z.string().trim().max(300).optional().or(z.literal("")),
});

export const searchContactsByCpfCnpjSchema = z.object({
  workspaceId: uuidSchema,
  value: cpfCnpjInputSchema,
});

export const dismissDuplicateCandidateSchema = z.object({ candidateId: uuidSchema });

export const mergeContactsSchema = z.object({
  keptContactId: uuidSchema,
  mergedContactId: uuidSchema,
  candidateId: uuidSchema.optional(),
  // Chaves em snake_case de propósito — vão direto como jsonb para
  // merge_contacts(), que lê p_field_resolutions->>'preferred_channel'.
  // Chave solta (não o enum específico): o record do Zod com enum de chave
  // exige objeto EXAUSTIVO (todas as chaves presentes) para bater com
  // Record<K,V> do TypeScript — aqui só algumas chaves vêm preenchidas,
  // nunca todas de uma vez.
  fieldResolutions: z.record(z.string(), z.enum(["a", "b"])).default({}),
});

export const unmergeContactSchema = z.object({ mergeId: uuidSchema });
