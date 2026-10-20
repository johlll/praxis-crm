/**
 * @vitest-environment node
 *
 * B3.1 — ambiente autenticado PRÓPRIO do WhatsApp
 * (docs/decisoes/b3-whatsapp-real.md §7.1). Nenhuma chave ou cabeçalho do
 * calendário (B2) vale aqui.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { CALENDAR_ENV_HEADER, calendarEnvHeaders, signCalendarEnvironment } from "@/server/calendar/environment";
import {
  getWhatsAppEnvironment,
  isWhatsAppEnvironmentConfigured,
  signWhatsAppEnvironment,
  WHATSAPP_ENV_HEADER,
  WHATSAPP_ENV_HEADER_TTL_SECONDS,
  whatsappEnvHeaders,
} from "@/server/whatsapp/environment";

const KEY = "chave-de-teste-b3-whatsapp-0123456789";

afterEach(() => vi.unstubAllEnvs());

describe("ambiente vem do servidor, com falha fechada para Production", () => {
  it("só VERCEL_ENV=production explícito vale production", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect(getWhatsAppEnvironment()).toBe("production");
  });

  it.each(["preview", "development", "", "Production", "prod"])("VERCEL_ENV=%j vira preview", (valor) => {
    vi.stubEnv("VERCEL_ENV", valor);
    expect(getWhatsAppEnvironment()).toBe("preview");
  });
});

describe("assinatura do cabeçalho do WhatsApp", () => {
  it("vetor compartilhado com o pgTAP (29_b3_whatsapp_foundation): Node e SQL assinam igual", () => {
    expect(signWhatsAppEnvironment("production", 4102444800, KEY)).toBe(
      "4e688daf0db27ff7e1944efaecdfaf612b511f68b7ef94499322c412d6d14afb",
    );
  });

  it("a finalidade WhatsApp faz parte da mensagem: a assinatura da B2 com a MESMA chave é outra", () => {
    expect(signWhatsAppEnvironment("production", 4102444800, KEY)).not.toBe(
      signCalendarEnvironment("production", 4102444800, KEY),
    );
  });

  it("ambiente e expiração entram na assinatura", () => {
    const base = signWhatsAppEnvironment("production", 4102444800, KEY);
    expect(signWhatsAppEnvironment("preview", 4102444800, KEY)).not.toBe(base);
    expect(signWhatsAppEnvironment("production", 4102444801, KEY)).not.toBe(base);
  });

  it("cabeçalho: v1.<ambiente>.<expira>.<hmac>, validade curta, só com WHATSAPP_ENV_SIGNING_KEY", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", KEY);
    const now = 1_800_000_000_000;
    const headers = whatsappEnvHeaders(now);
    const value = headers[WHATSAPP_ENV_HEADER];
    const expires = Math.floor(now / 1000) + WHATSAPP_ENV_HEADER_TTL_SECONDS;
    expect(value).toBe(`v1.preview.${expires}.${signWhatsAppEnvironment("preview", expires, KEY)}`);
    expect(WHATSAPP_ENV_HEADER_TTL_SECONDS).toBeLessThanOrEqual(900);
    expect(Object.keys(headers)).toEqual([WHATSAPP_ENV_HEADER]);
  });

  it("sem chave, ou com chave curta, nenhum cabeçalho é enviado (falha fechada)", () => {
    vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "");
    expect(whatsappEnvHeaders()).toEqual({});
    expect(isWhatsAppEnvironmentConfigured()).toBe(false);
    vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "curta-demais");
    expect(whatsappEnvHeaders()).toEqual({});
    expect(isWhatsAppEnvironmentConfigured()).toBe(false);
  });

  it("CALENDAR_ENV_SIGNING_KEY nunca autentica o WhatsApp", () => {
    vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "");
    vi.stubEnv("CALENDAR_ENV_SIGNING_KEY", KEY);
    expect(whatsappEnvHeaders()).toEqual({});
    expect(isWhatsAppEnvironmentConfigured()).toBe(false);
  });

  it("os dois módulos usam cabeçalhos diferentes e não emitem o do outro", () => {
    vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", KEY);
    vi.stubEnv("CALENDAR_ENV_SIGNING_KEY", KEY);
    expect(WHATSAPP_ENV_HEADER).not.toBe(CALENDAR_ENV_HEADER);
    expect(Object.keys(whatsappEnvHeaders())).not.toContain(CALENDAR_ENV_HEADER);
    expect(Object.keys(calendarEnvHeaders())).not.toContain(WHATSAPP_ENV_HEADER);
  });
});
