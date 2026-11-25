import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Documentos por caso — a aba renderizada: estados (falha, sem alcance, sem caso, vazio), recebimento fechado até
 * a ativação do backup, papéis, nome como TEXTO, remoção pendente, propostas em seção separada, e o envio em duas
 * fases com promessas controladas: troca de caso no meio do envio não mistura resultado; falha de rede mantém a
 * mesma chave na nova tentativa.
 */

const docActions = vi.hoisted(() => ({
  beginCaseDocumentUploadAction: vi.fn(),
  finalizeCaseDocumentUploadAction: vi.fn(),
  abandonCaseDocumentUploadAction: vi.fn(),
  reviewCaseDocumentAction: vi.fn(),
  removeCaseDocumentAction: vi.fn(),
}));
const storage = vi.hoisted(() => ({ uploadToSignedUrl: vi.fn() }));
const router = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("@/modules/case-documents/actions", () => docActions);
vi.mock("@/lib/supabase/browser", () => ({
  createBrowserSupabaseClient: () => ({ storage: { from: () => ({ uploadToSignedUrl: storage.uploadToSignedUrl }) } }),
}));
vi.mock("@/modules/status-tracks/actions", () => ({
  setOpportunityCaseProgressAction: vi.fn(),
  setConversationAttendanceAction: vi.fn(),
  setStatusTrackAutomationAction: vi.fn(),
  loadStatusTrackHistoryAction: vi.fn(),
}));
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
const { CaseDocumentUploader } = await import("@/components/conversations/context/case-documents");

const CONV = "c0000000-0000-4000-8000-000000000001";
const OPP_A = "0a000000-0000-4000-8000-00000000000a";
const OPP_B = "0b000000-0000-4000-8000-00000000000b";
const emptyHistory = { items: [], hasMore: false, next: null };

function state(over: Record<string, unknown>) {
  return {
    track: "attendance", conversationId: null, opportunityId: null, applicable: true, hasRecord: false, status: "nao_informado",
    stageId: null, stageName: null, version: 0, automationPaused: false, automationPausedAt: null, automationPausedByName: null,
    manualDecidedAt: null, ...over,
  };
}
function option(id: string, over: Record<string, unknown> = {}) {
  return {
    opportunityId: id, leadId: "1ead0000-0000-4000-8000-000000000001", legalArea: "Usucapião", leadStatus: "ativo", status: "open",
    stageId: "s2", stageName: "Qualificar", isLinked: false, caseProgressStatus: null, createdAt: "2026-11-16T12:05:00.000Z",
    caseNumber: null, serviceTypeName: null, serviceStepName: null, serviceStepPosition: null, serviceStepsTotal: null,
    serviceStepsCompleted: null, ...over,
  };
}
function doc(id: string, over: Record<string, unknown> = {}) {
  return {
    id, opportunityId: OPP_A, status: "ready", name: "matrícula.pdf", contentType: "application/pdf", byteSize: 2048,
    uploadedByName: "Bruno", uploadedAt: "2026-11-20T13:00:00.000Z", reviewStatus: "recebido", reviewNote: null,
    reviewedByName: null, reviewedAt: null, reviewVersion: 0, removalRequestedAt: null, ...over,
  };
}
type DocsView = Record<string, unknown> | null;
function focusOf(o: ReturnType<typeof option>, documents: DocsView) {
  return {
    option: o, responsible: "Lucas", nextAction: null, valueLabel: null, pipelineName: "Comercial", wonAt: null, signedAt: null,
    lostReasonLabel: null,
    commercial: { state: state({ track: "commercial_stage", opportunityId: o.opportunityId, status: null }), history: emptyHistory },
    progress: null, steps: null, stageMoves: [], pendingActivities: [], doneActivities: null,
    service: { opportunityId: o.opportunityId, opportunityStatus: o.status, applicable: false, caseNumber: null, version: 0, status: null, automationPaused: false, manualDecidedAt: null, plan: null, previousPlans: 0 },
    serviceHistory: null, serviceTypes: null, notes: null, documents,
  };
}
function ctx(items: ReturnType<typeof option>[], focus: ReturnType<typeof focusOf> | null) {
  return {
    attendance: { state: state({ conversationId: CONV, status: "aguardando_cliente" }), history: emptyHistory },
    cases: { conversationId: CONV, contactResolved: true, linkedOpportunityId: null, items, defaultOpportunityId: null, defaultSource: null },
    focusId: focus?.option.opportunityId ?? null, focusSource: focus ? "url" : null, invalidCaseRequested: false, focus, members: [],
  };
}
const okView = (items: unknown[] = [], over: Record<string, unknown> = {}) => ({
  status: "ok", items, uploadGateOpen: true, proposals: { status: "ok", items: [] }, ...over,
});

const OWNER = { editAttendance: true, editProgress: true, pauseCommercial: true, uploadDocuments: true, reviewDocuments: true, removeDocuments: true, documentsUploadServerEnabled: true };
const SALES = { editAttendance: true, editProgress: false, pauseCommercial: true, uploadDocuments: true, reviewDocuments: false, removeDocuments: false, documentsUploadServerEnabled: true };
const VIEWER = { editAttendance: false, editProgress: false, pauseCommercial: false };

function panel(context: ReturnType<typeof ctx>, perms: Record<string, unknown> = OWNER): ReactElement {
  return (
    <ConversationContextPanel
      conversation={{ id: CONV, contactId: "c1000000-0000-4000-8000-000000000001", contactName: "Maria Santos", waId: "+5541999990101", leadId: "1ead0000-0000-4000-8000-000000000001", legalArea: "Usucapião", needsLinkReview: false }}
      context={context as never}
      contextFailed={false}
      params={{ q: "", status: "all", page: 1, caso: null, sel: null, aba: "documentos" as never, editar: false }}
      permissions={perms as never}
      draftScope="ws:pessoa"
      evidence={[]}
      consentSlot={<p>consentimento</p>}
    />
  );
}
const one = (view: DocsView, perms: Record<string, unknown> = OWNER) => {
  const a = option(OPP_A);
  return render(panel(ctx([a], focusOf(a, view)), perms));
};

beforeEach(() => {
  for (const f of [...Object.values(docActions), storage.uploadToSignedUrl, router.refresh]) f.mockReset();
  docActions.abandonCaseDocumentUploadAction.mockResolvedValue({ ok: true, outcome: "abandoned" });
  vi.stubGlobal("crypto", { ...globalThis.crypto, randomUUID: vi.fn(() => "f0000000-0000-4000-8000-000000000001") });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("aba Documentos: lugar e estados", () => {
  it("é a terceira aba, entre Tarefas e Histórico, e fica ativa", () => {
    one(okView());
    const nav = screen.getByRole("navigation", { name: "Seções do caso" });
    const tabs = within(nav).getAllByRole("link");
    expect(tabs.map((t) => t.textContent)).toEqual(["Resumo", "Tarefas", "Documentos", "Histórico"]);
    expect(tabs[2]!.getAttribute("aria-current")).toBe("page");
  });
  it("vazio: diz que não há documento (e mostra a seção de propostas à parte)", () => {
    one(okView());
    expect(screen.getByText("Nenhum documento recebido neste caso.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Propostas geradas pelo Praxis" })).toBeTruthy();
    expect(screen.getByText("Nenhuma proposta com PDF gerado neste caso.")).toBeTruthy();
  });
  it("falha de leitura: aviso com nova tentativa, nunca \"nenhum documento\"", () => {
    one({ status: "error" });
    expect(screen.getByRole("alert").textContent).toMatch(/Não foi possível carregar os documentos deste caso/);
    expect(screen.queryByText("Nenhum documento recebido neste caso.")).toBeNull();
  });
  it("sem alcance: diz que não tem acesso", () => {
    one({ status: "unavailable" });
    expect(screen.getByText("Você não tem acesso aos documentos deste caso.")).toBeTruthy();
  });
  it("vários casos e nenhum em foco: pede a escolha, sem misturar documentos", () => {
    render(panel(ctx([option(OPP_A), option(OPP_B)], null)));
    expect(screen.queryByText("Nenhum documento recebido neste caso.")).toBeNull();
    expect(screen.queryByRole("region", { name: "Documentos recebidos" })).toBeNull();
    expect(screen.getAllByRole("link").some((l) => l.getAttribute("href")?.includes(`caso=${OPP_B}`))).toBe(true);
  });
});

describe("recebimento fechado até a ativação do backup", () => {
  it("portão do banco fechado: aviso claro e nenhum botão de anexar (nem para o owner)", () => {
    one(okView([], { uploadGateOpen: false }));
    expect(screen.getByRole("note").textContent).toMatch(/aguarda a ativação do backup dos arquivos/);
    expect(screen.queryByRole("button", { name: /Escolher arquivo/ })).toBeNull();
  });
  it("trava do servidor fechada (variável ausente): o mesmo aviso", () => {
    one(okView(), { ...OWNER, documentsUploadServerEnabled: false });
    expect(screen.getByRole("note").textContent).toMatch(/aguarda a ativação do backup/);
    expect(screen.queryByRole("button", { name: /Escolher arquivo/ })).toBeNull();
  });
  it("as duas abertas: aparece o envio, dizendo em qual caso o arquivo entra", () => {
    one(okView());
    expect(screen.getByRole("button", { name: /Escolher arquivo/ })).toBeTruthy();
    expect(screen.getByText(/Anexar documento a/).textContent).toMatch(/Usucapião/);
  });
  it("visualizador: só consulta", () => {
    one(okView([doc("d1")]), VIEWER);
    expect(screen.getByRole("note").textContent).toMatch(/Seu perfil só consulta/);
    expect(screen.queryByRole("button", { name: "Registrar conferência" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remover/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Abrir/ }).getAttribute("href")).toBe("/api/case-documents/d1?modo=abrir");
  });
  it("contato anonimizado: só consulta, com o motivo", () => {
    one(okView(), { ...OWNER, contactAnonymized: true, uploadDocuments: false });
    expect(screen.getByRole("note").textContent).toMatch(/anonimizado/);
  });
});

describe("lista", () => {
  it("nome, tipo, tamanho, autor, data e situação; o nome é TEXTO (HTML não vira elemento)", () => {
    const { container } = one(okView([doc("d1", { name: "<img src=x onerror=alert(1)>.pdf" })]));
    expect(screen.getByText("<img src=x onerror=alert(1)>.pdf")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/PDF · 2 KB · enviado por Bruno em/)).toBeTruthy();
    expect(screen.getByText("Recebido")).toBeTruthy();
  });
  it("conferido e com pendência mostram quem, quando e a observação", () => {
    one(okView([
      doc("d1", { reviewStatus: "conferido", reviewedByName: "Carla", reviewedAt: "2026-11-21T10:00:00Z", reviewVersion: 1 }),
      doc("d2", { reviewStatus: "com_pendencia", reviewedByName: "Daniel", reviewedAt: "2026-11-21T11:00:00Z", reviewNote: "Falta a página 2", reviewVersion: 1 }),
    ]));
    expect(screen.getByText(/Conferido por Carla em/)).toBeTruthy();
    expect(screen.getByText(/Pendência registrada por Daniel em/)).toBeTruthy();
    expect(screen.getByText("Falta a página 2")).toBeTruthy();
  });
  it("sales envia mas não confere nem remove", () => {
    one(okView([doc("d1")]), SALES);
    expect(screen.getByRole("button", { name: /Escolher arquivo/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Registrar conferência" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remover/ })).toBeNull();
  });
  it("remoção pendente: não abre e explica que a exclusão ainda não se completou", () => {
    one(okView([doc("d1", { status: "removing", removalRequestedAt: "2026-11-21T12:00:00Z" })]));
    expect(screen.queryByRole("link", { name: /Abrir/ })).toBeNull();
    expect(screen.getByText(/Remoção pendente: o arquivo ainda não saiu do armazenamento/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Concluir a remoção" })).toBeTruthy();
  });
  it("propostas em seção separada; baixar só para quem pode", () => {
    one(okView([], { proposals: { status: "ok", items: [
      { documentId: "p1", proposalNumber: "PROP-2026-0003", version: 2, generatedAt: "2026-11-19T10:00:00Z", canDownload: true },
      { documentId: "p2", proposalNumber: "PROP-2026-0004", version: 1, generatedAt: "2026-11-18T10:00:00Z", canDownload: false },
    ] } }));
    const sec = screen.getByRole("region", { name: "Propostas geradas pelo Praxis" });
    expect(within(sec).getByRole("link", { name: "Baixar PDF" }).getAttribute("href")).toBe("/api/proposals/documents/p1/download");
    expect(within(sec).getByText(/Seu perfil não baixa o PDF da proposta/)).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Documentos recebidos" })).queryByText(/PROP-2026/)).toBeNull();
  });
});

describe("conferência", () => {
  it("pendência sem observação não é aceita na tela; conflito avisa e atualiza sem sobrescrever", async () => {
    one(okView([doc("d1")]));
    fireEvent.click(screen.getByRole("button", { name: "Registrar conferência" }));
    fireEvent.click(screen.getByLabelText("Com pendência"));
    docActions.reviewCaseDocumentAction.mockResolvedValue({ ok: false, error: "Outra pessoa registrou a conferência deste documento antes. Veja a situação atual e decida de novo.", conflict: true });
    fireEvent.change(screen.getByLabelText(/O que está pendente/), { target: { value: "Falta a página 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Registrar" }));
    expect(await screen.findByText(/Outra pessoa registrou a conferência/)).toBeTruthy();
    expect(docActions.reviewCaseDocumentAction).toHaveBeenCalledWith({ documentId: "d1", status: "com_pendencia", note: "Falta a página 2", expectedVersion: 0 });
    expect(router.refresh).toHaveBeenCalled();
  });
});

describe("envio em duas fases (promessas controladas)", () => {
  const file = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "contrato.pdf", { type: "application/pdf" });
  const pick = (f: File) => {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [f] } });
  };

  it("reserva → sobe direto ao Storage → confere; a tela mostra cada fase e o resultado", async () => {
    let releaseBegin!: (v: unknown) => void;
    docActions.beginCaseDocumentUploadAction.mockImplementation(() => new Promise((r) => (releaseBegin = r)));
    storage.uploadToSignedUrl.mockResolvedValue({ data: {}, error: null });
    docActions.finalizeCaseDocumentUploadAction.mockResolvedValue({ ok: true, document: { name: "contrato.pdf" }, replayed: false });
    render(<CaseDocumentUploader opportunityId={OPP_A} caseLabel="Caso A" />);
    pick(file());
    expect(screen.getByRole("status").textContent).toMatch(/Preparando o envio/);
    expect(screen.getByRole("button", { name: /Escolher arquivo/ }).hasAttribute("disabled")).toBe(true);
    await act(async () => releaseBegin({ ok: true, documentId: "d9", path: `w/${OPP_A}/d9`, token: "tok", alreadyReady: null }));
    expect(await screen.findByText(/Documento recebido/)).toBeTruthy();
    expect(storage.uploadToSignedUrl).toHaveBeenCalledWith(`w/${OPP_A}/d9`, "tok", expect.any(File), { contentType: "application/pdf", upsert: false });
    expect(docActions.finalizeCaseDocumentUploadAction).toHaveBeenCalledWith({ documentId: "d9", declaredType: "application/pdf" });
    expect(router.refresh).toHaveBeenCalled();
  });

  it("arquivo recusado na tela (formato): nenhuma chamada ao servidor", () => {
    render(<CaseDocumentUploader opportunityId={OPP_A} caseLabel="Caso A" />);
    pick(new File(["x"], "planilha.xlsx", { type: "application/vnd.ms-excel" }));
    expect(screen.getByRole("alert").textContent).toMatch(/Formato não aceito/);
    expect(docActions.beginCaseDocumentUploadAction).not.toHaveBeenCalled();
  });

  it("falha ao subir: cancela a reserva (nada guardado, confirmado) e oferece nova tentativa", async () => {
    docActions.beginCaseDocumentUploadAction.mockResolvedValue({ ok: true, documentId: "d9", path: "p", token: "tok", alreadyReady: null });
    storage.uploadToSignedUrl.mockResolvedValue({ data: null, error: { message: "network error", statusCode: "500" } });
    render(<CaseDocumentUploader opportunityId={OPP_A} caseLabel="Caso A" />);
    pick(file());
    expect(await screen.findByText("O envio do arquivo não foi concluído. Nada foi guardado; tente de novo.")).toBeTruthy();
    expect(docActions.abandonCaseDocumentUploadAction).toHaveBeenCalledWith({ documentId: "d9", reason: "upload_interrupted" });
    expect(docActions.finalizeCaseDocumentUploadAction).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
  });

  it.each([
    [{ ok: true, outcome: "cleanup_pending" }, /registrada para a limpeza/],
    [{ ok: true, outcome: "already_absent" }, /não ficou visível no caso/],
    [{ ok: false, error: "x", concluded: false }, /não foi possível confirmar a exclusão/],
    [null, /não foi possível confirmar a exclusão/],
  ])("falha ao subir sem confirmação do descarte (%j): não diz “Nada foi guardado”", async (result, text) => {
    docActions.beginCaseDocumentUploadAction.mockResolvedValue({ ok: true, documentId: "d9", path: "p", token: "tok", alreadyReady: null });
    storage.uploadToSignedUrl.mockResolvedValue({ data: null, error: { message: "network error", statusCode: "500" } });
    if (result === null) docActions.abandonCaseDocumentUploadAction.mockRejectedValue(new Error("fetch failed"));
    else docActions.abandonCaseDocumentUploadAction.mockResolvedValue(result);
    render(<CaseDocumentUploader opportunityId={OPP_A} caseLabel="Caso A" />);
    pick(file());
    const alert = await screen.findByText(text);
    expect(alert.textContent).not.toMatch(/Nada foi guardado/);
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
  });

  it("falha ao subir, mas outra chamada já concluiu o envio: mostra recebido e atualiza (nada foi apagado)", async () => {
    docActions.beginCaseDocumentUploadAction.mockResolvedValue({ ok: true, documentId: "d9", path: "p", token: "tok", alreadyReady: null });
    storage.uploadToSignedUrl.mockResolvedValue({ data: null, error: { message: "network error", statusCode: "500" } });
    docActions.abandonCaseDocumentUploadAction.mockResolvedValue({ ok: false, error: "Este envio já foi concluído ou cancelado.", concluded: true });
    render(<CaseDocumentUploader opportunityId={OPP_A} caseLabel="Caso A" />);
    pick(file());
    expect(await screen.findByText(/Documento recebido/)).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("repetição de um envio que já chegou (objeto existe): segue para a conferência", async () => {
    docActions.beginCaseDocumentUploadAction.mockResolvedValue({ ok: true, documentId: "d9", path: "p", token: "tok", alreadyReady: null });
    storage.uploadToSignedUrl.mockResolvedValue({ data: null, error: { message: "The resource already exists", statusCode: "409" } });
    docActions.finalizeCaseDocumentUploadAction.mockResolvedValue({ ok: true, document: { name: "contrato.pdf" }, replayed: true });
    render(<CaseDocumentUploader opportunityId={OPP_A} caseLabel="Caso A" />);
    pick(file());
    expect(await screen.findByText(/Documento recebido/)).toBeTruthy();
    expect(docActions.abandonCaseDocumentUploadAction).not.toHaveBeenCalled();
  });

  it("resposta perdida na reserva: a nova tentativa usa a MESMA chave (não duplica)", async () => {
    docActions.beginCaseDocumentUploadAction.mockRejectedValueOnce(new Error("fetch failed"));
    render(<CaseDocumentUploader opportunityId={OPP_A} caseLabel="Caso A" />);
    pick(file());
    expect(await screen.findByText(/Não foi possível confirmar o envio/)).toBeTruthy();
    docActions.beginCaseDocumentUploadAction.mockResolvedValue({ ok: true, documentId: "d9", path: "p", token: null, alreadyReady: { name: "contrato.pdf" } });
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(docActions.beginCaseDocumentUploadAction).toHaveBeenCalledTimes(2));
    const keys = docActions.beginCaseDocumentUploadAction.mock.calls.map((c) => (c[0] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(await screen.findByText(/Documento recebido/)).toBeTruthy();
  });

  it("conteúdo inválido na conferência: mensagem e sem nova tentativa (a reserva já foi desfeita no servidor)", async () => {
    docActions.beginCaseDocumentUploadAction.mockResolvedValue({ ok: true, documentId: "d9", path: "p", token: "tok", alreadyReady: null });
    storage.uploadToSignedUrl.mockResolvedValue({ data: {}, error: null });
    docActions.finalizeCaseDocumentUploadAction.mockResolvedValue({ ok: false, error: "O arquivo não é um PDF, JPEG ou PNG válido (ou chegou incompleto). Nada foi guardado.", abandoned: true });
    render(<CaseDocumentUploader opportunityId={OPP_A} caseLabel="Caso A" />);
    pick(file());
    expect(await screen.findByText(/não é um PDF, JPEG ou PNG válido/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Tentar de novo" })).toBeNull();
  });

  it("trocar de caso no meio do envio: o resultado do caso A nunca aparece no caso B", async () => {
    let releaseBegin!: (v: unknown) => void;
    docActions.beginCaseDocumentUploadAction.mockImplementation(() => new Promise((r) => (releaseBegin = r)));
    storage.uploadToSignedUrl.mockResolvedValue({ data: {}, error: null });
    docActions.finalizeCaseDocumentUploadAction.mockResolvedValue({ ok: true, document: { name: "do-caso-A.pdf" }, replayed: false });
    const a = option(OPP_A, { legalArea: "Usucapião" });
    const b = option(OPP_B, { legalArea: "Inventário" });
    const view = okView();
    const { rerender } = render(panel(ctx([a, b], focusOf(a, view))));
    pick(new File([new Uint8Array([1])], "do-caso-A.pdf", { type: "application/pdf" }));
    expect(screen.getByRole("status").textContent).toMatch(/Preparando o envio/);
    rerender(panel(ctx([a, b], focusOf(b, view))));
    expect(screen.getByText(/Anexar documento a/).textContent).toMatch(/Inventário/);
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => releaseBegin({ ok: true, documentId: "dA", path: `w/${OPP_A}/dA`, token: "tok", alreadyReady: null }));
    expect(screen.queryByText(/do-caso-A\.pdf/)).toBeNull();
    expect(screen.queryByText(/Documento recebido/)).toBeNull();
    // O envio do caso A seguiu para o documento DELE (o id foi reservado no caso A), não para o B.
    expect(docActions.beginCaseDocumentUploadAction).toHaveBeenCalledWith(expect.objectContaining({ opportunityId: OPP_A }));
  });
});
