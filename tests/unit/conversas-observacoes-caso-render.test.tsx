import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Observações por caso, renderizadas: cartão "Observações" no Resumo (recentes com autor e data, anteriores por
 * página do servidor, vazio × falha × carregando distintos, texto longo e HTML como texto), a escrita só pela
 * edição (lápis) dizendo em qual caso, a chave de idempotência por intenção, o aviso antes de descartar um
 * rascunho e o isolamento entre casos (rascunho e gravação em andamento nunca passam para outro caso).
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
const noteActions = vi.hoisted(() => ({ addCaseNoteAction: vi.fn(), loadCaseNotesAction: vi.fn() }));
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock("@/modules/status-tracks/actions", () => trackActions);
vi.mock("@/modules/case-service/actions", () => serviceActions);
vi.mock("@/modules/case-notes/actions", () => noteActions);
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
const emptyHistory = { items: [], hasMore: false, next: null };
type Note = { id: string; opportunityId: string; body: string; authorName: string | null; createdAt: string };

/** `n` observações do caso, da mais recente para a mais antiga (ordem do banco); de 5 em 5 com o MESMO horário. */
function notes(opp: string, prefix: string, n: number): Note[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${String(n - i).padStart(4, "0")}-0000-4000-8000-000000000000`,
    opportunityId: opp,
    body: `Observação ${prefix}${n - i}`,
    authorName: i % 2 ? "Lucas Advogado" : "Ana Souza",
    createdAt: `2026-11-18T10:${String(59 - Math.floor(i / 5)).padStart(2, "0")}:00.123456+00:00`,
  }));
}
function page(all: Note[], cursor: { before: string; beforeId: string } | null, size: number) {
  const start = cursor ? all.findIndex((n) => n.createdAt === cursor.before && n.id === cursor.beforeId) + 1 : 0;
  const items = all.slice(start, start + size);
  const hasMore = start + size < all.length;
  const last = items.at(-1);
  return { items, hasMore, next: hasMore && last ? { before: last.createdAt, beforeId: last.id } : null };
}

function state(over: Record<string, unknown>) {
  return {
    track: "attendance", conversationId: null, opportunityId: null, applicable: true, hasRecord: false, status: "nao_informado",
    stageId: null, stageName: null, version: 0, automationPaused: false, automationPausedAt: null, automationPausedByName: null,
    manualDecidedAt: null, ...over,
  };
}
function option(id: string, legalArea: string, caseNumber: number | null) {
  return {
    opportunityId: id, leadId: "1ead0000-0000-4000-8000-000000000001", legalArea, leadStatus: "ativo", status: "won",
    stageId: "s9", stageName: "Ganho", isLinked: false, caseProgressStatus: "em_analise", createdAt: "2026-11-01T12:05:00.000Z",
    caseNumber, serviceTypeName: null, serviceStepName: null, serviceStepPosition: null, serviceStepsTotal: null, serviceStepsCompleted: null,
  };
}
type NotesView = { status: "ok"; page: ReturnType<typeof page> } | { status: "error" } | { status: "unavailable" } | null;
function ctx(id: string, legalArea: string, caseNumber: number | null, notesView: NotesView) {
  const o = option(id, legalArea, caseNumber);
  return {
    attendance: { state: state({ conversationId: CONV }), history: emptyHistory },
    cases: { conversationId: CONV, contactResolved: true, linkedOpportunityId: id, items: [option(OPP_A, "Imobiliário", 42), option(OPP_B, "Tributário", null)], defaultOpportunityId: null, defaultSource: null },
    focusId: id, focusSource: "url", invalidCaseRequested: false, members: [],
    focus: {
      option: o, responsible: "Lucas", nextAction: null, valueLabel: null, pipelineName: "Comercial", wonAt: "2026-11-02T12:00:00.000Z",
      signedAt: null, lostReasonLabel: null,
      commercial: { state: state({ track: "commercial_stage", opportunityId: id, status: null }), history: emptyHistory },
      progress: { state: state({ track: "case_progress", opportunityId: id, status: "em_analise", version: 3 }), history: emptyHistory },
      steps: null, stageMoves: [], pendingActivities: [], doneActivities: null,
      service: {
        opportunityId: id, opportunityStatus: "won", applicable: true, caseNumber: caseNumber ? { number: caseNumber, assignedVia: "win", assignedAt: "2026-11-02T12:00:00.000Z", assignedByName: null } : null,
        version: 3, status: "em_analise", automationPaused: false, manualDecidedAt: null, plan: null, previousPlans: 0,
      },
      serviceHistory: null, serviceTypes: [], notes: notesView,
    },
  };
}

const OWNER = { editAttendance: true, editProgress: true, pauseCommercial: true, editActivities: true, assignCaseNumber: true, manageServiceCatalog: true, addCaseNote: true };
const SALES = { editAttendance: true, editProgress: false, pauseCommercial: true, editActivities: true, assignCaseNumber: true, manageServiceCatalog: false, addCaseNote: true };
const VIEWER = { editAttendance: false, editProgress: false, pauseCommercial: false, editActivities: false, assignCaseNumber: false, manageServiceCatalog: false, addCaseNote: false };

function panel(context: ReturnType<typeof ctx>, opts: { editar?: boolean; perms?: typeof OWNER } = {}): ReactElement {
  return (
    <ConversationContextPanel
      conversation={{ id: CONV, contactId: "c1000000-0000-4000-8000-000000000001", contactName: "Maria Santos", waId: "+5541999990101", leadId: "1ead0000-0000-4000-8000-000000000001", legalArea: "Imobiliário", needsLinkReview: false }}
      context={context as never}
      contextFailed={false}
      params={{ q: "", status: "all", page: 1, caso: context.focusId, sel: null, aba: "resumo" as never, editar: opts.editar ?? false }}
      permissions={opts.perms ?? OWNER}
      evidence={[]}
      consentSlot={<p>consentimento</p>}
    />
  );
}

const card = () => screen.getByRole("region", { name: "Observações" });
const shown = (root: HTMLElement) =>
  within(root).queryAllByRole("listitem").map((li) => li.querySelector("p")?.textContent ?? "");
const LOAD_MORE = /^(Ver anteriores|Tentar de novo)$/;

beforeEach(() => {
  for (const fn of [...Object.values(trackActions), ...Object.values(serviceActions), ...Object.values(noteActions), ...Object.values(router)]) fn.mockReset();
  trackActions.loadStatusTrackHistoryAction.mockResolvedValue({ ok: true, page: emptyHistory });
});
afterEach(cleanup);

describe("Resumo: cartão Observações (consulta)", () => {
  it("mostra as recentes com autor e data, em ordem; é consulta (sem caixa de texto); 'Escrever' abre a edição", () => {
    const all = notes(OPP_A, "a", 3);
    render(panel(ctx(OPP_A, "Imobiliário", 42, { status: "ok", page: page(all, null, 3) })));
    expect(shown(card())).toEqual(["Observação a3", "Observação a2", "Observação a1"]);
    expect(within(card()).getAllByText(/Ana Souza|Lucas Advogado/)).toHaveLength(3);
    expect(within(card()).getAllByRole("listitem")[0]!.querySelector("time")!.getAttribute("datetime")).toBe(all[0]!.createdAt);
    expect(within(card()).queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Registrar observação/ })).toBeNull();
    expect(within(card()).getByRole("link", { name: "Escrever" }).getAttribute("href")).toMatch(/editar=1.*#observacoes$/);
  });

  it("vazio, falha e indisponível são estados DIFERENTES; falha nunca diz 'nenhuma observação'", () => {
    const { rerender } = render(panel(ctx(OPP_A, "Imobiliário", 42, { status: "ok", page: page([], null, 3) })));
    expect(within(card()).getByText("Nenhuma observação registrada neste caso.")).toBeTruthy();
    expect(within(card()).queryByRole("alert")).toBeNull();
    rerender(panel(ctx(OPP_A, "Imobiliário", 42, { status: "error" })));
    expect(within(card()).getByRole("alert").textContent).toMatch(/Não foi possível carregar as observações deste caso/);
    expect(within(card()).queryByText(/Nenhuma observação/)).toBeNull();
    expect(within(card()).getByRole("button", { name: "Tentar novamente" })).toBeTruthy();
    rerender(panel(ctx(OPP_A, "Imobiliário", 42, { status: "unavailable" })));
    expect(within(card()).queryByText(/Nenhuma observação/)).toBeNull();
    expect(within(card()).getByText(/não estão disponíveis para o seu perfil/)).toBeTruthy();
  });

  it("texto longo e HTML: mostrado como TEXTO, quebras preservadas, sem elemento injetado nem rolagem lateral", () => {
    const evil = { ...notes(OPP_A, "a", 1)[0]!, body: `<script>window.__x=1</script><img src=x onerror="alert(1)">\nlinha 2\n${"palavra".repeat(300)}` };
    render(panel(ctx(OPP_A, "Imobiliário", 42, { status: "ok", page: { items: [evil], hasMore: false, next: null } })));
    const p = within(card()).getByRole("listitem").querySelector("p")!;
    expect(p.textContent).toBe(evil.body);
    expect(card().querySelector("script, img")).toBeNull();
    expect(p.className).toContain("whitespace-pre-wrap");
    expect(p.className).toContain("[overflow-wrap:anywhere]");
  });

  it("anteriores: 23 observações (horários iguais) percorridas pelo servidor, sem repetir nem pular; carregando visível", async () => {
    const all = notes(OPP_A, "a", 23);
    let release: () => void = () => {};
    noteActions.loadCaseNotesAction.mockImplementation(async (input: { before: string; beforeId: string }) => {
      await new Promise<void>((r) => (release = r));
      return { ok: true, page: page(all, input, 10) };
    });
    render(panel(ctx(OPP_A, "Imobiliário", 42, { status: "ok", page: page(all, null, 3) })));
    for (const expected of [13, 23]) {
      fireEvent.click(await within(card()).findByRole("button", { name: LOAD_MORE }));
      expect(within(card()).getByRole("button", { name: "Carregando…" })).toBeTruthy();
      await act(async () => release());
      await waitFor(() => expect(shown(card())).toHaveLength(expected));
    }
    expect(within(card()).queryByRole("button", { name: LOAD_MORE })).toBeNull();
    expect(shown(card())).toEqual(all.map((n) => n.body));
    expect(noteActions.loadCaseNotesAction.mock.calls.map((c) => c[0])).toEqual([
      { opportunityId: OPP_A, before: all[2]!.createdAt, beforeId: all[2]!.id },
      { opportunityId: OPP_A, before: all[12]!.createdAt, beforeId: all[12]!.id },
    ]);
  });

  it("falha ao buscar as anteriores: avisa, mantém as já mostradas e deixa tentar de novo (mesmo cursor)", async () => {
    const all = notes(OPP_A, "a", 8);
    noteActions.loadCaseNotesAction
      .mockResolvedValueOnce({ ok: false, error: "Não foi possível carregar as observações. Tente de novo." })
      .mockImplementation(async (input: { before: string; beforeId: string }) => ({ ok: true, page: page(all, input, 10) }));
    render(panel(ctx(OPP_A, "Imobiliário", 42, { status: "ok", page: page(all, null, 3) })));
    fireEvent.click(within(card()).getByRole("button", { name: "Ver anteriores" }));
    expect((await within(card()).findByRole("alert")).textContent).toMatch(/Tente de novo/);
    expect(shown(card())).toHaveLength(3);
    fireEvent.click(await within(card()).findByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(shown(card())).toHaveLength(8));
    expect(noteActions.loadCaseNotesAction.mock.calls[1]![0]).toEqual(noteActions.loadCaseNotesAction.mock.calls[0]![0]);
  });

  it("troca de caso durante a busca: a resposta do caso anterior nunca entra no caso novo", async () => {
    const fromA = notes(OPP_A, "a", 9);
    const fromB = notes(OPP_B, "b", 2);
    let resolveA: (v: unknown) => void = () => {};
    noteActions.loadCaseNotesAction.mockImplementationOnce(() => new Promise((r) => (resolveA = r)));
    const view = render(panel(ctx(OPP_A, "Imobiliário", 42, { status: "ok", page: page(fromA, null, 3) })));
    fireEvent.click(within(card()).getByRole("button", { name: "Ver anteriores" }));
    view.rerender(panel(ctx(OPP_B, "Tributário", null, { status: "ok", page: page(fromB, null, 3) })));
    await act(async () => resolveA({ ok: true, page: page(fromA, { before: fromA[2]!.createdAt, beforeId: fromA[2]!.id }, 10) }));
    expect(shown(card())).toEqual(["Observação b2", "Observação b1"]);
  });
});

describe("Edição: escrever uma observação", () => {
  it("diz em qual caso será registrada; envia caso, texto normalizado e chave; limpa e confirma", async () => {
    noteActions.addCaseNoteAction.mockResolvedValue({ ok: true, replayed: false, note: { ...notes(OPP_A, "a", 1)[0]!, createdAt: "2026-11-19T13:00:00.000Z" } });
    render(panel(ctx(OPP_A, "Imobiliário", 42, { status: "ok", page: page([], null, 3) }), { editar: true, perms: SALES }));
    const box = screen.getByLabelText(/Nova observação para/);
    expect(screen.getByText("#0042 · Imobiliário")).toBeTruthy();
    fireEvent.change(box, { target: { value: "  Linha 1\r\nLinha 2  " } });
    fireEvent.click(screen.getByRole("button", { name: "Registrar observação" }));
    await waitFor(() => expect(noteActions.addCaseNoteAction).toHaveBeenCalledTimes(1));
    const sent = noteActions.addCaseNoteAction.mock.calls[0]![0] as { opportunityId: string; body: string; idempotencyKey: string };
    expect(sent).toMatchObject({ opportunityId: OPP_A, body: "Linha 1\nLinha 2" });
    expect(sent.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(""));
    expect(screen.getByText(/Observação registrada em/)).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("clique duplo envia uma vez; repetir depois de falha usa a MESMA chave; texto novo, chave nova", async () => {
    let finish: (v: unknown) => void = () => {};
    noteActions.addCaseNoteAction.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    render(panel(ctx(OPP_A, "Imobiliário", 42, { status: "ok", page: page([], null, 3) }), { editar: true }));
    const box = screen.getByLabelText(/Nova observação para/);
    fireEvent.change(box, { target: { value: "Texto" } });
    const btn = screen.getByRole("button", { name: "Registrar observação" });
    fireEvent.click(btn);
    fireEvent.click(screen.getByRole("button", { name: "Registrando…" }));
    expect(noteActions.addCaseNoteAction).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: false, error: "Falha de rede." }));
    expect((await screen.findByRole("alert")).textContent).toBe("Falha de rede.");
    expect((box as HTMLTextAreaElement).value).toBe("Texto");
    noteActions.addCaseNoteAction.mockResolvedValueOnce({ ok: false, error: "De novo." });
    fireEvent.click(screen.getByRole("button", { name: "Registrar observação" }));
    await waitFor(() => expect(noteActions.addCaseNoteAction).toHaveBeenCalledTimes(2));
    const k1 = (noteActions.addCaseNoteAction.mock.calls[0]![0] as { idempotencyKey: string }).idempotencyKey;
    const k2 = (noteActions.addCaseNoteAction.mock.calls[1]![0] as { idempotencyKey: string }).idempotencyKey;
    expect(k2).toBe(k1);
    await screen.findByText("De novo.");
    fireEvent.change(box, { target: { value: "Texto corrigido" } });
    noteActions.addCaseNoteAction.mockResolvedValueOnce({ ok: false, error: "x" });
    fireEvent.click(screen.getByRole("button", { name: "Registrar observação" }));
    await waitFor(() => expect(noteActions.addCaseNoteAction).toHaveBeenCalledTimes(3));
    expect((noteActions.addCaseNoteAction.mock.calls[2]![0] as { idempotencyKey: string }).idempotencyKey).not.toBe(k1);
  });

  it("rascunho não registrado: trocar de caso pede confirmação antes de descartar; nada é enviado", async () => {
    render(panel(ctx(OPP_A, "Imobiliário", 42, { status: "ok", page: page([], null, 3) }), { editar: true }));
    fireEvent.change(screen.getByLabelText(/Nova observação para/), { target: { value: "Rascunho do caso A" } });
    const link = document.createElement("a");
    link.href = `/conversas/${CONV}?caso=${OPP_B}`;
    link.textContent = "Tributário";
    document.body.appendChild(link);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    const dialog = await screen.findByRole("alertdialog", { name: "Observação não registrada" });
    expect(dialog.textContent).toMatch(/#0042 · Imobiliário/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Continuar escrevendo" }));
    expect((screen.getByLabelText(/Nova observação para/) as HTMLTextAreaElement).value).toBe("Rascunho do caso A");
    expect(router.push).not.toHaveBeenCalled();
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Descartar e sair" }));
    expect(router.push).toHaveBeenCalledWith(`/conversas/${CONV}?caso=${OPP_B}`);
    expect(noteActions.addCaseNoteAction).not.toHaveBeenCalled();
    link.remove();
  });

  it("sem rascunho, os links seguem normalmente (nenhum bloqueio)", () => {
    render(panel(ctx(OPP_A, "Imobiliário", 42, { status: "ok", page: page([], null, 3) }), { editar: true }));
    const link = document.createElement("a");
    link.href = `/conversas/${CONV}?caso=${OPP_B}`;
    document.body.appendChild(link);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    link.addEventListener("click", (e) => e.preventDefault());
    link.dispatchEvent(ev);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    link.remove();
  });

  it("troca de caso com gravação em andamento: vai para o caso ORIGINAL; o novo caso começa vazio e sem confirmação herdada", async () => {
    let finish: (v: unknown) => void = () => {};
    noteActions.addCaseNoteAction.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    const view = render(panel(ctx(OPP_A, "Imobiliário", 42, { status: "ok", page: page([], null, 3) }), { editar: true }));
    fireEvent.change(screen.getByLabelText(/Nova observação para/), { target: { value: "Observação do caso A" } });
    fireEvent.click(screen.getByRole("button", { name: "Registrar observação" }));
    view.rerender(panel(ctx(OPP_B, "Tributário", null, { status: "ok", page: page([], null, 3) }), { editar: true }));
    expect(screen.getByText("Tributário", { selector: "span" })).toBeTruthy();
    expect((screen.getByLabelText(/Nova observação para/) as HTMLTextAreaElement).value).toBe("");
    await act(async () => finish({ ok: true, replayed: false, note: { ...notes(OPP_A, "a", 1)[0]!, body: "Observação do caso A" } }));
    expect(noteActions.addCaseNoteAction).toHaveBeenCalledTimes(1);
    expect((noteActions.addCaseNoteAction.mock.calls[0]![0] as { opportunityId: string }).opportunityId).toBe(OPP_A);
    expect(screen.queryByText(/Observação registrada/)).toBeNull();
    expect((screen.getByLabelText(/Nova observação para/) as HTMLTextAreaElement).value).toBe("");
  });

  it("visualizador: lê, não escreve (sem caixa de texto nem lápis para observações)", () => {
    const all = notes(OPP_A, "a", 2);
    render(panel(ctx(OPP_A, "Imobiliário", 42, { status: "ok", page: page(all, null, 3) }), { perms: VIEWER }));
    expect(shown(card())).toHaveLength(2);
    expect(within(card()).queryByRole("link", { name: "Escrever" })).toBeNull();
    cleanup();
    render(panel(ctx(OPP_A, "Imobiliário", 42, { status: "ok", page: page(all, null, 3) }), { perms: VIEWER, editar: true }));
    expect(screen.queryByLabelText(/Nova observação para/)).toBeNull();
  });
});
