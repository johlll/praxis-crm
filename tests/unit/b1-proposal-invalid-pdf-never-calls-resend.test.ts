/**
 * @vitest-environment node
 *
 * Prova forte do bloqueio: um PDF inválido não pode resultar em NENHUMA
 * chamada HTTP ao Resend.
 *
 * Diferente de `b1-proposal-send-blocks-invalid-pdf.test.ts`, que troca o
 * módulo de e-mail por mock, aqui o módulo de e-mail é o **real** —
 * `adminDispatchProposalEmail` e `adminFailProposalEmail` de verdade. O
 * único mock é o cliente Supabase (RPCs/Storage) e o `fetch` global, que
 * fica sob espionagem. E `RESEND_API_KEY`/`RESEND_FROM_EMAIL` estão
 * configuradas de propósito: sem a validação, o despacho CHEGARIA a
 * chamar `https://api.resend.com/emails`. O que impede a chamada é só a
 * recusa do PDF.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpcAdminMock = vi.fn();
const downloadStorageMock = vi.fn();
const rpcSessaoMock = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/server/authz/safe", () => ({
  requirePermissionSafe: async () => ({ ctx: { userId: "11111111-1111-4111-8111-111111111111" } }),
}));

vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({ rpc: rpcSessaoMock }),
}));

// Único mock do caminho administrativo: o cliente. Tudo de
// src/server/proposals/admin/** roda de verdade.
vi.mock("@/server/proposals/admin/supabase", () => ({
  createProposalsAdminSupabaseClient: () => ({
    rpc: rpcAdminMock,
    storage: { from: () => ({ download: downloadStorageMock }) },
  }),
}));

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const SEND_ID = "44444444-4444-4444-8444-444444444444";

function formData() {
  const fd = new FormData();
  fd.set("proposalId", "22222222-2222-4222-8222-222222222222");
  fd.set("documentId", "33333333-3333-4333-8333-333333333333");
  fd.set("toEmail", "cliente@exemplo.com");
  fd.set("idempotencyKey", "55555555-5555-4555-8555-555555555555");
  return fd;
}

function blobDe(bytes: Buffer) {
  return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RESEND_API_KEY", "chave-de-teste-nao-real");
  vi.stubEnv("RESEND_FROM_EMAIL", "propostas@exemplo.test");

  fetchSpy = vi.fn(async () => new Response(JSON.stringify({ id: "msg-1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);

  rpcAdminMock.mockImplementation(async (fn: string) => {
    if (fn === "queue_proposal_email") {
      return { data: [{ send_id: SEND_ID, status: "queued", is_new: true }], error: null };
    }
    return { data: null, error: null };
  });

  rpcSessaoMock.mockImplementation(async (fn: string) => {
    if (fn === "get_proposal") return { data: { number: "PROP-2026-0003" }, error: null };
    if (fn === "get_proposal_document_for_download") {
      return { data: { storagePath: "ws/prop/v1.pdf", version: 1 }, error: null };
    }
    return { data: null, error: null };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const chamadasAoResend = () =>
  fetchSpy.mock.calls.filter((c) => String(c[0]).includes("api.resend.com"));

describe("PDF inválido nunca chega ao Resend", () => {
  it("não faz NENHUMA chamada a api.resend.com com a v1 corrompida", async () => {
    downloadStorageMock.mockResolvedValue({
      data: blobDe(readFileSync(join(FIXTURES, "b1-v1-corrompido.pdf"))),
      error: null,
    });
    const { dispatchProposalEmailAction } = await import("@/modules/proposals/documents-actions");

    const estado = await dispatchProposalEmailAction("lead-1", { ok: false }, formData());

    expect(chamadasAoResend()).toHaveLength(0);
    expect(estado.ok).toBe(false);
    // e o envio não fica preso em `queued`
    expect(rpcAdminMock).toHaveBeenCalledWith("mark_proposal_email_failed", {
      p_send_id: SEND_ID,
      p_error_code: "pdf_fluxo_truncado",
    });
    expect(rpcAdminMock).not.toHaveBeenCalledWith("mark_proposal_email_sent", expect.anything());
  });

  it("com a v18 íntegra, aí sim chama o Resend exatamente uma vez", async () => {
    downloadStorageMock.mockResolvedValue({
      data: blobDe(readFileSync(join(FIXTURES, "b1-v18-build-real.pdf"))),
      error: null,
    });
    const { dispatchProposalEmailAction } = await import("@/modules/proposals/documents-actions");

    const estado = await dispatchProposalEmailAction("lead-1", { ok: false }, formData());

    expect(chamadasAoResend()).toHaveLength(1);
    expect(estado.ok).toBe(true);
  });
});
