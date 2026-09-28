import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

import { getIngestConfig, getPayloadKey } from "@/server/ingest/config";

/**
 * Cifra do payload bruto dos eventos públicos (A11).
 *
 * Mesmo algoritmo já validado na A3 (AES-256-GCM, IV de 12 bytes sorteado
 * a cada operação, auth tag de 16 bytes), com duas diferenças
 * deliberadas:
 *
 *  1. CHAVE EXCLUSIVA da A11 (`A11_PAYLOAD_KEY_VERSIONS`), separada da
 *     chave de contatos, do blind index e do segredo de cookie. Vazar uma
 *     não vaza a outra.
 *  2. Colunas SEPARADAS no banco (ciphertext, iv, auth tag, algoritmo,
 *     versão) em vez do formato concatenado da A3 — pedido explícito do
 *     contrato, e mais fácil de auditar linha a linha.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export type EncryptedPayload = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  algorithm: string;
  keyVersion: string;
};

export function encryptPayload(plaintext: string): EncryptedPayload {
  const version = getIngestConfig().A11_PAYLOAD_ACTIVE_KEY_VERSION;
  const key = getPayloadKey(version);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error("Tamanho de authTag inesperado.");
  }
  return { ciphertext, iv, authTag, algorithm: ALGORITHM, keyVersion: version };
}

/**
 * Decifra em memória, no worker. A chave vem da VERSÃO gravada na linha
 * (não da ativa): um evento recebido antes de uma rotação continua
 * legível. Versão desconhecida lança — nunca devolve texto parcial.
 */
export function decryptPayload(input: {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  algorithm: string;
  keyVersion: string;
}): string {
  if (input.algorithm !== ALGORITHM) {
    throw new Error("Algoritmo de cifra não suportado.");
  }
  const key = getPayloadKey(input.keyVersion);
  const decipher = createDecipheriv(ALGORITHM, key, input.iv);
  decipher.setAuthTag(input.authTag);
  // Tag que não bate (adulteração ou chave errada) faz final() lançar.
  return Buffer.concat([decipher.update(input.ciphertext), decipher.final()]).toString("utf8");
}

/**
 * HMAC do IP — o IP completo NUNCA sai daqui. Chave própria
 * (`A11_IP_HMAC_KEY`), separada de tudo o mais, para que o identificador
 * usado no rate limit não sirva de ponte para outro dado.
 */
export function hmacIp(ip: string): Buffer {
  const key = getIngestConfig().A11_IP_HMAC_KEY;
  return createHmac("sha256", key).update(ip).digest();
}
