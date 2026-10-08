import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { z } from "zod";

import type { CalendarEnvironment } from "@/server/calendar/environment";

/**
 * Cifra dos tokens do Google (B2, docs/decisoes/b2-google-agenda.md §4/§7).
 *
 * AES-256-GCM, mesmo formato de `contact-sensitive.ts`
 * (iv 12B || authTag 16B || ciphertext, em base64).
 *
 * ISOLAMENTO POR AMBIENTE, em duas camadas independentes:
 *  1. As chaves vêm de `CALENDAR_TOKEN_KEY_VERSIONS`, uma variável com
 *     valores DIFERENTES em Preview e Production (escopo da Vercel): um
 *     ambiente nem tem a chave do outro.
 *  2. O ambiente, o workspace e o usuário dono entram como dado adicional
 *     autenticado (AAD) do GCM. Mesmo que, por engano, as duas chaves fossem iguais, o
 *     token cifrado por um ambiente NÃO decifra no outro, nem para outro
 *     usuário ou workspace — a etiqueta de autenticação falha.
 *
 * O banco só guarda o texto base64 opaco; nunca vê token.
 */

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

const keysSchema = z.object({
  CALENDAR_TOKEN_ACTIVE_KEY_VERSION: z.string().min(1),
  CALENDAR_TOKEN_KEY_VERSIONS: z
    .string()
    .min(1)
    .transform((raw, ctx) => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "CALENDAR_TOKEN_KEY_VERSIONS não é JSON válido." });
        return z.NEVER;
      }
    })
    .pipe(z.record(z.string(), z.string().min(1))),
});

export type CalendarTokenKeys = { activeVersion: string; keys: Record<string, Buffer> };

export function getCalendarTokenKeys(): CalendarTokenKeys {
  const parsed = keysSchema.parse({
    CALENDAR_TOKEN_ACTIVE_KEY_VERSION: process.env.CALENDAR_TOKEN_ACTIVE_KEY_VERSION,
    CALENDAR_TOKEN_KEY_VERSIONS: process.env.CALENDAR_TOKEN_KEY_VERSIONS,
  });
  const keys: Record<string, Buffer> = {};
  for (const [version, base64] of Object.entries(parsed.CALENDAR_TOKEN_KEY_VERSIONS)) {
    const key = Buffer.from(base64, "base64");
    if (key.length !== 32) {
      throw new Error(`A chave "${version}" de CALENDAR_TOKEN_KEY_VERSIONS não tem 32 bytes.`);
    }
    keys[version] = key;
  }
  if (!keys[parsed.CALENDAR_TOKEN_ACTIVE_KEY_VERSION]) {
    throw new Error("CALENDAR_TOKEN_ACTIVE_KEY_VERSION não existe em CALENDAR_TOKEN_KEY_VERSIONS.");
  }
  return { activeVersion: parsed.CALENDAR_TOKEN_ACTIVE_KEY_VERSION, keys };
}

/** Identidade estável e conhecida ANTES de a conexão existir no banco (o id
 * da linha é gerado pelo próprio INSERT). */
export type TokenContext = { environment: CalendarEnvironment; workspaceId: string; userId: string };

function aad(ctx: TokenContext): Buffer {
  return Buffer.from(`calendar-token|${ctx.environment}|${ctx.workspaceId}|${ctx.userId}`, "utf8");
}

export type EncryptedToken = { ciphertextBase64: string; keyVersion: string };

export function encryptCalendarToken(plain: string, ctx: TokenContext): EncryptedToken {
  const { activeVersion, keys } = getCalendarTokenKeys();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", keys[activeVersion]!, iv);
  cipher.setAAD(aad(ctx));
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  if (authTag.length !== AUTH_TAG_LENGTH) throw new Error("Tamanho de authTag inesperado.");
  return {
    ciphertextBase64: Buffer.concat([iv, authTag, encrypted]).toString("base64"),
    keyVersion: activeVersion,
  };
}

/** Falha (lança) para adulteração, outro usuário/workspace, outro ambiente ou chave
 * desconhecida — nunca devolve texto parcial. */
export function decryptCalendarToken(ciphertextBase64: string, keyVersion: string, ctx: TokenContext): string {
  const { keys } = getCalendarTokenKeys();
  const key = keys[keyVersion];
  if (!key) throw new Error(`Nenhuma chave de token de calendário para a versão "${keyVersion}".`);

  const raw = Buffer.from(ciphertextBase64, "base64");
  if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) throw new Error("Token cifrado inválido.");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const data = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad(ctx));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
