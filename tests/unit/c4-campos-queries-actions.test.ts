/**
 * @vitest-environment node
 *
 * C4 — camada de servidor: leitura só por RPC (nunca tabela), contrato de erro,
 * e as Server Actions: permissão por entidade, workspace sempre da sessão,
 * tipos vindos do banco, gravação de valores numa única chamada, erros sanitizados.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data: unknown; error: { message: string } | null };

const state = vi.hoisted(() => ({
  allowed: new Set<string>(["custom_field.manage", "contact.edit", "lead.edit", "opportunity.edit", "client.manage"]),
  asked: [] as string[],
  rpc: ((): Result => ({ data: null, error: null })) as (fn: string, args: Record<string, unknown>) => Result,
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));
const { revalidatePathMock } = vi.hoisted(() => ({ revalidatePathMock: vi.fn() }));

const WS = "10000000-0000-0000-0000-000000000001";
const OTHER_WS = "10000000-0000-0000-0000-000000000002";
const LEAD = "80000000-0000-0000-0000-000000000001";
const DEF_TEXT = "a0000000-0000-0000-0000-000000000001";
const DEF_NUM = "a0000000-0000-0000-0000-000000000002";
const DEF_SEL = "a0000000-0000-0000-0000-000000000003";
const OPT1 = "b0000000-0000-0000-0000-000000000001";

vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.calls.push({ fn, args });
      return state.rpc(fn, args);
    },
  }),
}));
vi.mock("@/server/authz/safe", () => ({
  requirePermissionSafe: async (permission: string) => {
    state.asked.push(permission);
    if (!state.allowed.has(permission)) return { error: "Você não tem permissão para fazer isso." };
    return { ctx: { role: "owner", userId: "u1", workspaceId: WS, membershipId: "m1" } };
  },
}));

import {
  saveCustomFieldDefinitionAction,
  saveCustomFieldValuesAction,
  setCustomFieldArchivedAction,
} from "@/modules/custom-fields/actions";
import { CustomFieldLoadError, getCustomFieldValues, listCustomFieldDefinitions } from "@/modules/custom-fields/queries";

const FIELDS = [
  { definition_id: DEF_TEXT, name: "Observação", field_type: "text", position: 0, options: [], value: null },
  { definition_id: DEF_NUM, name: "Valor da causa", field_type: "number", position: 1, options: [], value: 10 },
  { definition_id: DEF_SEL, name: "Fase", field_type: "select", position: 2, options: [{ id: OPT1, label: "Recursal" }], value: null },
];
const setCalls = () => state.calls.filter((c) => c.fn === "set_custom_field_values");

beforeEach(() => {
  vi.clearAllMocks();
  state.allowed = new Set(["custom_field.manage", "contact.edit", "lead.edit", "opportunity.edit", "client.manage"]);
  state.asked = [];
  state.calls = [];
  state.rpc = (fn) => ({ data: fn === "get_custom_field_values" ? FIELDS : fn === "set_custom_field_values" ? 2 : null, error: null });
});

describe("leitura", () => {
  it("lista as definições só pela RPC do workspace e converte o formato", async () => {
    state.rpc = () => ({
      data: [
        {
          id: DEF_SEL,
          entity_type: "lead",
          name: "Fase",
          field_type: "select",
          position: 2,
          archived: false,
          options: [{ id: OPT1, label: "Recursal", in_use: true }],
        },
      ],
      error: null,
    });
    const list = await listCustomFieldDefinitions(WS);
    expect(state.calls).toEqual([{ fn: "list_custom_field_definitions", args: { p_workspace_id: WS } }]);
    expect(list).toEqual([
      { id: DEF_SEL, entity: "lead", name: "Fase", type: "select", position: 2, archived: false, options: [{ id: OPT1, label: "Recursal", inUse: true }] },
    ]);
  });

  it("sem permissão → null (a página responde 'não encontrado'); outra falha → erro tipado, sem texto do banco", async () => {
    state.rpc = () => ({ data: null, error: { message: "insufficient_permission" } });
    expect(await listCustomFieldDefinitions(WS)).toBeNull();

    state.rpc = () => ({ data: null, error: { message: 'relation "x" does not exist: senha=segredo' } });
    const error = await listCustomFieldDefinitions(WS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CustomFieldLoadError);
    expect(String((error as Error).message)).not.toMatch(/segredo|relation/);
  });

  it("linha fora do formato nunca vira lista vazia", async () => {
    state.rpc = () => ({ data: [{ id: "não-é-uuid" }], error: null });
    await expect(listCustomFieldDefinitions(WS)).rejects.toBeInstanceOf(CustomFieldLoadError);
  });

  it("valores do registro: pela RPC com entidade e id; registro fora do alcance ou de outro workspace → null", async () => {
    const fields = await getCustomFieldValues("lead", LEAD);
    expect(state.calls[0]).toEqual({ fn: "get_custom_field_values", args: { p_entity_type: "lead", p_record_id: LEAD } });
    expect(fields?.map((f) => f.definitionId)).toEqual([DEF_TEXT, DEF_NUM, DEF_SEL]);

    state.rpc = () => ({ data: null, error: { message: "custom_field_record_not_found" } });
    expect(await getCustomFieldValues("lead", LEAD)).toBeNull();
    state.rpc = () => ({ data: null, error: { message: "insufficient_permission" } });
    expect(await getCustomFieldValues("lead", LEAD)).toBeNull();
    state.rpc = () => ({ data: null, error: { message: "timeout" } });
    await expect(getCustomFieldValues("lead", LEAD)).rejects.toBeInstanceOf(CustomFieldLoadError);
  });
});

describe("definições (Server Actions)", () => {
  const form = (over: Record<string, string> = {}) => {
    const fd = new FormData();
    const base = { entity: "lead", name: "Valor da causa", type: "number", position: "", options: "[]", ...over };
    for (const [k, v] of Object.entries(base)) fd.set(k, v);
    return fd;
  };

  it("sem custom_field.manage: nada chega ao banco", async () => {
    state.allowed.delete("custom_field.manage");
    expect((await saveCustomFieldDefinitionAction(form())).ok).toBe(false);
    expect((await setCustomFieldArchivedAction(DEF_TEXT, true)).ok).toBe(false);
    expect(state.calls).toEqual([]);
  });

  it("criar: o workspace é o da SESSÃO, mesmo que o formulário traga outro", async () => {
    state.rpc = (fn) => ({ data: fn === "create_custom_field" ? DEF_NUM : null, error: null });
    const fd = form();
    fd.set("workspaceId", OTHER_WS);
    fd.set("workspace_id", OTHER_WS);
    const result = await saveCustomFieldDefinitionAction(fd);
    expect(result).toEqual({ ok: true, definitionId: DEF_NUM });
    expect(state.calls).toEqual([
      { fn: "create_custom_field", args: { p_workspace_id: WS, p_entity_type: "lead", p_name: "Valor da causa", p_field_type: "number" } },
    ]);
    expect(revalidatePathMock).toHaveBeenCalledWith("/configuracoes/campos-personalizados");
  });

  it("criar seleção única leva as opções e a posição; tipo fora da lista é recusado antes do banco", async () => {
    state.rpc = (fn) => ({ data: fn === "create_custom_field" ? DEF_SEL : null, error: null });
    await saveCustomFieldDefinitionAction(form({ type: "select", position: "4", options: JSON.stringify([{ label: "Sim" }, { label: "Não" }]) }));
    expect(state.calls[0]?.args).toMatchObject({ p_field_type: "select", p_position: 4, p_options: [{ label: "Sim" }, { label: "Não" }] });

    state.calls = [];
    expect((await saveCustomFieldDefinitionAction(form({ type: "multiselect" }))).ok).toBe(false);
    expect((await saveCustomFieldDefinitionAction(form({ entity: "proposal" }))).ok).toBe(false);
    expect((await saveCustomFieldDefinitionAction(form({ options: "{lixo" }))).ok).toBe(false);
    expect(state.calls).toEqual([]);
  });

  it("editar: a RPC NÃO recebe tipo nem entidade (não mudam), só nome, posição e opções", async () => {
    const fd = form({ definitionId: DEF_SEL, type: "select", entity: "client", position: "2", options: JSON.stringify([{ id: OPT1, label: "Recursal" }]) });
    expect((await saveCustomFieldDefinitionAction(fd)).ok).toBe(true);
    expect(state.calls).toEqual([
      { fn: "update_custom_field", args: { p_definition_id: DEF_SEL, p_name: "Valor da causa", p_position: 2, p_options: [{ id: OPT1, label: "Recursal" }] } },
    ]);
    expect(Object.keys(state.calls[0]!.args)).not.toEqual(expect.arrayContaining(["p_field_type"]));
    expect(Object.keys(state.calls[0]!.args)).not.toEqual(expect.arrayContaining(["p_entity_type"]));
  });

  it("opção usada: o erro do banco volta como mensagem clara, sem o código cru", async () => {
    state.rpc = () => ({ data: null, error: { message: "custom_field_option_in_use" } });
    const result = await saveCustomFieldDefinitionAction(form({ definitionId: DEF_SEL, type: "select", options: JSON.stringify([{ label: "Nova" }]) }));
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).not.toContain("custom_field_option_in_use");
    expect((result as { error: string }).error).toMatch(/opç/i);
  });

  it("arquivar e restaurar: id e booleano validados; sucesso revalida a tela", async () => {
    expect(await setCustomFieldArchivedAction(DEF_TEXT, true)).toEqual({ ok: true });
    expect(state.calls[0]).toEqual({ fn: "set_custom_field_archived", args: { p_definition_id: DEF_TEXT, p_archived: true } });
    expect((await setCustomFieldArchivedAction("não-é-uuid", true)).ok).toBe(false);
    expect((await setCustomFieldArchivedAction(DEF_TEXT, "sim" as unknown as boolean)).ok).toBe(false);
    expect(state.calls).toHaveLength(1);
  });
});

describe("valores (Server Action)", () => {
  const values = (entries: Record<string, string>) => {
    const fd = new FormData();
    for (const [definitionId, raw] of Object.entries(entries)) fd.set(`cf_${definitionId}`, raw);
    return fd;
  };

  it.each([
    ["contact", "contact.edit"],
    ["lead", "lead.edit"],
    ["opportunity", "opportunity.edit"],
    ["client", "client.manage"],
  ] as const)("%s: exige %s e, sem ela, não toca no banco", async (entity, permission) => {
    state.allowed.delete(permission);
    const result = await saveCustomFieldValuesAction(entity, LEAD, values({ [DEF_TEXT]: "x" }));
    expect(state.asked).toEqual([permission]);
    expect(result.ok).toBe(false);
    expect(state.calls).toEqual([]);
  });

  it("entidade ou registro fora da lista fechada são recusados sem consultar nada", async () => {
    expect((await saveCustomFieldValuesAction("proposal", LEAD, values({}))).ok).toBe(false);
    expect((await saveCustomFieldValuesAction("lead", "não-é-uuid", values({}))).ok).toBe(false);
    expect(state.asked).toEqual([]);
    expect(state.calls).toEqual([]);
  });

  it("uma única gravação com todos os valores, tipados pelo BANCO; workspace e usuário nunca vão", async () => {
    const fd = values({ [DEF_TEXT]: "  Indicação  ", [DEF_NUM]: "1.234,5", [DEF_SEL]: OPT1 });
    // O navegador "diz" outros tipos e outro workspace: nada disso conta.
    fd.set("workspaceId", OTHER_WS);
    fd.set(`type_${DEF_NUM}`, "text");
    fd.set("cf_a0000000-0000-0000-0000-0000000000ff", "definição que não existe para este registro");

    const result = await saveCustomFieldValuesAction("lead", LEAD, fd);
    // "1.234,5" tem separador de milhar: o número aceito é o simples (ver schema); aqui deve falhar.
    expect(result.ok).toBe(false);
    expect(setCalls()).toHaveLength(0);

    const ok = await saveCustomFieldValuesAction("lead", LEAD, values({ [DEF_TEXT]: "  Indicação  ", [DEF_NUM]: "1234,5", [DEF_SEL]: OPT1 }));
    expect(ok).toEqual({ ok: true, changed: 2 });
    expect(setCalls()).toHaveLength(1);
    expect(setCalls()[0]?.args).toEqual({
      p_entity_type: "lead",
      p_record_id: LEAD,
      p_values: [
        { definition_id: DEF_TEXT, value: "Indicação" },
        { definition_id: DEF_NUM, value: 1234.5 },
        { definition_id: DEF_SEL, value: OPT1 },
      ],
    });
    expect(JSON.stringify(setCalls()[0]?.args)).not.toContain(OTHER_WS);
    expect(revalidatePathMock).toHaveBeenCalledWith(`/leads/${LEAD}`);
  });

  it("campo vazio limpa (null); campo ausente do envio não é tocado", async () => {
    await saveCustomFieldValuesAction("lead", LEAD, values({ [DEF_TEXT]: "" }));
    expect(setCalls()[0]?.args).toMatchObject({ p_values: [{ definition_id: DEF_TEXT, value: null }] });
  });

  it("valor inválido para o tipo: erro com o nome do campo e NENHUMA gravação (tudo ou nada)", async () => {
    const result = await saveCustomFieldValuesAction("lead", LEAD, values({ [DEF_TEXT]: "ok", [DEF_NUM]: "muito" }));
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("Valor da causa");
    expect(setCalls()).toHaveLength(0);
  });

  it("registro fora do alcance (o banco responde 'não encontrado'): erro, sem gravar", async () => {
    state.rpc = () => ({ data: null, error: { message: "custom_field_record_not_found" } });
    const result = await saveCustomFieldValuesAction("lead", LEAD, values({ [DEF_TEXT]: "x" }));
    expect(result).toEqual({ ok: false, error: "Registro não encontrado." });
    expect(setCalls()).toHaveLength(0);
  });

  it("erro do banco na gravação volta sanitizado", async () => {
    state.rpc = (fn) =>
      fn === "get_custom_field_values" ? { data: FIELDS, error: null } : { data: null, error: { message: 'duplicate key value violates "x": maria@exemplo.com' } };
    const result = await saveCustomFieldValuesAction("lead", LEAD, values({ [DEF_TEXT]: "x" }));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/duplicate|maria|exemplo/);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("falha ao carregar os campos (rede) não vira gravação", async () => {
    state.rpc = () => ({ data: null, error: { message: "timeout" } });
    const result = await saveCustomFieldValuesAction("lead", LEAD, values({ [DEF_TEXT]: "x" }));
    expect(result.ok).toBe(false);
    expect(setCalls()).toHaveLength(0);
  });
});
