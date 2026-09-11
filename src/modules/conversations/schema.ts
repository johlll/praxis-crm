import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";
import { normalizePhoneBR } from "@/lib/normalize";

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

export const CONSENT_LEGAL_BASIS = [
  "consentimento",
  "legitimo_interesse",
  "execucao_de_contrato",
  "obrigacao_legal",
  "outro",
] as const;

export const MESSAGE_STATUS_EVENTS = ["sent", "delivered", "read", "failed"] as const;

export const createWhatsAppChannelSchema = z.object({
  workspaceId: uuidSchema,
  label: z.string().trim().min(1, "Informe um nome para o canal.").max(120),
  phoneNumberId: z.string().trim().min(1, "Informe o identificador do número.").max(64),
  displayPhoneNumber: phoneInputSchema,
});

export const simulateInboundMessageSchema = z.object({
  channelId: uuidSchema,
  phoneNumberId: z.string().trim().min(1).max(64),
  fromPhone: phoneInputSchema,
  bodyText: z.string().trim().min(1, "Digite o texto da mensagem.").max(4096),
  profileName: z.string().trim().max(160).optional().or(z.literal("")),
  // "Entregar eventos fora de ordem": deixa escolher um instante diferente
  // de "agora" — opcional, default é o momento real do clique.
  timestampOverride: z.string().datetime().optional().or(z.literal("")),
});

export const simulateStatusEventSchema = z.object({
  phoneNumberId: z.string().trim().min(1).max(64),
  waMessageId: z.string().trim().min(1),
  recipientWaId: z.string().trim().min(1),
  status: z.enum(MESSAGE_STATUS_EVENTS),
  timestampOverride: z.string().datetime().optional().or(z.literal("")),
  errorMessage: z.string().trim().max(300).optional().or(z.literal("")),
});

export const sendMessageSchema = z.object({
  conversationId: uuidSchema,
  bodyText: z.string().trim().min(1, "Digite uma mensagem.").max(4096),
  clientDedupeKey: uuidSchema,
});

export const resolveConversationLinkSchema = z.object({
  conversationId: uuidSchema,
  contactId: uuidSchema.optional(),
  leadId: uuidSchema.optional(),
  opportunityId: uuidSchema.optional(),
});

export const registerContactConsentSchema = z.object({
  contactId: uuidSchema,
  channel: z.enum(["whatsapp", "email", "telefone", "presencial"]),
  legalBasis: z.enum(CONSENT_LEGAL_BASIS),
  purpose: z.string().trim().min(1, "Informe a finalidade.").max(300),
  evidenceSource: z.string().trim().max(300).optional().or(z.literal("")),
  acceptedText: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const revokeContactConsentSchema = z.object({ consentId: uuidSchema });
