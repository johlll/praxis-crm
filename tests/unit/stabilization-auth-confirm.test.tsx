import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Estabilização pós-A9 — inventário §6.1 (docs/decisoes/estabilizacao-pos-a9.md).
 *
 * O cliente do servidor usa o fluxo PKCE do @supabase/ssr (o cadastro grava o
 * cookie `code-verifier`). Com o modelo de e-mail padrão do Supabase, o link
 * de confirmação passa por `/auth/v1/verify` e volta para `/auth/confirm?code=…`
 * — não `?token_hash=…`. A rota só tratava `token_hash`, então a confirmação
 * real terminava em `/entrar?erro=confirmacao_invalida`, e a tela de login
 * ignorava esse parâmetro (falha silenciosa).
 */

const state = vi.hoisted(() => ({
  verifyOtp: vi.fn(async (_args: unknown) => ({ error: null as unknown })),
  exchangeCodeForSession: vi.fn(async (_code: string) => ({ error: null as unknown })),
}));

class RedirectSignal extends Error {
  constructor(public readonly to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));
vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    auth: { verifyOtp: state.verifyOtp, exchangeCodeForSession: state.exchangeCodeForSession },
  }),
}));
vi.mock("@/modules/auth/actions", () => ({ signInAction: vi.fn(), signUpAction: vi.fn() }));

const { GET } = await import("@/app/auth/confirm/route");
const { default: EntrarPage } = await import("@/app/entrar/page");

async function destinationOf(query: string) {
  const request = { url: `https://app.exemplo.test/auth/confirm${query}` } as never;
  try {
    await GET(request);
  } catch (error) {
    if (error instanceof RedirectSignal) return error.to;
    throw error;
  }
  throw new Error("a rota não redirecionou");
}

beforeEach(() => {
  state.verifyOtp.mockClear();
  state.exchangeCodeForSession.mockClear();
  state.verifyOtp.mockImplementation(async () => ({ error: null }));
  state.exchangeCodeForSession.mockImplementation(async () => ({ error: null }));
});

describe("/auth/confirm", () => {
  it("link do fluxo PKCE (?code=) troca o código pela sessão e segue para o onboarding", async () => {
    expect(await destinationOf("?code=codigo-pkce-1")).toBe("/onboarding");
    expect(state.exchangeCodeForSession).toHaveBeenCalledWith("codigo-pkce-1");
    expect(state.verifyOtp).not.toHaveBeenCalled();
  });

  it("código recusado (expirado, outro navegador) → volta ao login com o erro", async () => {
    state.exchangeCodeForSession.mockImplementation(async () => ({ error: { message: "invalid flow state" } }));
    expect(await destinationOf("?code=codigo-velho")).toBe("/entrar?erro=confirmacao_invalida");
  });

  it("link com token_hash continua funcionando", async () => {
    expect(await destinationOf("?token_hash=abc&type=signup")).toBe("/onboarding");
    expect(state.verifyOtp).toHaveBeenCalledWith({ type: "signup", token_hash: "abc" });
  });

  it("sem parâmetros → erro", async () => {
    expect(await destinationOf("")).toBe("/entrar?erro=confirmacao_invalida");
  });
});

describe("/entrar?erro=confirmacao_invalida", () => {
  it("mostra que o link de confirmação não funcionou", async () => {
    render(await EntrarPage({ searchParams: Promise.resolve({ erro: "confirmacao_invalida" }) }));
    expect(screen.getByRole("alert").textContent).toMatch(/link de confirmação/i);
  });

  it("sem erro, nenhum aviso", async () => {
    render(await EntrarPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByText(/link de confirmação/i)).toBeNull();
  });
});
