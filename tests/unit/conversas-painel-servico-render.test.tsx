import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Painel do caso, etapa B, renderizado: número interno no cabeçalho, cartão "Andamento do serviço" com
 * etapas, etapa atual e conclusões registradas (distintas sem depender de cor), a edição do roteiro pelo
 * lápis e o isolamento do editor ao trocar de caso. Confere o que a pessoa vê e o que é enviado ao servidor.
 */

const trackActions = vi.hoisted(() => ({
  setOpportunityCaseProgressAction: vi.fn(),
  setConversationAttendanceAction: vi.fn(),
  setStatusTrackAutomationAction: vi.fn(),
  loadStatusTrackHistoryAction: vi.fn(),
}));
const serviceActions = vi.hoisted(() => ({
  assignCaseNumberAction: vi.fn(),
  applyCaseServicePlanAction: vi.fn(),
  removeCaseServicePlanAction: vi.fn(),
  completeCaseServiceStepAction: vi.fn(),
  reopenCaseServiceStepAction: vi.fn(),
  setCaseServiceCurrentStepAction: vi.fn(),
  saveServiceTypeAction: vi.fn(),
  setServiceTypeArchivedAction: vi.fn(),
}));
vi.mock("@/modules/status-tracks/actions", () => trackActions);
vi.mock("@/modules/case-service/actions", () => serviceActions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useLinkStatus: () => ({ pending: false }),
}));

const { ConversationContextPanel } = await import("@/components/conversations/conversation-context-panel");

const CONV = "c0000000-0000-4000-8000-000000000001";
const OPP_A = "0a000000-0000-4000-8000-00000000000a";
const OPP_B = "0b000000-0000-4000-8000-00000000000b";
const TYPE = "7e000000-0000-4000-8000-000000000001";
const emptyHistory = { items: [], hasMore: false, next: null };
const step = (id: string, position: number, name: string, done = false) => ({
  id,
  position,
  name,
  completedAt: done ? "2026-11-18T15:00:00.000Z" : null,
  completedByName: done ? "Ana Souza" : null,
});

function state(over: Record<string, unknown>) {
  return {
    track: "attendance", conversationId: null, opportunityId: null, applicable: true, hasRecord: false, status: "nao_informado",
    stageId: null, stageName: null, version: 0, automationPaused: false, automationPausedAt: null, automationPausedByName: null,
    manualDecidedAt: null, ...over,
  };
}

function option(id: string, over: Record<string, unknown> = {}) {
  return {
    opportunityId: id, leadId: "1ead0000-0000-4000-8000-000000000001", legalArea: "Imobiliário", leadStatus: "ativo", status: "won",
    stageId: "s9", stageName: "Ganho", isLinked: false, caseProgressStatus: "em_analise", createdAt: "2026-11-16T12:05:00.000Z",
    caseNumber: null, serviceTypeName: null, serviceStepName: null, serviceStepPosition: null, serviceStepsTotal: null,
    serviceStepsCompleted: null, ...over,
  };
}

type Plan = { steps: ReturnType<typeof step>[]; currentStepId: string | null; hasRecords?: boolean };

function service(id: string, opts: { number?: number | null; plan?: Plan | null; status?: string; version?: number } = {}) {
  return {
    opportunityId: id, opportunityStatus: "won", applicable: true,
    caseNumber: opts.number ? { number: opts.number, assignedVia: "win", assignedAt: "2026-11-17T12:00:00.000Z", assignedByName: null } : null,
    version: opts.version ?? 3, status: opts.status ?? "em_analise", automationPaused: false, manualDecidedAt: null,
    plan: opts.plan
      ? {
          id: `p-${id}`, serviceTypeId: TYPE, serviceTypeName: "Procedimento extrajudicial", serviceTypeVersion: 1, templateName: "Procedimento extrajudicial",
          templateVersion: 1, templateArchived: false, appliedAt: "2026-11-17T12:00:00.000Z", appliedByName: "Ana Souza",
          currentStepId: opts.plan.currentStepId, hasRecords: opts.plan.hasRecords ?? opts.plan.steps.some((s) => s.completedAt), steps: opts.plan.steps,
        }
      : null,
    previousPlans: 0,
  };
}

function ctx(o: ReturnType<typeof option>, svc: ReturnType<typeof service>, items = [o]) {
  return {
    attendance: { state: state({ conversationId: CONV }), history: emptyHistory },
    cases: { conversationId: CONV, contactResolved: true, linkedOpportunityId: o.opportunityId, items, defaultOpportunityId: null, defaultSource: null },
    focusId: o.opportunityId, focusSource: "linked", invalidCaseRequested: false, members: [],
    focus: {
      option: o, responsible: "Lucas", nextAction: null, valueLabel: null, pipelineName: "Comercial", wonAt: "2026-11-17T12:00:00.000Z",
      signedAt: null, lostReasonLabel: null,
      commercial: { state: state({ track: "commercial_stage", opportunityId: o.opportunityId, status: null }), history: emptyHistory },
      progress: { state: state({ track: "case_progress", opportunityId: o.opportunityId, status: svc.status, version: svc.version }), history: emptyHistory },
      steps: null, stageMoves: [], pendingActivities: [], doneActivities: null,
      service: svc, serviceHistory: null,
      serviceTypes: [{ id: TYPE, name: "Consultoria", version: 1, suggestionCode: null, archived: false, steps: [{ position: 1, name: "Recebimento" }, { position: 2, name: "Parecer" }], activeCases: 0 }],
    },
  };
}

const OWNER = { editAttendance: true, editProgress: true, pauseCommercial: true, editActivities: true, assignCaseNumber: true, manageServiceCatalog: true };
const SALES = { editAttendance: true, editProgress: false, pauseCommercial: true, editActivities: true, assignCaseNumber: true, manageServiceCatalog: false };
const VIEWER = { editAttendance: false, editProgress: false, pauseCommercial: false, editActivities: false, assignCaseNumber: false, manageServiceCatalog: false };

function panel(context: ReturnType<typeof ctx>, opts: { editar?: boolean; perms?: typeof OWNER } = {}): ReactElement {
  return (
    <ConversationContextPanel
      conversation={{ id: CONV, contactId: "c1000000-0000-4000-8000-000000000001", contactName: "Maria Santos", waId: "+5541999990101", leadId: "1ead0000-0000-4000-8000-000000000001", legalArea: "Imobiliário", needsLinkReview: false }}
      context={context as never}
      contextFailed={false}
      params={{ q: "", status: "all", page: 1, caso: null, sel: null, aba: "resumo" as never, editar: opts.editar ?? false }}
      permissions={opts.perms ?? OWNER}
      evidence={[]}
      consentSlot={<p>consentimento</p>}
    />
  );
}

const FOUR = [step("s1", 1, "Documentos reunidos", true), step("s2", 2, "Análise documental"), step("s3", 3, "Elaboração do pedido"), step("s4", 4, "Conclusão")];

beforeEach(() => {
  for (const fn of [...Object.values(trackActions), ...Object.values(serviceActions)]) fn.mockReset();
  trackActions.loadStatusTrackHistoryAction.mockResolvedValue({ ok: true, page: emptyHistory });
  for (const fn of Object.values(serviceActions)) fn.mockResolvedValue({ ok: true, result: { replayed: false, version: 4 } });
});
afterEach(cleanup);

describe("cabeçalho e informações", () => {
  it("com número: 'Caso #0042' e, abaixo, tipo de serviço · área; linhas Nº interno e Tipo de serviço", () => {
    const a = option(OPP_A, { caseNumber: 42 });
    render(panel(ctx(a, service(OPP_A, { number: 42, plan: { steps: FOUR, currentStepId: "s3" } }))));
    expect(screen.getByRole("heading", { name: /Caso #0042/ })).toBeTruthy();
    expect(screen.getByText("Procedimento extrajudicial · Imobiliário")).toBeTruthy();
    const info = screen.getByRole("region", { name: "Informações do caso" });
    expect(within(info).getByText("#0042")).toBeTruthy();
    expect(within(info).getByText("Procedimento extrajudicial")).toBeTruthy();
  });
  it("caso antigo: sem número nem roteiro, nada inventado", () => {
    const a = option(OPP_A);
    render(panel(ctx(a, service(OPP_A))));
    expect(screen.getByRole("heading", { name: "Imobiliário" })).toBeTruthy();
    const info = screen.getByRole("region", { name: "Informações do caso" });
    expect(within(info).getByText("Não atribuído")).toBeTruthy();
    expect(within(info).getByText("Sem roteiro aplicado")).toBeTruthy();
    expect(screen.getByText(/Este caso não tem roteiro de etapas/)).toBeTruthy();
    expect(screen.queryByText(/#\d{4}/)).toBeNull();
  });
});

describe("cartão Andamento do serviço", () => {
  it("até 4 etapas: faixa horizontal; concluída, atual e pendente distintas por marca e texto, não só cor", () => {
    render(panel(ctx(option(OPP_A), service(OPP_A, { plan: { steps: FOUR, currentStepId: "s3" } }))));
    const list = screen.getByRole("list", { name: "Etapas do roteiro Procedimento extrajudicial" });
    expect(list.className).toContain("grid");
    const items = within(list).getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("(concluída — Concluída em 18/11/2026 por Ana Souza)");
    expect(items[1]!.textContent).toContain("(pendente)");
    expect(items[2]!.getAttribute("aria-current")).toBe("step");
    expect(items[2]!.textContent).toContain("atual");
    expect(items[3]!.textContent).toContain("(pendente)");
    // A etapa 2, antes da atual, NÃO aparece como concluída.
    expect(items[1]!.querySelector("svg")).toBeNull();
    expect(items[0]!.querySelector("svg")).not.toBeNull();
    expect(screen.getByText("1 de 4 etapas concluídas")).toBeTruthy();
  });
  it("mais de 4 etapas: lista vertical legível, com quem concluiu e quando", () => {
    const six = [...FOUR, step("s5", 5, "Registro"), step("s6", 6, "Entrega")];
    render(panel(ctx(option(OPP_A), service(OPP_A, { plan: { steps: six, currentStepId: "s2" } }))));
    const list = screen.getByRole("list", { name: "Etapas do roteiro Procedimento extrajudicial" });
    expect(list.className).toContain("flex-col");
    expect(within(list).getByText("Concluída em 18/11/2026 por Ana Souza")).toBeTruthy();
  });
  it("o Resumo continua sem formulário: nenhum botão de concluir, reabrir ou aplicar na consulta", () => {
    render(panel(ctx(option(OPP_A), service(OPP_A, { plan: { steps: FOUR, currentStepId: "s3" } }))));
    expect(screen.queryByRole("button", { name: /Concluir|Reabrir|Aplicar|Tornar atual/ })).toBeNull();
  });
});

describe("edição pelo lápis", () => {
  it("concluir a etapa atual envia a etapa, a versão e a próxima etapa atual escolhida (sugestão: a próxima pendente)", async () => {
    render(panel(ctx(option(OPP_A), service(OPP_A, { plan: { steps: FOUR, currentStepId: "s2" }, version: 7 })), { editar: true }));
    fireEvent.click(screen.getByRole("button", { name: "Concluir “Análise documental”" }));
    await waitFor(() => expect(serviceActions.completeCaseServiceStepAction).toHaveBeenCalledTimes(1));
    expect(serviceActions.completeCaseServiceStepAction.mock.calls[0]![0]).toMatchObject({
      opportunityId: OPP_A, stepId: "s2", expectedVersion: 7, nextCurrentStepId: "s3",
    });
  });
  it("escolher 'Nenhuma' como próxima etapa não inventa avanço", async () => {
    render(panel(ctx(option(OPP_A), service(OPP_A, { plan: { steps: FOUR, currentStepId: "s2" } })), { editar: true }));
    fireEvent.change(screen.getByLabelText("Depois de concluir, etapa atual"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Concluir “Análise documental”" }));
    await waitFor(() => expect(serviceActions.completeCaseServiceStepAction).toHaveBeenCalledTimes(1));
    expect(serviceActions.completeCaseServiceStepAction.mock.calls[0]![0]).toMatchObject({ nextCurrentStepId: null });
  });
  it("serviço concluído: reabrir exige escolher o novo andamento antes de confirmar", async () => {
    const done = FOUR.map((s) => ({ ...s, completedAt: "2026-11-18T15:00:00.000Z", completedByName: "Ana Souza" }));
    render(panel(ctx(option(OPP_A, { caseProgressStatus: "concluido" }), service(OPP_A, { plan: { steps: done, currentStepId: null }, status: "concluido" })), { editar: true }));
    fireEvent.click(screen.getByRole("button", { name: "Reabrir “Análise documental”" }));
    const confirm = screen.getByRole("button", { name: "Confirmar reabertura" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("O serviço está concluído. Novo andamento"), { target: { value: "em_execucao" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(serviceActions.reopenCaseServiceStepAction).toHaveBeenCalledTimes(1));
    expect(serviceActions.reopenCaseServiceStepAction.mock.calls[0]![0]).toMatchObject({ stepId: "s2", makeCurrent: true, progressStatus: "em_execucao" });
  });
  it("trocar um roteiro com conclusões exige a confirmação explícita de que elas ficam no histórico", async () => {
    render(panel(ctx(option(OPP_A), service(OPP_A, { plan: { steps: FOUR, currentStepId: "s2" } })), { editar: true }));
    fireEvent.click(screen.getByRole("button", { name: "Trocar roteiro" }));
    const group = screen.getByRole("group", { name: "Trocar roteiro" });
    fireEvent.change(within(group).getByLabelText("Tipo de serviço"), { target: { value: TYPE } });
    const confirm = within(group).getByRole("button", { name: "Confirmar troca" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(group).getByRole("checkbox"));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(serviceActions.applyCaseServicePlanAction).toHaveBeenCalledTimes(1));
    expect(serviceActions.applyCaseServicePlanAction.mock.calls[0]).toEqual([
      expect.objectContaining({ serviceTypeId: TYPE, acknowledgeRecords: true }),
      "replace",
    ]);
  });
  it("sem roteiro: aplicar é escolha explícita do tipo e da etapa atual inicial (ou nenhuma)", async () => {
    render(panel(ctx(option(OPP_A), service(OPP_A)), { editar: true }));
    const apply = screen.getByRole("button", { name: "Aplicar roteiro" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Tipo de serviço"), { target: { value: TYPE } });
    fireEvent.click(apply);
    await waitFor(() => expect(serviceActions.applyCaseServicePlanAction).toHaveBeenCalledTimes(1));
    expect(serviceActions.applyCaseServicePlanAction.mock.calls[0]).toEqual([expect.objectContaining({ currentStepPosition: null }), "apply"]);
  });
  it("número interno: atribuição só com confirmação; atendimento atribui, mas não altera o roteiro", async () => {
    render(panel(ctx(option(OPP_A), service(OPP_A, { plan: { steps: FOUR, currentStepId: "s2" } })), { editar: true, perms: SALES }));
    expect(screen.getByText("Seu perfil não altera o roteiro do serviço.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Atribuir número interno" }));
    expect(serviceActions.assignCaseNumberAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(serviceActions.assignCaseNumberAction).toHaveBeenCalledWith({ opportunityId: OPP_A }));
  });
  it("visualizador: sem lápis e editar=1 não abre controle nenhum", () => {
    render(panel(ctx(option(OPP_A), service(OPP_A, { plan: { steps: FOUR, currentStepId: "s2" } })), { editar: true, perms: VIEWER }));
    expect(screen.queryByRole("link", { name: "Editar situação e andamento" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Concluir|Reabrir|Atribuir/ })).toBeNull();
  });
});

describe("trocar de caso durante a edição", () => {
  it("a confirmação, as escolhas e a chave do caso A não passam para o caso B", async () => {
    const a = option(OPP_A);
    const b = option(OPP_B, { legalArea: "Família" });
    const view = render(panel(ctx(a, service(OPP_A, { plan: { steps: FOUR, currentStepId: "s2" } }), [a, b]), { editar: true }));
    // Em A: abre a reabertura e uma troca de roteiro, e pede uma conclusão cuja resposta "se perde".
    fireEvent.click(screen.getByRole("button", { name: "Reabrir “Documentos reunidos”" }));
    expect(screen.getByRole("button", { name: "Confirmar reabertura" })).toBeTruthy();
    serviceActions.completeCaseServiceStepAction.mockResolvedValueOnce({ ok: false, error: "Falha de rede." });
    fireEvent.click(screen.getByRole("button", { name: "Concluir “Análise documental”" }));
    await waitFor(() => expect(screen.getByText("Falha de rede.")).toBeTruthy());
    const keyA = serviceActions.completeCaseServiceStepAction.mock.calls[0]![0].idempotencyKey as string;

    const stepsB = [step("b1", 1, "Recebimento"), step("b2", 2, "Parecer")];
    view.rerender(panel(ctx(b, service(OPP_B, { plan: { steps: stepsB, currentStepId: "b1" } }), [a, b]), { editar: true }));
    expect(screen.queryByRole("button", { name: "Confirmar reabertura" })).toBeNull();
    expect(screen.queryByText("Falha de rede.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Concluir “Recebimento”" }));
    await waitFor(() => expect(serviceActions.completeCaseServiceStepAction).toHaveBeenCalledTimes(2));
    const callB = serviceActions.completeCaseServiceStepAction.mock.calls[1]![0];
    expect(callB).toMatchObject({ opportunityId: OPP_B, stepId: "b1", nextCurrentStepId: "b2" });
    expect(callB.idempotencyKey).not.toBe(keyA);
  });
});
