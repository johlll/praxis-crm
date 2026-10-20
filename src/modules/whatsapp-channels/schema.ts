import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";

/**
 * Entradas das operações de canal (B3.1). Objetos ESTRITOS: workspace,
 * usuário, papel, ambiente, provedor ou qualquer outro campo além dos
 * previstos é recusado — esses valores vêm só da sessão e do servidor.
 */

const label = z.string().trim().min(1, "Informe um nome para o canal.").max(120);
const displayPhoneNumber = z.string().trim().min(1, "Informe o número exibido do canal.").max(32);

export const createSimulatedChannelSchema = z
  .object({
    label,
    routingKey: z
      .string()
      .trim()
      .min(1, "Informe o identificador de roteamento.")
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/, "Use só letras, números, ponto, hífen, dois-pontos ou sublinhado."),
    displayPhoneNumber,
  })
  .strict();

export const updateChannelSettingsSchema = z
  .object({
    channelId: uuidSchema,
    label,
    displayPhoneNumber,
  })
  .strict();

export const channelRefSchema = z.object({ channelId: uuidSchema }).strict();
