/**
 * @vitest-environment node
 *
 * B3.2a — o adaptador é puro: sem rede, sem banco, sem log, sem ligar nada.
 *
 * Escritos ANTES do adaptador, contra a main 7b97297.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveWhatsAppProvider } from "@/server/whatsapp/provider";

import { body, bytes, FICT, inboundText, NOW_MS, signedHeaders, statusUpdated } from "../support/ycloud-fixtures";

const load = () => import("@/server/whatsapp/provider/ycloud");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("isolamento", () => {
  it("não faz nenhuma chamada de rede nem escreve no console", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("rede proibida no teste")));
    vi.stubGlobal("fetch", fetchSpy);
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));

    const { YCloudWhatsAppProvider } = await load();
    const provider = new YCloudWhatsAppProvider();
    for (const event of [inboundText, statusUpdated("failed")]) {
      const raw = bytes(body(event));
      const verified = provider.verifyWebhook({ rawBody: raw, headers: signedHeaders(raw), secret: FICT.secret, nowMs: NOW_MS });
      if (verified.ok) provider.normalizeEvents(verified.verified);
    }
    provider.verifyWebhook({ rawBody: bytes("{}"), headers: new Headers({ "YCloud-Signature": "lixo" }), secret: FICT.secret });

    const recipient = { kind: "phone" as const, phoneE164: FICT.customerPhone, bsuid: null };
    await expect(provider.sendText({ routingKey: "r", recipient, text: "x", correlationId: "c" })).resolves.toEqual({
      ok: false,
      reason: "unsupported",
      capability: "sendText",
    });
    await expect(
      provider.sendTemplate({ routingKey: "r", recipient, templateName: "t", templateLanguage: "pt_BR", parameters: [], correlationId: "c" }),
    ).resolves.toEqual({ ok: false, reason: "unsupported", capability: "sendTemplate" });
    await expect(provider.lookupMessage({ routingKey: "r", providerMessageId: "m" })).resolves.toEqual({
      ok: false,
      reason: "unsupported",
      capability: "lookupMessage",
    });
    await expect(provider.fetchMedia({ routingKey: "r", providerMediaRef: "m" })).resolves.toEqual({
      ok: false,
      reason: "unsupported",
      capability: "fetchMedia",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("o código do adaptador não importa banco, Inngest, Supabase, env nem cliente HTTP", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../../src/server/whatsapp/provider/ycloud.ts"), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    for (const spec of imports) {
      expect(spec).toMatch(/^(node:crypto|zod|@\/server\/whatsapp\/provider\/contract|@\/server\/whatsapp\/webhook)$/);
    }
    expect(source).not.toMatch(/\bfetch\s*\(|process\.env|console\./);
  });

  it("a resolução de provedor continua sem adaptador YCloud ligado (a rota é da B3.2c)", () => {
    expect(resolveWhatsAppProvider({ channelProvider: "ycloud", env: { WHATSAPP_PROVIDER: "ycloud" } })).toEqual({
      status: "disabled",
      reason: "not_available",
    });
  });
});

describe("fixtures só com dados fictícios", () => {
  it("todo telefone nas fixtures está na faixa reservada para ficção (+1 202 555-01xx)", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../support/ycloud-fixtures.ts"), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\*\*|\*|\/\/)/.test(line))
      .join("\n");
    const phones = [...code.matchAll(/\+\d[\d -]{6,}\d/g)].map((m) => m[0].replace(/[ -]/g, ""));
    expect(phones.length).toBeGreaterThan(0);
    for (const phone of phones) expect(phone).toMatch(/^\+120255501\d{2}$/);
    expect(source).not.toMatch(/whsec_|sk-[A-Za-z0-9]|eyJ[A-Za-z0-9]|workers\.dev|api\.ycloud\.com/);
  });
});
