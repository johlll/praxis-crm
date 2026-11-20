import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Conversas + IA (PR 2) — isolamento do estado transitório de edição entre casos.
 *
 * O painel mostra um caso por vez e a troca do caso (`?caso=`) é uma navegação de cliente: o Next atualiza a
 * árvore no mesmo lugar, então um componente de cliente SEM identidade própria conserva o estado local de um
 * caso para o outro. Aqui o painel real é renderizado e o caso é trocado com `rerender` (mesma reconciliação).
 * O que se confere é o COMPORTAMENTO: o que a pessoa vê e o que é enviado ao servidor.
 */

const actions = vi.hoisted(() => ({
  setOpportunityCaseProgressAction: vi.fn(),
  setConversationAttendanceAction: vi.fn(),
  setStatusTrackAutomationAction: vi.fn(),
  loadStatusTrackHistoryAction: vi.fn(),
}));
const refresh = vi.hoisted(() => vi.fn());

vi.mock("@/modules/status-tracks/actions", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
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
const MSGS = ["e0000000-0000-4000-8000-000000000001", "e0000000-0000-4000-8000-000000000002", "e0000000-0000-4000-8000-000000000003"];

const emptyHistory = { items: [], hasMore: false, next: null };

function state(over: Record<string, unknown>) {
  return {
    track: "case_progress",
    conversationId: null,
    opportunityId: null,
    applicable: true,
    hasRecord: false,
    status: "nao_informado",
    stageId: null,
    stageName: null,
    version: 0,
    automationPaused: false,
    automationPausedAt: null,
    automationPausedByName: null,
    manualDecidedAt: null,
    ...over,
  };
}

function option(id: string, area: string) {
  return {
    opportunityId: id,
    leadId: `1ead0000-0000-4000-8000-0000000000${id.slice(-2)}`,
    legalArea: area,
    leadStatus: "ativo",
    status: "won" as const,
    stageId: "5a000000-0000-4000-8000-000000000001",
    stageName: "Contrato assinado",
    isLinked: false,
    caseProgressStatus: "nao_informado" as const,
    createdAt: "2026-11-01T12:00:00+00:00",
    caseNumber: null,
    serviceTypeName: null,
    serviceStepName: null,
    serviceStepPosition: null,
    serviceStepsTotal: null,
    serviceStepsCompleted: null,
  };
}

/** Contexto com o caso `focusId` em foco (as duas oportunidades são ganhas e da mesma conversa/contato). */
function context(focusId: string, opts: { version?: number } = {}) {
  const version = opts.version ?? 0;
  const optA = option(OPP_A, "Previdenciário");
  const optB = option(OPP_B, "Tributário");
  const focus = focusId === OPP_A ? optA : optB;
  return {
    attendance: {
      state: state({ track: "attendance", conversationId: CONV, version: 0, status: "nao_informado" }),
      history: emptyHistory,
    },
    cases: {
      conversationId: CONV,
      contactResolved: true,
      linkedOpportunityId: null,
      items: [optA, optB],
      defaultOpportunityId: null,
      defaultSource: null,
    },
    members: [],
    focusId,
    focusSource: "url" as const,
    invalidCaseRequested: false,
    focus: {
      option: focus,
      responsible: null,
      nextAction: null,
      valueLabel: null,
      commercial: { state: state({ track: "commercial_stage", opportunityId: focusId, status: null }), history: emptyHistory },
      progress: { state: state({ track: "case_progress", opportunityId: focusId, version }), history: emptyHistory },
      pipelineName: "Comercial",
      wonAt: "2026-11-02T12:00:00+00:00",
      signedAt: null,
      lostReasonLabel: null,
      steps: null,
      stageMoves: [],
      pendingActivities: [],
      doneActivities: null,
      service: {
        opportunityId: focusId,
        opportunityStatus: "won",
        applicable: true,
        caseNumber: null,
        version,
        status: "nao_informado",
        automationPaused: false,
        manualDecidedAt: null,
        plan: null,
        previousPlans: 0,
      },
      serviceHistory: null,
      serviceTypes: null,
    },
  };
}

function panel(focusId: string, opts: { version?: number } = {}): ReactElement {
  return (
    <ConversationContextPanel
      conversation={{ id: CONV, contactId: "c1000000-0000-4000-8000-000000000001", contactName: "Rita", waId: "+5541999990111", leadId: null, legalArea: null, needsLinkReview: false }}
      context={context(focusId, opts) as never}
      contextFailed={false}
      // Os editores ficam na edição aberta pelo lápis (editar=1), não na consulta.
      params={{ q: "", status: "all", page: 1, caso: focusId, sel: null, aba: "resumo", editar: true }}
      permissions={{ editAttendance: true, editProgress: true, pauseCommercial: true }}
      draftScope="ws-teste:pessoa-teste"
      evidence={MSGS.map((id, i) => ({ id, createdAt: `2026-11-17T1${i}:00:00+00:00`, authorLabel: "Cliente", excerpt: `Mensagem ${i + 1}` }))}
      consentSlot={null}
    />
  );
}

const progressForm = () => screen.getByLabelText("Corrigir andamento").closest("form") as HTMLFormElement;
const attendanceForm = () => screen.getByLabelText("Corrigir situação").closest("form") as HTMLFormElement;
const checkboxes = (form: HTMLElement) => within(form).queryAllByRole("checkbox", { hidden: true }) as HTMLInputElement[];
const salvar = (form: HTMLElement) => within(form).getByRole("button", { name: /^Salvar|^Salvando/ }) as HTMLButtonElement;

function chooseAndPick(form: HTMLFormElement, status: string, evidenceIdx: number[]) {
  fireEvent.change(within(form).getByRole("combobox"), { target: { value: status } });
  const boxes = checkboxes(form);
  for (const i of evidenceIdx) fireEvent.click(boxes[i]!);
}

beforeEach(() => {
  let n = 0;
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` });
  for (const fn of Object.values(actions)) fn.mockReset();
  refresh.mockReset();
  actions.loadStatusTrackHistoryAction.mockResolvedValue({ ok: true, page: emptyHistory });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("trocar o caso em foco não leva o estado de edição do caso anterior", () => {
  it("o andamento escolhido e as evidências marcadas em A não aparecem em B", () => {
    const { rerender } = render(panel(OPP_A));
    chooseAndPick(progressForm(), "em_execucao", [0, 1]);
    expect((within(progressForm()).getByRole("combobox") as HTMLSelectElement).value).toBe("em_execucao");
    expect(checkboxes(progressForm()).filter((c) => c.checked)).toHaveLength(2);

    rerender(panel(OPP_B));

    expect((within(progressForm()).getByRole("combobox") as HTMLSelectElement).value).toBe("");
    expect(checkboxes(progressForm()).filter((c) => c.checked)).toHaveLength(0);
    // sem escolha própria em B não há o que salvar
    expect(salvar(progressForm()).disabled).toBe(true);
  });

  it("o que for salvo em B leva só B: nenhuma evidência nem andamento herdados de A", async () => {
    actions.setOpportunityCaseProgressAction.mockResolvedValue({ ok: true, result: { replayed: false } });
    const { rerender } = render(panel(OPP_A));
    chooseAndPick(progressForm(), "em_analise", [0, 2]);
    rerender(panel(OPP_B));

    // a pessoa escolhe em B e NÃO marca evidência
    fireEvent.change(within(progressForm()).getByRole("combobox"), { target: { value: "suspenso" } });
    await act(async () => {
      fireEvent.click(salvar(progressForm()));
    });

    expect(actions.setOpportunityCaseProgressAction).toHaveBeenCalledTimes(1);
    const sent = actions.setOpportunityCaseProgressAction.mock.calls[0]![0];
    expect(sent.opportunityId).toBe(OPP_B);
    expect(sent.status).toBe("suspenso");
    expect(sent.evidenceMessageIds).toEqual([]);
  });

  it("a chave de idempotência de um pedido de A (resposta perdida) não é reaproveitada em B", async () => {
    // A: o pedido seguiu, mas a resposta voltou como erro — a chave fica guardada para a nova tentativa em A
    actions.setOpportunityCaseProgressAction.mockResolvedValueOnce({ ok: false, error: "Não foi possível salvar." });
    actions.setOpportunityCaseProgressAction.mockResolvedValueOnce({ ok: true, result: { replayed: false } });
    const { rerender } = render(panel(OPP_A));
    fireEvent.change(within(progressForm()).getByRole("combobox"), { target: { value: "em_execucao" } });
    await act(async () => {
      fireEvent.click(salvar(progressForm()));
    });
    const chaveA = actions.setOpportunityCaseProgressAction.mock.calls[0]![0].idempotencyKey as string;
    expect(chaveA).toBeTruthy();

    rerender(panel(OPP_B));
    fireEvent.change(within(progressForm()).getByRole("combobox"), { target: { value: "em_execucao" } });
    await act(async () => {
      fireEvent.click(salvar(progressForm()));
    });

    const pedidoB = actions.setOpportunityCaseProgressAction.mock.calls[1]![0];
    expect(pedidoB.opportunityId).toBe(OPP_B);
    expect(pedidoB.idempotencyKey).not.toBe(chaveA);
  });

  it("erro, aviso de conflito e confirmação de A não aparecem sob o controle de B", async () => {
    actions.setOpportunityCaseProgressAction.mockResolvedValueOnce({ ok: false, error: "Falha em A.", conflict: true });
    actions.setStatusTrackAutomationAction.mockResolvedValue({ ok: true, result: { replayed: false } });
    const { rerender } = render(panel(OPP_A));

    fireEvent.change(within(progressForm()).getByRole("combobox"), { target: { value: "em_execucao" } });
    await act(async () => {
      fireEvent.click(salvar(progressForm()));
    });
    expect(within(progressForm()).getByText(/Este registro mudou enquanto você editava/)).toBeTruthy();

    // pausa do andamento de A: confirmação "Registrado."
    const pausarA = screen.getAllByRole("button", { name: /^Pausar/ }).at(-1)!;
    await act(async () => {
      fireEvent.click(pausarA);
    });
    expect(screen.getAllByText("Registrado.").length).toBeGreaterThan(0);

    rerender(panel(OPP_B));

    expect(screen.queryByText(/Este registro mudou enquanto você editava/)).toBeNull();
    expect(screen.queryByText("Registrado.")).toBeNull();
    expect(screen.queryByText("Falha em A.")).toBeNull();
  });

  it("a pausa pedida em A é enviada para A e a de B, para B (cada controle com o seu alvo)", async () => {
    actions.setStatusTrackAutomationAction.mockResolvedValue({ ok: true, result: { replayed: false } });
    const { rerender } = render(panel(OPP_A));
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /^Pausar/ }).at(-1)!);
    });
    rerender(panel(OPP_B));
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /^Pausar/ }).at(-1)!);
    });
    const alvos = actions.setStatusTrackAutomationAction.mock.calls.map((c) => [c[0].track, c[0].targetId]);
    expect(alvos).toEqual([
      ["case_progress", OPP_A],
      ["case_progress", OPP_B],
    ]);
  });
});

describe("o que NÃO deve ser reiniciado", () => {
  it("salvar ou atualizar o MESMO caso (nova versão) não apaga a confirmação nem o aviso", async () => {
    actions.setOpportunityCaseProgressAction.mockResolvedValue({ ok: true, result: { replayed: false } });
    const { rerender } = render(panel(OPP_A, { version: 0 }));
    fireEvent.change(within(progressForm()).getByRole("combobox"), { target: { value: "em_execucao" } });
    await act(async () => {
      fireEvent.click(salvar(progressForm()));
    });
    expect(within(progressForm()).getByText("Registrado.")).toBeTruthy();

    // depois do router.refresh() o servidor devolve o MESMO alvo com a versão nova
    rerender(panel(OPP_A, { version: 1 }));

    expect(within(progressForm()).getByText("Registrado.")).toBeTruthy();
  });

  it("a situação do atendimento (da conversa) escolhida e ainda não salva continua ao trocar o caso", () => {
    const { rerender } = render(panel(OPP_A));
    fireEvent.change(within(attendanceForm()).getByRole("combobox"), { target: { value: "aguardando_cliente" } });
    rerender(panel(OPP_B));
    expect((within(attendanceForm()).getByRole("combobox") as HTMLSelectElement).value).toBe("aguardando_cliente");
  });

  it("enquanto a situação do atendimento salva, os controles do caso ficam bloqueados (bloqueio compartilhado)", async () => {
    let resolver: (v: unknown) => void = () => {};
    actions.setConversationAttendanceAction.mockReturnValue(new Promise((r) => (resolver = r)));
    const { rerender } = render(panel(OPP_B));
    fireEvent.change(within(attendanceForm()).getByRole("combobox"), { target: { value: "novo" } });
    await act(async () => {
      fireEvent.click(salvar(attendanceForm()));
    });
    await waitFor(() => expect((within(progressForm()).getByRole("combobox") as HTMLSelectElement).disabled).toBe(true));
    // trocar de caso no meio do salvamento mantém o bloqueio: o novo editor também espera
    rerender(panel(OPP_A));
    expect((within(progressForm()).getByRole("combobox") as HTMLSelectElement).disabled).toBe(true);
    await act(async () => {
      resolver({ ok: true, result: { replayed: false } });
    });
    await waitFor(() => expect((within(progressForm()).getByRole("combobox") as HTMLSelectElement).disabled).toBe(false));
  });
});
