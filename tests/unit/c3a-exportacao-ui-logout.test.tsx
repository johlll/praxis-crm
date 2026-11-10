/**
 * C3a — seção "Privacidade e LGPD" na tela do contato (confirmação, processamento,
 * download, falha sem arquivo), exibição só para owner/admin e logout com escopo
 * global explícito.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContactPrivacySection } from "@/components/contacts/contact-privacy-section";
import { ROLES, roleHasPermission } from "@/lib/roles";

const CONTACT = "c0000000-0000-0000-0000-000000000001";
const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8").split("\r").join("");

describe("permissão e exibição", () => {
  it("privacy.manage é só de owner e admin", () => {
    expect(ROLES.filter((role) => roleHasPermission(role, "privacy.manage"))).toEqual(["owner", "admin"]);
  });

  it("a tela do contato só desenha a seção para quem tem a permissão", () => {
    const page = read("src/app/(app)/contatos/[id]/page.tsx");
    expect(page).toContain('roleHasPermission(user.role, "privacy.manage")');
    expect(page).toMatch(/canExportPrivacy \? <ContactPrivacySection contactId=\{contact\.id\} \/> : null/);
  });
});

describe("seção de exportação", () => {
  const fetchMock = vi.fn();
  const click = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    click.mockReset();
    URL.createObjectURL = vi.fn(() => "blob:teste");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(click);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("mostra o aviso de uso e o botão; nada é gerado antes da confirmação", () => {
    render(<ContactPrivacySection contactId={CONTACT} />);
    expect(screen.getByText("Privacidade e LGPD")).toBeTruthy();
    expect(
      screen.getByText(/Use esta exportação somente para atendimento de solicitação do titular\. O arquivo pode conter dados pessoais e deve ser armazenado e compartilhado com segurança\./),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Exportar dados do titular" }));
    expect(screen.getByText(/ficará registrada na auditoria/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancelar volta ao estado inicial sem chamar o servidor", () => {
    render(<ContactPrivacySection contactId={CONTACT} />);
    fireEvent.click(screen.getByRole("button", { name: "Exportar dados do titular" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.getByRole("button", { name: "Exportar dados do titular" })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("confirmar: processa, baixa o anexo com o nome do cabeçalho e avisa o sucesso", async () => {
    let finish!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (finish = r)));
    render(<ContactPrivacySection contactId={CONTACT} />);
    fireEvent.click(screen.getByRole("button", { name: "Exportar dados do titular" }));
    fireEvent.click(screen.getByRole("button", { name: "Gerar exportação" }));

    expect(fetchMock).toHaveBeenCalledWith(`/api/privacy/contacts/${CONTACT}/export`, { method: "POST" });
    expect((screen.getByRole("button", { name: "Gerando exportação…" }) as HTMLButtonElement).disabled).toBe(true);

    finish(new Response("{}", { status: 200, headers: { "Content-Disposition": `attachment; filename="titular-${CONTACT}-2026-11-12.json"` } }));
    await waitFor(() => expect(screen.getByText("Exportação gerada. O download começou.")).toBeTruthy());
    expect(click).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:teste");
  });

  it.each([
    [403, "forbidden", "Você não tem permissão para exportar os dados deste titular."],
    [404, "not_found", "Contato não encontrado."],
    [500, "export_failed", "Não foi possível gerar a exportação. Nenhum arquivo foi entregue; tente novamente."],
  ])("falha %i: mensagem clara e NENHUM download", async (status, code, message) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: code }), { status }));
    render(<ContactPrivacySection contactId={CONTACT} />);
    fireEvent.click(screen.getByRole("button", { name: "Exportar dados do titular" }));
    fireEvent.click(screen.getByRole("button", { name: "Gerar exportação" }));
    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
    expect(click).not.toHaveBeenCalled();
  });

  it("falha de rede também não baixa nada e não vaza o erro", async () => {
    fetchMock.mockRejectedValue(new Error("Failed to fetch 12345678901"));
    render(<ContactPrivacySection contactId={CONTACT} />);
    fireEvent.click(screen.getByRole("button", { name: "Exportar dados do titular" }));
    fireEvent.click(screen.getByRole("button", { name: "Gerar exportação" }));
    await waitFor(() => expect(screen.getByText(/Nenhum arquivo foi entregue/)).toBeTruthy());
    expect(document.body.textContent).not.toContain("12345678901");
    expect(click).not.toHaveBeenCalled();
  });
});

describe("logout global", () => {
  it("signOutAction envia scope 'global', limpa o cookie do workspace e redireciona", async () => {
    vi.resetModules();
    const signOut = vi.fn().mockResolvedValue({ error: null });
    const clearCookie = vi.fn().mockResolvedValue(undefined);
    const redirect = vi.fn(() => {
      throw new Error("NEXT_REDIRECT");
    });
    vi.doMock("@/server/supabase/server", () => ({ createServerSupabaseClient: async () => ({ auth: { signOut } }) }));
    vi.doMock("@/server/auth/workspace", () => ({
      clearActiveWorkspaceCookie: clearCookie,
      getActiveWorkspaceId: vi.fn(),
      switchActiveWorkspace: vi.fn(),
    }));
    vi.doMock("next/navigation", () => ({ redirect }));
    vi.doMock("@/modules/workspace/queries", () => ({ listMyWorkspaces: vi.fn() }));
    vi.doMock("@/server/request-origin", () => ({ getRequestOrigin: vi.fn() }));

    const { signOutAction } = await import("@/modules/auth/actions");
    await expect(signOutAction()).rejects.toThrow("NEXT_REDIRECT");

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ scope: "global" });
    expect(clearCookie).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/entrar");
  });
});
