/**
 * @vitest-environment node
 *
 * C3a — rota de download: anexo, no-store, nada em cache, contato validado,
 * outra origem recusada, erros fechados (sem detalhe) e sem conteúdo em log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CONTACT = "c0000000-0000-0000-0000-000000000001";
const { exportMock } = vi.hoisted(() => ({ exportMock: vi.fn() }));
vi.mock("@/server/privacy/export-subject", () => ({ exportSubjectData: exportMock }));

import { POST } from "@/app/api/privacy/contacts/[contactId]/export/route";

const call = (contactId: string, headers: Record<string, string> = {}) =>
  POST(new Request(`https://app.exemplo.test/api/privacy/contacts/${contactId}/export`, { method: "POST", headers: { host: "app.exemplo.test", ...headers } }), {
    params: Promise.resolve({ contactId }),
  });

let spies: Array<ReturnType<typeof vi.spyOn>> = [];
beforeEach(() => {
  vi.clearAllMocks();
  exportMock.mockResolvedValue({ ok: true, body: '{"format":"praxis_data_subject_export_v1"}', fileName: `titular-${CONTACT}-2026-11-12.json` });
  spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => spies.forEach((s) => s.mockRestore()));

describe("resposta de sucesso", () => {
  it("anexo JSON UTF-8, sem cache, sem sniffing e com nome sem PII", async () => {
    const response = await call(CONTACT);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe(`attachment; filename="titular-${CONTACT}-2026-11-12.json"`);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).toBe('{"format":"praxis_data_subject_export_v1"}');
    expect(exportMock).toHaveBeenCalledWith(CONTACT);
  });

  it("aceita a mesma origem (com ou sem host encaminhado)", async () => {
    expect((await call(CONTACT, { origin: "https://app.exemplo.test" })).status).toBe(200);
    expect((await call(CONTACT, { origin: "https://app.exemplo.test", "x-forwarded-host": "app.exemplo.test" })).status).toBe(200);
  });
});

describe("recusas", () => {
  it("outra origem: 403, sem registro e sem cache", async () => {
    const response = await call(CONTACT, { origin: "https://outro-site.test" });
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(exportMock).not.toHaveBeenCalled();
  });

  it("origem ilegível: 403", async () => {
    expect((await call(CONTACT, { origin: "não é url" })).status).toBe(403);
  });

  it("id que não é UUID: 404 sem consultar nada", async () => {
    const response = await call("não-uuid");
    expect(response.status).toBe(404);
    expect(exportMock).not.toHaveBeenCalled();
  });

  it.each([
    [403, "forbidden"],
    [404, "not_found"],
    [500, "export_failed"],
  ] as const)("falha %i devolve só o código fechado, no-store, sem anexo", async (status, error) => {
    exportMock.mockResolvedValue({ ok: false, status, error });
    const response = await call(CONTACT);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Disposition")).toBeNull();
  });
});

describe("sigilo", () => {
  it("nada é escrito em log", async () => {
    await call(CONTACT);
    exportMock.mockResolvedValue({ ok: false, status: 500, error: "export_failed" });
    await call(CONTACT);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
