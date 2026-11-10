/**
 * @vitest-environment node
 *
 * C3a — rota de download: anexo, no-store, nada em cache, contato validado, origem
 * EXATA (esquema + host + porta, falhando fechado: ausente, malformada ou diferente = 403,
 * sem confiar em x-forwarded-host do chamador), erros fechados e sem conteúdo em log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CONTACT = "c0000000-0000-4000-8000-000000000001";
const ORIGIN = "https://app.exemplo.test";
const { exportMock } = vi.hoisted(() => ({ exportMock: vi.fn() }));
vi.mock("@/server/privacy/export-subject", () => ({ exportSubjectData: exportMock }));

import { POST } from "@/app/api/privacy/contacts/[contactId]/export/route";

function call(contactId: string, headers: Record<string, string> = { origin: ORIGIN }, url = `${ORIGIN}/api/privacy/contacts/${contactId}/export`) {
  return POST(new Request(url, { method: "POST", headers }), { params: Promise.resolve({ contactId }) });
}

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

  it("mesma origem exata continua passando — também em outra porta quando a própria rota está nela", async () => {
    expect((await call(CONTACT, { origin: ORIGIN })).status).toBe(200);
    const local = "http://localhost:3000";
    expect((await call(CONTACT, { origin: local }, `${local}/api/privacy/contacts/${CONTACT}/export`)).status).toBe(200);
  });
});

describe("origem: falha fechado, sem tocar no banco", () => {
  const refused: Array<[string, Record<string, string>, string?]> = [
    ["Origin ausente", {}],
    ["Origin vazio", { origin: "" }],
    ["Origin literal 'null'", { origin: "null" }],
    ["Origin malformado", { origin: "não é url" }],
    ["origem diferente", { origin: "https://outro-site.test" }],
    ["subdomínio diferente", { origin: "https://evil.app.exemplo.test" }],
    ["mesmo host com protocolo diferente", { origin: "http://app.exemplo.test" }],
    ["mesmo host com porta diferente", { origin: "https://app.exemplo.test:8443" }],
    ["Origin com caminho (não é uma origem)", { origin: "https://app.exemplo.test/x" }],
    ["origem maliciosa + x-forwarded-host forjado", { origin: "https://evil.test", "x-forwarded-host": "evil.test" }],
    ["origem maliciosa + host forjado", { origin: "https://evil.test", host: "evil.test" }],
    ["sem Origin + x-forwarded-host forjado", { "x-forwarded-host": "app.exemplo.test" }],
  ];

  it.each(refused)("%s → 403, no-store, nenhuma chamada ao banco", async (_name, headers) => {
    const response = await call(CONTACT, headers);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Disposition")).toBeNull();
    expect(exportMock).not.toHaveBeenCalled();
  });

  it("a rota está em outra porta/protocolo que o Origin informa → 403", async () => {
    expect((await call(CONTACT, { origin: "https://localhost:3000" }, `http://localhost:3000/api/privacy/contacts/${CONTACT}/export`)).status).toBe(403);
    expect((await call(CONTACT, { origin: "http://localhost:3001" }, `http://localhost:3000/api/privacy/contacts/${CONTACT}/export`)).status).toBe(403);
    expect(exportMock).not.toHaveBeenCalled();
  });
});

describe("demais recusas", () => {
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

  it("até uma exceção inesperada do orquestrador vira 500 fechado, sem detalhe", async () => {
    exportMock.mockRejectedValue(new Error("ECONNRESET Titular ALFA 12345678901"));
    const response = await call(CONTACT);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "export_failed" });
  });
});

describe("sigilo", () => {
  it("nada é escrito em log", async () => {
    await call(CONTACT);
    exportMock.mockResolvedValue({ ok: false, status: 500, error: "export_failed" });
    await call(CONTACT);
    exportMock.mockRejectedValue(new Error("PII 12345678901"));
    await call(CONTACT);
    await call(CONTACT, {});
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
