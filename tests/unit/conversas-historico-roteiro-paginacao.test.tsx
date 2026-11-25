import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Painel do caso, etapa B — o histórico do roteiro na aba Histórico é paginado NO SERVIDOR: a primeira
 * página vem com a tela e "Mais antigos — roteiro do serviço" busca a próxima pelo cursor (horário + id)
 * até acabar. Mais de 100 eventos, com horários repetidos, percorridos até o fim, sem repetir nem pular;
 * falha ao buscar os antigos (o que já apareceu fica, dá para tentar de novo); troca de caso no meio da busca
 * (a resposta do caso anterior nunca entra no caso novo). Nada disso navega: o rascunho da mensagem, que vive
 * fora do painel, não é tocado (o painel nem chama o roteador).
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
  loadCaseServiceHistoryAction: vi.fn(),
}));
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock("@/modules/status-tracks/actions", () => trackActions);
vi.mock("@/modules/case-service/actions", () => serviceActions);
vi.mock("next/navigation", () => ({ useRouter: () => router }));
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
const PAGE = 50;
const LOAD_MORE = "Mais antigos — roteiro do serviço";
const emptyHistory = { items: [], hasMore: false, next: null };

type Ev = {
  id: string; op: "current_step_set"; planName: string; previousPlanName: null; stepName: null; stepPosition: null;
  currentBeforeName: string; currentAfterName: string; progressFrom: null; progressTo: null; toVersion: number; actorName: string; occurredAt: string;
};

/**
 * `n` eventos do caso, do mais novo ao mais antigo, na ordem do banco (horário desc, id desc). De 10 em 10
 * eles têm EXATAMENTE o mesmo horário (com microssegundos), para o desempate ser só pelo id.
 */
function events(prefix: string, n: number): Ev[] {
  const out: Ev[] = [];
  for (let i = 0; i < n; i++) {
    const group = Math.floor(i / 10);
    const second = String(59 - (group % 60)).padStart(2, "0");
    const minute = String(59 - Math.floor(group / 60)).padStart(2, "0");
    out.push({
      id: `${prefix}${String(n - i).padStart(4, "0")}-0000-4000-8000-000000000000`,
      op: "current_step_set", planName: "Procedimento", previousPlanName: null, stepName: null, stepPosition: null,
      currentBeforeName: `Etapa ${prefix}${n - i - 1}`, currentAfterName: `Etapa ${prefix}${n - i}`,
      progressFrom: null, progressTo: null, toVersion: n - i + 1, actorName: "Ana Souza",
      occurredAt: `2026-11-18T10:${minute}:${second}.123456+00:00`,
    });
  }
  return out;
}

/** Página do servidor a partir do cursor, como a RPC: estritamente depois de (horário, id). */
function serverPage(all: Ev[], cursor: { before: string; beforeId: string } | null) {
  const start = cursor ? all.findIndex((e) => e.occurredAt === cursor.before && e.id === cursor.beforeId) + 1 : 0;
  const items = all.slice(start, start + PAGE);
  const hasMore = start + PAGE < all.length;
  const last = items.at(-1);
  return { items, hasMore, next: hasMore && last ? { before: last.occurredAt, beforeId: last.id } : null };
}

function state(over: Record<string, unknown>) {
  return {
    track: "attendance", conversationId: null, opportunityId: null, applicable: true, hasRecord: false, status: "nao_informado",
    stageId: null, stageName: null, version: 0, automationPaused: false, automationPausedAt: null, automationPausedByName: null,
    manualDecidedAt: null, ...over,
  };
}

function option(id: string, legalArea: string) {
  return {
    opportunityId: id, leadId: "1ead0000-0000-4000-8000-000000000001", legalArea, leadStatus: "ativo", status: "won",
    stageId: "s9", stageName: "Ganho", isLinked: false, caseProgressStatus: "em_analise", createdAt: "2026-11-01T12:05:00.000Z",
    caseNumber: null, serviceTypeName: "Procedimento", serviceStepName: null, serviceStepPosition: null, serviceStepsTotal: 2,
    serviceStepsCompleted: 0,
  };
}

function ctx(id: string, legalArea: string, history: ReturnType<typeof serverPage> | null) {
  const o = option(id, legalArea);
  return {
    attendance: { state: state({ conversationId: CONV }), history: emptyHistory },
    cases: { conversationId: CONV, contactResolved: true, linkedOpportunityId: id, items: [option(OPP_A, "Imobiliário"), option(OPP_B, "Tributário")], defaultOpportunityId: null, defaultSource: null },
    focusId: id, focusSource: "linked", invalidCaseRequested: false, members: [],
    focus: {
      option: o, responsible: "Lucas", nextAction: null, valueLabel: null, pipelineName: "Comercial", wonAt: "2026-11-02T12:00:00.000Z",
      signedAt: null, lostReasonLabel: null,
      commercial: { state: state({ track: "commercial_stage", opportunityId: id, status: null }), history: emptyHistory },
      progress: { state: state({ track: "case_progress", opportunityId: id, status: "em_analise", version: 200 }), history: emptyHistory },
      steps: null, stageMoves: [], pendingActivities: [], doneActivities: null,
      service: {
        opportunityId: id, opportunityStatus: "won", applicable: true, caseNumber: null, version: 200, status: "em_analise",
        automationPaused: false, manualDecidedAt: null, plan: null, previousPlans: 0,
      },
      serviceHistory: history,
      serviceTypes: null,
    },
  };
}

const VIEWER = { editAttendance: false, editProgress: false, pauseCommercial: false, editActivities: false, assignCaseNumber: false, manageServiceCatalog: false };

function panel(context: ReturnType<typeof ctx>): ReactElement {
  return (
    <ConversationContextPanel
      conversation={{ id: CONV, contactId: "c1000000-0000-4000-8000-000000000001", contactName: "Maria Santos", waId: "+5541999990101", leadId: "1ead0000-0000-4000-8000-000000000001", legalArea: "Imobiliário", needsLinkReview: false }}
      context={context as never}
      contextFailed={false}
      params={{ q: "", status: "all", page: 1, caso: context.focusId, sel: null, aba: "historico" as never, editar: false }}
      permissions={VIEWER}
      draftScope="ws-teste:pessoa-teste"
      evidence={[]}
      consentSlot={<p>consentimento</p>}
    />
  );
}

/** Eventos do roteiro visíveis, na ordem da tela (o texto traz a etapa, que identifica o evento). */
function shownServiceEvents(): string[] {
  return screen
    .getAllByRole("listitem")
    .filter((li) => within(li).queryByText("Roteiro do serviço") !== null)
    .map((li) => /Etapa atual: (Etapa \S+)/.exec(li.textContent ?? "")?.[1] ?? "?");
}

beforeEach(() => {
  for (const fn of [...Object.values(trackActions), ...Object.values(serviceActions), ...Object.values(router)]) fn.mockReset();
  trackActions.loadStatusTrackHistoryAction.mockResolvedValue({ ok: true, page: emptyHistory });
});
afterEach(cleanup);

describe("histórico do roteiro paginado no servidor", () => {
  it("130 eventos (horários repetidos): percorre as 3 páginas pelo cursor, na ordem, sem repetir nem pular", async () => {
    const all = events("a", 130);
    serviceActions.loadCaseServiceHistoryAction.mockImplementation(async (input: { opportunityId: string; before: string; beforeId: string }) => ({
      ok: true, page: serverPage(all, { before: input.before, beforeId: input.beforeId }),
    }));
    render(panel(ctx(OPP_A, "Imobiliário", serverPage(all, null))));
    expect(shownServiceEvents()).toHaveLength(PAGE);

    for (let page = 2; page <= 3; page++) {
      fireEvent.click(await screen.findByRole("button", { name: LOAD_MORE }));
      await waitFor(() => expect(shownServiceEvents()).toHaveLength(Math.min(page * PAGE, all.length)));
    }
    expect(screen.queryByRole("button", { name: LOAD_MORE })).toBeNull();

    // Cada página pediu exatamente o cursor do último evento da anterior, sem converter o horário.
    expect(serviceActions.loadCaseServiceHistoryAction.mock.calls.map((c) => c[0])).toEqual([
      { opportunityId: OPP_A, before: all[49]!.occurredAt, beforeId: all[49]!.id },
      { opportunityId: OPP_A, before: all[99]!.occurredAt, beforeId: all[99]!.id },
    ]);
    const shown = shownServiceEvents();
    expect(new Set(shown).size).toBe(130);
    expect(shown).toEqual(all.map((e) => e.currentAfterName));
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("falha ao buscar os antigos: avisa, mantém o que já apareceu e deixa tentar de novo", async () => {
    const all = events("a", 120);
    serviceActions.loadCaseServiceHistoryAction
      .mockResolvedValueOnce({ ok: false, error: "Não foi possível carregar o histórico. Tente de novo." })
      .mockImplementation(async (input: { before: string; beforeId: string }) => ({ ok: true, page: serverPage(all, input) }));
    render(panel(ctx(OPP_A, "Imobiliário", serverPage(all, null))));

    fireEvent.click(await screen.findByRole("button", { name: LOAD_MORE }));
    expect((await screen.findByRole("alert")).textContent).toContain("Não foi possível carregar o histórico. Tente de novo.");
    expect(shownServiceEvents()).toHaveLength(PAGE);

    fireEvent.click(await screen.findByRole("button", { name: LOAD_MORE }));
    await waitFor(() => expect(shownServiceEvents()).toHaveLength(100));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(serviceActions.loadCaseServiceHistoryAction.mock.calls[1]![0]).toEqual(serviceActions.loadCaseServiceHistoryAction.mock.calls[0]![0]);
  });

  it("troca de caso durante a busca: a resposta do caso anterior nunca entra no caso novo", async () => {
    const fromA = events("a", 120);
    const fromB = events("b", 7);
    let resolveA: (v: unknown) => void = () => {};
    serviceActions.loadCaseServiceHistoryAction.mockImplementationOnce(() => new Promise((r) => (resolveA = r)));
    const view = render(panel(ctx(OPP_A, "Imobiliário", serverPage(fromA, null))));
    fireEvent.click(await screen.findByRole("button", { name: LOAD_MORE }));
    await waitFor(() => expect(serviceActions.loadCaseServiceHistoryAction).toHaveBeenCalledTimes(1));

    view.rerender(panel(ctx(OPP_B, "Tributário", serverPage(fromB, null))));
    await act(async () => resolveA({ ok: true, page: serverPage(fromA, { before: fromA[49]!.occurredAt, beforeId: fromA[49]!.id }) }));

    expect(shownServiceEvents()).toEqual(fromB.map((e) => e.currentAfterName));
    expect(screen.queryByRole("button", { name: LOAD_MORE })).toBeNull();
    expect(screen.queryByText(/Etapa atual: Etapa a/)).toBeNull();
  });

  it("depois de uma atualização (nova primeira página do servidor), a lista recomeça dela, sem eventos repetidos", async () => {
    const all = events("a", 120);
    serviceActions.loadCaseServiceHistoryAction.mockImplementation(async (input: { before: string; beforeId: string }) => ({ ok: true, page: serverPage(all, input) }));
    const view = render(panel(ctx(OPP_A, "Imobiliário", serverPage(all, null))));
    fireEvent.click(await screen.findByRole("button", { name: LOAD_MORE }));
    await waitFor(() => expect(shownServiceEvents()).toHaveLength(100));

    // Uma decisão nova no caso (outra aba, ou a própria tela) → o servidor manda a primeira página de novo.
    const newer = [{ ...events("n", 1)[0]!, occurredAt: "2026-11-19T09:00:00.000001+00:00" }, ...all];
    view.rerender(panel(ctx(OPP_A, "Imobiliário", serverPage(newer, null))));
    const shown = shownServiceEvents();
    expect(shown).toHaveLength(PAGE);
    expect(shown[0]).toBe("Etapa n1");
    expect(new Set(shown).size).toBe(shown.length);
  });

  it("caso sem histórico do roteiro: nenhum botão de carregar mais", () => {
    render(panel(ctx(OPP_A, "Imobiliário", emptyHistory)));
    expect(screen.queryByRole("button", { name: LOAD_MORE })).toBeNull();
  });
});
