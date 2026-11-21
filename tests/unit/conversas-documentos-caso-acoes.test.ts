import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Documentos por caso — as AÇÕES do servidor com dependências simuladas: a trava do recebimento vale em todo
 * caminho de envio e finalização (antes de qualquer chamada ao banco ou ao Storage), a permissão é conferida
 * aqui, o conteúdo inválido apaga objeto e linha pendente, a remoção que não apaga o arquivo fica PENDENTE e
 * a conferência concorrente volta como conflito (nunca sobrescreve).
 */

const m = vi.hoisted(() => ({
  guard: vi.fn(),
  rpc: vi.fn(),
  adminBegin: vi.fn(),
  adminToken: vi.fn(),
  adminDownload: vi.fn(),
  adminFinalize: vi.fn(),
  adminAbandon: vi.fn(),
  adminRemoveObject: vi.fn(),
  adminBeginRemoval: vi.fn(),
  adminFinalizeRemoval: vi.fn(),
  adminCleanup: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: m.revalidate }));
vi.mock("@/server/authz/safe", () => ({ requirePermissionSafe: m.guard }));
vi.mock("@/server/supabase/server", () => ({ createServerSupabaseClient: async () => ({ rpc: m.rpc }) }));
vi.mock("@/server/case-documents/admin/documents", () => ({
  CaseDocumentAdminError: class extends Error {
    constructor(public code: string) {
      super(code);
    }
  },
  adminBeginCaseDocument: m.adminBegin,
  adminCreateUploadToken: m.adminToken,
  adminDownloadObject: m.adminDownload,
  adminFinalizeCaseDocument: m.adminFinalize,
  adminAbandonCaseDocument: m.adminAbandon,
  adminRemoveObject: m.adminRemoveObject,
  adminBeginRemoval: m.adminBeginRemoval,
  adminFinalizeRemoval: m.adminFinalizeRemoval,
  adminRunCaseDocumentCleanup: m.adminCleanup,
}));

const actions = await import("@/modules/case-documents/actions");

const OPP = "0a000000-0000-4000-8000-00000000000a";
const DOC = "d0000000-0000-4000-8000-000000000001";
const KEY = "f0000000-0000-4000-8000-000000000001";
const ACTOR = "20000000-0000-0000-0000-000000000002";
const PDF = Uint8Array.from(Buffer.from("%PDF-1.7\nconteúdo sintético\n%%EOF\n", "latin1"));
const READY_ROW = {
  id: DOC, opportunity_id: OPP, status: "ready", name: "contrato.pdf", content_type: "application/pdf", byte_size: PDF.length,
  uploaded_by_name: "Bruno", uploaded_at: "2026-11-21T12:00:00Z", review_status: "recebido", review_note: null,
  reviewed_by_name: null, reviewed_at: null, review_version: 0, removal_requested_at: null,
};

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.guard.mockResolvedValue({ ctx: { userId: ACTOR, workspaceId: "w", role: "sales" } });
  m.adminCleanup.mockResolvedValue({ removals: 0, objects: 0, pending: 0 });
  vi.stubEnv("CASE_DOCUMENTS_UPLOAD_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

const beginInput = { opportunityId: OPP, name: "contrato.pdf", type: "application/pdf", size: PDF.length, idempotencyKey: KEY };

describe("trava do recebimento: fechada por padrão, em todos os caminhos", () => {
  it.each([undefined, "", "TRUE", "false"])("CASE_DOCUMENTS_UPLOAD_ENABLED=%j: envio recusado sem tocar banco nem Storage", async (v) => {
    vi.stubEnv("CASE_DOCUMENTS_UPLOAD_ENABLED", v as string);
    const r = await actions.beginCaseDocumentUploadAction(beginInput);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/aguarda a ativação do backup/) });
    expect(m.adminBegin).not.toHaveBeenCalled();
    expect(m.adminToken).not.toHaveBeenCalled();
  });
  it("finalização também recusa com a trava fechada (chamada direta à ação)", async () => {
    vi.stubEnv("CASE_DOCUMENTS_UPLOAD_ENABLED", "");
    const r = await actions.finalizeCaseDocumentUploadAction({ documentId: DOC, declaredType: "application/pdf" });
    expect(r.ok).toBe(false);
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.adminDownload).not.toHaveBeenCalled();
    expect(m.adminFinalize).not.toHaveBeenCalled();
  });
  it("o portão do banco fechado também volta como mensagem do backup (segunda trava)", async () => {
    m.adminBegin.mockRejectedValue(Object.assign(new Error("case_documents_upload_disabled"), { code: "case_documents_upload_disabled" }));
    const { CaseDocumentAdminError } = await import("@/server/case-documents/admin/documents");
    m.adminBegin.mockRejectedValue(new CaseDocumentAdminError("case_documents_upload_disabled"));
    const r = await actions.beginCaseDocumentUploadAction(beginInput);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/aguarda a ativação do backup/) });
    expect(m.adminToken).not.toHaveBeenCalled();
  });
});

describe("envio", () => {
  it("sem permissão: recusa antes de qualquer chamada", async () => {
    m.guard.mockResolvedValue({ error: "Você não tem permissão para fazer isso." });
    expect(await actions.beginCaseDocumentUploadAction(beginInput)).toEqual({ ok: false, error: "Você não tem permissão para fazer isso." });
    expect(m.adminBegin).not.toHaveBeenCalled();
  });
  it("valida no servidor: tipo e tamanho fora do limite recusados", async () => {
    expect((await actions.beginCaseDocumentUploadAction({ ...beginInput, type: "text/html" })).ok).toBe(false);
    expect((await actions.beginCaseDocumentUploadAction({ ...beginInput, size: 10 * 1024 * 1024 + 1 })).ok).toBe(false);
    expect(m.adminBegin).not.toHaveBeenCalled();
  });
  it("reserva e devolve o link de envio do caminho gerado pelo banco; o ator vem da sessão", async () => {
    m.adminBegin.mockResolvedValue({ documentId: DOC, storagePath: `w/${OPP}/${DOC}`, status: "pending", replayed: false, document: {} });
    m.adminToken.mockResolvedValue({ path: `w/${OPP}/${DOC}`, token: "tok" });
    const r = await actions.beginCaseDocumentUploadAction(beginInput);
    expect(r).toEqual({ ok: true, documentId: DOC, path: `w/${OPP}/${DOC}`, token: "tok", alreadyReady: null });
    expect(m.adminBegin).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: ACTOR, idempotencyKey: KEY }));
  });
  it("repetição depois de pronto: não pede novo envio, devolve o documento", async () => {
    m.adminBegin.mockResolvedValue({ documentId: DOC, storagePath: "p", status: "ready", replayed: true, document: READY_ROW });
    const r = await actions.beginCaseDocumentUploadAction(beginInput);
    expect(r.ok && r.alreadyReady?.name).toBe("contrato.pdf");
    expect(m.adminToken).not.toHaveBeenCalled();
  });
});

describe("finalização: conteúdo conferido no servidor", () => {
  beforeEach(() => {
    m.rpc.mockResolvedValue({ data: { storagePath: `w/${OPP}/${DOC}`, declaredType: "application/pdf", status: "pending" }, error: null });
  });
  it("o caminho vem do banco (get_pending_case_document), nunca do navegador", async () => {
    m.adminDownload.mockResolvedValue(PDF);
    m.adminFinalize.mockResolvedValue({ ...READY_ROW, replayed: false });
    const r = await actions.finalizeCaseDocumentUploadAction({ documentId: DOC, declaredType: "application/pdf" });
    expect(r.ok).toBe(true);
    expect(m.rpc).toHaveBeenCalledWith("get_pending_case_document", { p_document_id: DOC });
    expect(m.adminDownload).toHaveBeenCalledWith(`w/${OPP}/${DOC}`);
    expect(m.adminFinalize).toHaveBeenCalledWith(expect.objectContaining({ contentType: "application/pdf", byteSize: PDF.length, checksumSha256: expect.stringMatching(/^[0-9a-f]{64}$/) }));
  });
  it("conteúdo inválido (HTML com extensão .pdf): apaga objeto e linha pendente, nada fica visível", async () => {
    m.adminDownload.mockResolvedValue(Uint8Array.from(Buffer.from("<html><script>alert(1)</script></html>")));
    const r = await actions.finalizeCaseDocumentUploadAction({ documentId: DOC, declaredType: "application/pdf" });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/não é um PDF, JPEG ou PNG válido/), abandoned: true });
    expect(m.adminAbandon).toHaveBeenCalledWith(expect.objectContaining({ documentId: DOC, storagePath: `w/${OPP}/${DOC}`, errorCode: "case_document_content_invalid" }));
    expect(m.adminFinalize).not.toHaveBeenCalled();
  });
  it("objeto ainda não chegou: não finaliza nem abandona (dá para tentar de novo)", async () => {
    m.adminDownload.mockResolvedValue(null);
    const r = await actions.finalizeCaseDocumentUploadAction({ documentId: DOC, declaredType: "application/pdf" });
    expect(r.ok).toBe(false);
    expect(m.adminAbandon).not.toHaveBeenCalled();
    expect(m.adminFinalize).not.toHaveBeenCalled();
  });
});

describe("conferência", () => {
  it("conflito de versão volta como conflito, sem sobrescrever", async () => {
    m.guard.mockResolvedValue({ ctx: { userId: ACTOR, workspaceId: "w", role: "lawyer" } });
    m.rpc.mockResolvedValue({ data: null, error: { message: "case_document_review_conflict" } });
    const r = await actions.reviewCaseDocumentAction({ documentId: DOC, status: "conferido", note: "", expectedVersion: 0 });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/Outra pessoa registrou/), conflict: true });
  });
  it("sem permissão (sales): recusa antes do banco", async () => {
    m.guard.mockResolvedValue({ error: "Você não tem permissão para fazer isso." });
    const r = await actions.reviewCaseDocumentAction({ documentId: DOC, status: "conferido", note: "", expectedVersion: 0 });
    expect(r.ok).toBe(false);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});

describe("remoção controlada em duas fases", () => {
  beforeEach(() => {
    m.adminBeginRemoval.mockResolvedValue({ storagePath: `w/${OPP}/${DOC}` });
  });
  it("arquivo apagado: só então o registro sai", async () => {
    m.adminRemoveObject.mockResolvedValue(true);
    m.adminFinalizeRemoval.mockResolvedValue(true);
    expect(await actions.removeCaseDocumentAction({ documentId: DOC, reason: "duplicado" })).toEqual({ ok: true });
    expect(m.adminFinalizeRemoval).toHaveBeenCalledWith({ documentId: DOC, actorUserId: ACTOR });
  });
  it("falha ao apagar o arquivo: a remoção fica PENDENTE (registro não sai, nada é prometido)", async () => {
    m.adminRemoveObject.mockResolvedValue(false);
    const r = await actions.removeCaseDocumentAction({ documentId: DOC, reason: "duplicado" });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/ficou pendente/), pending: true });
    expect(m.adminFinalizeRemoval).not.toHaveBeenCalled();
  });
  it("motivo fora da lista fechada: recusado", async () => {
    expect((await actions.removeCaseDocumentAction({ documentId: DOC, reason: "porque sim" })).ok).toBe(false);
    expect(m.adminBeginRemoval).not.toHaveBeenCalled();
  });
});
