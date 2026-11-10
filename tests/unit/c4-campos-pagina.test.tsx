/**
 * @vitest-environment node
 *
 * C4 — página "Campos personalizados" em Configurações: owner/admin administram;
 * qualquer outro papel recebe "não encontrado" sem consultar nada; o workspace é o
 * da sessão; estado vazio e lista por entidade; atalho no hub só para quem pode.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

class NotFoundSignal extends Error {
  constructor() {
    super("NEXT_NOT_FOUND");
  }
}

const state = vi.hoisted(() => ({ role: "owner" as string, workspaceId: "10000000-0000-0000-0000-000000000001" }));
const { listMock } = vi.hoisted(() => ({ listMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundSignal();
  },
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/components/app-shell/topbar", () => ({
  Topbar: ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <header data-testid="topbar">
      {title} | {subtitle}
    </header>
  ),
}));
vi.mock("@/modules/shell/queries", () => ({
  getShellContext: async () => ({
    user: { id: "u-1", fullName: "Ana", initials: "A", role: state.role },
    activeWorkspace: { id: state.workspaceId, name: "Escritório Um" },
  }),
}));
vi.mock("@/server/authz/permissions", async () => {
  const roles: { roleHasPermission: (role: string, permission: string) => boolean } = await vi.importActual("@/lib/roles");
  return {
    requireMembership: async () => ({
      role: state.role,
      userId: "20000000-0000-0000-0000-000000000001",
      workspaceId: state.workspaceId,
      membershipId: "m-1",
    }),
    roleHasPermission: roles.roleHasPermission,
  };
});
vi.mock("@/modules/custom-fields/queries", () => ({ listCustomFieldDefinitions: listMock }));
vi.mock("@/modules/custom-fields/actions", () => ({
  saveCustomFieldDefinitionAction: vi.fn(),
  setCustomFieldArchivedAction: vi.fn(),
  saveCustomFieldValuesAction: vi.fn(),
}));

import CamposPersonalizadosPage from "@/app/(app)/configuracoes/campos-personalizados/page";
import ConfiguracoesPage from "@/app/(app)/configuracoes/page";

const def = (over: Record<string, unknown> = {}) => ({
  id: "a0000000-0000-0000-0000-000000000001",
  entity: "lead",
  name: "Fase processual",
  type: "select",
  position: 0,
  archived: false,
  options: [{ id: "b0000000-0000-0000-0000-000000000001", label: "Recursal", inUse: false }],
  ...over,
});

const render = async () => renderToStaticMarkup(await CamposPersonalizadosPage());

beforeEach(() => {
  vi.clearAllMocks();
  state.role = "owner";
  listMock.mockResolvedValue([def()]);
});

describe("página de administração", () => {
  it.each(["owner", "admin"])("%s administra: vê a lista por entidade, o aviso de segredo e os botões", async (role) => {
    state.role = role;
    const html = await render();
    expect(html).toContain("Campos personalizados");
    expect(html).toContain("Fase processual");
    for (const label of ["Contatos", "Leads", "Oportunidades", "Clientes"]) expect(html).toContain(label);
    expect(html).toContain("Novo campo");
    expect(html).toContain("Não use campos personalizados para CPF, credenciais, senhas");
    expect(html).toContain("Seleção única");
  });

  it.each(["manager", "lawyer", "sales", "viewer"])("%s recebe 'não encontrado' sem consultar o banco", async (role) => {
    state.role = role;
    await expect(CamposPersonalizadosPage()).rejects.toBeInstanceOf(NotFoundSignal);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("consulta o workspace da SESSÃO", async () => {
    await render();
    expect(listMock).toHaveBeenCalledWith(state.workspaceId);
  });

  it("o banco recusou (papel mudou): mesma resposta de quem nunca teve acesso", async () => {
    listMock.mockResolvedValue(null);
    await expect(CamposPersonalizadosPage()).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it("sem nenhum campo: estado vazio com a instrução, e as quatro entidades continuam listadas", async () => {
    listMock.mockResolvedValue([]);
    const html = await render();
    expect(html).toContain("Nenhum campo personalizado ainda");
    expect(html).toContain("Nenhum campo em contatos ainda");
  });

  it("campo arquivado aparece como arquivado, com a explicação de que o valor continua guardado", async () => {
    listMock.mockResolvedValue([def({ archived: true })]);
    const html = await render();
    expect(html).toContain("Arquivado");
    expect(html).toContain("Restaurar");
    expect(html).toContain("continuam guardados");
  });

  it("falha de carregamento sobe para o error.tsx (nunca vira lista vazia)", async () => {
    listMock.mockRejectedValue(new Error("falha"));
    await expect(CamposPersonalizadosPage()).rejects.toThrow("falha");
  });
});

describe("atalho em Configurações", () => {
  it("só owner e admin veem o cartão", async () => {
    state.role = "admin";
    expect(renderToStaticMarkup(await ConfiguracoesPage())).toContain("/configuracoes/campos-personalizados");
    state.role = "manager";
    expect(renderToStaticMarkup(await ConfiguracoesPage())).not.toContain("/configuracoes/campos-personalizados");
  });
});
