import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { z } from "zod";

import type { WhatsAppEnvironment } from "@/server/whatsapp/environment";
import type { WhatsAppProviderKind } from "@/server/whatsapp/provider/contract";

/**
 * Cifra das credenciais do canal de WhatsApp (B3.1,
 * docs/decisoes/b3-whatsapp-real.md §7.1).
 *
 * AES-256-GCM (iv 12B || authTag 16B || ciphertext, em base64), com chave
 * versionada PRÓPRIA (`WHATSAPP_CREDENTIAL_ACTIVE_KEY_VERSION` +
 * `WHATSAPP_CREDENTIAL_KEY_VERSIONS`, valores diferentes por ambiente). Não
 * lê nenhuma chave de calendário, de contatos ou da A11.
 *
 * A AAD amarra o texto cifrado a finalidade, versão do formato, ambiente,
 * workspace, canal, provedor e propósito da credencial: trocar qualquer um
 * deles faz a etiqueta de autenticação falhar. Mesmo com a mesma chave por
 * engano, um texto cifrado pela B2 não decifra aqui (outra AAD).
 *
 * Erros são sempre `WhatsAppCredentialError` com mensagem fixa: nunca
 * carregam o texto cifrado, a chave ou o valor em claro.
 */

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export const WHATSAPP_CREDENTIAL_AAD_PREFIX = "praxis:whatsapp:credential:v1";

export type WhatsAppCredentialPurpose = "api_key" | "webhook_secret";

export class WhatsAppCredentialError extends Error {
  constructor(
    public readonly code: "not_configured" | "unknown_key_version" | "invalid_ciphertext" | "decrypt_failed",
  ) {
    super(`whatsapp_credential_${code}`);
    this.name = "WhatsAppCredentialError";
  }
}

const keysSchema = z.object({
  WHATSAPP_CREDENTIAL_ACTIVE_KEY_VERSION: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  WHATSAPP_CREDENTIAL_KEY_VERSIONS: z.string().min(1),
});

export type WhatsAppCredentialKeys = { activeVersion: string; keys: Record<string, Buffer> };

/** Lança `not_configured` quando as variáveis faltam ou são inválidas —
 * nunca cai numa chave padrão. */
export function getWhatsAppCredentialKeys(): WhatsAppCredentialKeys {
  const parsed = keysSchema.safeParse({
    WHATSAPP_CREDENTIAL_ACTIVE_KEY_VERSION: process.env.WHATSAPP_CREDENTIAL_ACTIVE_KEY_VERSION,
    WHATSAPP_CREDENTIAL_KEY_VERSIONS: process.env.WHATSAPP_CREDENTIAL_KEY_VERSIONS,
  });
  if (!parsed.success) throw new WhatsAppCredentialError("not_configured");

  let raw: unknown;
  try {
    raw = JSON.parse(parsed.data.WHATSAPP_CREDENTIAL_KEY_VERSIONS);
  } catch {
    throw new WhatsAppCredentialError("not_configured");
  }
  const versions = z.record(z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), z.string().min(1)).safeParse(raw);
  if (!versions.success) throw new WhatsAppCredentialError("not_configured");

  const keys: Record<string, Buffer> = {};
  for (const [version, base64] of Object.entries(versions.data)) {
    const key = Buffer.from(base64, "base64");
    if (key.length !== 32) throw new WhatsAppCredentialError("not_configured");
    keys[version] = key;
  }
  const activeVersion = parsed.data.WHATSAPP_CREDENTIAL_ACTIVE_KEY_VERSION;
  if (!keys[activeVersion]) throw new WhatsAppCredentialError("not_configured");
  return { activeVersion, keys };
}

export function isWhatsAppCredentialCryptoConfigured(): boolean {
  try {
    getWhatsAppCredentialKeys();
    return true;
  } catch {
    return false;
  }
}

/** Identidade da credencial. O id do canal é gerado pela aplicação antes do
 * INSERT justamente para poder entrar aqui. */
export type CredentialContext = {
  environment: WhatsAppEnvironment;
  workspaceId: string;
  channelId: string;
  provider: WhatsAppProviderKind;
  purpose: WhatsAppCredentialPurpose;
};

export function credentialAad(ctx: CredentialContext): Buffer {
  return Buffer.from(
    [WHATSAPP_CREDENTIAL_AAD_PREFIX, ctx.environment, ctx.workspaceId, ctx.channelId, ctx.provider, ctx.purpose].join("|"),
    "utf8",
  );
}

export type EncryptedCredential = { ciphertextBase64: string; keyVersion: string };

export function encryptWhatsAppCredential(plain: string, ctx: CredentialContext): EncryptedCredential {
  const { activeVersion, keys } = getWhatsAppCredentialKeys();
  const key = keys[activeVersion]!;
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(credentialAad(ctx));
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertextBase64: Buffer.concat([iv, authTag, encrypted]).toString("base64"),
    keyVersion: activeVersion,
  };
}

/** Falha (lança) para adulteração, outra AAD (ambiente, workspace, canal,
 * provedor, propósito) ou chave desconhecida — nunca devolve texto parcial. */
export function decryptWhatsAppCredential(ciphertextBase64: string, keyVersion: string, ctx: CredentialContext): string {
  const { keys } = getWhatsAppCredentialKeys();
  const key = keys[keyVersion];
  if (!key) throw new WhatsAppCredentialError("unknown_key_version");

  const raw = Buffer.from(ciphertextBase64, "base64");
  if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) throw new WhatsAppCredentialError("invalid_ciphertext");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const data = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(credentialAad(ctx));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    throw new WhatsAppCredentialError("decrypt_failed");
  }
}
