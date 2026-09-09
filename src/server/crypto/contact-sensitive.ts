import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

import { getEnv } from "@/server/env";

/**
 * Cifra e blind index de CPF/CNPJ — decisão registrada em
 * docs/decisoes/a3-criptografia.md, API conferida na documentação oficial
 * do Node (https://nodejs.org/api/crypto.html#class-cipheriv) antes de
 * escrever este arquivo.
 *
 * A cifra e o cálculo do HMAC rodam aqui, em Node — nunca em SQL/pgcrypto.
 * `pgcrypto` não tem AES-GCM autenticado (só CBC/ECB); e manter a chave
 * fora do Postgres por completo é uma camada a mais: mesmo um acesso direto
 * ao banco não permite decifrar nada sem as variáveis de ambiente do
 * processo Node.
 */

const IV_LENGTH = 12; // 96 bits — recomendado para GCM
const AUTH_TAG_LENGTH = 16; // 128 bits — padrão do Node, nunca reduzido

export type EncryptedContactValue = {
  /** iv (12B) || authTag (16B) || ciphertext — uma única coluna bytea. */
  ciphertextBase64: string;
  blindIndexBase64: string;
  keyVersion: string;
};

function keysForVersion(version: string) {
  const env = getEnv();
  const entry = env.CONTACTS_KEY_VERSIONS[version];
  if (!entry) {
    throw new Error(
      `Nenhuma chave registrada para a versão "${version}" em CONTACTS_KEY_VERSIONS.`,
    );
  }
  return entry;
}

/** CPF/CNPJ só com dígitos — a mesma normalização em toda entrada (cifra,
 * blind index e busca), nunca confiada como já normalizada vinda do cliente. */
export function normalizeCpfCnpj(raw: string): string {
  return raw.replace(/\D/g, "");
}

function computeBlindIndex(workspaceId: string, normalized: string, hmacKey: Buffer): Buffer {
  // workspace_id entra na mensagem: sem isso, o mesmo CPF em dois
  // workspaces diferentes produziria o mesmo índice, permitindo correlação
  // entre escritórios só comparando blind indexes — ver a3-criptografia.md.
  return createHmac("sha256", hmacKey).update(`${workspaceId}:${normalized}`).digest();
}

/**
 * Cifra + blind index para uma gravação nova (criar contato ou editar
 * CPF/CNPJ) — sempre com a versão de chave ATIVA. Nunca usada para busca
 * (ver `blindIndexesForSearch`, que cobre todas as versões conhecidas).
 */
export function encryptCpfCnpj(workspaceId: string, rawValue: string): EncryptedContactValue {
  const env = getEnv();
  const version = env.CONTACTS_ACTIVE_KEY_VERSION;
  const keys = keysForVersion(version);
  const normalized = normalizeCpfCnpj(rawValue);

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", keys.cipher, iv);
  const encrypted = Buffer.concat([cipher.update(normalized, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  if (authTag.length !== AUTH_TAG_LENGTH) {
    // Nunca deveria acontecer com o Node gerenciando o tamanho sozinho —
    // checagem defensiva porque o formato armazenado assume 16 bytes fixos.
    throw new Error("Tamanho de authTag inesperado.");
  }

  return {
    ciphertextBase64: Buffer.concat([iv, authTag, encrypted]).toString("base64"),
    blindIndexBase64: computeBlindIndex(workspaceId, normalized, keys.hmac).toString("base64"),
    keyVersion: version,
  };
}

/**
 * Decifra um valor já armazenado — precisa da versão gravada na própria
 * linha (`key_version`), não da versão ativa (uma linha antiga, ainda não
 * reindexada, usa uma chave anterior — ver procedimento de rotação).
 */
export function decryptCpfCnpj(ciphertextBase64: string, keyVersion: string): string {
  const keys = keysForVersion(keyVersion);
  const raw = Buffer.from(ciphertextBase64, "base64");
  if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Ciphertext armazenado é curto demais para o formato esperado.");
  }

  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const data = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv("aes-256-gcm", keys.cipher, iv);
  decipher.setAuthTag(authTag);
  // Se a tag não bater (adulteração, ou chave errada para a versão),
  // decipher.final() lança — nunca devolve texto parcial silenciosamente.
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/**
 * Todos os blind indexes possíveis para um valor de busca, um por versão de
 * chave conhecida — necessário porque linhas gravadas antes de uma rotação
 * ainda usam a chave antiga até serem reindexadas; sem isso, buscar um CPF
 * gravado com a versão anterior à ativa nunca encontraria a linha.
 */
export function blindIndexesForSearch(workspaceId: string, rawValue: string): string[] {
  const env = getEnv();
  const normalized = normalizeCpfCnpj(rawValue);
  return Object.values(env.CONTACTS_KEY_VERSIONS).map((keys) =>
    computeBlindIndex(workspaceId, normalized, keys.hmac).toString("base64"),
  );
}
