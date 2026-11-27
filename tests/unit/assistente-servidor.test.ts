/**
 * Assistente — ações do servidor, com sessão e banco simulados. Conferem: escritório sempre da sessão,
 * permissões revalidadas na confirmação, pergunta só do que falta, duplicidade antes de gravar, repetição
 * sem segundo cadastro e recusas do banco como mensagens claras. As regras de verdade (papéis, contato do
 * escritório, uma gravação por chave, concorrência) estão provadas em
 * supabase/tests/database/64_assistente_cadastro.test.sql.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as PermissionsModule from "@/server/authz/permissions";

type Role = "owner" | "admin" | "manager" | "lawyer" | "sales" | "viewer";
type RpcResult = { data: unknown; error: { message: string } | null };

const state = vi.hoisted(() => ({
  role: "owner" as string,
  membershipError: null as Error | null,
  rpc: (() => ({ data: null, error: null })) as (fn: string, args: Record<string, unknown>) => RpcResult,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  scheduled: [] as string[],
  dashboard: (async () => ({ legalAreas: [], attention: { total: 0, items: [] }, generatedAt: "2026-11-26T15:00:00Z", stalledDays: 5 })) as () => Promise<unknown>,
  activities: (async () => ({ items: [], total: 0 })) as (filter: string) => Promise<unknown>,
}));

const WS = "10000000-0000-0000-0000-000000000001";
const OTHER_WS = "10000000-0000-0000-0000-000000000099";
const REQ = "e0000000-0000-4000-8000-000000000001";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return state.rpc(fn, args);
    },
  }),
}));
vi.mock("@/server/authz/permissions", async (importOriginal) => {
  const original = await importOriginal<typeof PermissionsModule>();
  return {
    ...original,
    requireMembership: async () => {
      if (state.membershipError) throw state.membershipError;
      return { userId: "u1", workspaceId: WS, membershipId: "m1", role: state.role };
    },
  };
});
vi.mock("@/modules/automations/run", () => ({ scheduleAutomationRun: (ws: string) => state.scheduled.push(ws) }));
vi.mock("@/modules/dashboard/queries", () => ({ getDashboard: () => state.dashboard() }));
vi.mock("@/modules/activities/queries", () => ({
  listActivities: (_ws: string, filters: { filter: string }) => state.activities(filters.filter),
}));

const { askAssistantAction, confirmRegistrationAction } = await import("@/modules/assistant/actions");
const { AuthzError } = await import("@/server/authz/permissions");

const blocksOf = async (text: string, pending: Record<string, string> | null = null) => askAssistantAction({ text, pending });

beforeEach(() => {
  state.role = "owner";
  state.membershipError = null;
  state.rpcCalls = [];
  state.scheduled = [];
  state.rpc = (fn) => (fn === "assistant_find_contact_matches" ? { data: [], error: null } : { data: null, error: null });
  state.dashboard = async () => ({ legalAreas: ["Família"], attention: { total: 0, items: [] }, generatedAt: "2026-11-26T15:00:00Z", stalledDays: 5 });
  state.activities = async () => ({ items: [], total: 0 });
});

describe("conversa", () => {
  it("toda resposta diz que a interpretação é simulada", async () => {
    const r = await blocksOf("bom dia");
    expect(r.interpreter).toEqual({ id: "simulado-v1", simulated: true });
    expect(r.blocks[0]).toMatchObject({ type: "text", text: expect.stringContaining("duas coisas") });
  });

  it("mensagem vazia é recusada antes de qualquer consulta", async () => {
    const r = await blocksOf("   ");
    expect(r.blocks[0]).toEqual({ type: "error", text: "Escreva uma mensagem." });
    expect(state.rpcCalls).toEqual([]);
  });

  it("sem sessão no escritório: resposta clara, nada consultado", async () => {
    state.membershipError = new AuthzError("not_a_member", "x");
    const r = await blocksOf("O que precisa da minha atenção hoje?");
    expect(r.blocks[0]).toMatchObject({ type: "denied" });
    expect(state.rpcCalls).toEqual([]);
  });
});

describe("diagnóstico", () => {
  it("consulta pelo escritório da sessão e informa a parte que falhou", async () => {
    state.activities = async (filter) => {
      if (filter === "today") throw new Error("rede");
      return { items: [], total: 0 };
    };
    const r = await blocksOf("O que precisa da minha atenção hoje?");
    expect(r.blocks[0]).toMatchObject({ type: "diagnosis" });
    const block = r.blocks[0] as { sections: { key: string; status: string }[]; summary: string };
    expect(block.sections.map((s) => `${s.key}:${s.status}`)).toEqual(["overdue:ok", "today:unavailable", "attention:ok"]);
    expect(block.summary).toContain("Não consegui consultar: agenda de hoje");
  });
});

describe("cadastro por conversa", () => {
  it("pergunta só o que falta e guarda o rascunho", async () => {
    const r = await blocksOf("Cadastre um cliente");
    expect(r.blocks[0]).toMatchObject({ type: "question", missing: ["name", "legalArea"] });
    expect(r.pending).toEqual({});

    const r2 = await blocksOf("Cadastre Ana Ribeiro");
    expect(r2.blocks[0]).toMatchObject({ type: "question", missing: ["legalArea"] });
    expect(r2.pending).toEqual({ name: "Ana Ribeiro" });
    expect(state.rpcCalls).toEqual([]);
  });

  it("com o que faltava, procura duplicidade no escritório da sessão e mostra o cartão", async () => {
    const r = await blocksOf("Família", { name: "Ana Ribeiro" });
    expect(state.rpcCalls).toEqual([{ fn: "assistant_find_contact_matches", args: { p_workspace_id: WS, p_name: "Ana Ribeiro" } }]);
    expect(r.blocks[1]).toMatchObject({ type: "confirm", draft: { name: "Ana Ribeiro", legalArea: "Família" }, decision: null });
    expect(r.pending).toBeNull();
  });

  it("possível duplicidade: mostra o registro encontrado para decidir, sem gravar", async () => {
    state.rpc = () => ({ data: [{ contact_id: "c1", name: "Ana Ribeiro", signals: ["same_name"], lead_count: 1 }], error: null });
    const r = await blocksOf("Cadastre Ana Ribeiro para um caso de regularização de imóvel");
    expect(r.blocks[1]).toMatchObject({
      type: "duplicate",
      matches: [{ contactId: "c1", name: "Ana Ribeiro", reasons: ["nome igual"], href: "/contatos/c1" }],
    });
    expect(state.rpcCalls.map((c) => c.fn)).toEqual(["assistant_find_contact_matches"]);
  });

  it("cancelar descarta o rascunho", async () => {
    const r = await blocksOf("cancelar", { name: "Ana" });
    expect(r.blocks[0]).toEqual({ type: "text", text: "Cadastro cancelado. Nada foi gravado." });
    expect(r.pending).toBeNull();
  });

  it.each<Role>(["viewer"])("perfil %s recebe a recusa ao pedir o cadastro", async (role) => {
    state.role = role;
    const r = await blocksOf("Cadastre Ana Ribeiro para um caso de regularização de imóvel");
    expect(r.blocks[0]).toEqual({ type: "denied", text: expect.stringContaining("Visualizador") });
    expect(state.rpcCalls).toEqual([]);
  });
});

describe("confirmação", () => {
  const draft = { name: "Ana Ribeiro", legalArea: "Imobiliário", summary: "Regularização de imóvel", phone: "(11) 98888-7777" };
  const saved = { data: { contact_id: "c9", lead_id: "l9", contact_created: true, replayed: false }, error: null };

  it("grava pelo escritório da sessão, nunca pelo que veio do navegador", async () => {
    state.rpc = (fn) => (fn === "assistant_register_client" ? saved : { data: [], error: null });
    const r = await confirmRegistrationAction({ requestId: REQ, draft, decision: { kind: "new" }, workspaceId: OTHER_WS });
    expect(r.outcome).toBe("saved");
    expect(state.rpcCalls).toEqual([
      {
        fn: "assistant_register_client",
        args: {
          p_workspace_id: WS,
          p_request_id: REQ,
          p_name: "Ana Ribeiro",
          p_legal_area: "Imobiliário",
          p_summary: "Regularização de imóvel",
          p_phones: [{ value_normalized: "+5511988887777", is_primary: true }],
          p_emails: [],
        },
      },
    ]);
    expect(r.blocks[0]).toMatchObject({ type: "success", contactHref: "/contatos/c9", leadHref: "/leads/l9", replayed: false });
    expect(state.scheduled).toEqual([WS]);
  });

  it("sem decisão, confere a duplicidade de novo antes de gravar", async () => {
    state.rpc = (fn) =>
      fn === "assistant_find_contact_matches" ? { data: [{ contact_id: "c1", name: "Ana Ribeiro", signals: ["phone"], lead_count: 0 }], error: null } : saved;
    const r = await confirmRegistrationAction({ requestId: REQ, draft, decision: null });
    expect(r.outcome).toBe("duplicate");
    expect(state.rpcCalls.map((c) => c.fn)).toEqual(["assistant_find_contact_matches"]);
  });

  it("contato existente: só o lead, com o nome do contato escolhido", async () => {
    state.rpc = () => ({ data: { contact_id: "c1", lead_id: "l2", contact_created: false, replayed: false }, error: null });
    const r = await confirmRegistrationAction({
      requestId: REQ,
      draft,
      decision: { kind: "existing", contactId: "a6400000-0000-4000-8000-000000000001", contactName: "Ana Ribeiro" },
    });
    expect(state.rpcCalls[0]!.args).toMatchObject({ p_existing_contact_id: "a6400000-0000-4000-8000-000000000001", p_phones: [], p_emails: [] });
    expect(r.blocks[0]).toMatchObject({ type: "success", contactCreated: false });
  });

  it("repetição devolve o mesmo cadastro, sem pedir outra rodada de automação", async () => {
    state.rpc = () => ({ data: { contact_id: "c9", lead_id: "l9", contact_created: true, replayed: true }, error: null });
    const r = await confirmRegistrationAction({ requestId: REQ, draft, decision: { kind: "new" } });
    expect(r.blocks[0]).toMatchObject({ type: "success", replayed: true, leadHref: "/leads/l9" });
    expect(state.scheduled).toEqual([]);
  });

  it("permissão revalidada na hora de confirmar", async () => {
    state.role = "viewer";
    const r = await confirmRegistrationAction({ requestId: REQ, draft, decision: { kind: "new" } });
    expect(r.outcome).toBe("denied");
    expect(state.rpcCalls).toEqual([]);
  });

  it("recusa do banco por permissão vira a mesma recusa", async () => {
    state.rpc = () => ({ data: null, error: { message: "insufficient_permission" } });
    const r = await confirmRegistrationAction({ requestId: REQ, draft, decision: { kind: "new" } });
    expect(r).toMatchObject({ outcome: "denied", blocks: [{ type: "denied" }] });
  });

  it.each([
    ["assistant_request_conflict", "Esta confirmação já foi usada com outros dados"],
    ["contact_not_found", "não está disponível neste escritório"],
    ["erro_qualquer", "Não foi possível concluir a operação"],
  ])("recusa %s: mensagem clara e “Nada foi gravado”", async (code, text) => {
    state.rpc = () => ({ data: null, error: { message: code } });
    const r = await confirmRegistrationAction({ requestId: REQ, draft, decision: { kind: "new" } });
    expect(r.outcome).toBe("failed");
    expect(r.message).toContain(text);
    expect(r.message).toContain("Nada foi gravado.");
  });

  it("dado inválido mantém o cartão aberto para corrigir", async () => {
    const r = await confirmRegistrationAction({ requestId: REQ, draft: { ...draft, phone: "12" }, decision: { kind: "new" } });
    expect(r).toEqual({ outcome: "invalid", blocks: [], message: "Telefone inválido." });
    expect(state.rpcCalls).toEqual([]);
  });

  it("chave de solicitação inválida não chega ao banco", async () => {
    const r = await confirmRegistrationAction({ requestId: "1", draft, decision: { kind: "new" } });
    expect(r.outcome).toBe("invalid");
    expect(state.rpcCalls).toEqual([]);
  });
});
