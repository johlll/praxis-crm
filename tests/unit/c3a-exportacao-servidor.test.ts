/**
 * @vitest-environment node
 *
 * C3a — orquestração da exportação: ordem das chamadas, decifra só no servidor,
 * falha em qualquer ponto fecha o registro como FALHA e não entrega arquivo, o
 * registro só vira "concluído" imediatamente antes da entrega, e nada vai para
 * o log. Nenhum serviço externo é tocado (só o cliente do banco, simulado).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CONTACT = "c0000000-0000-0000-0000-000000000001";
const EXPORT = "e0000000-0000-0000-0000-000000000001";

const state = vi.hoisted(() => ({
  guard: { ctx: { workspaceId: "w", userId: "u", role: "owner" } } as { ctx?: unknown; error?: string },
  rpc: null as unknown as (fn: string, args: Record<string, unknown>) => { data: unknown; error: { message: string } | null },
}));
const { decryptMock, rpcMock } = vi.hoisted(() => ({ decryptMock: vi.fn(), rpcMock: vi.fn() }));

vi.mock("@/server/authz/safe", () => ({ requirePermissionSafe: async () => state.guard }));
vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({ rpc: rpcMock }),
}));
vi.mock("@/server/crypto/contact-sensitive", () => ({ decryptCpfCnpj: decryptMock }));

import { PRIVACY_EXPORT_LIST_CATEGORIES } from "@/modules/privacy/export-format";
import { exportSubjectData } from "@/server/privacy/export-subject";

function fullData(over: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { contact: { id: CONTACT, name: "Titular ALFA" } };
  for (const key of PRIVACY_EXPORT_LIST_CATEGORIES) data[key] = [];
  return { ...data, ...over };
}

const calls = () => rpcMock.mock.calls.map(([fn, args]) => [fn, args] as [string, Record<string, unknown>]);
const names = () => calls().map(([fn]) => fn);
const finishCalls = () => calls().filter(([fn]) => fn === "finish_privacy_export");

let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  vi.clearAllMocks();
  state.guard = { ctx: { workspaceId: "w", userId: "u", role: "owner" } };
  decryptMock.mockReturnValue("12345678901");
  state.rpc = (fn) => {
    if (fn === "request_privacy_export") return { data: EXPORT, error: null };
    if (fn === "get_privacy_export_payload") {
      return { data: { data: fullData(), sensitive: { ciphertext_base64: "Y2lwaGVy", key_version: "v2" } }, error: null };
    }
    return { data: null, error: null };
  };
  rpcMock.mockImplementation(async (fn: string, args: Record<string, unknown>) => state.rpc(fn, args));
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => consoleSpies.forEach((spy) => spy.mockRestore()));

describe("caminho feliz", () => {
  it("abre, lê, decifra, monta, FECHA como concluído e só então entrega", async () => {
    const result = await exportSubjectData(CONTACT);
    expect(names()).toEqual(["request_privacy_export", "get_privacy_export_payload", "finish_privacy_export"]);
    expect(calls()[0]![1]).toEqual({ p_contact_id: CONTACT });
    expect(calls()[1]![1]).toEqual({ p_export_id: EXPORT });
    expect(finishCalls()[0]![1]).toEqual({ p_export_id: EXPORT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = JSON.parse(result.body);
    expect(doc.sections.sensitive_data.items).toEqual([{ field: "cpf_cnpj", value: "12345678901" }]);
    expect(result.fileName).toMatch(new RegExp(`^titular-${CONTACT}-\\d{4}-\\d{2}-\\d{2}\\.json$`));
  });

  it("CPF/CNPJ é decifrado aqui, com o ciphertext e a versão que o banco devolveu", async () => {
    await exportSubjectData(CONTACT);
    expect(decryptMock).toHaveBeenCalledWith("Y2lwaGVy", "v2");
  });

  it("sem CPF cadastrado: não decifra nada", async () => {
    state.rpc = (fn) =>
      fn === "request_privacy_export"
        ? { data: EXPORT, error: null }
        : fn === "get_privacy_export_payload"
          ? { data: { data: fullData(), sensitive: null }, error: null }
          : { data: null, error: null };
    const result = await exportSubjectData(CONTACT);
    expect(decryptMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });
});

describe("autorização e isolamento", () => {
  it("sem a permissão do servidor: 403 e nenhuma chamada ao banco", async () => {
    state.guard = { error: "Você não tem permissão para fazer isso." };
    expect(await exportSubjectData(CONTACT)).toEqual({ ok: false, status: 403, error: "forbidden" });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("o banco recusa o papel: 403, sem registro nem arquivo", async () => {
    state.rpc = () => ({ data: null, error: { message: "insufficient_permission" } });
    expect(await exportSubjectData(CONTACT)).toEqual({ ok: false, status: 403, error: "forbidden" });
    expect(names()).toEqual(["request_privacy_export"]);
  });

  it.each(["contact_not_found", "privacy_export_not_found"])("%s do banco = 404 (outro workspace e inexistente respondem igual)", async (message) => {
    state.rpc = () => ({ data: null, error: { message } });
    expect(await exportSubjectData(CONTACT)).toEqual({ ok: false, status: 404, error: "not_found" });
  });
});

describe("falha no meio: registro de falha e nenhum arquivo", () => {
  it("leitura falha → registro 'data_unavailable', sem decifrar", async () => {
    state.rpc = (fn) =>
      fn === "request_privacy_export" ? { data: EXPORT, error: null } : fn === "get_privacy_export_payload" ? { data: null, error: { message: "timeout" } } : { data: null, error: null };
    const result = await exportSubjectData(CONTACT);
    expect(result).toEqual({ ok: false, status: 500, error: "export_failed" });
    expect(finishCalls().map(([, a]) => a)).toEqual([{ p_export_id: EXPORT, p_failure_code: "data_unavailable" }]);
    expect(decryptMock).not.toHaveBeenCalled();
  });

  it("decifra falha → registro 'decryption_failed' e nada do conteúdo sai", async () => {
    decryptMock.mockImplementation(() => { throw new Error("tag inválida do CPF 12345678901"); });
    const result = await exportSubjectData(CONTACT);
    expect(result).toEqual({ ok: false, status: 500, error: "export_failed" });
    expect(JSON.stringify(result)).not.toContain("12345678901");
    expect(finishCalls().map(([, a]) => a)).toEqual([{ p_export_id: EXPORT, p_failure_code: "decryption_failed" }]);
  });

  it("estrutura incompleta → registro 'data_unavailable' (nada de arquivo parcial)", async () => {
    state.rpc = (fn) =>
      fn === "request_privacy_export"
        ? { data: EXPORT, error: null }
        : fn === "get_privacy_export_payload"
          ? { data: { data: { contact: { id: CONTACT }, phones: [] }, sensitive: null }, error: null }
          : { data: null, error: null };
    const result = await exportSubjectData(CONTACT);
    expect(result.ok).toBe(false);
    expect(finishCalls().map(([, a]) => a)).toEqual([{ p_export_id: EXPORT, p_failure_code: "data_unavailable" }]);
  });

  it("fechar como concluído falha → o arquivo é DESCARTADO", async () => {
    state.rpc = (fn) => {
      if (fn === "request_privacy_export") return { data: EXPORT, error: null };
      if (fn === "get_privacy_export_payload") return { data: { data: fullData(), sensitive: null }, error: null };
      return { data: null, error: { message: "falha ao fechar" } };
    };
    const result = await exportSubjectData(CONTACT);
    expect(result).toEqual({ ok: false, status: 500, error: "export_failed" });
    expect("body" in result).toBe(false);
  });

  it("o registro de falha em si falhar não vira exceção nem vaza nada", async () => {
    decryptMock.mockImplementation(() => { throw new Error("x"); });
    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === "finish_privacy_export") throw new Error("rede");
      return state.rpc(fn, {});
    });
    await expect(exportSubjectData(CONTACT)).resolves.toEqual({ ok: false, status: 500, error: "export_failed" });
  });
});

describe("sigilo", () => {
  it("nada é escrito em log — nem no sucesso, nem na falha, nem com erro contendo PII", async () => {
    await exportSubjectData(CONTACT);
    decryptMock.mockImplementation(() => { throw new Error("CPF 12345678901 de Titular ALFA"); });
    await exportSubjectData(CONTACT);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("o conteúdo nunca vai para os argumentos das chamadas ao banco (só ids e códigos fechados)", async () => {
    decryptMock.mockImplementation(() => { throw new Error("x"); });
    await exportSubjectData(CONTACT);
    const sent = JSON.stringify(calls().map(([, args]) => args));
    expect(sent).not.toContain("Titular ALFA");
    expect(sent).not.toContain("12345678901");
  });
});
