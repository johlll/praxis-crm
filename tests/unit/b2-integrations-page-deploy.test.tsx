/**
 * @vitest-environment node
 *
 * B2 — cenário de deployment: código novo publicado ANTES de a migration da
 * B2 ser aplicada no banco hospedado (as RPCs de calendário ainda não
 * existem lá).
 *
 *  - Integração desativada (sem provedor): a tela mostra o aviso e NÃO
 *    consulta nada de B2, então não depende do schema novo.
 *  - Integração habilitada: o erro de banco sobe (error.tsx) e nunca é
 *    mascarado como "nenhuma conexão".
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { providerMock, listConnectionsMock, listCalendarsMock } = vi.hoisted(() => ({
  providerMock: vi.fn(),
  listConnectionsMock: vi.fn(),
  listCalendarsMock: vi.fn(),
}));

vi.mock("@/components/app-shell/topbar", () => ({
  Topbar: ({ title }: { title: string }) => <header>{title}</header>,
}));
vi.mock("@/components/calendar/calendar-connection-forms", () => ({
  ConnectCalendarForm: () => <form data-testid="connect" />,
  DisconnectCalendarForm: () => <form data-testid="disconnect" />,
  SelectCalendarForm: () => <form data-testid="select" />,
}));
vi.mock("@/modules/shell/queries", () => ({
  getShellContext: async () => ({ user: { name: "Teste" }, activeWorkspace: { id: "ws-1" } }),
}));
vi.mock("@/server/authz/permissions", async () => {
  const roles = await vi.importActual<typeof import("@/lib/roles")>("@/lib/roles");
  return {
    requireMembership: async () => ({ role: "owner", userId: "u-1", workspaceId: "ws-1", membershipId: "m-1" }),
    roleHasPermission: roles.roleHasPermission,
  };
});
vi.mock("@/server/calendar/provider", () => ({ getCalendarProvider: () => providerMock() }));
vi.mock("@/modules/calendar/queries", () => ({
  listCalendarConnections: listConnectionsMock,
  listChoosableCalendars: listCalendarsMock,
}));

import IntegracoesPage from "@/app/(app)/configuracoes/integracoes/page";

beforeEach(() => vi.clearAllMocks());

describe("Integrações — deployment com a migration da B2 ainda ausente", () => {
  it("integração desativada: mostra o aviso e não toca em NENHUMA consulta de B2", async () => {
    providerMock.mockResolvedValue(null);
    // Se a página consultasse, o schema ausente derrubaria a tela.
    listConnectionsMock.mockRejectedValue(new Error('function public.list_calendar_connections does not exist'));

    const html = renderToStaticMarkup(await IntegracoesPage());

    expect(html).toContain("ainda não está configurada neste ambiente");
    expect(listConnectionsMock).not.toHaveBeenCalled();
    expect(listCalendarsMock).not.toHaveBeenCalled();
    expect(html).not.toContain("connect");
  });

  it("integração habilitada: erro de banco NÃO é mascarado como estado vazio", async () => {
    providerMock.mockResolvedValue({});
    listConnectionsMock.mockRejectedValue(new Error('function public.list_calendar_connections does not exist'));

    await expect(IntegracoesPage()).rejects.toThrow(/list_calendar_connections/);
    expect(listConnectionsMock).toHaveBeenCalledWith("ws-1");
  });

  it("integração habilitada e sem conexão: oferece conectar", async () => {
    providerMock.mockResolvedValue({});
    listConnectionsMock.mockResolvedValue([]);

    const html = renderToStaticMarkup(await IntegracoesPage());

    expect(html).toContain('data-testid="connect"');
    expect(html).not.toContain("não está configurada");
  });
});
