import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Estabilização pós-A9 — inventário §6.1 e §6.3
 * (docs/decisoes/estabilizacao-pos-a9.md).
 *
 * A rota de confirmação precisa separar situações que pedem ações
 * diferentes:
 * - link recusado, expirado ou reutilizado (erro vindo do Auth ou falha do
 *   verifyOtp): isso diz só que aquele link não vale mais — NÃO determina se
 *   a conta está confirmada, porque um link já usado de uma conta confirmada
 *   dá o mesmo erro → o aviso fala do link e oferece entrar ou pedir um link
 *   novo;
 * - o Auth aceitou o link e devolveu um código, mas a sessão não pôde ser
 *   aberta (outro navegador, código expirado): aqui a confirmação já
 *   aconteceu antes do redirecionamento, e só a sessão falhou → mandar
 *   entrar com a senha, nunca pedir cadastro de novo;
 * - link do modelo com `token_hash` (o que passou a ser usado depois da
 *   troca do modelo de e-mail) → verifyOtp.
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
  it("link com token_hash (modelo atual do e-mail) cria a sessão e segue para o onboarding", async () => {
    expect(await destinationOf("?token_hash=abc&type=email")).toBe("/onboarding");
    expect(state.verifyOtp).toHaveBeenCalledWith({ type: "email", token_hash: "abc" });
  });

  it("link do fluxo PKCE (?code=) troca o código pela sessão e segue para o onboarding", async () => {
    expect(await destinationOf("?code=codigo-pkce-1")).toBe("/onboarding");
    expect(state.exchangeCodeForSession).toHaveBeenCalledWith("codigo-pkce-1");
    expect(state.verifyOtp).not.toHaveBeenCalled();
  });

  it("e-mail já confirmado mas sessão não aberta → manda entrar, não pede cadastro novo", async () => {
    state.exchangeCodeForSession.mockImplementation(async () => ({ error: { message: "invalid flow state" } }));
    expect(await destinationOf("?code=codigo-velho")).toBe("/entrar?erro=sessao_nao_criada");
  });

  it("o próprio Auth recusou o link (expirado/reutilizado) → pedir link novo", async () => {
    expect(await destinationOf("?error=access_denied&error_code=otp_expired")).toBe("/entrar?erro=link_invalido");
    expect(state.verifyOtp).not.toHaveBeenCalled();
    expect(state.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("token_hash recusado → link inválido (não determina se a conta está confirmada)", async () => {
    state.verifyOtp.mockImplementation(async () => ({ error: { message: "Token has expired" } }));
    expect(await destinationOf("?token_hash=abc&type=email")).toBe("/entrar?erro=link_invalido");
  });

  it("sem parâmetros → link inválido", async () => {
    expect(await destinationOf("")).toBe("/entrar?erro=link_invalido");
  });
});

describe("/entrar mostra o aviso certo para cada caso", () => {
  it("sessão não criada: diz que o e-mail está confirmado e pede o login", async () => {
    render(await EntrarPage({ searchParams: Promise.resolve({ erro: "sessao_nao_criada" }) }));
    const texto = screen.getByRole("alert").textContent ?? "";
    expect(texto).toMatch(/confirmad/i);
    expect(texto).toMatch(/entre/i);
    expect(texto).not.toMatch(/cadastr/i);
  });

  it("link inválido: fala do link, não do estado da conta", async () => {
    render(await EntrarPage({ searchParams: Promise.resolve({ erro: "link_invalido" }) }));
    const texto = screen.getByRole("alert").textContent ?? "";
    // O link ter expirado ou sido reutilizado não diz nada sobre a conta
    // estar confirmada: a mesma resposta acontece com um link já usado de
    // uma conta confirmada. O aviso oferece os dois caminhos.
    expect(texto).toMatch(/j[áa] (foi )?usad|expirou|inv[áa]lid/i);
    expect(texto).toMatch(/entrar|entre/i);
    expect(texto).not.toMatch(/(conta|e-mail)[^.]{0,40}n[ãa]o (foi |est[áa] )?confirmad/i);
    // O caminho oferecido precisa existir na tela: o formulário "Criar
    // conta" com o mesmo e-mail reenvia a confirmação e mantém a conta
    // (comprovado no ambiente hospedado). Não prometer "conta nova" nem
    // uma ação que só existe fora da interface.
    expect(texto).toMatch(/criar conta/i);
    expect(texto).toMatch(/mantid|preservad|continua sendo/i);
    expect(texto).not.toMatch(/crie a conta de novo|nova conta/i);
  });

  it("sem erro, nenhum aviso", async () => {
    render(await EntrarPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
