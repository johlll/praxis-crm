/**
 * @vitest-environment node
 *
 * C3a — orquestração da exportação: o ator vem SÓ do contexto confiável do servidor, as
 * três RPCs passam pelo cliente administrativo (nunca pela sessão), falha em qualquer
 * ponto — inclusive Promise rejeitada — fecha o registro como FALHA e não entrega
 * arquivo, o registro só vira "concluído" com confirmação, e nada vai para o log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CONTACT = "c0000000-0000-4000-8000-000000000001";
const EXPORT = "e0000000-0000-4000-8000-000000000001";
const ACTOR = "a0000000-0000-4000-8000-000000000001";
const WS = "b0000000-0000-4000-8000-0000000000b1";

type RpcResult = { data: unknown; error: { message: string } | null };

const state = vi.hoisted(() => ({
  guard: null as unknown as { ctx?: { userId: string; workspaceId: string; role: string }; error?: string },
  rpc: null as unknown as (fn: string, args: Record<string, unknown>) => RpcResult | Promise<RpcResult>,
  clientThrows: false,
}));
const { decryptMock, rpcMock, sessionClientMock } = vi.hoisted(() => ({
  decryptMock: vi.fn(),
  rpcMock: vi.fn(),
  sessionClientMock: vi.fn(),
}));

vi.mock("@/server/authz/safe", () => ({ requirePermissionSafe: async () => state.guard }));
vi.mock("@/server/privacy/admin/supabase", () => ({
  createPrivacyAdminSupabaseClient: () => {
    if (state.clientThrows) throw new Error("SUPABASE_SECRET_KEY ausente: 12345678901");
    return { rpc: rpcMock };
  },
}));
// A sessão do usuário NÃO pode ser usada neste fluxo: se alguém a importar, o teste vê.
vi.mock("@/server/supabase/server", () => ({ createServerSupabaseClient: sessionClientMock }));
vi.mock("@/server/crypto/contact-sensitive", () => ({ decryptCpfCnpj: decryptMock }));

import { PRIVACY_EXPORT_LIST_CATEGORIES } from "@/modules/privacy/export-format";
import { exportSubjectData } from "@/server/privacy/export-subject";

function fullData(over: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { contact: { id: CONTACT, name: "Titular ALFA" } };
  for (const key of PRIVACY_EXPORT_LIST_CATEGORIES) data[key] = [];
  return { ...data, ...over };
}

const okPayload = () => ({ data: { data: fullData(), sensitive: { ciphertext_base64: "Y2lwaGVy", key_version: "v2" } }, error: null });

const calls = () => rpcMock.mock.calls.map(([fn, args]) => [fn, args] as [string, Record<string, unknown>]);
const names = () => calls().map(([fn]) => fn);
const finishCalls = () => calls().filter(([fn]) => fn === "finish_privacy_export");
const FAILED = { ok: false, status: 500, error: "export_failed" };

let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  vi.clearAllMocks();
  state.clientThrows = false;
  state.guard = { ctx: { userId: ACTOR, workspaceId: WS, role: "owner" } };
  decryptMock.mockReturnValue("12345678901");
  state.rpc = (fn) => {
    if (fn === "request_privacy_export") return { data: EXPORT, error: null };
    if (fn === "get_privacy_export_payload") return okPayload();
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
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = JSON.parse(result.body);
    expect(doc.sections.sensitive_data.items).toEqual([{ field: "cpf_cnpj", value: "12345678901" }]);
    expect(result.fileName).toMatch(new RegExp(`^titular-${CONTACT}-\\d{4}-\\d{2}-\\d{2}\\.json$`));
  });

  it("o ator é SEMPRE o do contexto confiável, nas três chamadas — nunca algo vindo da requisição", async () => {
    await exportSubjectData(CONTACT);
    expect(calls()).toEqual([
      ["request_privacy_export", { p_actor_user_id: ACTOR, p_workspace_id: WS, p_contact_id: CONTACT }],
      ["get_privacy_export_payload", { p_actor_user_id: ACTOR, p_workspace_id: WS, p_export_id: EXPORT }],
      ["finish_privacy_export", { p_actor_user_id: ACTOR, p_workspace_id: WS, p_export_id: EXPORT }],
    ]);
  });

  it("o workspace enviado às RPCs é exatamente o ATIVO confiável (guard.ctx.workspaceId) — nas três chamadas e em qualquer valor", async () => {
    for (const workspaceId of [WS, "b0000000-0000-4000-8000-0000000000b2"]) {
      rpcMock.mockClear();
      state.guard = { ctx: { userId: ACTOR, workspaceId, role: "admin" } };
      await exportSubjectData(CONTACT);
      expect(calls()).toHaveLength(3);
      for (const [, args] of calls()) expect(args.p_workspace_id).toBe(workspaceId);
    }
  });

  it("a única entrada da requisição é o id do contato: não existe como informar workspace ou ator por fora", async () => {
    expect(exportSubjectData.length).toBe(1);
    state.guard = { ctx: { userId: ACTOR, workspaceId: WS, role: "owner" } };
    // Mesmo que o "id do contato" venha carregando outro workspace, ele só é usado como p_contact_id.
    await exportSubjectData(`${CONTACT}&p_workspace_id=00000000-0000-4000-8000-000000000bad`);
    const first = calls()[0]![1];
    expect(first.p_workspace_id).toBe(WS);
    expect(first.p_contact_id).toBe(`${CONTACT}&p_workspace_id=00000000-0000-4000-8000-000000000bad`);
  });

  it("nenhuma RPC da exportação passa pela sessão do usuário", async () => {
    await exportSubjectData(CONTACT);
    expect(sessionClientMock).not.toHaveBeenCalled();
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
  it("sem a permissão do servidor: 403, sem cliente administrativo e sem chamada ao banco", async () => {
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
  it("leitura devolve erro → registro 'data_unavailable', sem decifrar", async () => {
    state.rpc = (fn) =>
      fn === "request_privacy_export" ? { data: EXPORT, error: null } : fn === "get_privacy_export_payload" ? { data: null, error: { message: "timeout" } } : { data: null, error: null };
    expect(await exportSubjectData(CONTACT)).toEqual(FAILED);
    expect(finishCalls().map(([, a]) => a)).toEqual([{ p_actor_user_id: ACTOR, p_workspace_id: WS, p_export_id: EXPORT, p_failure_code: "data_unavailable" }]);
    expect(decryptMock).not.toHaveBeenCalled();
  });

  it("decifra falha → registro 'decryption_failed' e nada do conteúdo sai", async () => {
    decryptMock.mockImplementation(() => {
      throw new Error("tag inválida do CPF 12345678901");
    });
    const result = await exportSubjectData(CONTACT);
    expect(result).toEqual(FAILED);
    expect(JSON.stringify(result)).not.toContain("12345678901");
    expect(finishCalls().map(([, a]) => a)).toEqual([{ p_actor_user_id: ACTOR, p_workspace_id: WS, p_export_id: EXPORT, p_failure_code: "decryption_failed" }]);
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
    expect(finishCalls().map(([, a]) => a)).toEqual([{ p_actor_user_id: ACTOR, p_workspace_id: WS, p_export_id: EXPORT, p_failure_code: "data_unavailable" }]);
  });

  it("fechar como concluído devolve erro → o arquivo é DESCARTADO", async () => {
    state.rpc = (fn) => {
      if (fn === "request_privacy_export") return { data: EXPORT, error: null };
      if (fn === "get_privacy_export_payload") return { data: { data: fullData(), sensitive: null }, error: null };
      return { data: null, error: { message: "falha ao fechar" } };
    };
    const result = await exportSubjectData(CONTACT);
    expect(result).toEqual(FAILED);
    expect("body" in result).toBe(false);
  });

  it("o fechamento como falha devolver { error } continua falhando fechado, sem arquivo", async () => {
    decryptMock.mockImplementation(() => {
      throw new Error("x");
    });
    state.rpc = (fn) => {
      if (fn === "request_privacy_export") return { data: EXPORT, error: null };
      if (fn === "get_privacy_export_payload") return okPayload();
      return { data: null, error: { message: "não consegui fechar" } };
    };
    const result = await exportSubjectData(CONTACT);
    expect(result).toEqual(FAILED);
    expect("body" in result).toBe(false);
    expect(finishCalls()).toHaveLength(1);
  });
});

describe("exceções de transporte (Promise rejeitada) nunca escapam", () => {
  const boom = () => {
    throw new Error("ECONNRESET Titular ALFA 12345678901");
  };

  it("criação do cliente administrativo falha → 500 fechado, nenhuma chamada", async () => {
    state.clientThrows = true;
    await expect(exportSubjectData(CONTACT)).resolves.toEqual(FAILED);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("abertura rejeita → 500 fechado (nada foi aberto, nada a fechar)", async () => {
    state.rpc = (fn) => (fn === "request_privacy_export" ? boom() : { data: null, error: null });
    await expect(exportSubjectData(CONTACT)).resolves.toEqual(FAILED);
    expect(names()).toEqual(["request_privacy_export"]);
  });

  it("leitura rejeita → tenta fechar como falha e não entrega nada", async () => {
    state.rpc = (fn) => {
      if (fn === "request_privacy_export") return { data: EXPORT, error: null };
      if (fn === "get_privacy_export_payload") return boom();
      return { data: null, error: null };
    };
    const result = await exportSubjectData(CONTACT);
    expect(result).toEqual(FAILED);
    expect(finishCalls().map(([, a]) => a)).toEqual([{ p_actor_user_id: ACTOR, p_workspace_id: WS, p_export_id: EXPORT, p_failure_code: "internal_error" }]);
    expect(decryptMock).not.toHaveBeenCalled();
  });

  it("fechamento como concluído rejeita → tenta fechar como falha e o arquivo é descartado", async () => {
    let finishes = 0;
    state.rpc = (fn) => {
      if (fn === "request_privacy_export") return { data: EXPORT, error: null };
      if (fn === "get_privacy_export_payload") return okPayload();
      finishes += 1;
      return finishes === 1 ? boom() : { data: null, error: null };
    };
    const result = await exportSubjectData(CONTACT);
    expect(result).toEqual(FAILED);
    expect("body" in result).toBe(false);
    expect(finishCalls().map(([, a]) => a)).toEqual([
      { p_actor_user_id: ACTOR, p_workspace_id: WS, p_export_id: EXPORT },
      { p_actor_user_id: ACTOR, p_workspace_id: WS, p_export_id: EXPORT, p_failure_code: "internal_error" },
    ]);
  });

  it("o fechamento como falha também rejeita → continua falhando fechado, sem arquivo e sem exceção", async () => {
    decryptMock.mockImplementation(() => {
      throw new Error("x");
    });
    state.rpc = (fn) => {
      if (fn === "request_privacy_export") return { data: EXPORT, error: null };
      if (fn === "get_privacy_export_payload") return okPayload();
      return boom();
    };
    const result = await exportSubjectData(CONTACT);
    expect(result).toEqual(FAILED);
    expect("body" in result).toBe(false);
  });

  it("o resultado nunca carrega mensagem, stack nem PII das exceções", async () => {
    state.rpc = () => boom();
    const result = await exportSubjectData(CONTACT);
    expect(JSON.stringify(result)).not.toMatch(/ECONNRESET|ALFA|12345678901|stack/i);
  });
});

describe("sigilo", () => {
  it("nada é escrito em log — nem no sucesso, nem na falha, nem em exceção com PII", async () => {
    await exportSubjectData(CONTACT);
    decryptMock.mockImplementation(() => {
      throw new Error("CPF 12345678901 de Titular ALFA");
    });
    await exportSubjectData(CONTACT);
    state.rpc = () => {
      throw new Error("ECONNRESET Titular ALFA 12345678901");
    };
    await exportSubjectData(CONTACT);
    state.clientThrows = true;
    await exportSubjectData(CONTACT);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("o conteúdo nunca vai para os argumentos das chamadas ao banco (só ids e códigos fechados)", async () => {
    decryptMock.mockImplementation(() => {
      throw new Error("x");
    });
    await exportSubjectData(CONTACT);
    const sent = JSON.stringify(calls().map(([, args]) => args));
    expect(sent).not.toContain("Titular ALFA");
    expect(sent).not.toContain("12345678901");
  });
});
