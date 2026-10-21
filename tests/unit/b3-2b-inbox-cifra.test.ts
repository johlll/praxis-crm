/**
 * @vitest-environment node
 *
 * B3.2b — cifra PRÓPRIA da caixa de entrada do webhook.
 *
 * AES-256-GCM com chaves só da inbox (`WHATSAPP_INBOX_KEY_VERSIONS` +
 * `WHATSAPP_INBOX_ACTIVE_KEY_VERSION`), sem reutilizar agenda nem
 * credenciais do canal. A AAD prende a cifra a finalidade/versão, ambiente,
 * workspace, canal, provedor e id do evento: trocar qualquer um impede a
 * decifragem. Nonce, texto cifrado e tag ficam separados.
 *
 * Escritos ANTES da implementação, contra a main 3feedd1.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const load = () => import("@/server/whatsapp/inbox-crypto");

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");

type Ctx = {
  environment: "production" | "preview";
  workspaceId: string;
  channelId: string;
  provider: "simulated" | "ycloud" | "meta";
  providerEventId: string;
};

const CTX: Ctx = {
  environment: "preview",
  workspaceId: "10000000-0000-0000-0000-000000000001",
  channelId: "33000000-0000-0000-0000-000000000001",
  provider: "simulated",
  providerEventId: "evt_ficticio_0001",
};

function keys(versions: Record<string, string> = { "1": KEY_A }, active = "1") {
  vi.stubEnv("WHATSAPP_INBOX_KEY_VERSIONS", JSON.stringify(versions));
  vi.stubEnv("WHATSAPP_INBOX_ACTIVE_KEY_VERSION", active);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

const encoder = new TextEncoder();

const BODIES: Array<[string, Uint8Array]> = [
  ["acento e emoji", encoder.encode('{"text":"Olá, ação — 🚀"}')],
  ["LF", encoder.encode('{\n"a":1\n}\n')],
  ["CRLF", encoder.encode('{\r\n"a":1\r\n}\r\n')],
  ["BOM", new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode("{}")])],
  ["byte inválido em UTF-8", new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])],
  ["um byte", new Uint8Array([0x00])],
];

describe("1. ida e volta exata", () => {
  it.each(BODIES)("%s: decifra exatamente os mesmos bytes", async (_name, raw) => {
    keys();
    const { encryptWhatsAppInboxBody, decryptWhatsAppInboxBody } = await load();
    const enc = encryptWhatsAppInboxBody(raw, CTX);
    expect(Array.from(decryptWhatsAppInboxBody(enc, CTX))).toEqual(Array.from(raw));
  });

  it("LF e CRLF geram textos cifrados diferentes e voltam cada um ao seu", async () => {
    keys();
    const { encryptWhatsAppInboxBody, decryptWhatsAppInboxBody } = await load();
    const lf = encryptWhatsAppInboxBody(BODIES[1]![1], CTX);
    const crlf = encryptWhatsAppInboxBody(BODIES[2]![1], CTX);
    expect(lf.ciphertext).not.toBe(crlf.ciphertext);
    expect(Array.from(decryptWhatsAppInboxBody(crlf, CTX))).toEqual(Array.from(BODIES[2]![1]));
  });

  it("nonce de 12 bytes, tag de 16, separados e em base64; nonce novo a cada cifra", async () => {
    keys();
    const { encryptWhatsAppInboxBody } = await load();
    const a = encryptWhatsAppInboxBody(BODIES[0]![1], CTX);
    const b = encryptWhatsAppInboxBody(BODIES[0]![1], CTX);
    expect(Buffer.from(a.nonce, "base64")).toHaveLength(12);
    expect(Buffer.from(a.authTag, "base64")).toHaveLength(16);
    expect(a.keyVersion).toBe("1");
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.ciphertext).not.toContain(Buffer.from(BODIES[0]![1]).toString("base64"));
  });

  it("um corpo vazio não é cifrado", async () => {
    keys();
    const { encryptWhatsAppInboxBody } = await load();
    expect(() => encryptWhatsAppInboxBody(new Uint8Array(0), CTX)).toThrow();
  });
});

describe("2. AAD: qualquer elemento trocado impede a decifragem", () => {
  it.each([
    ["ambiente", { environment: "production" as const }],
    ["workspace", { workspaceId: "10000000-0000-0000-0000-000000000002" }],
    ["canal", { channelId: "33000000-0000-0000-0000-000000000002" }],
    ["provedor", { provider: "ycloud" as const }],
    ["id do evento", { providerEventId: "evt_ficticio_0002" }],
  ])("%s", async (_name, patch) => {
    keys();
    const { encryptWhatsAppInboxBody, decryptWhatsAppInboxBody } = await load();
    const enc = encryptWhatsAppInboxBody(BODIES[0]![1], CTX);
    expect(() => decryptWhatsAppInboxBody(enc, { ...CTX, ...patch })).toThrow(expect.objectContaining({ code: "decrypt_failed" }));
  });

  it("a AAD tem finalidade e versão próprias e todos os elementos", async () => {
    const { inboxAad, WHATSAPP_INBOX_AAD_PREFIX } = await load();
    expect(WHATSAPP_INBOX_AAD_PREFIX).toBe("praxis:whatsapp:inbox:v1");
    expect(inboxAad(CTX).toString("utf8")).toBe(
      [WHATSAPP_INBOX_AAD_PREFIX, CTX.environment, CTX.workspaceId, CTX.channelId, CTX.provider, CTX.providerEventId].join("|"),
    );
  });

  it("elemento com o separador `|` é recusado (duas identidades nunca dão a mesma AAD)", async () => {
    const { inboxAad } = await load();
    expect(() => inboxAad({ ...CTX, providerEventId: "x|y" })).toThrow();
    expect(() => inboxAad({ ...CTX, workspaceId: `${CTX.workspaceId}|${CTX.channelId}` })).toThrow();
  });

  it("nonce, tag ou texto cifrado adulterados: decrypt_failed", async () => {
    keys();
    const { encryptWhatsAppInboxBody, decryptWhatsAppInboxBody } = await load();
    const enc = encryptWhatsAppInboxBody(BODIES[0]![1], CTX);
    const flip = (b64: string) => {
      const buf = Buffer.from(b64, "base64");
      buf[0] = buf[0]! ^ 1;
      return buf.toString("base64");
    };
    for (const field of ["nonce", "authTag", "ciphertext"] as const) {
      expect(() => decryptWhatsAppInboxBody({ ...enc, [field]: flip(enc[field]) }, CTX)).toThrow(
        expect.objectContaining({ code: "decrypt_failed" }),
      );
    }
  });
});

describe("3. chaves próprias, por ambiente e por versão", () => {
  it("chave de Production usada no Preview (e vice-versa) não decifra", async () => {
    const { encryptWhatsAppInboxBody, decryptWhatsAppInboxBody } = await load();
    keys({ "1": KEY_A });
    const prod = encryptWhatsAppInboxBody(BODIES[0]![1], { ...CTX, environment: "production" });
    keys({ "1": KEY_B });
    const prev = encryptWhatsAppInboxBody(BODIES[0]![1], CTX);
    expect(() => decryptWhatsAppInboxBody(prod, { ...CTX, environment: "production" })).toThrow(
      expect.objectContaining({ code: "decrypt_failed" }),
    );
    keys({ "1": KEY_A });
    expect(() => decryptWhatsAppInboxBody(prev, CTX)).toThrow(expect.objectContaining({ code: "decrypt_failed" }));
  });

  it("versão de chave inexistente: unknown_key_version", async () => {
    keys({ "1": KEY_A });
    const { encryptWhatsAppInboxBody, decryptWhatsAppInboxBody } = await load();
    const enc = encryptWhatsAppInboxBody(BODIES[0]![1], CTX);
    expect(() => decryptWhatsAppInboxBody({ ...enc, keyVersion: "9" }, CTX)).toThrow(
      expect.objectContaining({ code: "unknown_key_version" }),
    );
  });

  it("rotação: a versão antiga continua decifrando o que cifrou", async () => {
    const { encryptWhatsAppInboxBody, decryptWhatsAppInboxBody } = await load();
    keys({ "1": KEY_A }, "1");
    const old = encryptWhatsAppInboxBody(BODIES[0]![1], CTX);
    keys({ "1": KEY_A, "2": KEY_B }, "2");
    const fresh = encryptWhatsAppInboxBody(BODIES[0]![1], CTX);
    expect(fresh.keyVersion).toBe("2");
    expect(Array.from(decryptWhatsAppInboxBody(old, CTX))).toEqual(Array.from(BODIES[0]![1]));
  });

  it.each([
    ["sem variáveis", undefined, undefined],
    ["versão ativa ausente do mapa", { "1": KEY_A }, "2"],
    ["chave curta", { "1": Buffer.alloc(16, 1).toString("base64") }, "1"],
    ["JSON inválido", "não é json", "1"],
  ])("falha fechada: %s", async (_name, versions, active) => {
    if (versions !== undefined) vi.stubEnv("WHATSAPP_INBOX_KEY_VERSIONS", typeof versions === "string" ? versions : JSON.stringify(versions));
    else vi.stubEnv("WHATSAPP_INBOX_KEY_VERSIONS", "");
    vi.stubEnv("WHATSAPP_INBOX_ACTIVE_KEY_VERSION", active ?? "");
    const { encryptWhatsAppInboxBody } = await load();
    expect(() => encryptWhatsAppInboxBody(BODIES[0]![1], CTX)).toThrow(expect.objectContaining({ code: "not_configured" }));
  });

  it("não usa as chaves de credencial do canal nem as da agenda", async () => {
    vi.stubEnv("WHATSAPP_INBOX_KEY_VERSIONS", "");
    vi.stubEnv("WHATSAPP_INBOX_ACTIVE_KEY_VERSION", "");
    vi.stubEnv("WHATSAPP_CREDENTIAL_KEY_VERSIONS", JSON.stringify({ "1": KEY_A }));
    vi.stubEnv("WHATSAPP_CREDENTIAL_ACTIVE_KEY_VERSION", "1");
    vi.stubEnv("CALENDAR_TOKEN_KEY_VERSIONS", JSON.stringify({ "1": KEY_A }));
    const { encryptWhatsAppInboxBody } = await load();
    expect(() => encryptWhatsAppInboxBody(BODIES[0]![1], CTX)).toThrow(expect.objectContaining({ code: "not_configured" }));
  });

  it("um texto cifrado de credencial (mesma chave) não decifra como inbox", async () => {
    vi.stubEnv("WHATSAPP_CREDENTIAL_KEY_VERSIONS", JSON.stringify({ "1": KEY_A }));
    vi.stubEnv("WHATSAPP_CREDENTIAL_ACTIVE_KEY_VERSION", "1");
    keys({ "1": KEY_A });
    const { encryptWhatsAppCredential } = await import("@/server/whatsapp/credential-crypto");
    const { decryptWhatsAppInboxBody } = await load();
    const cred = Buffer.from(
      encryptWhatsAppCredential("segredo-ficticio", { ...CTX, purpose: "webhook_secret" }).ciphertextBase64,
      "base64",
    );
    const asInbox = {
      keyVersion: "1",
      nonce: cred.subarray(0, 12).toString("base64"),
      authTag: cred.subarray(12, 28).toString("base64"),
      ciphertext: cred.subarray(28).toString("base64"),
    };
    expect(() => decryptWhatsAppInboxBody(asInbox, CTX)).toThrow(expect.objectContaining({ code: "decrypt_failed" }));
  });

  it("os erros nunca carregam chave, nonce, texto cifrado ou corpo", async () => {
    keys();
    const { encryptWhatsAppInboxBody, decryptWhatsAppInboxBody } = await load();
    const enc = encryptWhatsAppInboxBody(BODIES[0]![1], CTX);
    try {
      decryptWhatsAppInboxBody(enc, { ...CTX, channelId: "outro" });
      throw new Error("deveria falhar");
    } catch (error) {
      const text = `${String(error)} ${JSON.stringify(error)}`;
      for (const secret of [KEY_A, enc.nonce, enc.ciphertext, enc.authTag, "Olá"]) expect(text).not.toContain(secret);
    }
  });
});
