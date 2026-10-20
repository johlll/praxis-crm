/**
 * @vitest-environment node
 *
 * B3.1 — cifra das credenciais do canal de WhatsApp (AES-256-GCM, chave
 * versionada própria e AAD própria). Prova que a AAD amarra ambiente,
 * workspace, canal, provedor e propósito, e que nada do calendário serve.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptCalendarToken } from "@/server/calendar/token-crypto";
import {
  credentialAad,
  decryptWhatsAppCredential,
  encryptWhatsAppCredential,
  getWhatsAppCredentialKeys,
  isWhatsAppCredentialCryptoConfigured,
  WHATSAPP_CREDENTIAL_AAD_PREFIX,
  WhatsAppCredentialError,
  type CredentialContext,
} from "@/server/whatsapp/credential-crypto";

const KEY_1 = Buffer.alloc(32, 7).toString("base64");
const KEY_2 = Buffer.alloc(32, 9).toString("base64");
const SECRET = "segredo-de-teste-que-nunca-pode-vazar-0001";

const CTX: CredentialContext = {
  environment: "preview",
  workspaceId: "10000000-0000-0000-0000-000000000001",
  channelId: "30000000-0000-0000-0000-000000000001",
  provider: "simulated",
  purpose: "webhook_secret",
};

function useKeys(keys: Record<string, string>, active: string) {
  vi.stubEnv("WHATSAPP_CREDENTIAL_KEY_VERSIONS", JSON.stringify(keys));
  vi.stubEnv("WHATSAPP_CREDENTIAL_ACTIVE_KEY_VERSION", active);
}

beforeEach(() => useKeys({ "1": KEY_1 }, "1"));
afterEach(() => vi.unstubAllEnvs());

function expectFailure(fn: () => unknown, code: WhatsAppCredentialError["code"]) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WhatsAppCredentialError);
    expect((error as WhatsAppCredentialError).code).toBe(code);
    return error as WhatsAppCredentialError;
  }
  throw new Error("deveria ter falhado");
}

describe("ida e volta", () => {
  it("decifra com o mesmo contexto e a mesma versão", () => {
    const enc = encryptWhatsAppCredential(SECRET, CTX);
    expect(enc.keyVersion).toBe("1");
    expect(enc.ciphertextBase64).not.toContain(SECRET);
    expect(decryptWhatsAppCredential(enc.ciphertextBase64, enc.keyVersion, CTX)).toBe(SECRET);
  });

  it("cada cifragem usa IV novo", () => {
    const a = encryptWhatsAppCredential(SECRET, CTX).ciphertextBase64;
    const b = encryptWhatsAppCredential(SECRET, CTX).ciphertextBase64;
    expect(a).not.toBe(b);
  });

  it("chave antiga continua decifrando depois da rotação da versão ativa", () => {
    const enc = encryptWhatsAppCredential(SECRET, CTX);
    useKeys({ "1": KEY_1, "2": KEY_2 }, "2");
    expect(encryptWhatsAppCredential(SECRET, CTX).keyVersion).toBe("2");
    expect(decryptWhatsAppCredential(enc.ciphertextBase64, "1", CTX)).toBe(SECRET);
  });
});

describe("a AAD amarra a credencial ao seu contexto", () => {
  const enc = () => encryptWhatsAppCredential(SECRET, CTX);

  it.each<[string, Partial<CredentialContext>]>([
    ["Preview não decifra em Production", { environment: "production" }],
    ["outro workspace não decifra", { workspaceId: "10000000-0000-0000-0000-000000000002" }],
    ["outro canal não decifra", { channelId: "30000000-0000-0000-0000-000000000002" }],
    ["outro provedor não decifra", { provider: "ycloud" }],
    ["outro propósito não decifra", { purpose: "api_key" }],
  ])("%s", (_nome, troca) => {
    const e = enc();
    expectFailure(() => decryptWhatsAppCredential(e.ciphertextBase64, e.keyVersion, { ...CTX, ...troca }), "decrypt_failed");
  });

  it("a AAD contém finalidade, versão e todos os campos do contexto", () => {
    const aad = credentialAad(CTX).toString("utf8");
    expect(aad).toBe(
      [WHATSAPP_CREDENTIAL_AAD_PREFIX, CTX.environment, CTX.workspaceId, CTX.channelId, CTX.provider, CTX.purpose].join("|"),
    );
    expect(WHATSAPP_CREDENTIAL_AAD_PREFIX).toBe("praxis:whatsapp:credential:v1");
  });

  it("texto cifrado adulterado falha", () => {
    const e = enc();
    const raw = Buffer.from(e.ciphertextBase64, "base64");
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff;
    expectFailure(() => decryptWhatsAppCredential(raw.toString("base64"), e.keyVersion, CTX), "decrypt_failed");
  });

  it("etiqueta de autenticação adulterada falha", () => {
    const e = enc();
    const raw = Buffer.from(e.ciphertextBase64, "base64");
    raw[13] = raw[13]! ^ 0x01;
    expectFailure(() => decryptWhatsAppCredential(raw.toString("base64"), e.keyVersion, CTX), "decrypt_failed");
  });

  it("texto curto demais é recusado antes de decifrar", () => {
    expectFailure(() => decryptWhatsAppCredential("AAAA", "1", CTX), "invalid_ciphertext");
  });

  it("versão de chave desconhecida é recusada", () => {
    const e = enc();
    expectFailure(() => decryptWhatsAppCredential(e.ciphertextBase64, "9", CTX), "unknown_key_version");
  });
});

describe("separação completa entre as chaves da B2 e da B3", () => {
  it("só as variáveis de calendário configuradas: o WhatsApp continua sem cifra", () => {
    vi.stubEnv("WHATSAPP_CREDENTIAL_KEY_VERSIONS", "");
    vi.stubEnv("WHATSAPP_CREDENTIAL_ACTIVE_KEY_VERSION", "");
    vi.stubEnv("CALENDAR_TOKEN_KEY_VERSIONS", JSON.stringify({ "1": KEY_1 }));
    vi.stubEnv("CALENDAR_TOKEN_ACTIVE_KEY_VERSION", "1");
    expect(isWhatsAppCredentialCryptoConfigured()).toBe(false);
    expectFailure(() => encryptWhatsAppCredential(SECRET, CTX), "not_configured");
  });

  it("texto cifrado pela B2, com a MESMA chave bruta, não decifra como credencial de WhatsApp", () => {
    vi.stubEnv("CALENDAR_TOKEN_KEY_VERSIONS", JSON.stringify({ "1": KEY_1 }));
    vi.stubEnv("CALENDAR_TOKEN_ACTIVE_KEY_VERSION", "1");
    const calendar = encryptCalendarToken(SECRET, {
      environment: "preview",
      workspaceId: CTX.workspaceId,
      userId: CTX.channelId,
    });
    expectFailure(() => decryptWhatsAppCredential(calendar.ciphertextBase64, "1", CTX), "decrypt_failed");
  });
});

describe("configuração e erros nunca vazam segredo", () => {
  it.each([
    ["ausente", undefined, "1"],
    ["JSON inválido", "{nao-e-json", "1"],
    ["chave curta", JSON.stringify({ "1": Buffer.alloc(16).toString("base64") }), "1"],
    ["versão ativa inexistente", JSON.stringify({ "1": KEY_1 }), "2"],
  ])("configuração %s → not_configured", (_nome, versions, active) => {
    vi.stubEnv("WHATSAPP_CREDENTIAL_KEY_VERSIONS", versions ?? "");
    vi.stubEnv("WHATSAPP_CREDENTIAL_ACTIVE_KEY_VERSION", active);
    expectFailure(() => getWhatsAppCredentialKeys(), "not_configured");
  });

  it("a mensagem do erro não carrega texto cifrado, segredo nem chave", () => {
    const e = encryptWhatsAppCredential(SECRET, CTX);
    const error = expectFailure(
      () => decryptWhatsAppCredential(e.ciphertextBase64, e.keyVersion, { ...CTX, channelId: "outro" }),
      "decrypt_failed",
    );
    const visible = `${error.message} ${String(error)} ${JSON.stringify(error)}`;
    expect(visible).not.toContain(e.ciphertextBase64);
    expect(visible).not.toContain(SECRET);
    expect(visible).not.toContain(KEY_1);
  });
});
