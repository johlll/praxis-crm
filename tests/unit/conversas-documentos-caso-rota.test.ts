import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Documentos por caso — a rota de abrir/baixar: autorização por sessão a cada clique, 404 (nunca 403) para quem
 * não alcança o documento, link temporário de 60 s gerado na hora, nome sem acentos no download.
 */

const m = vi.hoisted(() => ({ guard: vi.fn(), rpc: vi.fn(), sign: vi.fn() }));
vi.mock("@/server/authz/safe", () => ({ requirePermissionSafe: m.guard }));
vi.mock("@/server/supabase/server", () => ({ createServerSupabaseClient: async () => ({ rpc: m.rpc }) }));
vi.mock("@/server/case-documents/admin/documents", () => ({ adminCreateDownloadUrl: m.sign }));

const { GET } = await import("@/app/api/case-documents/[documentId]/route");

const DOC = "d0000000-0000-4000-8000-000000000001";
const call = (id: string, modo?: string) =>
  GET(new Request(`http://x/api/case-documents/${id}${modo ? `?modo=${modo}` : ""}`), { params: Promise.resolve({ documentId: id }) });

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.guard.mockResolvedValue({ ctx: { userId: "u", workspaceId: "w", role: "viewer" } });
  m.rpc.mockResolvedValue({ data: { storagePath: `w/o/${DOC}`, name: "Matrícula.pdf", contentType: "application/pdf" }, error: null });
  m.sign.mockResolvedValue("http://storage/object/sign/case-documents/w/o/d?token=t");
});

describe("abrir e baixar", () => {
  it("sem sessão/permissão: 404 sem consultar o banco", async () => {
    m.guard.mockResolvedValue({ error: "x" });
    expect((await call(DOC)).status).toBe(404);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("id malformado: 404 sem consultar o banco", async () => {
    expect((await call("../../etc")).status).toBe(404);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("fora do alcance, outro escritório ou em remoção (o banco recusa): 404 e nenhum link", async () => {
    m.rpc.mockResolvedValue({ data: null, error: { message: "document_not_found" } });
    expect((await call(DOC)).status).toBe(404);
    expect(m.sign).not.toHaveBeenCalled();
  });
  it("abrir: redireciona para o link temporário, sem cache", async () => {
    const r = await call(DOC, "abrir");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toMatch(/token=t/);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(m.rpc).toHaveBeenCalledWith("get_case_document_for_download", { p_document_id: DOC });
    expect(m.sign).toHaveBeenCalledWith({ storagePath: `w/o/${DOC}`, name: "Matrícula.pdf", mode: "abrir" });
  });
  it("baixar: pede o link de download (o caminho vem do banco, nunca da URL)", async () => {
    await call(DOC, "baixar");
    expect(m.sign).toHaveBeenCalledWith({ storagePath: `w/o/${DOC}`, name: "Matrícula.pdf", mode: "baixar" });
  });
  it("falha ao gerar o link: 503, sem expor detalhe", async () => {
    m.sign.mockRejectedValue(new Error("detalhe interno"));
    const r = await call(DOC);
    expect(r.status).toBe(503);
    expect(await r.text()).not.toMatch(/detalhe interno/);
  });
});
