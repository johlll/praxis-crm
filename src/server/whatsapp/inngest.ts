import { Inngest } from "inngest";

/**
 * Cliente Inngest PRÓPRIO do WhatsApp (B3.2c, docs/decisoes/b3-whatsapp-real.md
 * §18.3). Separado da A11 (`@/server/ingest/*`, app `praxis-crm`) e da
 * agenda: app próprio e chave própria, `WHATSAPP_INNGEST_EVENT_KEY`.
 *
 * A chave é passada EXPLICITAMENTE ao SDK: sem ela, o SDK cairia na
 * variável genérica da A11. Por isso, sem a chave própria (ausente ou
 * vazia), nada é criado e a publicação falha fechada, com código fixo.
 *
 * A rota de atendimento do Inngest e a signing key do WhatsApp são da
 * B3.2d, também com prefixo `WHATSAPP_`.
 */

export const WHATSAPP_INNGEST_APP_ID = "praxis-crm-whatsapp";

export class WhatsAppInngestConfigError extends Error {
  readonly code = "inbox_event_not_configured" as const;
  constructor() {
    super("inbox_event_not_configured");
    this.name = "WhatsAppInngestConfigError";
  }
}

/** Um cliente por chamada: barato, e nunca guarda uma chave antiga. */
export function whatsappInngestClient(): Inngest {
  const eventKey = process.env.WHATSAPP_INNGEST_EVENT_KEY;
  if (typeof eventKey !== "string" || eventKey.trim() === "") throw new WhatsAppInngestConfigError();
  return new Inngest({ id: WHATSAPP_INNGEST_APP_ID, eventKey });
}
