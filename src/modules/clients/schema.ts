import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";

/**
 * Vive aqui (não em queries.ts) e é reexportado de lá — mesma disciplina
 * de src/lib/roles.ts: queries.ts importa createServerSupabaseClient
 * (que puxa next/headers) no topo do arquivo, então qualquer import de
 * valor real de lá (não só tipo) arrasta next/headers para o bundle do
 * navegador. Achado real no build da Vercel: client-status-form.tsx (
 * "use client") importava CLIENT_STATUSES de queries.ts e quebrava o
 * build com "You're importing a module that depends on next/headers...
 * in the Pages Router". schema.ts só depende de zod — seguro para
 * Client Components importarem.
 */
export const CLIENT_STATUSES = ["ativo", "encerrado", "suspenso"] as const;

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
