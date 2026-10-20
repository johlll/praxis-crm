import { createHmac } from "node:crypto";

/**
 * Ambiente AUTENTICADO do WhatsApp (B3.1, docs/decisoes/b3-whatsapp-real.md §7.1).
 *
 * Mesmo PADRÃO da B2 (Preview e Production compartilham o Supabase; o banco
 * só aceita um ambiente que o servidor tenha assinado), mas com tudo
 * próprio: chave (`WHATSAPP_ENV_SIGNING_KEY`, valor diferente por
 * ambiente), cabeçalho (`X-Praxis-WhatsApp-Env`), versão de formato e
 * finalidade embutida na mensagem assinada. Nada aqui lê variável, chave ou
 * cabeçalho do calendário: uma assinatura da B2 nunca vale para o WhatsApp,
 * nem com a mesma chave por engano, porque a mensagem assinada é outra.
 *
 * FALHA FECHADA:
 *  - só `VERCEL_ENV=production` explícito vale `production`; tudo o mais é
 *    `preview`;
 *  - sem chave (ou chave curta), nenhum cabeçalho é enviado, e o banco
 *    recusa toda operação que depende do ambiente.
 */
export type WhatsAppEnvironment = "production" | "preview";

export const WHATSAPP_ENV_HEADER = "X-Praxis-WhatsApp-Env";
export const WHATSAPP_ENV_FORMAT_VERSION = "v1";
export const WHATSAPP_ENV_PURPOSE = "praxis:whatsapp:env";

/** Validade emitida pelo servidor. O banco recusa mais de 15 minutos. */
export const WHATSAPP_ENV_HEADER_TTL_SECONDS = 300;

const MIN_SIGNING_KEY_LENGTH = 32;

export function getWhatsAppEnvironment(): WhatsAppEnvironment {
  return process.env.VERCEL_ENV === "production" ? "production" : "preview";
}

/** Mesma conta do banco (`private.whatsapp_environment_signature`):
 * HMAC-SHA256 de `praxis:whatsapp:env:v1|<ambiente>|<expira>` em hexadecimal. */
export function signWhatsAppEnvironment(environment: string, expiresAtSeconds: number, key: string): string {
  return createHmac("sha256", key)
    .update(`${WHATSAPP_ENV_PURPOSE}:${WHATSAPP_ENV_FORMAT_VERSION}|${environment}|${expiresAtSeconds}`)
    .digest("hex");
}

export function isWhatsAppEnvironmentConfigured(): boolean {
  const key = process.env.WHATSAPP_ENV_SIGNING_KEY;
  return typeof key === "string" && key.length >= MIN_SIGNING_KEY_LENGTH;
}

export function whatsappEnvHeaders(nowMs: number = Date.now()): Record<string, string> {
  const key = process.env.WHATSAPP_ENV_SIGNING_KEY;
  if (!key || key.length < MIN_SIGNING_KEY_LENGTH) return {};

  const environment = getWhatsAppEnvironment();
  const expires = Math.floor(nowMs / 1000) + WHATSAPP_ENV_HEADER_TTL_SECONDS;
  const signature = signWhatsAppEnvironment(environment, expires, key);
  return { [WHATSAPP_ENV_HEADER]: `${WHATSAPP_ENV_FORMAT_VERSION}.${environment}.${expires}.${signature}` };
}
