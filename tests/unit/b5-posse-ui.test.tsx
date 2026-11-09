/**
 * B5 — interface: diálogo de transferência de posse (confirmação explícita),
 * seção "Posse do workspace" só para o proprietário e cartão "Auditoria" só
 * para quem tem a permissão.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { transferMock } = vi.hoisted(() => ({ transferMock: vi.fn() }));
const state = vi.hoisted(() => ({ role: "owner" as string, members: [] as unknown[] }));

vi.mock("@/modules/team/actions", () => ({
  transferOwnershipAction: transferMock,
  // As outras actions do módulo não são usadas aqui.
  createInvitationAction: vi.fn(),
  cancelInvitationAction: vi.fn(),
  updateMembershipRoleAction: vi.fn(),
  removeMembershipAction: vi.fn(),
  acceptInvitationAction: vi.fn(),
}));
vi.mock("@/components/app-shell/topbar", () => ({ Topbar: ({ title }: { title: string }) => <header>{title}</header> }));
vi.mock("@/modules/shell/queries", () => ({
  getShellContext: async () => ({
    user: { id: "u-1", fullName: "Ana", initials: "A", role: state.role },
    activeWorkspace: { id: "ws-1", name: "Escritório Um" },
  }),
}));
vi.mock("@/server/authz/permissions", async () => {
  const roles: { roleHasPermission: (role: string, permission: string) => boolean } = await vi.importActual("@/lib/roles");
  return {
    requireMembership: async () => ({ role: state.role, userId: "u-1", workspaceId: "ws-1", membershipId: "m-1" }),
    roleHasPermission: roles.roleHasPermission,
  };
});
vi.mock("@/modules/team/queries", () => ({
  listTeamMembers: async () => state.members,
  listPendingInvitations: async () => [],
}));
// A tela da equipe usa estes três; o diálogo de posse fica REAL.
vi.mock("@/components/team/member-row", () => ({ MemberRow: ({ member }: { member: { email: string } }) => <div>{member.email}</div> }));
vi.mock("@/components/team/pending-invitation-row", () => ({ PendingInvitationRow: () => <div /> }));
vi.mock("@/components/team/invite-dialog", () => ({ InviteDialog: () => <button type="button">Convidar</button> }));

import EquipePage from "@/app/(app)/configuracoes/equipe/page";
import ConfiguracoesPage from "@/app/(app)/configuracoes/page";
import { TransferOwnershipDialog } from "@/components/team/transfer-ownership-dialog";
import type { TeamMember } from "@/modules/team/queries";

const ANA: TeamMember = { membershipId: "m-ana", userId: "u-ana", fullName: "Ana Owner", email: "ana@x.com", role: "owner", isCurrentUser: true };
const CARLA: TeamMember = { membershipId: "m-carla", userId: "u-carla", fullName: "Carla Souza", email: "carla@x.com", role: "lawyer", isCurrentUser: false };
const ELISA: TeamMember = { membershipId: "m-elisa", userId: "u-elisa", fullName: null, email: "elisa@x.com", role: "viewer", isCurrentUser: false };

beforeEach(() => {
  transferMock.mockReset();
  state.role = "owner";
  state.members = [ANA, CARLA, ELISA];
});
afterEach(cleanup);

function openDialog() {
  render(<TransferOwnershipDialog members={[ANA, CARLA, ELISA]} />);
  fireEvent.click(screen.getByRole("button", { name: /Transferir posse…/ }));
  return screen.getByRole("dialog");
}
const submitButton = () => screen.getByRole("button", { name: /^Transferir posse$/ });
const select = () => screen.getByLabelText("Novo proprietário") as HTMLSelectElement;
const confirmBox = () => screen.getByRole("checkbox") as HTMLInputElement;

describe("diálogo de transferência de posse", () => {
  it("começa fechado", () => {
    render(<TransferOwnershipDialog members={[ANA, CARLA, ELISA]} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: /Transferir posse…/ })).toBeInTheDocument();
  });

  it("oferece só os outros membros, com o papel atual; nunca quem está logado", () => {
    openDialog();
    const options = within(select()).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Escolha uma pessoa", "Carla Souza — Advogado", "elisa@x.com — Visualizador"]);
  });

  it("o botão só habilita com a pessoa escolhida E a confirmação marcada", () => {
    openDialog();
    expect(submitButton()).toBeDisabled();

    fireEvent.click(confirmBox());
    expect(submitButton()).toBeDisabled(); // confirmou, mas sem pessoa

    fireEvent.change(select(), { target: { value: "m-carla" } });
    expect(submitButton()).toBeEnabled();

    fireEvent.click(confirmBox());
    expect(submitButton()).toBeDisabled(); // desmarcou
  });

  it("o aviso nomeia a pessoa e explica a troca de papéis", () => {
    const dialog = openDialog();
    expect(within(dialog).getByText(/A pessoa escolhida/)).toBeInTheDocument();
    fireEvent.change(select(), { target: { value: "m-carla" } });
    const warning = within(dialog).getByRole("alert");
    expect(warning).toHaveTextContent("Carla Souza passará a ser Proprietário");
    expect(warning).toHaveTextContent("você passará a ser Administrador");
    expect(warning).toHaveTextContent("só o novo proprietário poderá devolver a posse");
  });

  it("confirmar chama a action com SÓ o destinatário e a confirmação, e fecha", async () => {
    transferMock.mockResolvedValue({ ok: true });
    openDialog();
    fireEvent.change(select(), { target: { value: "m-carla" } });
    fireEvent.click(confirmBox());
    fireEvent.click(submitButton());

    await waitFor(() => expect(transferMock).toHaveBeenCalledTimes(1));
    const sent = transferMock.mock.calls[0]![0] as FormData;
    expect([...sent.entries()]).toEqual([
      ["membershipId", "m-carla"],
      ["confirm", "yes"],
    ]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("recusa do servidor: mostra a mensagem, mantém aberto e permite tentar de novo", async () => {
    transferMock.mockResolvedValue({ ok: false, error: "Só é possível transferir a posse para um membro ativo da equipe." });
    const dialog = openDialog();
    fireEvent.change(select(), { target: { value: "m-elisa" } });
    fireEvent.click(confirmBox());
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(within(dialog).getByText("Só é possível transferir a posse para um membro ativo da equipe.")).toBeInTheDocument(),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // O botão volta quando a transição termina — um instante depois do erro aparecer.
    await waitFor(() => expect(submitButton()).toBeEnabled());
  });

  it("submeter o formulário sem confirmação (Enter) não chama a action", () => {
    const dialog = openDialog();
    fireEvent.change(select(), { target: { value: "m-carla" } });
    fireEvent.submit(dialog.querySelector("form")!);
    expect(transferMock).not.toHaveBeenCalled();
  });

  it("cancelar fecha e limpa: ao reabrir, nada escolhido nem confirmado", () => {
    openDialog();
    fireEvent.change(select(), { target: { value: "m-carla" } });
    fireEvent.click(confirmBox());
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Transferir posse…/ }));
    expect(select().value).toBe("");
    expect(confirmBox().checked).toBe(false);
    expect(submitButton()).toBeDisabled();
    expect(transferMock).not.toHaveBeenCalled();
  });
});

describe("tela da equipe: seção de posse", () => {
  const html = async () => renderToStaticMarkup(await EquipePage());

  it("o proprietário vê a seção e o botão", async () => {
    const out = await html();
    expect(out).toContain("Posse do workspace");
    expect(out).toContain("Transferir posse…");
    expect(out).toContain("Escritório Um");
  });

  it.each(["admin", "manager", "lawyer", "sales", "viewer"])("%s não vê a seção de posse", async (role) => {
    state.role = role;
    const out = await html();
    expect(out).not.toContain("Posse do workspace");
    expect(out).not.toContain("Transferir posse");
  });

  it("proprietário sozinho na equipe: pede para convidar alguém antes, sem botão", async () => {
    state.members = [ANA];
    const out = await html();
    expect(out).toContain("Posse do workspace");
    expect(out).toContain("Convide mais alguém para a equipe antes de transferir a posse.");
    expect(out).not.toContain("Transferir posse…");
  });
});

describe("índice de Configurações: cartão de auditoria", () => {
  const html = async () => renderToStaticMarkup(await ConfiguracoesPage());

  it.each(["owner", "admin"])("%s vê o cartão, com link para a tela", async (role) => {
    state.role = role;
    const out = await html();
    expect(out).toContain("Auditoria");
    expect(out).toContain('href="/configuracoes/auditoria"');
    expect(out).not.toContain("fase C"); // não é mais um marcador de fase futura
  });

  it.each(["manager", "lawyer", "sales", "viewer"])("%s não vê o cartão (nem um marcador de 'ainda não existe')", async (role) => {
    state.role = role;
    const out = await html();
    expect(out).not.toContain("Auditoria");
    expect(out).not.toContain("/configuracoes/auditoria");
    expect(out).not.toContain("fase C");
  });
});
