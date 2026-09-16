import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";

export const FEE_MODELS = ["fixed", "contingency", "fixed_contingency"] as const;
export const PROPOSAL_CHANNELS = ["email", "whatsapp"] as const;

const lockVersionSchema = z.coerce.number().int().min(0);

export const createProposalSchema = z.object({
  opportunityId: uuidSchema,
  valueCents: z.coerce.number().int().min(0),
  feeModel: z.enum(FEE_MODELS),
});

export const sendProposalSchema = z.object({
  proposalId: uuidSchema,
  lockVersion: lockVersionSchema,
  channels: z.array(z.enum(PROPOSAL_CHANNELS)).min(1, "Selecione ao menos um canal de envio."),
});

export const decideProposalSchema = z.object({
  proposalId: uuidSchema,
  lockVersion: lockVersionSchema,
  decision: z.enum(["aceita", "recusada"]),
  note: z.string().trim().max(2000).optional().or(z.literal("")),
});
