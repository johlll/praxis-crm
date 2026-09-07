import { z } from "zod";

import { ROLES } from "@/lib/roles";

export const createInvitationSchema = z.object({
  email: z.string().trim().toLowerCase().email("Informe um e-mail válido."),
  role: z.enum(ROLES),
});

export const invitationIdSchema = z.object({
  invitationId: z.string().uuid(),
});

export const membershipIdSchema = z.object({
  membershipId: z.string().uuid(),
});

export const updateMembershipRoleSchema = z.object({
  membershipId: z.string().uuid(),
  role: z.enum(ROLES),
});

export const acceptInvitationSchema = z.object({
  token: z.string().min(16).max(256),
});
