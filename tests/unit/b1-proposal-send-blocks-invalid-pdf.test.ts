/**
 * @vitest-environment node
 *
 * B1, §10 — como versões históricas inválidas deixam de ser elegíveis
 * para envio novo, SEM migration e SEM tocar em registro hospedado.
 *
 * As 16 versões quebradas de PROP-2026-0003 continuam no Storage e no
 * banco, intactas, como evidência. O que muda é que o despacho revalida
 * os bytes do anexo antes de chamar o provedor: PDF que não abre não
 * sai, e a linha de envio é marcada como falha em vez de ficar presa em
 * `queued` (o estado ambíguo encontrado na investigação).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const queueMock = vi.fn();
const dispatchMock = vi.fn();
const failEmailMock = vi.fn();
const downloadMock = vi.fn();
const rpcMock = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/server/authz/safe", () => ({
  requirePermissionSafe: async () => ({ ctx: { userId: "11111111-1111-4111-8111-111111111111" } }),
}));

vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({ rpc: rpcMock }),
}));

vi.mock("@/server/proposals/admin/documents", () => ({
  adminBeginProposalDocument: vi.fn(),
  adminFailProposalDocument: vi.fn(),
  adminUploadAndFinalizeProposalDocument: vi.fn(),
  adminDownloadProposalDocumentBytes: downloadMock,
}));

vi.mock("@/server/proposals/admin/email", () => ({
  adminQueueProposalEmail: queueMock,
  adminDispatchProposalEmail: dispatchMock,
  adminFailProposalEmail: failEmailMock,
}));

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const PROPOSAL_ID = "22222222-2222-4222-8222-222222222222";
const DOCUMENT_ID = "33333333-3333-4333-8333-333333333333";
const SEND_ID = "44444444-4444-4444-8444-444444444444";

function formData() {
  const fd = new FormData();
  fd.set("proposalId", PROPOSAL_ID);
  fd.set("documentId", DOCUMENT_ID);
  fd.set("toEmail", "cliente@exemplo.com");
  fd.set("idempotencyKey", "55555555-5555-4555-8555-555555555555");
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  queueMock.mockResolvedValue({ sendId: SEND_ID, status: "queued", isNew: true });
  rpcMock.mockImplementation(async (fn: string) => {
    if (fn === "get_proposal") return { data: { number: "PROP-2026-0003" }, error: null };
    if (fn === "get_proposal_document_for_download") {
      return { data: { storagePath: "ws/prop/v1.pdf", version: 1 }, error: null };
    }
    return { data: null, error: null };
  });
});

describe("envio recusa versão cujo PDF não abre", () => {
  it("não chama o provedor quando o anexo é a v1 corrompida real", async () => {
    downloadMock.mockResolvedValue(readFileSync(join(FIXTURES, "b1-v1-corrompido.pdf")));
    const { dispatchProposalEmailAction } = await import("@/modules/proposals/documents-actions");

    const estado = await dispatchProposalEmailAction("lead-1", { ok: false }, formData());

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(estado.ok).toBe(false);
    expect(estado.error).toContain("não abre corretamente");
  });

  it("marca o envio como falho, em vez de deixar preso em queued", async () => {
    downloadMock.mockResolvedValue(readFileSync(join(FIXTURES, "b1-v1-corrompido.pdf")));
    const { dispatchProposalEmailAction } = await import("@/modules/proposals/documents-actions");

    await dispatchProposalEmailAction("lead-1", { ok: false }, formData());

    expect(failEmailMock).toHaveBeenCalledWith(SEND_ID, "pdf_fluxo_truncado");
  });

  it("deixa passar a versão íntegra gerada pelo build real (v18)", async () => {
    downloadMock.mockResolvedValue(readFileSync(join(FIXTURES, "b1-v18-build-real.pdf")));
    dispatchMock.mockResolvedValue({ providerMessageId: "msg-1" });
    const { dispatchProposalEmailAction } = await import("@/modules/proposals/documents-actions");

    const estado = await dispatchProposalEmailAction("lead-1", { ok: false }, formData());

    expect(failEmailMock).not.toHaveBeenCalled();
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(estado.ok).toBe(true);
  });
});
