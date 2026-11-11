/**
 * @vitest-environment node
 *
 * C3b — rota de retenção: origem EXATA (falha fechada), contato validado, corpo estrito, a
 * confirmação forte da anonimização, nada do navegador decide workspace/ator/prazo, resposta
 * sem cache e sem conteúdo em log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CONTACT = "c0000000-0000-4000-8000-000000000001";
const HOLD = "d0000000-0000-4000-8000-000000000001";
const ORIGIN = "https://app.exemplo.test";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  hold: vi.fn(),
  release: vi.fn(),
  anonymize: vi.fn(),
}));
vi.mock("@/server/privacy/retention", () => ({
  getRetentionStatus: mocks.status,
  createLegalHold: mocks.hold,
  releaseLegalHold: mocks.release,
  anonymizeContact: mocks.anonymize,
}));

import { POST } from "@/app/api/privacy/contacts/[contactId]/retention/route";

const STATUS = { state: "eligible", eligible: true, reasons: [], lead_count: 1, archived_lead_count: 1, retention_due_at: null, anonymized_at: null, holds: [] };
const OK = { ok: true, status: STATUS };

function call(body: unknown, opts: { contactId?: string; headers?: Record<string, string>; url?: string; raw?: string | undefined } = {}) {
  const contactId = opts.contactId ?? CONTACT;
  return POST(
    new Request(opts.url ?? `${ORIGIN}/api/privacy/contacts/${contactId}/retention`, {
      method: "POST",
      headers: opts.headers ?? { origin: ORIGIN, "content-type": "application/json" },
      body: opts.raw ?? JSON.stringify(body),
    }),
    { params: Promise.resolve({ contactId }) },
  );
}

let spies: Array<ReturnType<typeof vi.spyOn>> = [];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.status.mockResolvedValue(OK);
  mocks.hold.mockResolvedValue(OK);
  mocks.release.mockResolvedValue(OK);
  mocks.anonymize.mockResolvedValue({ ...OK, outcome: "anonymized" });
  spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => spies.forEach((s) => s.mockRestore()));

const touched = () => Object.values(mocks).some((m) => m.mock.calls.length > 0);

describe("origem", () => {
  it.each([
    ["ausente", {}],
    ["diferente", { origin: "https://outro.exemplo.test" }],
    ["porta diferente", { origin: `${ORIGIN}:8443` }],
    ["esquema diferente", { origin: "http://app.exemplo.test" }],
    ["malformada", { origin: "nao-e-uma-origem" }],
    ["x-forwarded-host não vale", { "x-forwarded-host": "app.exemplo.test" }],
  ])("origem %s: 403 sem tocar o banco", async (_name, headers) => {
    const response = await call({ action: "status" }, { headers: { "content-type": "application/json", ...headers } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(touched()).toBe(false);
  });

  it("a mesma origem passa", async () => {
    expect((await call({ action: "status" })).status).toBe(200);
  });
});

describe("entrada", () => {
  it("contato fora do formato de UUID: 404", async () => {
    const response = await call({ action: "status" }, { contactId: "nao-e-uuid" });
    expect(response.status).toBe(404);
    expect(touched()).toBe(false);
  });

  it.each([
    ["corpo ausente", undefined, "{"],
    ["ação desconhecida", { action: "apagar_tudo" }, undefined],
    ["motivo livre", { action: "hold_create", reasonCode: "porque sim" }, undefined],
    ["motivo ausente", { action: "hold_create" }, undefined],
    ["id de preservação inválido", { action: "hold_release", holdId: "1; drop table" }, undefined],
    ["anonimizar sem confirmação", { action: "anonymize" }, undefined],
    ["anonimizar com confirmação errada", { action: "anonymize", confirmation: "anonimizar" }, undefined],
    ["anonimizar com confirmação booleana", { action: "anonymize", confirmation: true }, undefined],
  ])("%s: 400 sem tocar o banco", async (_name, body, raw) => {
    const response = await call(body, { raw });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(touched()).toBe(false);
  });
});

describe("ações", () => {
  it("status, criar e encerrar preservação, anonimizar: cada uma chama o orquestrador certo", async () => {
    expect((await call({ action: "status" })).status).toBe(200);
    expect(mocks.status).toHaveBeenCalledWith(CONTACT);
    expect((await call({ action: "hold_create", reasonCode: "judicial_process" })).status).toBe(200);
    expect(mocks.hold).toHaveBeenCalledWith(CONTACT, "judicial_process");
    expect((await call({ action: "hold_release", holdId: HOLD })).status).toBe(200);
    expect(mocks.release).toHaveBeenCalledWith(CONTACT, HOLD);
    const anonymized = await call({ action: "anonymize", confirmation: "ANONIMIZAR" });
    expect(anonymized.status).toBe(200);
    expect(mocks.anonymize).toHaveBeenCalledWith(CONTACT);
    expect(await anonymized.json()).toEqual({ status: STATUS, outcome: "anonymized" });
  });

  it("workspace, ator e prazo enviados pelo navegador não chegam a lugar nenhum", async () => {
    const hostile = "00000000-0000-4000-8000-000000000bad";
    const response = await POST(
      new Request(`${ORIGIN}/api/privacy/contacts/${CONTACT}/retention?workspaceId=${hostile}&months=1`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json", "x-workspace-id": hostile, "x-actor-user-id": hostile },
        body: JSON.stringify({ action: "anonymize", confirmation: "ANONIMIZAR", workspaceId: hostile, p_workspace_id: hostile, actor: hostile, retention_months: 0 }),
      }),
      { params: Promise.resolve({ contactId: CONTACT }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.anonymize.mock.calls).toEqual([[CONTACT]]);
  });
});

describe("erros fechados e resposta", () => {
  it("falhas do orquestrador viram o status e o código dele", async () => {
    mocks.anonymize.mockResolvedValue({ ok: false, status: 404, error: "not_found" });
    const response = await call({ action: "anonymize", confirmation: "ANONIMIZAR" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("exceção inesperada: 500 com código fechado, sem detalhe nem log", async () => {
    mocks.status.mockRejectedValue(new Error("falha com Titular ALFA 12345678901"));
    const response = await call({ action: "status" });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toBe('{"error":"retention_failed"}');
    expect(text).not.toMatch(/ALFA|12345678901/);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("toda resposta é no-store", async () => {
    for (const response of [await call({ action: "status" }), await call({ action: "x" }), await call({ action: "status" }, { headers: {} })]) {
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});
