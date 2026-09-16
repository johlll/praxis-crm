import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";

export const CONFLICT_CHECK_STATUSES = [
  "nao_verificado",
  "sem_conflito",
  "conflito_identificado",
  "em_analise",
] as const;

export const upsertConflictCheckSchema = z.object({
  leadId: uuidSchema,
  status: z.enum(CONFLICT_CHECK_STATUSES),
  note: z.string().trim().max(2000).optional().or(z.literal("")),
  // Ausente na primeira verificação (registro ainda não existe) — presente
  // em toda atualização seguinte, mesmo padrão de lock_version opcional
  // só no primeiro caso de toda a base (create vs update em uma função só).
  lockVersion: z.coerce.number().int().min(0).optional().or(z.literal("")),
});
