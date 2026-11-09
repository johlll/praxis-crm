import { z } from "zod";

import { ROLES } from "@/lib/roles";
import { uuidSchema } from "@/lib/uuid";

export const createInvitationSchema = z.object({
  email: z.string().trim().toLowerCase().email("Informe um e-mail válido."),
  role: z.enum(ROLES),
});

export const invitationIdSchema = z.object({
  invitationId: uuidSchema,
});

export const membershipIdSchema = z.object({
  membershipId: uuidSchema,
});

export const updateMembershipRoleSchema = z.object({
  membershipId: uuidSchema,
  role: z.enum(ROLES),
});

/**
 * Transferência de posse (B5). `confirm` é a confirmação explícita da tela
 * (caixa marcada): sem ela a action nem chama o banco. O workspace NÃO está
 * aqui de propósito — vem sempre da sessão, nunca do formulário.
 */
export const transferOwnershipSchema = z.object({
  membershipId: uuidSchema,
  confirm: z.literal("yes"),
});

export const acceptInvitationSchema = z.object({
  token: z.string().min(16).max(256),
});
