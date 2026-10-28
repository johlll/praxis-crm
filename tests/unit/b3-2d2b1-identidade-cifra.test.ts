/**
 * @vitest-environment node
 *
 * B3.2d-2b1 — o BSUID é PII nova: nunca fica em texto puro no banco.
 * Mesmo padrão aprovado na A3 (CPF/CNPJ): AES-256-GCM decifrado só no
 * Node e índice cego HMAC-SHA256 para busca. Chaves PRÓPRIAS
 * (`WHATSAPP_IDENTITY_KEY_VERSIONS` / `WHATSAPP_IDENTITY_ACTIVE_KEY_VERSION`),
 * nunca as da inbox, das credenciais do canal ou dos contatos.
 *
 * O escopo (ambiente, workspace e canal) entra no índice e na AAD: o mesmo
 * BSUID em outro canal, workspace ou ambiente gera outro índice, e um texto
 * cifrado não decifra fora do escopo dele.
 *
 * Escritos ANTES da implementação, contra a main 6633084. Chaves fictícias.
 */
import { createHash, createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadCrypto = () => import("@/server/whatsapp/identity-crypto");

const KEY_1 = Buffer.alloc(32, 11).toString("base64");
const KEY_2 = Buffer.alloc(32, 22).toString("base64");
const OTHER = Buffer.alloc(32, 33).toString("base64");
const WS = "10000000-0000-0000-0000-000000000001";
const OTHER_WS = "10000000-0000-0000-0000-000000000002";
const CHANNEL = "36000000-0000-0000-0000-000000000001";
const OTHER_CHANNEL = "36000000-0000-0000-0000-000000000002";
const BSUID = "BR.1234567890";
const SCOPE = { environment: "preview" as const, workspaceId: WS, channelId: CHANNEL };

function configure(active = "1", versions: Record<string, string> = { "1": KEY_1 }) {
  vi.stubEnv("WHATSAPP_IDENTITY_KEY_VERSIONS", JSON.stringify(versions));
  vi.stubEnv("WHATSAPP_IDENTITY_ACTIVE_KEY_VERSION", active);
}

beforeEach(() => configure());
afterEach(() => vi.unstubAllEnvs());

describe("1. cifra e índice cego", () => {
  it("índice cego determinístico no mesmo escopo, com 32 bytes", async () => {
    const c = await loadCrypto();
    const a = c.encryptWhatsAppBsuid(SCOPE, BSUID);
    const b = c.encryptWhatsAppBsuid(SCOPE, BSUID);
    expect(a.blindIndexBase64).toBe(b.blindIndexBase64);
    expect(Buffer.from(a.blindIndexBase64, "base64")).toHaveLength(32);
    expect(a.keyVersion).toBe("1");
  });

  it("texto cifrado diferente a cada gravação (IV aleatório) e sem o BSUID", async () => {
    const c = await loadCrypto();
    const a = c.encryptWhatsAppBsuid(SCOPE, BSUID);
    const b = c.encryptWhatsAppBsuid(SCOPE, BSUID);
    expect(a.ciphertextBase64).not.toBe(b.ciphertextBase64);
    for (const value of [a.ciphertextBase64, a.blindIndexBase64, Buffer.from(a.ciphertextBase64, "base64").toString("latin1")]) {
      expect(value).not.toContain(BSUID);
      expect(value).not.toContain("1234567890");
    }
  });

  it.each([
    ["outro canal", { ...SCOPE, channelId: OTHER_CHANNEL }],
    ["outro workspace", { ...SCOPE, workspaceId: OTHER_WS }],
    ["outro ambiente", { ...SCOPE, environment: "production" as const }],
    ["canal legado (sem ambiente)", { ...SCOPE, environment: null }],
  ])("o mesmo BSUID em %s gera outro índice", async (_name, scope) => {
    const c = await loadCrypto();
    expect(c.encryptWhatsAppBsuid(scope, BSUID).blindIndexBase64).not.toBe(c.encryptWhatsAppBsuid(SCOPE, BSUID).blindIndexBase64);
  });

  it("o índice não é um hash simples do BSUID nem um HMAC com a chave crua", async () => {
    const c = await loadCrypto();
    const index = c.encryptWhatsAppBsuid(SCOPE, BSUID).blindIndexBase64;
    expect(index).not.toBe(createHash("sha256").update(BSUID).digest("base64"));
    expect(index).not.toBe(createHmac("sha256", Buffer.from(KEY_1, "base64")).update(BSUID).digest("base64"));
    expect(index).not.toBe(createHmac("sha256", Buffer.from(KEY_1, "base64")).update(`${WS}:${BSUID}`).digest("base64"));
  });

  it("decifra só no mesmo escopo (AAD)", async () => {
    const c = await loadCrypto();
    const enc = c.encryptWhatsAppBsuid(SCOPE, BSUID);
    expect(c.decryptWhatsAppBsuid(SCOPE, enc)).toBe(BSUID);
    for (const scope of [{ ...SCOPE, channelId: OTHER_CHANNEL }, { ...SCOPE, workspaceId: OTHER_WS }, { ...SCOPE, environment: "production" as const }]) {
      expect(() => c.decryptWhatsAppBsuid(scope, enc)).toThrow(expect.objectContaining({ code: "decrypt_failed" }));
    }
  });

  it("busca cobre todas as versões de chave; gravação usa só a ativa", async () => {
    configure("2", { "1": KEY_1, "2": KEY_2 });
    const c = await loadCrypto();
    const indexes = c.whatsappBsuidBlindIndexes(SCOPE, BSUID);
    expect(indexes.map((i) => i.keyVersion).sort()).toEqual(["1", "2"]);
    expect(c.encryptWhatsAppBsuid(SCOPE, BSUID).keyVersion).toBe("2");
    expect(new Set(indexes.map((i) => i.blindIndexBase64)).size).toBe(2);
  });

  it("um texto cifrado de versão desconhecida é recusado", async () => {
    const c = await loadCrypto();
    const enc = c.encryptWhatsAppBsuid(SCOPE, BSUID);
    expect(() => c.decryptWhatsAppBsuid(SCOPE, { ...enc, keyVersion: "9" })).toThrow(expect.objectContaining({ code: "unknown_key_version" }));
  });

  it.each(["", "  ", "BR 123", "+5511999990000", "x".repeat(129)])("BSUID inválido (%j): recusado antes da cifra", async (bsuid) => {
    const c = await loadCrypto();
    expect(() => c.encryptWhatsAppBsuid(SCOPE, bsuid)).toThrow(expect.objectContaining({ code: "invalid_bsuid" }));
  });

  it.each([
    ["workspace inválido", { ...SCOPE, workspaceId: "x" }],
    ["canal inválido", { ...SCOPE, channelId: "" }],
    ["ambiente desconhecido", { ...SCOPE, environment: "staging" }],
  ])("escopo com %s: recusado", async (_name, scope) => {
    const c = await loadCrypto();
    expect(() => c.encryptWhatsAppBsuid(scope as never, BSUID)).toThrow(expect.objectContaining({ code: "invalid_context" }));
  });
});

describe("2. chaves próprias, sem queda para outras", () => {
  it.each([
    ["sem as variáveis", {}],
    ["só as chaves da inbox", { WHATSAPP_INBOX_KEY_VERSIONS: JSON.stringify({ "1": OTHER }), WHATSAPP_INBOX_ACTIVE_KEY_VERSION: "1" }],
    ["só as das credenciais do canal", { WHATSAPP_CREDENTIAL_KEY_VERSIONS: JSON.stringify({ "1": OTHER }), WHATSAPP_CREDENTIAL_ACTIVE_KEY_VERSION: "1" }],
    ["só as dos contatos (A3)", { CONTACTS_KEY_VERSIONS: JSON.stringify({ "1": { cipher: OTHER, hmac: OTHER } }), CONTACTS_ACTIVE_KEY_VERSION: "1" }],
  ])("%s: not_configured", async (_name, env) => {
    vi.unstubAllEnvs();
    vi.stubEnv("WHATSAPP_IDENTITY_KEY_VERSIONS", "");
    vi.stubEnv("WHATSAPP_IDENTITY_ACTIVE_KEY_VERSION", "");
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
    const c = await loadCrypto();
    expect(() => c.encryptWhatsAppBsuid(SCOPE, BSUID)).toThrow(expect.objectContaining({ code: "not_configured" }));
  });

  it.each([
    ["chave curta", { "1": Buffer.alloc(16, 1).toString("base64") }, "1"],
    ["versão ativa ausente", { "1": KEY_1 }, "2"],
    ["JSON inválido", "não é json", "1"],
  ])("%s: not_configured", async (_name, versions, active) => {
    vi.stubEnv("WHATSAPP_IDENTITY_KEY_VERSIONS", typeof versions === "string" ? versions : JSON.stringify(versions));
    vi.stubEnv("WHATSAPP_IDENTITY_ACTIVE_KEY_VERSION", active);
    const c = await loadCrypto();
    expect(() => c.encryptWhatsAppBsuid(SCOPE, BSUID)).toThrow(expect.objectContaining({ code: "not_configured" }));
  });

  it("estático: o módulo só lê WHATSAPP_IDENTITY_*", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(`${process.cwd()}/src/server/whatsapp/identity-crypto.ts`, "utf8");
    const envs = [...src.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect(envs.length).toBeGreaterThan(0);
    for (const name of envs) expect(name).toMatch(/^WHATSAPP_IDENTITY_/);
    expect(src).not.toMatch(/getEnv\(|CONTACTS_|WHATSAPP_INBOX_|WHATSAPP_CREDENTIAL_/);
  });

  it("nenhum erro carrega o BSUID ou a chave", async () => {
    const c = await loadCrypto();
    const enc = c.encryptWhatsAppBsuid(SCOPE, BSUID);
    const errors: unknown[] = [];
    try {
      c.decryptWhatsAppBsuid({ ...SCOPE, channelId: OTHER_CHANNEL }, enc);
    } catch (e) {
      errors.push(e);
    }
    try {
      c.encryptWhatsAppBsuid(SCOPE, "BR 123 inválido");
    } catch (e) {
      errors.push(e);
    }
    expect(errors).toHaveLength(2);
    for (const e of errors) {
      const text = `${(e as Error).message} ${(e as Error).stack ?? ""}`;
      expect(text).not.toContain(BSUID);
      expect(text).not.toContain("BR 123");
      expect(text).not.toContain(KEY_1);
    }
  });
});
