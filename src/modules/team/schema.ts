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

export const acceptInvitationSchema = z.object({
  token: z.string().min(16).max(256),
});
