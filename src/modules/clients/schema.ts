import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";
import { CLIENT_STATUSES } from "./queries";

export const listClientsFiltersSchema = z.object({
  status: z.enum(CLIENT_STATUSES).optional().or(z.literal("")),
  search: z.string().trim().max(160).optional().or(z.literal("")),
  sort: z.enum(["created_at_desc", "created_at_asc"]).default("created_at_desc"),
  page: z.coerce.number().int().min(1).default(1),
});

export const updateClientStatusSchema = z.object({
  clientId: uuidSchema,
  status: z.enum(CLIENT_STATUSES),
  lockVersion: z.coerce.number().int().min(0),
});

export const transferClientOwnerSchema = z.object({
  clientId: uuidSchema,
  ownerUserId: uuidSchema.optional().or(z.literal("")),
  lockVersion: z.coerce.number().int().min(0),
});
