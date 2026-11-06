/**
 * @vitest-environment node
 *
 * B3 — o adaptador YCloud ligado no resolvedor do provedor (§28.16). Só as
 * proteções essenciais: desligado não resolve; habilitado resolve o YCloud para
 * canal YCloud; outro provedor não resolve; o simulador continua recusado em
 * Production. Sem rede e sem log.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveWhatsAppProvider } from "@/server/whatsapp/provider";
import { YCloudWhatsAppProvider } from "@/server/whatsapp/provider/ycloud";

type Kind = Parameters<typeof resolveWhatsAppProvider>[0]["channelProvider"];
const resolve = (channelProvider: string, env: Record<string, string | undefined>) =>
  resolveWhatsAppProvider({ channelProvider: channelProvider as Kind, env });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("YCloud no resolvedor", () => {
  it.each([
    ["ausente", {}, "missing"],
    ["vazia", { WHATSAPP_PROVIDER: "" }, "missing"],
    ["em maiúsculas", { WHATSAPP_PROVIDER: "YCLOUD" }, "unknown"],
    ["com espaço", { WHATSAPP_PROVIDER: " ycloud" }, "unknown"],
  ])("desligado (variável %s): canal YCloud não resolve", (_nome, env, reason) => {
    expect(resolve("ycloud", { VERCEL_ENV: "preview", ...env })).toEqual({ status: "disabled", reason });
  });

  it.each(["preview", "production", undefined])("habilitado (VERCEL_ENV=%s): canal YCloud resolve o adaptador YCloud", (vercelEnv) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const resolution = resolve("ycloud", { WHATSAPP_PROVIDER: "ycloud", VERCEL_ENV: vercelEnv });
    expect(resolution.status).toBe("enabled");
    expect(resolution.status === "enabled" && resolution.provider).toBeInstanceOf(YCloudWhatsAppProvider);
    expect(resolution.status === "enabled" && resolution.provider.kind).toBe("ycloud");
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["canal simulado com ycloud habilitado", "simulated", { WHATSAPP_PROVIDER: "ycloud" }, "provider_not_enabled"],
    ["canal Meta com ycloud habilitado", "meta", { WHATSAPP_PROVIDER: "ycloud" }, "provider_not_enabled"],
    ["canal YCloud com simulated habilitado", "ycloud", { WHATSAPP_PROVIDER: "simulated", VERCEL_ENV: "preview" }, "provider_not_enabled"],
    ["canal YCloud com meta habilitado", "ycloud", { WHATSAPP_PROVIDER: "meta" }, "provider_not_enabled"],
    ["canal Meta com meta habilitado (sem adaptador)", "meta", { WHATSAPP_PROVIDER: "meta" }, "not_available"],
  ])("%s: não resolve", (_nome, channelProvider, env, reason) => {
    expect(resolve(channelProvider, env)).toEqual({ status: "disabled", reason });
  });

  it("o simulador continua recusado em Production", () => {
    expect(resolve("simulated", { WHATSAPP_PROVIDER: "simulated", VERCEL_ENV: "production" })).toEqual({
      status: "disabled",
      reason: "simulated_not_allowed_in_production",
    });
  });
});
