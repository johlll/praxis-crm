/**
 * @vitest-environment node
 *
 * B5 — página de auditoria: só owner/admin; quem não tem a permissão recebe
 * "não encontrado" sem tocar em nenhuma consulta; o workspace é o da sessão
 * (nunca o da URL); filtros e cursor refletidos; sem dado sensível no HTML.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

class NotFoundSignal extends Error {
  constructor() {
    super("NEXT_NOT_FOUND");
  }
}

const state = vi.hoisted(() => ({
  role: "owner" as string,
  workspaceId: "10000000-0000-0000-0000-000000000001",
}));
const { listAuditLogMock, listTeamMembersMock } = vi.hoisted(() => ({
  listAuditLogMock: vi.fn(),
  listTeamMembersMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundSignal();
  },
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
vi.mock("@/modules/audit/queries", () => ({ listAuditLog: listAuditLogMock }));
vi.mock("@/modules/team/queries", () => ({ listTeamMembers: listTeamMembersMock }));

import AuditoriaPage from "@/app/(app)/configuracoes/auditoria/page";

const ANA = "20000000-0000-0000-0000-000000000001";
const CARLA = "20000000-0000-0000-0000-000000000003";
const ID1 = "a1000000-0000-0000-0000-000000000001";
const ID2 = "a1000000-0000-0000-0000-000000000002";
const MEMBERS = [
  { membershipId: "m1", userId: ANA, fullName: "Ana Owner", email: "ana@x.com", role: "owner", isCurrentUser: true },
  { membershipId: "m2", userId: CARLA, fullName: null, email: "carla@x.com", role: "lawyer", isCurrentUser: false },
];

const entry = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  createdAt: "2026-11-09T15:00:00+00:00",
  action: "membership.role_changed",
  actorUserId: ANA,
  actorName: "Ana Owner",
  targetName: null,
  details: { from_role: "viewer", to_role: "admin" },
  ...over,
});

const render = async (searchParams: Record<string, string | string[] | undefined> = {}) =>
  renderToStaticMarkup(await AuditoriaPage({ searchParams: Promise.resolve(searchParams) }));

/** Só a tabela de registros (o filtro "Pessoa" mostra o e-mail de quem não tem nome, como os de leads). */
const tableOf = (html: string) => /<table[\s\S]*<\/table>/.exec(html)?.[0] ?? "";

beforeEach(() => {
  vi.clearAllMocks();
  state.role = "owner";
  state.workspaceId = "10000000-0000-0000-0000-000000000001";
  listAuditLogMock.mockResolvedValue({ items: [entry(ID1)], hasMore: false, nextCursor: null });
  listTeamMembersMock.mockResolvedValue(MEMBERS);
});

describe("acesso", () => {
  it.each(["manager", "lawyer", "sales", "viewer"])("%s recebe 'não encontrado' e nenhuma consulta roda", async (role) => {
    state.role = role;
    await expect(render()).rejects.toBeInstanceOf(NotFoundSignal);
    expect(listAuditLogMock).not.toHaveBeenCalled();
    expect(listTeamMembersMock).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"])("%s vê a tela", async (role) => {
    state.role = role;
    const html = await render();
    expect(html).toContain("Auditoria");
    expect(html).toContain("Papel alterado");
    expect(listAuditLogMock).toHaveBeenCalledTimes(1);
  });

  it("o banco recusou (papel mudou desde que a página abriu) → também 'não encontrado'", async () => {
    listAuditLogMock.mockResolvedValue(null);
    await expect(render()).rejects.toBeInstanceOf(NotFoundSignal);
  });
});

describe("workspace sempre da sessão", () => {
  it("parâmetros de workspace na URL são ignorados", async () => {
    await render({
      workspace: "10000000-0000-0000-0000-000000000002",
      workspaceId: "10000000-0000-0000-0000-000000000002",
      p_workspace_id: "10000000-0000-0000-0000-000000000002",
      acao: "lead.created",
    });
    expect(listAuditLogMock).toHaveBeenCalledExactlyOnceWith(
      "10000000-0000-0000-0000-000000000001",
      { action: "lead.created", actorUserId: null, from: null, to: null },
      null,
    );
    expect(listTeamMembersMock).toHaveBeenCalledWith("10000000-0000-0000-0000-000000000001", ANA);
  });
});

describe("conteúdo", () => {
  it("mostra quando, quem, o quê e os detalhes em português", async () => {
    const html = await render();
    expect(html).toContain("Papel alterado");
    expect(html).toContain("Ana Owner");
    expect(html).toContain("Papel anterior");
    expect(html).toContain("Visualizador");
    expect(html).toContain("Papel novo");
    expect(html).toContain("Administrador");
    expect(html).toContain('dateTime="2026-11-09T15:00:00+00:00"');
    // 15:00 UTC = 12:00 em Brasília.
    expect(html).toMatch(/09\/11\/2026,? 12:00/);
  });

  it("registro do sistema (sem ator) e ação sem rótulo conhecido", async () => {
    listAuditLogMock.mockResolvedValue({
      items: [entry(ID1, { actorUserId: null, actorName: null, action: "acao.futura.sem_rotulo", details: {} })],
      hasMore: false,
      nextCursor: null,
    });
    const html = await render();
    expect(html).toContain("Sistema");
    expect(html).toContain("acao.futura.sem_rotulo");
  });

  it("transferência de posse mostra o novo proprietário e os papéis, sem e-mail", async () => {
    listAuditLogMock.mockResolvedValue({
      items: [
        entry(ID1, {
          action: "workspace.ownership_transferred",
          targetName: "Carla Compartilhada",
          details: { new_owner_previous_role: "lawyer", previous_owner_new_role: "admin" },
        }),
      ],
      hasMore: false,
      nextCursor: null,
    });
    const html = await render();
    expect(html).toContain("Posse do workspace transferida");
    expect(html).toContain("Novo proprietário");
    expect(html).toContain("Carla Compartilhada");
    expect(html).toContain("Papel anterior do novo proprietário");
    expect(html).toContain("Advogado");
    expect(tableOf(html)).not.toBe("");
    expect(tableOf(html)).not.toMatch(/@/);
  });

  it("nada de metadata nem de dado sensível, mesmo se a camada de consulta deixasse passar", async () => {
    listAuditLogMock.mockResolvedValue({
      items: [
        entry(ID1, {
          action: "invitation.created",
          details: { role: "lawyer", email: "convidado@exemplo.com", token: "tok_123" },
          metadata: { email: "convidado@exemplo.com" },
        }),
      ],
      hasMore: false,
      nextCursor: null,
    });
    const html = await render();
    expect(html).toContain("Convite criado");
    expect(html).toContain("Advogado");
    expect(html).not.toMatch(/exemplo|tok_123|metadata/);
  });
});

describe("filtros refletidos", () => {
  it("o formulário é GET para a própria tela e mostra a seleção atual", async () => {
    const html = await render({ acao: "lead.created", pessoa: CARLA, de: "2026-11-01", ate: "2026-11-09" });
    expect(html).toContain('action="/configuracoes/auditoria"');
    expect(html).toContain('method="get"');
    expect(html).toMatch(/<option value="lead.created" selected/);
    expect(html).toMatch(new RegExp(`<option value="${CARLA}" selected`));
    expect(html).toContain('value="2026-11-01"');
    expect(html).toContain('value="2026-11-09"');
    expect(html).toContain("Limpar filtros");
    expect(listAuditLogMock.mock.calls[0]?.[1]).toEqual({
      action: "lead.created",
      actorUserId: CARLA,
      from: "2026-11-01",
      to: "2026-11-09",
    });
  });

  it("o nome da pessoa vem da equipe (nome ou e-mail)", async () => {
    const html = await render();
    expect(html).toContain("Ana Owner");
    expect(html).toContain("carla@x.com");
  });

  it("sem filtros: não oferece 'Limpar filtros'", async () => {
    expect(await render()).not.toContain("Limpar filtros");
  });

  it("filtro inválido na URL vira 'sem filtro'", async () => {
    await render({ acao: "x'; drop table audit_logs;--", pessoa: "nao-uuid", de: "ontem" });
    expect(listAuditLogMock.mock.calls[0]?.[1]).toEqual({ action: null, actorUserId: null, from: null, to: null });
  });

  it("período invertido: avisa e consulta sem período", async () => {
    const html = await render({ de: "2026-11-10", ate: "2026-11-01" });
    expect(html).toContain("A data inicial não pode ser depois da data final");
    expect(listAuditLogMock.mock.calls[0]?.[1]).toEqual({ action: null, actorUserId: null, from: null, to: null });
  });
});

describe("paginação por cursor", () => {
  it("há mais: link para os registros mais antigos com o cursor e os filtros", async () => {
    listAuditLogMock.mockResolvedValue({
      items: [entry(ID2), entry(ID1)],
      hasMore: true,
      nextCursor: { createdAt: "2026-11-09T15:00:00.123456+00:00", id: ID1 },
    });
    const html = await render({ acao: "lead.created" });
    const href = /href="([^"]*antes=[^"]*)"/.exec(html)?.[1];
    expect(href).toBeDefined();
    const url = new URL(href!.replace(/&amp;/g, "&"), "http://x");
    expect(url.pathname).toBe("/configuracoes/auditoria");
    expect(url.searchParams.get("acao")).toBe("lead.created");
    expect(url.searchParams.get("antes")).toBe(`2026-11-09T15:00:00.123456+00:00|${ID1}`);
    expect(html).not.toContain("Voltar ao início");
  });

  it("numa página seguinte: 'Voltar ao início' e o cursor chega à consulta", async () => {
    const antes = `2026-11-09T15:00:00.123456+00:00|${ID1}`;
    listAuditLogMock.mockResolvedValue({ items: [entry(ID2)], hasMore: false, nextCursor: null });
    const html = await render({ acao: "lead.created", antes });
    expect(html).toContain("Voltar ao início");
    expect(listAuditLogMock.mock.calls[0]?.[2]).toEqual({ createdAt: "2026-11-09T15:00:00.123456+00:00", id: ID1 });
  });

  it("cursor adulterado: volta ao início, sem erro", async () => {
    await render({ antes: "qualquer-coisa" });
    expect(listAuditLogMock.mock.calls[0]?.[2]).toBeNull();
  });

  it("uma página só: sem paginação", async () => {
    expect(await render()).not.toContain("Registros mais antigos");
  });
});

describe("estados vazios", () => {
  beforeEach(() => {
    listAuditLogMock.mockResolvedValue({ items: [], hasMore: false, nextCursor: null });
  });

  it("sem filtros", async () => {
    const html = await render();
    expect(html).toContain("Nenhum registro ainda");
  });

  it("com filtros", async () => {
    const html = await render({ acao: "lead.created" });
    expect(html).toContain("Nenhum registro encontrado");
    expect(html).toContain("limpe os filtros");
  });
});

describe("falha de carga não vira tela vazia", () => {
  it("o erro da consulta sobe para o error.tsx", async () => {
    listAuditLogMock.mockRejectedValue(new Error("falha operacional"));
    await expect(render()).rejects.toThrow("falha operacional");
  });
});
