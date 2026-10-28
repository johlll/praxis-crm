import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";
import type { WhatsAppEnvironment } from "@/server/whatsapp/environment";
import { whatsappContactIdentity } from "@/server/whatsapp/provider/contract";

/**
 * Cifra e índice cego do BSUID (B3.2d-2b1, docs/decisoes/b3-whatsapp-real.md
 * §21). O BSUID é PII nova: o banco só guarda o texto cifrado e o índice.
 *
 * Mesmo PADRÃO aprovado na A3 para CPF/CNPJ
 * (src/server/crypto/contact-sensitive.ts): AES-256-GCM com IV aleatório,
 * decifrado só aqui, e índice cego HMAC-SHA256 para busca. Chaves PRÓPRIAS,
 * nunca as da inbox, das credenciais do canal ou dos contatos:
 *   WHATSAPP_IDENTITY_KEY_VERSIONS = {"<versão>": "<32 bytes em base64>"}
 *   WHATSAPP_IDENTITY_ACTIVE_KEY_VERSION = "<versão>"
 * De cada chave saem, por HKDF-SHA256, duas subchaves de finalidades
 * diferentes (cifra e índice): uma nunca serve de outra.
 *
 * O escopo (ambiente, workspace e canal) entra no índice e na AAD: o mesmo
 * BSUID em outro canal, workspace ou ambiente gera outro índice, e um texto
 * cifrado não decifra fora do escopo dele. Canal legado da A7 (sem ambiente)
 * usa o marcador `legacy`.
 */

export const WHATSAPP_IDENTITY_PURPOSE = "praxis:whatsapp:identity:v1";

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const VERSION = /^[A-Za-z0-9_-]{1,32}$/;

export class WhatsAppIdentityCryptoError extends Error {
  constructor(
    public readonly code: "not_configured" | "unknown_key_version" | "invalid_ciphertext" | "decrypt_failed" | "invalid_context" | "invalid_bsuid",
  ) {
    super(`whatsapp_identity_crypto_${code}`);
    this.name = "WhatsAppIdentityCryptoError";
  }
}

export type WhatsAppIdentityScope = {
  /** NULL só para o canal legado da A7. */
  environment: WhatsAppEnvironment | null;
  workspaceId: string;
  channelId: string;
};

export type EncryptedWhatsAppBsuid = { ciphertextBase64: string; blindIndexBase64: string; keyVersion: string };

type Keys = { activeVersion: string; keys: Record<string, { cipher: Buffer; blindIndex: Buffer }> };

function derive(key: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), `${WHATSAPP_IDENTITY_PURPOSE}:${purpose}`, 32));
}

/** Falha fechada: variáveis ausentes ou inválidas → `not_configured`; nunca
 * cai numa chave padrão ou de outro módulo. */
function loadKeys(): Keys {
  const active = process.env.WHATSAPP_IDENTITY_ACTIVE_KEY_VERSION;
  const rawVersions = process.env.WHATSAPP_IDENTITY_KEY_VERSIONS;
  if (typeof active !== "string" || !VERSION.test(active) || typeof rawVersions !== "string" || rawVersions === "") {
    throw new WhatsAppIdentityCryptoError("not_configured");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawVersions);
  } catch {
    throw new WhatsAppIdentityCryptoError("not_configured");
  }
  const versions = z.record(z.string().regex(VERSION), z.string().min(1)).safeParse(parsed);
  if (!versions.success) throw new WhatsAppIdentityCryptoError("not_configured");

  const keys: Keys["keys"] = {};
  for (const [version, base64] of Object.entries(versions.data)) {
    const key = Buffer.from(base64, "base64");
    if (key.length !== 32) throw new WhatsAppIdentityCryptoError("not_configured");
    keys[version] = { cipher: derive(key, "aes-256-gcm"), blindIndex: derive(key, "blind-index") };
  }
  if (!keys[active]) throw new WhatsAppIdentityCryptoError("not_configured");
  return { activeVersion: active, keys };
}

function scopeLabel(scope: WhatsAppIdentityScope): string {
  const env = scope?.environment;
  if (env !== null && env !== "production" && env !== "preview") throw new WhatsAppIdentityCryptoError("invalid_context");
  const workspace = uuidSchema.safeParse(scope.workspaceId);
  const channel = uuidSchema.safeParse(scope.channelId);
  if (!workspace.success || !channel.success) throw new WhatsAppIdentityCryptoError("invalid_context");
  return `${env ?? "legacy"}|${workspace.data.toLowerCase()}|${channel.data.toLowerCase()}`;
}

function checkedBsuid(bsuid: unknown): string {
  if (typeof bsuid !== "string") throw new WhatsAppIdentityCryptoError("invalid_bsuid");
  const identity = whatsappContactIdentity({ bsuid });
  if (!identity || identity.bsuid !== bsuid) throw new WhatsAppIdentityCryptoError("invalid_bsuid");
  return bsuid;
}

function blindIndex(key: Buffer, scope: string, bsuid: string): Buffer {
  return createHmac("sha256", key).update(`${WHATSAPP_IDENTITY_PURPOSE}|bsuid|${scope}|${bsuid}`).digest();
}

/** Cifra + índice para uma gravação nova, sempre com a versão ATIVA. */
export function encryptWhatsAppBsuid(scope: WhatsAppIdentityScope, bsuid: string): EncryptedWhatsAppBsuid {
  const label = scopeLabel(scope);
  const value = checkedBsuid(bsuid);
  const { activeVersion, keys } = loadKeys();
  const key = keys[activeVersion]!;

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key.cipher, iv);
  cipher.setAAD(Buffer.from(`${WHATSAPP_IDENTITY_PURPOSE}|${label}`, "utf8"));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== AUTH_TAG_LENGTH) throw new WhatsAppIdentityCryptoError("invalid_ciphertext");

  return {
    ciphertextBase64: Buffer.concat([iv, tag, encrypted]).toString("base64"),
    blindIndexBase64: blindIndex(key.blindIndex, label, value).toString("base64"),
    keyVersion: activeVersion,
  };
}

/** Índices do BSUID em TODAS as versões de chave conhecidas, para busca. */
export function whatsappBsuidBlindIndexes(scope: WhatsAppIdentityScope, bsuid: string): { keyVersion: string; blindIndexBase64: string }[] {
  const label = scopeLabel(scope);
  const value = checkedBsuid(bsuid);
  const { keys } = loadKeys();
  return Object.entries(keys).map(([keyVersion, key]) => ({
    keyVersion,
    blindIndexBase64: blindIndex(key.blindIndex, label, value).toString("base64"),
  }));
}

/** Decifra só no escopo da gravação (AAD). Nenhum erro carrega o valor. */
export function decryptWhatsAppBsuid(scope: WhatsAppIdentityScope, encrypted: { ciphertextBase64: string; keyVersion: string }): string {
  const label = scopeLabel(scope);
  const { keys } = loadKeys();
  const key = keys[encrypted.keyVersion];
  if (!key) throw new WhatsAppIdentityCryptoError("unknown_key_version");
  const raw = Buffer.from(encrypted.ciphertextBase64, "base64");
  if (raw.length <= IV_LENGTH + AUTH_TAG_LENGTH) throw new WhatsAppIdentityCryptoError("invalid_ciphertext");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.cipher, raw.subarray(0, IV_LENGTH));
    decipher.setAAD(Buffer.from(`${WHATSAPP_IDENTITY_PURPOSE}|${label}`, "utf8"));
    decipher.setAuthTag(raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH));
    return Buffer.concat([decipher.update(raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH)), decipher.final()]).toString("utf8");
  } catch {
    throw new WhatsAppIdentityCryptoError("decrypt_failed");
  }
}
