import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";
import type { Permission } from "@/lib/roles";
import type { RegistrationDraft, RequiredRegistrationField } from "./types";

/**
 * Operações que o Assistente pode executar — a lista é esta, e só esta. O intérprete (hoje, a simulação)
 * só PROPÕE uma operação com parâmetros; o servidor confere se ela está aqui, valida os parâmetros com o
 * esquema dela, confere as permissões da sessão e então executa pelos caminhos oficiais do CRM. O
 * escritório nunca é parâmetro: vem sempre da sessão.
 */

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

export const registrationDraftSchema = z.object({
  name: optionalText(160),
  legalArea: optionalText(120),
  summary: optionalText(2000),
  phone: optionalText(40),
  email: optionalText(254),
});

export const ASSISTANT_OPERATIONS = {
  /** Lê agenda de hoje, atividades atrasadas e oportunidades que exigem atenção. */
  diagnose_attention: {
    kind: "read",
    permissions: [] as Permission[],
    params: z.object({}).strict(),
  },
  /** Monta (ou completa) o rascunho de cadastro. Não grava nada. */
  propose_client_registration: {
    kind: "draft",
    permissions: ["contact.edit", "lead.edit"] as Permission[],
    params: registrationDraftSchema,
  },
  /** Descarta o rascunho aberto. */
  cancel_registration: {
    kind: "draft",
    permissions: [] as Permission[],
    params: z.object({}).strict(),
  },
} as const;

export type AssistantOperationName = keyof typeof ASSISTANT_OPERATIONS;

export function isAssistantOperation(name: string): name is AssistantOperationName {
  return Object.prototype.hasOwnProperty.call(ASSISTANT_OPERATIONS, name);
}

/** A gravação não é proposta pelo intérprete: só acontece no clique de confirmação, com estes dados. */
export const confirmRegistrationSchema = z.object({
  requestId: uuidSchema,
  draft: registrationDraftSchema,
  decision: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("new") }),
      z.object({ kind: z.literal("existing"), contactId: uuidSchema, contactName: text(160) }),
    ])
    .nullable(),
});

export const askAssistantSchema = z.object({
  text: z.string().trim().min(1, "Escreva uma mensagem.").max(2000, "Mensagem longa demais."),
  pending: registrationDraftSchema.nullable(),
});

export const REQUIRED_FIELDS: readonly RequiredRegistrationField[] = ["name", "legalArea"];

export const FIELD_LABEL: Record<keyof RegistrationDraft, string> = {
  name: "Nome",
  legalArea: "Área jurídica",
  summary: "Assunto do caso",
  phone: "Telefone",
  email: "E-mail",
};

export function missingFields(draft: RegistrationDraft): RequiredRegistrationField[] {
  return REQUIRED_FIELDS.filter((field) => !draft[field]?.trim());
}

/** Junta o que já se sabia com o que chegou agora, sem apagar o que já estava preenchido com vazio. */
export function mergeDraft(base: RegistrationDraft | null, next: RegistrationDraft): RegistrationDraft {
  const merged: RegistrationDraft = { ...(base ?? {}) };
  for (const key of Object.keys(next) as (keyof RegistrationDraft)[]) {
    const value = next[key];
    if (value) merged[key] = value;
  }
  return merged;
}
