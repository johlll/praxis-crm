/**
 * @vitest-environment node
 *
 * B3.1, revisão da PR #42 — ponto 2: provedor global × provedor gravado no
 * canal. A resolução recebe o provedor do canal confiável; a variável
 * `WHATSAPP_PROVIDER` só HABILITA um provedor neste ambiente, nunca
 * substitui a identidade do canal.
 *
 * Escritos ANTES da correção, contra o HEAD 3bdb181.
 */
import { describe, expect, it } from "vitest";

import { resolveWhatsAppProvider } from "@/server/whatsapp/provider";

type Env = Record<string, string | undefined>;

function resolve(channelProvider: string, env: Env) {
  // @ts-expect-error — `channelProvider` livre de propósito, para provar a recusa de valores fora do tipo.
  return resolveWhatsAppProvider({ channelProvider, env });
}

describe("resolução pelo provedor do canal", () => {
  it("canal simulado + simulated habilitado (Preview) → adaptador simulado", () => {
    const resolution = resolveWhatsAppProvider({
      channelProvider: "simulated",
      env: { WHATSAPP_PROVIDER: "simulated", VERCEL_ENV: "preview" },
    });
    expect(resolution.status).toBe("enabled");
    expect(resolution.status === "enabled" && resolution.provider.kind).toBe("simulated");
  });

  it.each([
    ["canal YCloud, variável simulated", "ycloud", { WHATSAPP_PROVIDER: "simulated", VERCEL_ENV: "preview" }, "provider_not_enabled"],
    ["canal Meta, variável simulated", "meta", { WHATSAPP_PROVIDER: "simulated", VERCEL_ENV: "preview" }, "provider_not_enabled"],
    ["canal simulado, variável ycloud", "simulated", { WHATSAPP_PROVIDER: "ycloud" }, "provider_not_enabled"],
    ["canal YCloud, variável ycloud (adaptador ainda não existe)", "ycloud", { WHATSAPP_PROVIDER: "ycloud" }, "not_available"],
    ["canal Meta, variável meta (adaptador ainda não existe)", "meta", { WHATSAPP_PROVIDER: "meta" }, "not_available"],
    ["variável ausente", "simulated", {}, "missing"],
    ["variável vazia", "simulated", { WHATSAPP_PROVIDER: " " }, "missing"],
    ["variável desconhecida", "simulated", { WHATSAPP_PROVIDER: "twilio" }, "unknown"],
    ["simulado nunca em Production", "simulated", { WHATSAPP_PROVIDER: "simulated", VERCEL_ENV: "production" }, "simulated_not_allowed_in_production"],
    ["provedor do canal desconhecido", "twilio", { WHATSAPP_PROVIDER: "simulated" }, "invalid_channel_provider"],
  ])("%s → desligado (%s)", (_nome, channelProvider, env, reason) => {
    expect(resolve(channelProvider, env)).toEqual({ status: "disabled", reason });
  });

  it("um canal YCloud nunca recebe o simulador, qualquer que seja a variável", () => {
    for (const value of ["simulated", "ycloud", "meta", "", "SIMULATED", undefined]) {
      const resolution = resolve("ycloud", { WHATSAPP_PROVIDER: value, VERCEL_ENV: "preview" });
      expect(resolution.status === "enabled" ? resolution.provider.kind : null).not.toBe("simulated");
      if (resolution.status === "enabled") expect(resolution.provider.kind).toBe("ycloud");
    }
  });

  it("quando habilitado, o adaptador é sempre do mesmo provedor do canal", () => {
    const resolution = resolve("simulated", { WHATSAPP_PROVIDER: "simulated", VERCEL_ENV: "preview" });
    expect(resolution.status === "enabled" && resolution.provider.kind).toBe("simulated");
  });
});
