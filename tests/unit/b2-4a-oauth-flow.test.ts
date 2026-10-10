/**
 * @vitest-environment node
 *
 * B2, etapa 4a — fluxo "Conectar com Google" contra o endpoint de token
 * SIMULADO: state imprevisível, expirável, de uso único e vinculado à sessão,
 * ao ambiente e ao navegador; PKCE; ID token (OpenID Connect); escopos
 * concedidos; refresh token ausente; outra conta. Dados fictícios.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { GoogleCalendarConfig } from "@/server/calendar/google/config";
import { pkceChallenge, sha256 } from "@/server/calendar/google/oauth";
import { completeGoogleOAuth, startGoogleOAuth, type OAuthFlowDeps, type OAuthSession } from "@/server/calendar/google/oauth-flow";
import { CALENDAR_SCOPES } from "@/server/calendar/provider";

import { fakeGoogleHttp, fakeIdToken, type FakeReply, type RecordedRequest } from "../support/google-fake-http";
import { MemoryIdentityConnections, MemoryOAuthStates } from "../support/oauth-memory";

const CONFIG: GoogleCalendarConfig = {
  clientId: "cliente-teste.apps.googleusercontent.com",
  clientSecret: "segredo-ficticio",
  redirectUri: "https://crm.exemplo.test/api/calendar/oauth/callback",
  origin: "https://crm.exemplo.test",
};
const DONA: OAuthSession = { userId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const OUTRA: OAuthSession = { userId: "33333333-3333-4333-8333-333333333333", workspaceId: DONA.workspaceId };
const ALL_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email", ...CALENDAR_SCOPES].join(" ");

let clock: { t: number };
let states: MemoryOAuthStates;
let connections: MemoryIdentityConnections;
let tokenReply: (req: RecordedRequest, nonce: string) => FakeReply;
let http: ReturnType<typeof fakeGoogleHttp>;
let lastNonce: string;

const now = () => new Date(clock.t);
const claims = (nonce: string, extra: Record<string, unknown> = {}) => ({
  iss: "https://accounts.google.com",
  aud: CONFIG.clientId,
  sub: "1098765432101234567890",
  email: "teste.qa@exemplo.test",
  email_verified: true,
  iat: Math.floor(clock.t / 1000),
  exp: Math.floor(clock.t / 1000) + 3600,
  nonce,
  ...extra,
});
const goodToken = (nonce: string, extra: Record<string, unknown> = {}): FakeReply => ({
  status: 200,
  json: {
    access_token: "acesso-ficticio",
    refresh_token: "refresh-ficticio",
    expires_in: 3599,
    scope: ALL_SCOPES,
    token_type: "Bearer",
    id_token: fakeIdToken(claims(nonce)),
    ...extra,
  },
});

function deps(): OAuthFlowDeps {
  return {
    config: CONFIG,
    http: http.http,
    states,
    connect: connections.connect,
    // Cifra fictícia, reversível e LIGADA à sessão (como o AAD real).
    encryptVerifier: (verifier, s) => ({ ciphertext: Buffer.from(`${s.userId}|${verifier}`).toString("base64"), keyVersion: "v1" }),
    decryptVerifier: (ciphertext, _v, s) => {
      const [user, verifier] = Buffer.from(ciphertext, "base64").toString().split("|");
      if (user !== s.userId) throw new Error("auth_tag");
      return verifier!;
    },
    now,
  };
}

async function start(session = DONA) {
  const started = await startGoogleOAuth(deps(), session);
  const url = new URL(started.authorizationUrl);
  lastNonce = url.searchParams.get("nonce")!;
  return { ...started, url, state: url.searchParams.get("state")! };
}

const finish = (session: OAuthSession, p: { state: string; code?: string | null; error?: string | null; browserNonce?: string | null }) =>
  completeGoogleOAuth(deps(), session, { code: "codigo-ficticio", ...p });

const tokenCalls = () => http.requests.filter((r) => r.url.host === "oauth2.googleapis.com");

beforeEach(() => {
  clock = { t: Date.parse("2026-11-01T12:00:00.000Z") };
  states = new MemoryOAuthStates(now);
  connections = new MemoryIdentityConnections();
  tokenReply = (_req, nonce) => goodToken(nonce);
  http = fakeGoogleHttp((req) => tokenReply(req, lastNonce));
});

describe("início", () => {
  it("endereço do Google: cliente, retorno CONFIGURADO, escopos mínimos + identidade, offline, consentimento e PKCE S256", async () => {
    const { url } = await start();
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = url.searchParams;
    expect(p.get("client_id")).toBe(CONFIG.clientId);
    expect(p.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("scope")!.split(" ")).toEqual(["openid", "email", ...CALENDAR_SCOPES]);
    expect(p.get("scope")).not.toMatch(/auth\/calendar(\s|$)/); // nunca o escopo amplo
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toContain("consent");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.has("client_secret")).toBe(false);
  });

  it("state, nonce e PKCE novos a cada tentativa; o banco guarda só hashes e o verificador cifrado", async () => {
    const a = await start();
    const b = await start();
    expect(a.state).not.toBe(b.state);
    expect(a.url.searchParams.get("nonce")).not.toBe(b.url.searchParams.get("nonce"));
    expect(a.state.length).toBeGreaterThanOrEqual(43);

    const row = states.rows.find((r) => r.stateHash === sha256(a.state))!;
    expect(JSON.stringify(states.rows)).not.toContain(a.state);
    expect(row.browserHash).toBe(sha256(a.browserNonce));
    const verifier = deps().decryptVerifier(row.verifierCiphertext, row.keyVersion, DONA);
    expect(pkceChallenge(verifier)).toBe(a.url.searchParams.get("code_challenge"));
  });
});

describe("retorno: state", () => {
  it("válido: troca o código com PKCE e o retorno configurado, e conecta pela identidade", async () => {
    const s = await start();
    const result = await finish(DONA, { state: s.state, browserNonce: s.browserNonce });

    expect(result).toMatchObject({ outcome: "connected", refreshKept: false });
    const form = Object.fromEntries(new URLSearchParams(tokenCalls()[0]!.body!));
    expect(form).toMatchObject({ grant_type: "authorization_code", code: "codigo-ficticio", redirect_uri: CONFIG.redirectUri });
    expect(pkceChallenge(form.code_verifier!)).toBe(s.url.searchParams.get("code_challenge"));
    expect(connections.rows).toEqual([
      expect.objectContaining({ subject: "1098765432101234567890", clientId: CONFIG.clientId, email: "teste.qa@exemplo.test", refreshToken: "refresh-ficticio" }),
    ]);
  });

  it("reutilizado: a segunda vez é recusada, sem nova troca de código", async () => {
    const s = await start();
    await finish(DONA, { state: s.state, browserNonce: s.browserNonce });
    expect(await finish(DONA, { state: s.state, browserNonce: s.browserNonce })).toEqual({ outcome: "invalid_state" });
    expect(tokenCalls()).toHaveLength(1);
  });

  it("inventado ou malformado: recusado sem chamar o Google", async () => {
    expect(await finish(DONA, { state: "a".repeat(43), browserNonce: "x" })).toEqual({ outcome: "invalid_state" });
    expect(await finish(DONA, { state: "<script>", browserNonce: "x" })).toEqual({ outcome: "invalid_state" });
    expect(tokenCalls()).toEqual([]);
  });

  it("expirado (mais de 10 min): recusado e consumido", async () => {
    const s = await start();
    clock.t += 10 * 60_000 + 1000;
    expect(await finish(DONA, { state: s.state, browserNonce: s.browserNonce })).toEqual({ outcome: "expired" });
    expect(states.rows).toEqual([]);
    expect(tokenCalls()).toEqual([]);
  });

  it("troca de sessão (outro usuário ou outro workspace): recusado, nada conectado", async () => {
    const s = await start();
    expect(await finish(OUTRA, { state: s.state, browserNonce: s.browserNonce })).toEqual({ outcome: "session_mismatch" });
    const t = await start();
    expect(await finish({ ...DONA, workspaceId: "44444444-4444-4444-8444-444444444444" }, { state: t.state, browserNonce: t.browserNonce })).toEqual({
      outcome: "session_mismatch",
    });
    expect(connections.rows).toEqual([]);
    expect(tokenCalls()).toEqual([]);
  });

  it("troca de ambiente (iniciado no Preview, retorno em Production): recusado", async () => {
    const s = await start();
    states.environment = "production";
    expect(await finish(DONA, { state: s.state, browserNonce: s.browserNonce })).toEqual({ outcome: "wrong_environment" });
    expect(tokenCalls()).toEqual([]);
  });

  it("outro navegador (sem o cookie ou com outro): recusado", async () => {
    const s = await start();
    expect(await finish(DONA, { state: s.state, browserNonce: null })).toEqual({ outcome: "browser_mismatch" });
    const t = await start();
    expect(await finish(DONA, { state: t.state, browserNonce: "cookie-de-outro-navegador" })).toEqual({ outcome: "browser_mismatch" });
  });

  it("autorização negada no Google: cancelado, e o state não vale de novo", async () => {
    const s = await start();
    expect(await finish(DONA, { state: s.state, browserNonce: s.browserNonce, code: null, error: "access_denied" })).toMatchObject({ outcome: "cancelled" });
    expect(await finish(DONA, { state: s.state, browserNonce: s.browserNonce })).toEqual({ outcome: "invalid_state" });
  });
});

describe("retorno: resposta do Google", () => {
  it.each([
    ["outro cliente (aud)", { aud: "outro.apps.googleusercontent.com" }],
    ["outro emissor (iss)", { iss: "https://atacante.exemplo" }],
    ["vencido (exp)", { exp: Math.floor(Date.parse("2026-11-01T11:00:00.000Z") / 1000) }],
    ["nonce de outra autorização", { nonce: "outro-nonce" }],
    ["e-mail não verificado", { email_verified: false }],
    ["sem identidade (sub)", { sub: "" }],
  ])("ID token inválido — %s: nada conectado", async (_name, extra) => {
    const s = await start();
    tokenReply = (_req, nonce) => goodToken(nonce, { id_token: fakeIdToken(claims(nonce, extra)) });
    expect(await finish(DONA, { state: s.state, browserNonce: s.browserNonce })).toMatchObject({ outcome: "identity_invalid" });
    expect(connections.rows).toEqual([]);
  });

  it("sem ID token: nada conectado (a conta não é presumida pela agenda principal)", async () => {
    const s = await start();
    tokenReply = (_req, nonce) => goodToken(nonce, { id_token: undefined });
    expect(await finish(DONA, { state: s.state, browserNonce: s.browserNonce })).toMatchObject({ outcome: "identity_invalid", code: "id_token_missing" });
  });

  it("consentimento PARCIAL (sem disponibilidade): nada guardado e nada revogado", async () => {
    const s = await start();
    tokenReply = (_req, nonce) => goodToken(nonce, { scope: ALL_SCOPES.replace(" https://www.googleapis.com/auth/calendar.freebusy", "") });
    expect(await finish(DONA, { state: s.state, browserNonce: s.browserNonce })).toEqual({ outcome: "partial_scopes" });
    expect(connections.rows).toEqual([]);
    expect(http.requests.some((r) => r.url.pathname === "/revoke")).toBe(false);
  });

  it.each([
    ["código inválido (invalid_grant)", { status: 400, json: { error: "invalid_grant" } } as FakeReply],
    ["Google fora do ar", { status: 503, json: { error: "temporarily_unavailable" } } as FakeReply],
    ["prazo esgotado", "timeout" as FakeReply],
  ])("troca do código falha — %s: nada conectado", async (_name, reply) => {
    const s = await start();
    tokenReply = () => reply;
    expect(await finish(DONA, { state: s.state, browserNonce: s.browserNonce })).toMatchObject({ outcome: "failed" });
    expect(connections.rows).toEqual([]);
  });
});

describe("retorno: refresh token e identidade da conta", () => {
  const withoutRefresh = () => {
    tokenReply = (_req, nonce) => goodToken(nonce, { refresh_token: undefined });
  };
  async function connectOnce(extra: Record<string, unknown> = {}) {
    const s = await start();
    tokenReply = (_req, nonce) => goodToken(nonce, extra);
    return finish(DONA, { state: s.state, browserNonce: s.browserNonce });
  }

  it("conexão NOVA sem refresh token: recusada, para pedir novo consentimento", async () => {
    withoutRefresh();
    const s = await start();
    expect(await finish(DONA, { state: s.state, browserNonce: s.browserNonce })).toMatchObject({ outcome: "refresh_missing" });
    expect(connections.rows).toEqual([]);
  });

  it("reautorização da MESMA conta e cliente sem refresh token: mantém o existente (não apaga)", async () => {
    await connectOnce();
    connections.rows[0]!.calendarId = "agenda-de-teste@x";
    withoutRefresh();
    const s = await start();
    expect(await finish(DONA, { state: s.state, browserNonce: s.browserNonce })).toMatchObject({ outcome: "connected", refreshKept: true });
    expect(connections.rows[0]).toMatchObject({ refreshToken: "refresh-ficticio", calendarId: "agenda-de-teste@x" });
  });

  it("mesma conta, mas o token guardado veio de OUTRO cliente OAuth: recusada", async () => {
    await connectOnce();
    connections.rows[0]!.clientId = "cliente-antigo.apps.googleusercontent.com";
    withoutRefresh();
    const s = await start();
    expect(await finish(DONA, { state: s.state, browserNonce: s.browserNonce })).toMatchObject({ outcome: "refresh_missing" });
  });

  it("conexão a reautorizar sem refresh token novo: recusada (o guardado já não serve)", async () => {
    await connectOnce();
    connections.rows[0]!.status = "needs_reauth";
    withoutRefresh();
    const s = await start();
    expect(await finish(DONA, { state: s.state, browserNonce: s.browserNonce })).toMatchObject({ outcome: "refresh_missing" });
  });

  it("OUTRA conta Google sobre a conexão existente: recusada, e o token existente fica intacto", async () => {
    await connectOnce();
    const s = await start();
    tokenReply = (_req, nonce) => goodToken(nonce, { refresh_token: "refresh-de-outra-conta", id_token: fakeIdToken(claims(nonce, { sub: "outra-conta", email: "outra@exemplo.test" })) });
    expect(await finish(DONA, { state: s.state, browserNonce: s.browserNonce })).toMatchObject({ outcome: "account_mismatch" });
    expect(connections.rows[0]).toMatchObject({ subject: "1098765432101234567890", refreshToken: "refresh-ficticio" });
  });

  it("a mesma conta Google já conectada por OUTRA pessoa do escritório: recusada", async () => {
    await connectOnce();
    const s = await start(OUTRA);
    expect(await finish(OUTRA, { state: s.state, browserNonce: s.browserNonce })).toMatchObject({ outcome: "account_in_use" });
    expect(connections.rows).toHaveLength(1);
  });
});

describe("nada sensível sai do fluxo", () => {
  it("o resultado nunca traz código, token, state, e-mail ou identificador da conta", async () => {
    const s = await start();
    const results = [
      await finish(DONA, { state: s.state, browserNonce: s.browserNonce }),
      await finish(DONA, { state: s.state, browserNonce: s.browserNonce }),
    ];
    const text = JSON.stringify(results);
    for (const secret of ["codigo-ficticio", "acesso-ficticio", "refresh-ficticio", s.state, "teste.qa@exemplo.test", "1098765432101234567890", CONFIG.clientSecret]) {
      expect(text).not.toContain(secret);
    }
  });
});
