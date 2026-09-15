import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";

export const createLeadNoteSchema = z.object({
  leadId: uuidSchema,
  body: z.string().trim().min(1, "Escreva algo antes de salvar.").max(4000),
});
