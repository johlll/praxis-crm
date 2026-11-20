import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Conversas + IA — painel do caso (PR A), renderizado: o que a pessoa vê em cada estado. Cabeçalho do caso,
 * abas, Resumo em cartões, edição só pelo lápis, vários casos sem palpite e foco × vínculo.
 */

const actions = vi.hoisted(() => ({
  setOpportunityCaseProgressAction: vi.fn(),
  setConversationAttendanceAction: vi.fn(),
  setStatusTrackAutomationAction: vi.fn(),
  loadStatusTrackHistoryAction: vi.fn(),
}));
vi.mock("@/modules/status-tracks/actions", () => actions);
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
const OPP_C = "0c000000-0000-4000-8000-00000000000c";
const emptyHistory = { items: [], hasMore: false, next: null };

function state(over: Record<string, unknown>) {
  return {
    track: "attendance",
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

function option(id: string, over: Record<string, unknown> = {}) {
  return {
    opportunityId: id,
    leadId: "1ead0000-0000-4000-8000-000000000001",
    legalArea: "Usucapião",
    leadStatus: "ativo",
    status: "open",
    stageId: "s2",
    stageName: "Qualificar",
    isLinked: false,
    caseProgressStatus: null,
    createdAt: "2026-11-16T12:05:00.000Z",
    caseNumber: null,
    serviceTypeName: null,
    serviceStepName: null,
    serviceStepPosition: null,
    serviceStepsTotal: null,
    serviceStepsCompleted: null,
    ...over,
  };
}


/** Serviço do caso sem número e sem roteiro (o estado de todo caso antigo). */
function noService(o: { opportunityId: string; status: string; caseProgressStatus: string | null }) {
  return {
    opportunityId: o.opportunityId,
    opportunityStatus: o.status,
    applicable: o.status === "won",
    caseNumber: null,
    version: 0,
    status: o.status === "won" ? (o.caseProgressStatus ?? "nao_informado") : null,
    automationPaused: false,
    manualDecidedAt: null,
    plan: null,
    previousPlans: 0,
  };
}

function focusOf(o: ReturnType<typeof option>, over: Record<string, unknown> = {}) {
  return {
    option: o,
    responsible: "Lucas",
    nextAction: null,
    valueLabel: null,
    pipelineName: "Comercial",
    wonAt: o.status === "won" ? "2026-11-17T12:00:00.000Z" : null,
    signedAt: null,
    lostReasonLabel: o.status === "lost" ? "Escolheu outro escritório" : null,
    commercial: { state: state({ track: "commercial_stage", opportunityId: o.opportunityId, status: null }), history: emptyHistory },
    progress:
      o.status === "won"
        ? { state: state({ track: "case_progress", opportunityId: o.opportunityId, status: o.caseProgressStatus ?? "nao_informado" }), history: emptyHistory }
        : null,
    steps:
      o.status === "open"
        ? [
            { id: "s1", name: "Contato", state: "previous" },
            { id: "s2", name: "Qualificar", state: "current" },
            { id: "s3", name: "Proposta", state: "next" },
          ]
        : null,
    stageMoves: [{ id: "m1", occurredAt: "2026-11-17T09:00:00.000Z", fromStageName: "Contato", toStageName: "Qualificar", actorName: "Paula" }],
    pendingActivities: [],
    doneActivities: null,
    service: noService(o),
    serviceHistory: null,
    serviceTypes: null,
    ...over,
  };
}

function ctx(opts: { items: ReturnType<typeof option>[]; focus: ReturnType<typeof focusOf> | null; source?: string | null; linked?: string | null }) {
  return {
    attendance: { state: state({ conversationId: CONV, status: "aguardando_cliente" }), history: emptyHistory },
    cases: {
      conversationId: CONV,
      contactResolved: true,
      linkedOpportunityId: opts.linked ?? null,
      items: opts.items,
      defaultOpportunityId: null,
      defaultSource: null,
    },
    focusId: opts.focus?.option.opportunityId ?? null,
    focusSource: opts.focus ? (opts.source ?? "linked") : null,
    invalidCaseRequested: false,
    focus: opts.focus,
    members: [],
  };
}

const OWNER = { editAttendance: true, editProgress: true, pauseCommercial: true, editActivities: true };
const VIEWER = { editAttendance: false, editProgress: false, pauseCommercial: false, editActivities: false };

function panel(context: ReturnType<typeof ctx>, opts: { aba?: string; editar?: boolean; perms?: typeof OWNER } = {}): ReactElement {
  return (
    <ConversationContextPanel
      conversation={{ id: CONV, contactId: "c1000000-0000-4000-8000-000000000001", contactName: "Maria Santos", waId: "+5541999990101", leadId: "1ead0000-0000-4000-8000-000000000001", legalArea: "Usucapião", needsLinkReview: false }}
      context={context as never}
      contextFailed={false}
      params={{ q: "", status: "all", page: 1, caso: null, sel: null, aba: (opts.aba ?? "resumo") as never, editar: opts.editar ?? false }}
      permissions={opts.perms ?? OWNER}
      draftScope="ws-teste:pessoa-teste"
      evidence={[]}
      consentSlot={<p>consentimento</p>}
    />
  );
}

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  actions.loadStatusTrackHistoryAction.mockResolvedValue({ ok: true, page: emptyHistory });
});
afterEach(cleanup);

describe("cabeçalho do caso e abas", () => {
  it("assunto, abertura, selo com a natureza e lápis; abas Resumo · Tarefas · Histórico (sem Documentos)", () => {
    const a = option(OPP_A, { isLinked: true });
    render(panel(ctx({ items: [a], focus: focusOf(a), linked: OPP_A })));
    expect(screen.getByRole("heading", { name: "Usucapião" })).toBeTruthy();
    expect(screen.getByText("Aberta em 16/11/2026")).toBeTruthy();
    expect(screen.getByTitle("Comercial: Qualificar")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Editar situação e andamento" }).getAttribute("href")).toContain("editar=1");
    const tabs = within(screen.getByRole("navigation", { name: "Seções do caso" })).getAllByRole("link").map((l) => l.textContent);
    expect(tabs).toEqual(["Resumo", "Tarefas", "Histórico"]);
    expect(screen.queryByText(/Documentos/)).toBeNull();
    expect(screen.getByText("Caso vinculado a esta conversa.")).toBeTruthy();
  });

  it("consulta sem formulários: nada de Corrigir, Salvar ou Pausar no Resumo", () => {
    const a = option(OPP_A);
    render(panel(ctx({ items: [a], focus: focusOf(a) })));
    expect(screen.queryByLabelText(/Corrigir/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Salvar|Pausar|Retomar/ })).toBeNull();
    expect(screen.getByRole("region", { name: "Informações do caso" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Andamento comercial" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Próximas ações" })).toBeTruthy();
  });

  it("andamento comercial marca só a etapa atual; nenhuma marca de conclusão", () => {
    const a = option(OPP_A);
    const { container } = render(panel(ctx({ items: [a], focus: focusOf(a) })));
    const steps = screen.getByRole("list", { name: /^Etapas comerciais/ });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(3);
    expect(container.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(container.querySelector('[aria-current="step"]')!.textContent).toContain("Qualificar");
    expect(steps.textContent).not.toMatch(/✓|concluíd/i);
    expect(screen.getByText(/não indicam conclusão/)).toBeTruthy();
  });

  it("serviço ganho sem roteiro: andamento real e aviso honesto, sem protocolo nem sentença", () => {
    const a = option(OPP_A, { status: "won", stageName: "Ganho", caseProgressStatus: "em_analise" });
    render(panel(ctx({ items: [a], focus: focusOf(a), source: "lead" })));
    expect(screen.getByRole("region", { name: "Andamento do serviço" })).toBeTruthy();
    expect(screen.getAllByTitle("Serviço: Em análise").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Este caso não tem roteiro de etapas/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/protocolo|sentença/i);
    expect(screen.getByText(/Único caso do lead desta conversa/)).toBeTruthy();
  });

  it("perdida: selo 'Perdida', motivo, sem andamento", () => {
    const a = option(OPP_A, { status: "lost", stageName: "Negociar" });
    render(panel(ctx({ items: [a], focus: focusOf(a) })));
    expect(screen.getAllByTitle("Oportunidade perdida").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Escolheu outro escritório")).toBeTruthy();
    expect(screen.getByText(/não há andamento de serviço/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: /^Etapas comerciais/ })).toBeNull();
  });
});

describe("vários casos e foco × vínculo", () => {
  it("vários casos sem vínculo: 'N casos', escolha explícita, nenhum andamento do cliente inteiro", () => {
    const items = [option(OPP_A), option(OPP_B, { createdAt: "2026-11-16T17:40:00.000Z" }), option(OPP_C, { createdAt: "2026-11-16T17:40:20.000Z" })];
    render(panel(ctx({ items, focus: null })));
    expect(screen.getByRole("heading", { name: "3 casos deste contato" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Escolha o caso" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: /^Andamento/ })).toBeNull();
    const links = within(screen.getByRole("list", { name: "Casos do contato" })).getAllByRole("link");
    expect(links).toHaveLength(3);
    // identificador real distinto para casos com mesma área e etapa
    const lines = links.map((l) => within(l).getByText(/^Aberta em/).textContent);
    expect(new Set(lines).size).toBe(3);
    expect(links[0]!.getAttribute("href")).toContain(`caso=${OPP_A}`);
  });

  it("foco escolhido diferente do vínculo: aviso e link para o vinculado; seletor marca o vínculo", () => {
    const a = option(OPP_A, { isLinked: true });
    const b = option(OPP_B, { legalArea: "Inventário" });
    render(panel(ctx({ items: [a, b], focus: focusOf(b), source: "url", linked: OPP_A })));
    expect(screen.getByText(/A conversa está vinculada a outro caso/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ver o caso vinculado" }).getAttribute("href")).toContain(`caso=${OPP_A}`);
    fireEvent.click(screen.getByRole("button", { name: /^Trocar caso \(2\)/ }));
    const list = screen.getByRole("list", { name: "Casos deste contato" });
    expect(within(list).getByText("vínculo da conversa")).toBeTruthy();
    expect(list.querySelector('a[aria-current="true"]')!.textContent).toContain("Inventário");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("list", { name: "Casos deste contato" })).toBeNull();
  });
});

describe("edição pelo lápis e permissões", () => {
  it("dono: edição com seções próprias; controles de automação separados e nomeados pela trilha", () => {
    const a = option(OPP_A, { status: "won", stageName: "Ganho", caseProgressStatus: "em_analise" });
    render(panel(ctx({ items: [a], focus: focusOf(a) }), { editar: true }));
    expect(screen.queryByRole("navigation", { name: "Seções do caso" })).toBeNull();
    expect(screen.getByLabelText("Corrigir situação")).toBeTruthy();
    expect(screen.getByLabelText("Corrigir andamento")).toBeTruthy();
    const auto = screen.getByRole("region", { name: "Alterações automáticas de status" });
    expect(within(auto).getByText("Situação do atendimento")).toBeTruthy();
    expect(within(auto).getByText("Andamento do serviço")).toBeTruthy();
    expect(auto.textContent).toMatch(/não pausa nem retoma o bot de atendimento/);
    expect(screen.getByRole("link", { name: "Voltar ao caso" }).getAttribute("href")).not.toContain("editar");
    expect(screen.getByRole("link", { name: "Fechar a edição" })).toBeTruthy();
  });

  it("visualizador: sem lápis; editar=1 não abre controles", () => {
    const a = option(OPP_A);
    const { rerender } = render(panel(ctx({ items: [a], focus: focusOf(a) }), { perms: VIEWER }));
    expect(screen.queryByRole("link", { name: "Editar situação e andamento" })).toBeNull();
    rerender(panel(ctx({ items: [a], focus: focusOf(a) }), { perms: VIEWER, editar: true }));
    expect(screen.queryByLabelText(/Corrigir/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Salvar|Pausar|Retomar/ })).toBeNull();
    expect(screen.getByRole("navigation", { name: "Seções do caso" })).toBeTruthy();
  });

  it("atendimento sem permissão de andamento: lápis para a situação, andamento só leitura", () => {
    const a = option(OPP_A, { status: "won", stageName: "Ganho", caseProgressStatus: "em_analise" });
    render(panel(ctx({ items: [a], focus: focusOf(a) }), { editar: true, perms: { editAttendance: true, editProgress: false, pauseCommercial: true, editActivities: true } }));
    expect(screen.getByLabelText("Corrigir situação")).toBeTruthy();
    expect(screen.queryByLabelText("Corrigir andamento")).toBeNull();
    expect(screen.getByText(/Seu perfil não altera o andamento do caso/)).toBeTruthy();
  });
});

describe("histórico do caso", () => {
  it("cada evento com a origem; movimentação comercial e marcos aparecem uma vez", () => {
    const a = option(OPP_A);
    render(panel(ctx({ items: [a], focus: focusOf(a) }), { aba: "historico" }));
    expect(screen.getAllByText("Etapa comercial alterada")).toHaveLength(1);
    expect(screen.getByText("De “Contato” para “Qualificar”")).toBeTruthy();
    expect(screen.getAllByText("Oportunidade aberta")).toHaveLength(1);
    expect(screen.getAllByText("Etapa comercial").length).toBeGreaterThanOrEqual(1);
  });
});
