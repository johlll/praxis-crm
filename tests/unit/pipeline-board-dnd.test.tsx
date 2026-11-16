import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OpportunityCard, PipelineBoardColumn, StageRequirementStatus } from "@/modules/opportunities/queries";

/**
 * Refinamento do pipeline (arrastar e soltar): o movimento — por arraste,
 * teclado ou pelo seletor "Mover" — passa SEMPRE pelo mesmo fluxo de negócio
 * (checkStageRequirementsAction → StageAdvanceDialog se houver pendência →
 * moveOpportunityStageAction com lock_version). Aqui se prova o
 * comportamento do quadro em volta desse fluxo: posição exibida, falha,
 * cancelamento, bloqueio de envio duplicado e papel sem edição. O gesto de
 * arrastar em si (mouse, toque, teclado) é provado em navegador real
 * (tests/e2e/pipeline.spec.ts e conferência local).
 */

const { checkMock, moveMock, refreshMock, pushMock } = vi.hoisted(() => ({
  checkMock: vi.fn(),
  moveMock: vi.fn(),
  refreshMock: vi.fn(),
  pushMock: vi.fn(),
}));

vi.mock("@/modules/opportunities/actions", () => ({
  checkStageRequirementsAction: checkMock,
  moveOpportunityStageAction: moveMock,
  checkWinRequirementsAction: vi.fn(),
  winOpportunityAction: vi.fn(),
  listLostReasonsAction: vi.fn(),
  loseOpportunityAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock, push: pushMock }),
}));

const { PipelineBoard } = await import("@/components/pipeline/pipeline-board");

function card(id: string, name: string, lockVersion = 3): OpportunityCard {
  return {
    id,
    leadId: `lead-${id}`,
    contactName: name,
    legalArea: "Cível",
    assignedTo: null,
    assignedToName: null,
    stageEnteredAt: "2026-11-10T12:00:00Z",
    lockVersion,
    nextAction: null,
    overdueActivitiesCount: 0,
  };
}

function column(stageId: string, stageName: string, position: number, cards: OpportunityCard[]): PipelineBoardColumn {
  return {
    stageId,
    stageName,
    position,
    color: null,
    isWon: false,
    isLost: false,
    count: cards.length,
    avgSecondsInStage: null,
    cards,
  };
}

const columns = (): PipelineBoardColumn[] => [
  column("s1", "Fazer primeiro contato", 0, [card("o1", "Ana Fictícia"), card("o2", "Bruno Fictício")]),
  column("s2", "Qualificar oportunidade", 1, []),
  column("s3", "Agendar consulta", 2, []),
];

function requirement(stageId: string): StageRequirementStatus {
  return {
    requirementId: "r1",
    stageId,
    stageName: "Agendar consulta",
    label: "Conflito verificado",
    fieldType: "checkbox",
    hint: null,
    valueText: null,
    valueBool: null,
    filled: false,
  };
}

const stageSection = (name: string) => screen.getByRole("region", { name: `Etapa ${name}` });
const moveSelect = (name: string) => screen.getByLabelText(`Mover ${name} para etapa`);

beforeEach(() => {
  checkMock.mockReset();
  moveMock.mockReset();
  refreshMock.mockReset();
  pushMock.mockReset();
  checkMock.mockResolvedValue({ ok: true, requirements: [] });
  moveMock.mockResolvedValue({ ok: true, opportunityId: "o1" });
});

describe("pipeline — mudança de etapa no quadro", () => {
  it("move pelo fluxo existente, com a etapa de origem e o lock_version do servidor", async () => {
    render(<PipelineBoard workspaceId="w1" columns={columns()} canEdit />);

    fireEvent.change(moveSelect("Ana Fictícia"), { target: { value: "s2" } });

    await waitFor(() => expect(moveMock).toHaveBeenCalledTimes(1));
    expect(checkMock).toHaveBeenCalledWith("o1", "s2");
    const fd = moveMock.mock.calls[0]![1] as FormData;
    expect(fd.get("opportunityId")).toBe("o1");
    expect(fd.get("fromStageId")).toBe("s1");
    expect(fd.get("toStageId")).toBe("s2");
    expect(fd.get("lockVersion")).toBe("3");
    expect(fd.get("requirementValues")).toBe("[]");
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    // Até o quadro novo chegar, o cartão fica no destino marcado como pendente.
    expect(within(stageSection("Qualificar oportunidade")).getByText("Ana Fictícia")).toBeInTheDocument();
    expect(screen.getByText("Atualizando…")).toBeInTheDocument();
  });

  it("falha do servidor recoloca o cartão na origem e mostra o motivo", async () => {
    moveMock.mockResolvedValue({ ok: false, error: "Outra pessoa alterou esta oportunidade. Recarregue." });
    render(<PipelineBoard workspaceId="w1" columns={columns()} canEdit />);

    fireEvent.change(moveSelect("Ana Fictícia"), { target: { value: "s2" } });

    expect(await screen.findByText("Outra pessoa alterou esta oportunidade. Recarregue.")).toBeInTheDocument();
    expect(within(stageSection("Fazer primeiro contato")).getByText("Ana Fictícia")).toBeInTheDocument();
    expect(within(stageSection("Qualificar oportunidade")).queryByText("Ana Fictícia")).not.toBeInTheDocument();
    expect(refreshMock).toHaveBeenCalled();
  });

  it("sem conseguir conferir requisitos, não move (nada é presumido)", async () => {
    checkMock.mockResolvedValue({ ok: false, error: "Não foi possível carregar os requisitos." });
    render(<PipelineBoard workspaceId="w1" columns={columns()} canEdit />);

    fireEvent.change(moveSelect("Ana Fictícia"), { target: { value: "s2" } });

    expect(await screen.findByText("Não foi possível carregar os requisitos.")).toBeInTheDocument();
    expect(moveMock).not.toHaveBeenCalled();
    expect(within(stageSection("Fazer primeiro contato")).getByText("Ana Fictícia")).toBeInTheDocument();
  });

  it("requisito pendente abre o fluxo existente; cancelar não grava e mantém na origem", async () => {
    checkMock.mockResolvedValue({ ok: true, requirements: [requirement("s3")] });
    render(<PipelineBoard workspaceId="w1" columns={columns()} canEdit />);

    fireEvent.change(moveSelect("Ana Fictícia"), { target: { value: "s3" } });

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Complete os dados necessários para avançar esta oportunidade")).toBeInTheDocument();
    expect(await within(dialog).findByText("Conflito verificado")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(moveMock).not.toHaveBeenCalled();
    expect(within(stageSection("Fazer primeiro contato")).getByText("Ana Fictícia")).toBeInTheDocument();
  });

  it("requisito preenchido e confirmado segue para o mesmo movimento, com os valores", async () => {
    checkMock.mockResolvedValue({ ok: true, requirements: [requirement("s3")] });
    render(<PipelineBoard workspaceId="w1" columns={columns()} canEdit />);

    fireEvent.change(moveSelect("Ana Fictícia"), { target: { value: "s3" } });
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Salvar e avançar" }));

    await waitFor(() => expect(moveMock).toHaveBeenCalledTimes(1));
    const fd = moveMock.mock.calls[0]![1] as FormData;
    expect(JSON.parse(String(fd.get("requirementValues")))).toEqual([{ requirement_id: "r1", value_bool: true }]);
    expect(fd.get("toStageId")).toBe("s3");
  });

  it("um movimento por vez: durante o envio, o resto do quadro fica travado", async () => {
    let release!: (v: { ok: true; opportunityId: string }) => void;
    moveMock.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    render(<PipelineBoard workspaceId="w1" columns={columns()} canEdit />);

    fireEvent.change(moveSelect("Ana Fictícia"), { target: { value: "s2" } });
    await waitFor(() => expect(moveMock).toHaveBeenCalledTimes(1));

    expect(moveSelect("Bruno Fictício")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Arrastar Bruno Fictício" })).toBeDisabled();
    fireEvent.change(moveSelect("Bruno Fictício"), { target: { value: "s3" } });
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(moveMock).toHaveBeenCalledTimes(1);

    await act(async () => release({ ok: true, opportunityId: "o1" }));
  });

  it("dados novos do servidor encerram o movimento e mandam na posição e nos contadores", async () => {
    const { rerender } = render(<PipelineBoard workspaceId="w1" columns={columns()} canEdit />);
    fireEvent.change(moveSelect("Ana Fictícia"), { target: { value: "s2" } });
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());

    const fresh = [
      column("s1", "Fazer primeiro contato", 0, [card("o2", "Bruno Fictício")]),
      column("s2", "Qualificar oportunidade", 1, [card("o1", "Ana Fictícia", 4)]),
      column("s3", "Agendar consulta", 2, []),
    ];
    rerender(<PipelineBoard workspaceId="w1" columns={fresh} canEdit />);

    expect(screen.queryByText("Atualizando…")).not.toBeInTheDocument();
    expect(within(stageSection("Fazer primeiro contato")).getByLabelText("1 oportunidade")).toBeInTheDocument();
    expect(within(stageSection("Qualificar oportunidade")).getByLabelText("1 oportunidade")).toBeInTheDocument();
    expect(moveSelect("Bruno Fictício")).toBeEnabled();
  });

  it("coluna vazia mostra o estado vazio; o seletor oferece só as outras etapas, na ordem do pipeline", () => {
    render(<PipelineBoard workspaceId="w1" columns={columns()} canEdit />);

    expect(within(stageSection("Agendar consulta")).getByText("Nenhuma oportunidade nesta etapa")).toBeInTheDocument();
    const options = within(moveSelect("Ana Fictícia") as HTMLElement)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(["Mover…", "Qualificar oportunidade", "Agendar consulta"]);
  });

  it("clique no cartão abre o detalhe da oportunidade", () => {
    render(<PipelineBoard workspaceId="w1" columns={columns()} canEdit />);

    fireEvent.click(within(stageSection("Fazer primeiro contato")).getAllByTestId("pipeline-card")[0]!);

    expect(pushMock).toHaveBeenCalledWith("/oportunidades/o1");
  });

  it("papel sem edição não tem alça, seletor nem botões de ganho/perda — e ainda abre o detalhe", () => {
    render(<PipelineBoard workspaceId="w1" columns={columns()} canEdit={false} />);

    expect(screen.queryByRole("button", { name: /^Arrastar / })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Mover .* para etapa$/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ganhou" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ana Fictícia" })).toHaveAttribute("href", "/oportunidades/o1");
  });
});
