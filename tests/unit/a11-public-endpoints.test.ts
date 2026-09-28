import { describe, expect, it } from "vitest";

import { isPublicPath } from "@/proxy";

/**
 * A superfície de ingestão da A11 não tem sessão de usuário: cada rota se
 * autentica sozinha (chave pública + Turnstile no formulário, segredo no
 * cron, assinatura do Inngest). Sem constar como pública no proxy, o POST
 * era desviado para /entrar e a captação respondia a página de login com
 * 200 — foi o que derrubou o e2e 2.
 */
describe("rotas públicas do proxy", () => {
  it("a captação, a fila e a retenção passam sem sessão", () => {
    expect(isPublicPath("/api/forms/chave-publica-qualquer")).toBe(true);
    expect(isPublicPath("/api/inngest")).toBe(true);
    expect(isPublicPath("/api/cron/outbox")).toBe(true);
    expect(isPublicPath("/api/cron/retention")).toBe(true);
  });

  it("continua exigindo sessão no resto da aplicação", () => {
    for (const path of ["/", "/visao-geral", "/leads", "/configuracoes/formularios", "/api"]) {
      expect(isPublicPath(path)).toBe(false);
    }
  });

  it("não libera caminho que apenas começa com o mesmo texto", () => {
    expect(isPublicPath("/api/formsulario")).toBe(false);
    expect(isPublicPath("/api/cronometro")).toBe(false);
  });

  it("mantém as rotas públicas de autenticação", () => {
    expect(isPublicPath("/entrar")).toBe(true);
    expect(isPublicPath("/convite/abc")).toBe(true);
    expect(isPublicPath("/auth/callback")).toBe(true);
  });
});
