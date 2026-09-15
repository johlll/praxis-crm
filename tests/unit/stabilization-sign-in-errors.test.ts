import { AuthApiError, AuthRetryableFetchError, AuthUnknownError } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Estabilização pós-A9 — inventário §1.19 (docs/decisoes/estabilizacao-pos-a9.md).
 *
 * `signInAction` transformava qualquer erro de `signInWithPassword` em
 * "E-mail ou senha incorretos" — uma queda do Auth mandava a pessoa
 * redigitar a senha certa. A decisão usa os tipos e códigos oficiais do
 * `@supabase/auth-js` instalado (`AuthApiError.code`,
 * `AuthRetryableFetchError`), nunca o texto do erro, e a mensagem mostrada
 * não diz se a conta existe.
 */

const state = vi.hoisted(() => ({
  signIn: (() => ({ error: null })) as () => { error: unknown },
  redirects: [] as string[],
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    state.redirects.push(to);
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    auth: { signInWithPassword: async () => state.signIn() },
  }),
}));
vi.mock("@/server/auth/workspace", () => ({
  getActiveWorkspaceId: async () => "ws-1",
  switchActiveWorkspace: vi.fn(),
  clearActiveWorkspaceCookie: vi.fn(),
}));
vi.mock("@/modules/workspace/queries", () => ({ listMyWorkspaces: async () => [] }));

const { signInAction } = await import("@/modules/auth/actions");
const { SIGN_IN_INVALID_CREDENTIALS_MESSAGE, SIGN_IN_UNAVAILABLE_MESSAGE } = await import("@/modules/auth/sign-in-errors");

function form() {
  const fd = new FormData();
  fd.set("email", "qa@exemplo.com");
  fd.set("password", "senha-qualquer-123");
  return fd;
}

async function signInWith(error: unknown) {
  state.signIn = () => ({ error });
  return signInAction({ ok: false }, form());
}

beforeEach(() => {
  state.redirects = [];
});

describe("signInAction distingue credencial inválida de falha do serviço", () => {
  it("credenciais inválidas (400 invalid_credentials) → mensagem de e-mail ou senha", async () => {
    const result = await signInWith(new AuthApiError("Invalid login credentials", 400, "invalid_credentials"));
    expect(result).toEqual({ ok: false, error: SIGN_IN_INVALID_CREDENTIALS_MESSAGE });
    expect(SIGN_IN_INVALID_CREDENTIALS_MESSAGE).toBe("E-mail ou senha incorretos.");
  });

  it("serviço fora do ar (503) → indisponibilidade, não 'senha incorreta'", async () => {
    const result = await signInWith(new AuthRetryableFetchError("Service Unavailable", 503));
    expect(result).toEqual({ ok: false, error: SIGN_IN_UNAVAILABLE_MESSAGE });
  });

  it("falha de rede (fetch failed, status 0) → indisponibilidade", async () => {
    const result = await signInWith(new AuthRetryableFetchError("fetch failed", 0));
    expect(result).toEqual({ ok: false, error: SIGN_IN_UNAVAILABLE_MESSAGE });
  });

  it("resposta ilegível do Auth (AuthUnknownError) → indisponibilidade", async () => {
    const result = await signInWith(new AuthUnknownError("Unexpected token <", new SyntaxError("x")));
    expect(result).toEqual({ ok: false, error: SIGN_IN_UNAVAILABLE_MESSAGE });
  });

  it("código não mapeado (unexpected_failure) → indisponibilidade, nunca o texto original", async () => {
    const result = await signInWith(new AuthApiError("pq: connection refused on auth.users", 400, "unexpected_failure"));
    expect(result).toEqual({ ok: false, error: SIGN_IN_UNAVAILABLE_MESSAGE });
    expect(JSON.stringify(result)).not.toContain("auth.users");
  });

  it("limite de tentativas (429 over_request_rate_limit) → pede para aguardar", async () => {
    const result = await signInWith(new AuthApiError("Request rate limit reached", 429, "over_request_rate_limit"));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/aguarde/i);
    expect(result.error).not.toBe(SIGN_IN_INVALID_CREDENTIALS_MESSAGE);
  });

  it("e-mail não confirmado → pede a confirmação (o Auth só responde isso depois de validar a senha)", async () => {
    const result = await signInWith(new AuthApiError("Email not confirmed", 400, "email_not_confirmed"));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/confirm/i);
  });

  it("nenhuma mensagem de falha revela se a conta existe", async () => {
    const messages = [
      (await signInWith(new AuthApiError("Invalid login credentials", 400, "invalid_credentials"))).error,
      (await signInWith(new AuthRetryableFetchError("fetch failed", 0))).error,
    ];
    for (const message of messages) {
      expect(message).not.toMatch(/não (existe|encontrad|cadastrad)|conta inexistente|usuário/i);
    }
    expect(state.redirects).toEqual([]);
  });

  it("login certo continua redirecionando", async () => {
    await expect(signInWith(null)).rejects.toThrow("redirect:/visao-geral");
  });
});
