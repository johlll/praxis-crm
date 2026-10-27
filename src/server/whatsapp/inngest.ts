import { randomBytes } from "node:crypto";

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
 * A rota de atendimento (`/api/inngest/whatsapp`, B3.2d-2a) usa
 * `whatsappInngestServeClient`, com a signing key própria
 * `WHATSAPP_INNGEST_SIGNING_KEY` (e a reserva
 * `WHATSAPP_INNGEST_SIGNING_KEY_FALLBACK`).
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

// ---------------------------------------------------------------------
// Atendimento (rota /api/inngest/whatsapp, B3.2d-2a)
// ---------------------------------------------------------------------

/**
 * Sem as opções, o SDK cairia nas variáveis GENÉRICAS do Inngest — as da
 * A11 e da agenda — para a signing key, a reserva e a chave de evento: a
 * reserva da A11 passaria a autenticar esta rota. Por isso as três são
 * sempre passadas explicitamente; a que não estiver configurada recebe um
 * valor que nunca valida nada (aleatório, por processo) e nunca envia.
 */
const UNUSABLE_SIGNING_KEY = `signkey-unused-${randomBytes(32).toString("hex")}`;
const UNUSABLE_SIGNING_KEY_FALLBACK = `signkey-unused-${randomBytes(32).toString("hex")}`;
const UNUSABLE_EVENT_KEY = "whatsapp-inngest-event-key-not-configured";

/** Nada no console: nem do SDK. */
const SILENT_LOGGER = Object.freeze({ info() {}, warn() {}, error() {}, debug() {} });

export type WhatsAppInngestServeConfig =
  | { ok: true; signingKey: string; signingKeyFallback: string; eventKey: string; isDev: boolean }
  | { ok: false };

function devModeRequested(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return Boolean(v) && v !== "0" && v !== "false";
}

/**
 * FALHA FECHADA. Em Preview e Production (`VERCEL_ENV`), só com
 * `WHATSAPP_INNGEST_SIGNING_KEY`, e sempre em modo cloud (assinatura
 * conferida), mesmo com `INNGEST_DEV` definido. Fora da Vercel, sem a chave
 * própria, só no modo de desenvolvimento explícito (`INNGEST_DEV`). Nunca
 * lê as variáveis genéricas do Inngest.
 */
export function whatsappInngestServeConfig(env: Readonly<Record<string, string | undefined>> = process.env): WhatsAppInngestServeConfig {
  const hosted = env.VERCEL_ENV === "preview" || env.VERCEL_ENV === "production";
  const signingKey = env.WHATSAPP_INNGEST_SIGNING_KEY?.trim();
  const isDev = !hosted && devModeRequested(env.INNGEST_DEV);
  if (!signingKey && !isDev) return { ok: false };
  return {
    ok: true,
    signingKey: signingKey || UNUSABLE_SIGNING_KEY,
    signingKeyFallback: env.WHATSAPP_INNGEST_SIGNING_KEY_FALLBACK?.trim() || UNUSABLE_SIGNING_KEY_FALLBACK,
    eventKey: env.WHATSAPP_INNGEST_EVENT_KEY?.trim() || UNUSABLE_EVENT_KEY,
    isDev,
  };
}

export function whatsappInngestServeClient(config: Extract<WhatsAppInngestServeConfig, { ok: true }>): Inngest {
  return new Inngest({
    id: WHATSAPP_INNGEST_APP_ID,
    signingKey: config.signingKey,
    signingKeyFallback: config.signingKeyFallback,
    eventKey: config.eventKey,
    isDev: config.isDev,
    logger: SILENT_LOGGER,
    internalLogger: SILENT_LOGGER,
  });
}
