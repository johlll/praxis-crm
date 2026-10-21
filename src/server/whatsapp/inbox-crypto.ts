import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { z } from "zod";

import type { WhatsAppEnvironment } from "@/server/whatsapp/environment";
import type { WhatsAppProviderKind } from "@/server/whatsapp/provider/contract";

/**
 * Cifra da caixa de entrada do webhook de WhatsApp (B3.2b,
 * docs/decisoes/b3-whatsapp-real.md §17).
 *
 * AES-256-GCM com chave versionada PRÓPRIA da inbox
 * (`WHATSAPP_INBOX_ACTIVE_KEY_VERSION` + `WHATSAPP_INBOX_KEY_VERSIONS`,
 * valores diferentes por ambiente). Não lê a chave das credenciais do canal,
 * da agenda, de contatos ou da A11.
 *
 * A AAD prende o texto cifrado a finalidade e versão do formato, ambiente,
 * workspace, canal, provedor e id do evento: trocar qualquer um deles faz a
 * tag falhar. Nonce (12 bytes), texto cifrado e tag (16 bytes) saem
 * separados, em base64, para colunas próprias.
 *
 * Erros são sempre `WhatsAppInboxCryptoError` com código fixo: nunca levam
 * chave, nonce, texto cifrado ou corpo.
 */

const NONCE_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export const WHATSAPP_INBOX_AAD_PREFIX = "praxis:whatsapp:inbox:v1";

export class WhatsAppInboxCryptoError extends Error {
  constructor(
    public readonly code: "not_configured" | "unknown_key_version" | "invalid_ciphertext" | "decrypt_failed" | "invalid_context",
  ) {
    super(`whatsapp_inbox_crypto_${code}`);
    this.name = "WhatsAppInboxCryptoError";
  }
}

const VERSION = /^[A-Za-z0-9_-]{1,32}$/;

const keysSchema = z.object({
  WHATSAPP_INBOX_ACTIVE_KEY_VERSION: z.string().regex(VERSION),
  WHATSAPP_INBOX_KEY_VERSIONS: z.string().min(1),
});

export type WhatsAppInboxKeys = { activeVersion: string; keys: Record<string, Buffer> };

/** Lança `not_configured` quando as variáveis faltam ou são inválidas —
 * nunca cai numa chave padrão nem em outra chave do sistema. */
export function getWhatsAppInboxKeys(): WhatsAppInboxKeys {
  const parsed = keysSchema.safeParse({
    WHATSAPP_INBOX_ACTIVE_KEY_VERSION: process.env.WHATSAPP_INBOX_ACTIVE_KEY_VERSION,
    WHATSAPP_INBOX_KEY_VERSIONS: process.env.WHATSAPP_INBOX_KEY_VERSIONS,
  });
  if (!parsed.success) throw new WhatsAppInboxCryptoError("not_configured");

  let raw: unknown;
  try {
    raw = JSON.parse(parsed.data.WHATSAPP_INBOX_KEY_VERSIONS);
  } catch {
    throw new WhatsAppInboxCryptoError("not_configured");
  }
  const versions = z.record(z.string().regex(VERSION), z.string().min(1)).safeParse(raw);
  if (!versions.success) throw new WhatsAppInboxCryptoError("not_configured");

  const keys: Record<string, Buffer> = {};
  for (const [version, base64] of Object.entries(versions.data)) {
    const key = Buffer.from(base64, "base64");
    if (key.length !== 32) throw new WhatsAppInboxCryptoError("not_configured");
    keys[version] = key;
  }
  const activeVersion = parsed.data.WHATSAPP_INBOX_ACTIVE_KEY_VERSION;
  if (!keys[activeVersion]) throw new WhatsAppInboxCryptoError("not_configured");
  return { activeVersion, keys };
}

/** Identidade de uma entrega na inbox. */
export type InboxCipherContext = {
  environment: WhatsAppEnvironment;
  workspaceId: string;
  channelId: string;
  provider: WhatsAppProviderKind;
  providerEventId: string;
};

/** Nenhum elemento pode conter o separador: duas identidades diferentes
 * nunca produzem a mesma AAD. */
export function inboxAad(ctx: InboxCipherContext): Buffer {
  const parts = [ctx.environment, ctx.workspaceId, ctx.channelId, ctx.provider, ctx.providerEventId];
  for (const part of parts) {
    if (typeof part !== "string" || part.length === 0 || part.includes("|")) throw new WhatsAppInboxCryptoError("invalid_context");
  }
  return Buffer.from([WHATSAPP_INBOX_AAD_PREFIX, ...parts].join("|"), "utf8");
}

export type EncryptedInboxBody = {
  keyVersion: string;
  /** base64, 12 bytes. */
  nonce: string;
  /** base64. */
  ciphertext: string;
  /** base64, 16 bytes. */
  authTag: string;
};

export function encryptWhatsAppInboxBody(body: Uint8Array, ctx: InboxCipherContext): EncryptedInboxBody {
  if (!(body instanceof Uint8Array) || body.byteLength === 0) throw new WhatsAppInboxCryptoError("invalid_ciphertext");
  const aad = inboxAad(ctx);
  const { activeVersion, keys } = getWhatsAppInboxKeys();
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", keys[activeVersion]!, nonce, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
  return {
    keyVersion: activeVersion,
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/** Falha (lança) para adulteração, outra AAD ou chave desconhecida — nunca
 * devolve bytes parciais. */
export function decryptWhatsAppInboxBody(enc: EncryptedInboxBody, ctx: InboxCipherContext): Uint8Array {
  const aad = inboxAad(ctx);
  const { keys } = getWhatsAppInboxKeys();
  const key = keys[enc.keyVersion];
  if (!key) throw new WhatsAppInboxCryptoError("unknown_key_version");

  const nonce = Buffer.from(enc.nonce, "base64");
  const authTag = Buffer.from(enc.authTag, "base64");
  const data = Buffer.from(enc.ciphertext, "base64");
  if (nonce.length !== NONCE_LENGTH || authTag.length !== AUTH_TAG_LENGTH || data.length === 0) {
    throw new WhatsAppInboxCryptoError("invalid_ciphertext");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    return new Uint8Array(Buffer.concat([decipher.update(data), decipher.final()]));
  } catch {
    throw new WhatsAppInboxCryptoError("decrypt_failed");
  }
}
