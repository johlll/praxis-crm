import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Estabilização pós-A9 — formulários de edição com campos não controlados
 * (docs/decisoes/estabilizacao-pos-a9.md §5b). Reproduzido no preview em
 * `AssignLeadForm`: depois de "Atribuir" com sucesso, o React 19 limpa o
 * formulário e o seletor volta a mostrar o valor anterior, embora o banco já
 * tenha o novo (só aparece certo ao recarregar).
 *
 * Cada caso escolhe um valor novo, envia com sucesso e confere que a tela
 * continua mostrando o valor salvo.
 */

const actions = vi.hoisted(() => ({
  assignLeadAction: vi.fn(async () => ({ ok: true })),
  updateLeadBasicFieldsAction: vi.fn(async () => ({ ok: true })),
  upsertConflictCheckAction: vi.fn(async () => ({ ok: true })),
  updateClientStatusAction: vi.fn(async () => ({ ok: true })),
  transferClientOwnerAction: vi.fn(async () => ({ ok: true })),
  updateContactBasicFieldsAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/modules/leads/actions", () => ({
  assignLeadAction: actions.assignLeadAction,
  updateLeadBasicFieldsAction: actions.updateLeadBasicFieldsAction,
}));
vi.mock("@/modules/conflict-checks/actions", () => ({ upsertConflictCheckAction: actions.upsertConflictCheckAction }));
vi.mock("@/modules/clients/actions", () => ({
  updateClientStatusAction: actions.updateClientStatusAction,
  transferClientOwnerAction: actions.transferClientOwnerAction,
}));
vi.mock("@/modules/contacts/actions", () => ({ updateContactBasicFieldsAction: actions.updateContactBasicFieldsAction }));

const { AssignLeadForm } = await import("@/components/leads/assign-lead-form");
const { LeadBasicFieldsForm } = await import("@/components/leads/lead-basic-fields-form");
const { ConflictCheckPanel } = await import("@/components/leads/conflict-check-panel");
const { ClientStatusForm } = await import("@/components/clients/client-status-form");
const { TransferClientOwnerForm } = await import("@/components/clients/transfer-client-owner-form");
const { ContactBasicFieldsForm } = await import("@/components/contacts/contact-basic-fields-form");

const members = [
  { membershipId: "m1", userId: "u1", fullName: "Ana", email: "ana@x.com", role: "owner" as const, isCurrentUser: true },
  { membershipId: "m2", userId: "u2", fullName: "Bia", email: "bia@x.com", role: "lawyer" as const, isCurrentUser: false },
];

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockClear();
});

async function submit(button: HTMLElement, action: { mock: { calls: unknown[] } }) {
  await act(async () => {
    fireEvent.click(button);
  });
  await waitFor(() => expect(action.mock.calls.length).toBe(1));
  // deixa a transição do envio terminar (é quando o React limpa o formulário)
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("formulário continua mostrando o valor salvo depois do envio", () => {
  it("AssignLeadForm", async () => {
    const lead = {
      id: "l1",
      contactId: "c1",
      contactName: "X",
      legalArea: "Cível",
      summary: null,
      tags: [],
      priority: "media" as const,
      status: "ativo" as const,
      assignedTo: null,
      assignedToName: null,
      createdAt: "2026-09-01",
      updatedAt: "2026-09-01T00:00:00Z",
    };
    render(<AssignLeadForm lead={lead} members={members} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "u2" } });
    await submit(screen.getByRole("button", { name: "Atribuir" }), actions.assignLeadAction);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("u2");
  });

  it("LeadBasicFieldsForm (prioridade)", async () => {
    const lead = {
      id: "l1",
      contactId: "c1",
      contactName: "X",
      legalArea: "Cível",
      summary: null,
      tags: [],
      priority: "media" as const,
      status: "ativo" as const,
      assignedTo: null,
      assignedToName: null,
      createdAt: "2026-09-01",
      updatedAt: "2026-09-01T00:00:00Z",
    };
    render(<LeadBasicFieldsForm lead={lead} readOnly={false} />);
    fireEvent.change(screen.getByLabelText("Prioridade"), { target: { value: "alta" } });
    await submit(screen.getByRole("button", { name: "Salvar" }), actions.updateLeadBasicFieldsAction);
    expect((screen.getByLabelText("Prioridade") as HTMLSelectElement).value).toBe("alta");
  });

  it("ConflictCheckPanel (status e nota)", async () => {
    render(
      <ConflictCheckPanel
        leadId="l1"
        canEdit
        conflictCheck={{ id: null, status: "nao_verificado", note: null, checkedBy: null, checkedAt: null, lockVersion: null }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Status da verificação de conflito"), { target: { value: "sem_conflito" } });
    fireEvent.change(screen.getByPlaceholderText("Nota (opcional)"), { target: { value: "Nenhum vínculo" } });
    await submit(screen.getByRole("button", { name: "Registrar verificação" }), actions.upsertConflictCheckAction);
    expect((screen.getByLabelText("Status da verificação de conflito") as HTMLSelectElement).value).toBe("sem_conflito");
    expect((screen.getByPlaceholderText("Nota (opcional)") as HTMLTextAreaElement).value).toBe("Nenhum vínculo");
  });

  const client = { id: "cl1", status: "ativo", ownerUserId: null, lockVersion: 0 } as never;

  it("ClientStatusForm", async () => {
    render(<ClientStatusForm client={client} />);
    fireEvent.change(screen.getByLabelText("Status do cliente"), { target: { value: "suspenso" } });
    await submit(screen.getByRole("button", { name: "Salvar status" }), actions.updateClientStatusAction);
    expect((screen.getByLabelText("Status do cliente") as HTMLSelectElement).value).toBe("suspenso");
  });

  it("TransferClientOwnerForm", async () => {
    render(<TransferClientOwnerForm client={client} members={members} />);
    fireEvent.change(screen.getByLabelText("Responsável pelo cliente"), { target: { value: "u2" } });
    await submit(screen.getByRole("button", { name: "Transferir" }), actions.transferClientOwnerAction);
    expect((screen.getByLabelText("Responsável pelo cliente") as HTMLSelectElement).value).toBe("u2");
  });

  it("ContactBasicFieldsForm", async () => {
    const contact = {
      id: "c1",
      workspaceId: "w",
      name: "Nome antigo",
      type: "pf",
      city: null,
      uf: null,
      preferredChannel: null,
      createdAt: "2026-09-01",
      phones: [],
      emails: [],
      hasSensitive: false,
    } as never;
    render(<ContactBasicFieldsForm contact={contact} />);
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Nome novo" } });
    fireEvent.change(screen.getByLabelText("Canal preferido"), { target: { value: "email" } });
    await submit(screen.getByRole("button", { name: "Salvar" }), actions.updateContactBasicFieldsAction);
    expect((screen.getByLabelText("Nome") as HTMLInputElement).value).toBe("Nome novo");
    expect((screen.getByLabelText("Canal preferido") as HTMLSelectElement).value).toBe("email");
  });
});
