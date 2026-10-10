/**
 * @vitest-environment node
 *
 * B2, etapa 4a — configuração (a integração só liga COMPLETA) e as rotas
 * `/api/calendar/oauth/start` e `/callback`: origem, chamada de outro site,
 * permissão, cookie do navegador, redirecionamento sempre para a tela fixa e
 * nada sensível em log. Endpoint do Google simulado; dados fictícios.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  deps: { value: null as unknown },
  permission: { value: null as unknown },
  cookie: { value: undefined as string | undefined },
  recover: vi.fn(),
}));

vi.mock("@/server/calendar/google/oauth-deps", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  googleOAuthDeps: () => m.deps.value,
}));
vi.mock("@/server/authz/safe", () => ({ requirePermissionSafe: async () => m.permission.value }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "praxis_gcal_oauth" && m.cookie.value ? { value: m.cookie.value } : undefined) }),
}));
vi.mock("@/modules/calendar/automation", () => ({ recoverOwnCalendarLinks: m.recover }));

import { GET as callback } from "@/app/api/calendar/oauth/callback/route";
import { GET as start } from "@/app/api/calendar/oauth/start/route";
import { getGoogleCalendarConfig, missingGoogleCalendarConfig, parseRedirectUri } from "@/server/calendar/google/config";
import type { OAuthFlowDeps } from "@/server/calendar/google/oauth-flow";
import { getCalendarProvider } from "@/server/calendar/provider";
import { oauthOutcomeMessage } from "@/modules/calendar/oauth-messages";
import { CALENDAR_SCOPES } from "@/server/calendar/provider";

import { fakeGoogleHttp, fakeIdToken } from "../support/google-fake-http";
import { MemoryIdentityConnections, MemoryOAuthStates } from "../support/oauth-memory";

const ORIGIN = "https://crm.exemplo.test";
const KEY = Buffer.alloc(32, 7).toString("base64");
const FULL_ENV = {
  CALENDAR_PROVIDER: "google",
  GOOGLE_OAUTH_CLIENT_ID: "cliente-teste.apps.googleusercontent.com",
  GOOGLE_OAUTH_CLIENT_SECRET: "segredo-ficticio",
  GOOGLE_OAUTH_REDIRECT_URI: `${ORIGIN}/api/calendar/oauth/callback`,
  CALENDAR_TOKEN_ACTIVE_KEY_VERSION: "v1",
  CALENDAR_TOKEN_KEY_VERSIONS: JSON.stringify({ v1: KEY }),
  CALENDAR_ENV_SIGNING_KEY: "chave-de-assinatura-ficticia-0123456789",
};
const SESSION = { ctx: { userId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", role: "lawyer" } };

afterEach(() => vi.unstubAllEnvs());

describe("configuração: só liga completa", () => {
  const stubAll = (env: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
  };

  it("completa no Preview: provedor Google", async () => {
    stubAll({ ...FULL_ENV, VERCEL_ENV: "preview" });
    expect(missingGoogleCalendarConfig()).toEqual([]);
    expect((await getCalendarProvider())?.kind).toBe("google");
  });

  it.each(Object.keys(FULL_ENV))("faltando %s: desligada (nada é chamado)", async (key) => {
    stubAll({ ...FULL_ENV, VERCEL_ENV: "production", [key]: "" });
    expect(missingGoogleCalendarConfig()).toContain(key === "CALENDAR_TOKEN_ACTIVE_KEY_VERSION" ? "CALENDAR_TOKEN_KEY_VERSIONS" : key);
    expect(await getCalendarProvider()).toBeNull();
  });

  it("assinatura de ambiente curta ou chave de cifra de tamanho errado: desligada", async () => {
    stubAll({ ...FULL_ENV, VERCEL_ENV: "preview", CALENDAR_ENV_SIGNING_KEY: "curta" });
    expect(await getCalendarProvider()).toBeNull();
    stubAll({ ...FULL_ENV, VERCEL_ENV: "preview", CALENDAR_TOKEN_KEY_VERSIONS: JSON.stringify({ v1: Buffer.alloc(16).toString("base64") }) });
    expect(await getCalendarProvider()).toBeNull();
  });

  it("o simulado continua impossível no Preview e em Production", async () => {
    stubAll({ CALENDAR_PROVIDER: "simulated", VERCEL_ENV: "preview" });
    expect(await getCalendarProvider()).toBeNull();
  });

  it.each([
    ["http fora do localhost", "http://crm.exemplo.test/api/calendar/oauth/callback", "preview"],
    ["outro caminho", `${ORIGIN}/qualquer`, "preview"],
    ["com query", `${ORIGIN}/api/calendar/oauth/callback?next=https://atacante.exemplo`, "preview"],
    ["com fragmento", `${ORIGIN}/api/calendar/oauth/callback#x`, "preview"],
    ["com credencial", "https://u:p@crm.exemplo.test/api/calendar/oauth/callback", "preview"],
    ["localhost na Vercel", "http://localhost:3000/api/calendar/oauth/callback", "preview"],
  ])("endereço de retorno recusado: %s", (_name, uri, env) => {
    expect(parseRedirectUri(uri, env)).toBeNull();
  });

  it("endereço de retorno aceito: https exato; http só em localhost fora da Vercel", () => {
    expect(parseRedirectUri(`${ORIGIN}/api/calendar/oauth/callback`, "preview")?.toString()).toBe(`${ORIGIN}/api/calendar/oauth/callback`);
    expect(parseRedirectUri("http://localhost:3000/api/calendar/oauth/callback", undefined)).not.toBeNull();
  });

  it("nenhum valor de configuração aparece na lista do que falta", () => {
    stubAll({ ...FULL_ENV, GOOGLE_OAUTH_REDIRECT_URI: "ftp://x" });
    expect(JSON.stringify(missingGoogleCalendarConfig())).not.toMatch(/segredo|chave|cliente-teste/);
    expect(getGoogleCalendarConfig()).toBeNull();
  });
});

describe("rotas OAuth", () => {
  let states: MemoryOAuthStates;
  let connections: MemoryIdentityConnections;
  let nonce = "";
  let logs: string[];

  beforeEach(() => {
    states = new MemoryOAuthStates(() => new Date());
    connections = new MemoryIdentityConnections();
    m.permission.value = SESSION;
    m.cookie.value = undefined;
    m.recover.mockReset();
    logs = [];
    for (const level of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
    }
    const http = fakeGoogleHttp(() => ({
      status: 200,
      json: {
        access_token: "acesso-ficticio",
        refresh_token: "refresh-ficticio",
        expires_in: 3599,
        scope: ["openid", ...CALENDAR_SCOPES].join(" "),
        id_token: fakeIdToken({
          iss: "https://accounts.google.com",
          aud: FULL_ENV.GOOGLE_OAUTH_CLIENT_ID,
          sub: "1098765432101234567890",
          email: "teste.qa@exemplo.test",
          email_verified: true,
          exp: Math.floor(Date.now() / 1000) + 3600,
          nonce,
        }),
      },
    }));
    const deps: OAuthFlowDeps = {
      config: { clientId: FULL_ENV.GOOGLE_OAUTH_CLIENT_ID, clientSecret: "segredo-ficticio", redirectUri: FULL_ENV.GOOGLE_OAUTH_REDIRECT_URI, origin: ORIGIN },
      http: http.http,
      states,
      connect: connections.connect,
      encryptVerifier: (v) => ({ ciphertext: Buffer.from(v).toString("base64"), keyVersion: "v1" }),
      decryptVerifier: (c) => Buffer.from(c, "base64").toString(),
      now: () => new Date(),
    };
    m.deps.value = deps;
  });
  afterEach(() => vi.restoreAllMocks());

  const req = (path: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}${path}`, { headers });
  const agenda = (res: Response) => new URL(res.headers.get("location")!).searchParams.get("agenda");

  async function begin() {
    const res = await start(req("/api/calendar/oauth/start", { "sec-fetch-site": "same-origin" }));
    const google = new URL(res.headers.get("location")!);
    nonce = google.searchParams.get("nonce")!;
    m.cookie.value = /praxis_gcal_oauth=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    return { res, google, state: google.searchParams.get("state")! };
  }

  it("início: redireciona ao Google e grava o cookie do navegador (httpOnly, Secure, Lax, só no caminho do OAuth, 10 min)", async () => {
    const { res, google } = await begin();
    expect(res.status).toBe(303);
    expect(google.host).toBe("accounts.google.com");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Path=\/api\/calendar\/oauth/);
    expect(cookie).toMatch(/Max-Age=600/);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("integração desligada: início e retorno voltam à tela fixa, sem tocar em nada", async () => {
    m.deps.value = null;
    expect(agenda(await start(req("/api/calendar/oauth/start")))).toBe("not_configured");
    expect(agenda(await callback(req("/api/calendar/oauth/callback?state=x&code=y")))).toBe("not_configured");
    expect(states.rows).toEqual([]);
  });

  it("início recusado: outro site, outra origem, sem permissão", async () => {
    expect(agenda(await start(req("/api/calendar/oauth/start", { "sec-fetch-site": "cross-site" })))).toBe("invalid_state");

    const other = await start(new Request("https://praxis-outro-deploy.vercel.app/api/calendar/oauth/start"));
    expect(other.headers.get("location")).toBe(`${ORIGIN}/configuracoes/integracoes?agenda=wrong_origin`);

    m.permission.value = { error: "Você não tem permissão para fazer isso." };
    expect(agenda(await start(req("/api/calendar/oauth/start")))).toBe("forbidden");
    expect(states.rows).toEqual([]);
  });

  it("retorno válido: conecta, roda a recuperação e volta à tela fixa; cookie apagado", async () => {
    const { state } = await begin();
    const res = await callback(req(`/api/calendar/oauth/callback?state=${state}&code=codigo-ficticio&scope=x`));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/configuracoes/integracoes?agenda=connected`);
    expect(res.headers.get("set-cookie")).toMatch(/praxis_gcal_oauth=;.*Max-Age=0/i);
    expect(connections.rows).toHaveLength(1);
    expect(m.recover).toHaveBeenCalledTimes(1);
  });

  it("retorno reutilizado, sem o cookie ou de outra sessão: recusado, nada conectado; nada da URL ecoado", async () => {
    const a = await begin();
    await callback(req(`/api/calendar/oauth/callback?state=${a.state}&code=codigo-ficticio`));
    const again = await callback(req(`/api/calendar/oauth/callback?state=${a.state}&code=codigo-ficticio`));
    expect(agenda(again)).toBe("invalid_state");

    const b = await begin();
    m.cookie.value = undefined;
    expect(agenda(await callback(req(`/api/calendar/oauth/callback?state=${b.state}&code=c`)))).toBe("browser_mismatch");

    const c = await begin();
    m.permission.value = { ctx: { ...SESSION.ctx, userId: "33333333-3333-4333-8333-333333333333" } };
    const other = await callback(req(`/api/calendar/oauth/callback?state=${c.state}&code=c&next=https://atacante.exemplo`));
    expect(agenda(other)).toBe("session_mismatch");
    expect(other.headers.get("location")).not.toContain("atacante");
    expect(connections.rows).toHaveLength(1);
  });

  it("nenhum log traz código, token, state, segredo, e-mail ou identificador da conta", async () => {
    const a = await begin();
    await callback(req(`/api/calendar/oauth/callback?state=${a.state}&code=codigo-ficticio`));
    await callback(req(`/api/calendar/oauth/callback?state=${a.state}&code=codigo-ficticio`));
    const text = logs.join("\n");
    expect(logs.length).toBeGreaterThan(0); // a recusa é registrada (só o desfecho)
    for (const secret of ["codigo-ficticio", "acesso-ficticio", "refresh-ficticio", a.state, "segredo-ficticio", "teste.qa@exemplo.test", "1098765432101234567890"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("a tela só mostra desfechos conhecidos", () => {
    expect(oauthOutcomeMessage("connected")?.level).toBe("success");
    expect(oauthOutcomeMessage("<script>alert(1)</script>")).toBeNull();
    expect(oauthOutcomeMessage("toString")).toBeNull();
  });
});
