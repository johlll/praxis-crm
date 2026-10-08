/**
 * @vitest-environment node
 *
 * B2, fundação — ambiente determinado pelo servidor, cifra de tokens por
 * ambiente e permissões novas. Provedor do Google sempre simulado: nenhuma
 * chamada externa.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { roleHasPermission, ROLES } from "@/lib/roles";
import { CALENDAR_ENV_HEADER, calendarEnvHeaders, getCalendarEnvironment } from "@/server/calendar/environment";
import { decryptCalendarToken, encryptCalendarToken } from "@/server/calendar/token-crypto";
import { getCalendarProvider, usesSimulatedCalendarProvider } from "@/server/calendar/provider";
import { SimulatedCalendarProvider } from "@/server/calendar/simulated-provider";

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");

function useKeys(keys: Record<string, string>, active: string) {
  vi.stubEnv("CALENDAR_TOKEN_KEY_VERSIONS", JSON.stringify(keys));
  vi.stubEnv("CALENDAR_TOKEN_ACTIVE_KEY_VERSION", active);
}

afterEach(() => vi.unstubAllEnvs());

describe("ambiente vem do servidor e falha fechada para Production", () => {
  it("só VERCEL_ENV=production explícito vale production", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect(getCalendarEnvironment()).toBe("production");
  });

  it.each(["preview", "development", "", "Production", "prod"])("VERCEL_ENV=%j nunca vira production", (valor) => {
    vi.stubEnv("VERCEL_ENV", valor);
    expect(getCalendarEnvironment()).toBe("preview");
  });

  it("variável ausente também é preview", () => {
    delete process.env.VERCEL_ENV;
    expect(getCalendarEnvironment()).toBe("preview");
  });

  it("o cabeçalho enviado ao banco reflete o ambiente do servidor", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect(calendarEnvHeaders()).toEqual({ [CALENDAR_ENV_HEADER]: "production" });
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(calendarEnvHeaders()).toEqual({ [CALENDAR_ENV_HEADER]: "preview" });
  });
});

describe("cifra dos tokens, isolada por ambiente", () => {
  const ctx = { environment: "production" as const, workspaceId: "w1", userId: "u1" };

  beforeEach(() => useKeys({ "1": KEY_A }, "1"));

  it("ida e volta", () => {
    const enc = encryptCalendarToken("refresh-secreto", ctx);
    expect(enc.ciphertextBase64).not.toContain("refresh-secreto");
    expect(decryptCalendarToken(enc.ciphertextBase64, enc.keyVersion, ctx)).toBe("refresh-secreto");
  });

  it("token cifrado em Preview NÃO decifra em Production, mesmo com a MESMA chave", () => {
    const enc = encryptCalendarToken("t", { ...ctx, environment: "preview" });
    expect(() => decryptCalendarToken(enc.ciphertextBase64, enc.keyVersion, ctx)).toThrow();
  });

  it("não decifra para outro usuário nem outro workspace", () => {
    const enc = encryptCalendarToken("t", ctx);
    expect(() => decryptCalendarToken(enc.ciphertextBase64, enc.keyVersion, { ...ctx, userId: "u2" })).toThrow();
    expect(() => decryptCalendarToken(enc.ciphertextBase64, enc.keyVersion, { ...ctx, workspaceId: "w2" })).toThrow();
  });

  it("não decifra com a chave do outro ambiente", () => {
    const enc = encryptCalendarToken("t", ctx);
    useKeys({ "1": KEY_B }, "1");
    expect(() => decryptCalendarToken(enc.ciphertextBase64, enc.keyVersion, ctx)).toThrow();
  });

  it("detecta adulteração do texto cifrado", () => {
    const enc = encryptCalendarToken("t", ctx);
    const raw = Buffer.from(enc.ciphertextBase64, "base64");
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff;
    expect(() => decryptCalendarToken(raw.toString("base64"), enc.keyVersion, ctx)).toThrow();
  });

  it("chaves versionadas: texto antigo continua legível depois de rotacionar", () => {
    const enc = encryptCalendarToken("antigo", ctx);
    useKeys({ "1": KEY_A, "2": KEY_B }, "2");
    expect(decryptCalendarToken(enc.ciphertextBase64, enc.keyVersion, ctx)).toBe("antigo");
    expect(encryptCalendarToken("novo", ctx).keyVersion).toBe("2");
  });

  it("recusa chave que não tem 32 bytes e versão ativa inexistente", () => {
    useKeys({ "1": Buffer.alloc(16).toString("base64") }, "1");
    expect(() => encryptCalendarToken("t", ctx)).toThrow(/32 bytes/);
    useKeys({ "1": KEY_A }, "9");
    expect(() => encryptCalendarToken("t", ctx)).toThrow(/ACTIVE_KEY_VERSION/);
  });
});

describe("permissões da B2 (conferidas contra src/lib/roles.ts)", () => {
  it("conectar a própria conta: todos menos viewer", () => {
    for (const role of ROLES) {
      expect(roleHasPermission(role, "calendar.connect_own")).toBe(role !== "viewer");
    }
  });

  it("administrar conexões de outros: só owner e admin", () => {
    for (const role of ROLES) {
      expect(roleHasPermission(role, "calendar.manage")).toBe(role === "owner" || role === "admin");
    }
  });
});

describe("provedor simulado só fora de Production e Preview", () => {
  it("variável é ignorada em production e em preview", async () => {
    vi.stubEnv("CALENDAR_PROVIDER", "simulated");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(usesSimulatedCalendarProvider()).toBe(false);
    expect(await getCalendarProvider()).toBeNull();
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(await getCalendarProvider()).toBeNull();
  });

  it("sem a variável, não há provedor (a tela diz que não está configurado)", async () => {
    vi.stubEnv("VERCEL_ENV", "development");
    vi.stubEnv("CALENDAR_PROVIDER", "");
    expect(await getCalendarProvider()).toBeNull();
  });

  it("local com a variável: simulado, sem rede", async () => {
    vi.stubEnv("VERCEL_ENV", "development");
    vi.stubEnv("CALENDAR_PROVIDER", "simulated");
    expect(await getCalendarProvider()).toBeInstanceOf(SimulatedCalendarProvider);
  });

  it("o simulado devolve só os escopos mínimos e agendas por token", async () => {
    const p = new SimulatedCalendarProvider();
    const tokens = await p.exchangeAuthorization("Ana@Vizentini.test|pessoal,equipe");
    expect(tokens.scopes.every((s) => s !== "https://www.googleapis.com/auth/calendar")).toBe(true);
    expect(tokens.accountEmail).toBe("ana@vizentini.test");
    const calendars = await p.listCalendars(tokens.accessToken);
    expect(calendars.map((c) => c.summary)).toEqual(["pessoal", "equipe"]);
    expect(calendars[0]!.owned).toBe(true);
    await expect(p.listCalendars("token-inventado")).rejects.toThrow();
    await expect(p.exchangeAuthorization("nao-e-email")).rejects.toThrow();
  });
});
