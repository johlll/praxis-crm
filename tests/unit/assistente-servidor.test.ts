/**
 * Assistente — ações do servidor, com sessão e banco simulados. Conferem: escritório sempre da sessão,
 * cartão ligado à pessoa e ao escritório que o abriram (recusado se o escritório ativo mudou, mesmo em
 * outra aba), permissões revalidadas na confirmação, pergunta só do que falta, resultado já gravado
 * recuperado antes da conferência de duplicidade, resultado incerto dito como incerto e recusas do banco
 * como mensagens claras. As regras de verdade (papéis, contato do
 * escritório, uma gravação por chave, concorrência) estão provadas em
 * supabase/tests/database/64_assistente_cadastro.test.sql.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as PermissionsModule from "@/server/authz/permissions";

type Role = "owner" | "admin" | "manager" | "lawyer" | "sales" | "viewer";
type RpcResult = { data: unknown; error: { message: string; code?: string } | null };

const state = vi.hoisted(() => ({
  role: "owner" as string,
  userId: "u1",
  workspaceId: "10000000-0000-0000-0000-000000000001",
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
      return { userId: state.userId, workspaceId: state.workspaceId, membershipId: "m1", role: state.role };
    },
  };
});
vi.mock("@/modules/automations/run", () => ({ scheduleAutomationRun: (ws: string) => state.scheduled.push(ws) }));
vi.mock("@/modules/dashboard/queries", () => ({ getDashboard: () => state.dashboard() }));
vi.mock("@/modules/activities/queries", () => ({
  listActivities: (_ws: string, filters: { filter: string }) => state.activities(filters.filter),
}));

const { askAssistantAction, confirmRegistrationAction } = await import("@/modules/assistant/actions");
const { issueCardTicket } = await import("@/server/assistant/card-ticket");
const { AuthzError } = await import("@/server/authz/permissions");

const blocksOf = async (text: string, pending: Record<string, string> | null = null) => askAssistantAction({ text, pending });

beforeEach(() => {
  state.role = "owner";
  state.userId = "u1";
  state.workspaceId = WS;
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
    // O cartão sai com o comprovante desta pessoa, deste escritório e desta chave.
    const card = r.blocks[1] as { requestId: string; ticket: string };
    expect(card.ticket).toBe(issueCardTicket({ userId: "u1", workspaceId: WS, requestId: card.requestId }));
  });

  it("possível duplicidade: mostra o registro encontrado para decidir, sem gravar", async () => {
    state.rpc = () => ({ data: [{ contact_id: "c1", name: "Ana Ribeiro", signals: ["same_name"] }], error: null });
    const r = await blocksOf("Cadastre Ana Ribeiro para um caso de regularização de imóvel");
    expect(r.blocks[1]).toMatchObject({
      type: "duplicate",
      matches: [{ contactId: "c1", name: "Ana Ribeiro", reasons: ["nome igual"], href: "/contatos/c1" }],
    });
    const card = r.blocks[1] as { requestId: string; ticket: string; matches: object[] };
    expect(card.ticket).toBe(issueCardTicket({ userId: "u1", workspaceId: WS, requestId: card.requestId }));
    expect(Object.keys(card.matches[0]!)).not.toContain("leadCount");
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
  const notYet = { data: null, error: null };
  /** Comprovante emitido para o cartão aberto pela pessoa u1 no escritório WS. */
  const ticket = (over: { userId?: string; workspaceId?: string; requestId?: string } = {}) =>
    issueCardTicket({ userId: "u1", workspaceId: WS, requestId: REQ, ...over });
  const confirm = (over: Record<string, unknown> = {}) =>
    confirmRegistrationAction({ requestId: REQ, ticket: ticket(), draft, decision: { kind: "new" }, ...over });
  const dbError = (message: string) => ({ data: null, error: { message, code: "P0001" } });
  const lostResponse = { data: null, error: { message: "TypeError: fetch failed", code: "" } };

  /** Banco: nada gravado para a chave, sem duplicidade, gravação conforme `register`. */
  const db = (register: RpcResult, prior: RpcResult = notYet) => (fn: string) =>
    fn === "assistant_find_registration" ? prior : fn === "assistant_register_client" ? register : { data: [], error: null };

  it("grava pelo escritório da sessão, nunca pelo que veio do navegador", async () => {
    state.rpc = db(saved);
    const r = await confirm({ workspaceId: OTHER_WS });
    expect(r.outcome).toBe("saved");
    const args = {
      p_workspace_id: WS,
      p_request_id: REQ,
      p_name: "Ana Ribeiro",
      p_legal_area: "Imobiliário",
      p_summary: "Regularização de imóvel",
      p_phones: [{ value_normalized: "+5511988887777", is_primary: true }],
      p_emails: [],
    };
    // Primeiro procura o resultado já gravado desta chave; só então grava, com os mesmos dados.
    expect(state.rpcCalls).toEqual([
      { fn: "assistant_find_registration", args },
      { fn: "assistant_register_client", args },
    ]);
    expect(r.blocks[0]).toMatchObject({ type: "success", contactHref: "/contatos/c9", leadHref: "/leads/l9", replayed: false });
    expect(state.scheduled).toEqual([WS]);
  });

  describe("cartão ligado à pessoa e ao escritório que o abriram", () => {
    it("aberto no escritório A, confirmado depois de trocar para B (outra aba): recusado, nada gravado em nenhum", async () => {
      // A mesma pessoa pode cadastrar nos dois escritórios.
      state.rpc = db(saved);
      state.workspaceId = OTHER_WS;
      const r = await confirm();
      expect(r).toMatchObject({ outcome: "stale", blocks: [{ type: "denied", text: expect.stringContaining("O escritório ativo mudou") }] });
      expect((r.blocks[0] as { text: string }).text).toContain("Nada foi gravado.");
      expect(state.rpcCalls).toEqual([]);
      expect(state.scheduled).toEqual([]);
    });

    it("e o caminho inverso (aberto em B, confirmado com A ativo) também", async () => {
      state.rpc = db(saved);
      const r = await confirm({ ticket: ticket({ workspaceId: OTHER_WS }) });
      expect(r.outcome).toBe("stale");
      expect(state.rpcCalls).toEqual([]);
    });

    it("cartão aberto por outra pessoa: recusado", async () => {
      state.rpc = db(saved);
      state.userId = "u2";
      const r = await confirm();
      expect(r).toMatchObject({ outcome: "stale", blocks: [{ type: "denied", text: expect.stringContaining("não pertence à sua sessão") }] });
      expect(state.rpcCalls).toEqual([]);
    });

    it.each([
      ["escritório trocado à mão no comprovante", () => `${OTHER_WS}.${ticket().split(".")[1]}`],
      ["comprovante de outra chave", () => ticket({ requestId: "e0000000-0000-4000-8000-000000000002" })],
      ["comprovante sem assinatura", () => WS],
      ["assinatura inventada", () => `${WS}.${"0".repeat(64)}`],
    ])("%s: recusado", async (_label, make) => {
      state.rpc = db(saved);
      const r = await confirm({ ticket: make() });
      expect(r.outcome).toBe("stale");
      expect(state.rpcCalls).toEqual([]);
    });

    it("sem comprovante não chega nem a conferir a sessão", async () => {
      const r = await confirmRegistrationAction({ requestId: REQ, draft, decision: { kind: "new" } });
      expect(r.outcome).toBe("invalid");
      expect(state.rpcCalls).toEqual([]);
    });
  });

  describe("resultado já gravado e resultado incerto", () => {
    const already = { data: { contact_id: "c9", lead_id: "l9", contact_created: true, replayed: true }, error: null };

    it("resposta da primeira gravação perdida: a nova tentativa devolve os mesmos links, sem aviso de duplicidade", async () => {
      // O contato recém-criado apareceria como duplicidade; a consulta do resultado vem antes.
      state.rpc = (fn) =>
        fn === "assistant_find_registration"
          ? already
          : fn === "assistant_find_contact_matches"
            ? { data: [{ contact_id: "c9", name: "Ana Ribeiro", signals: ["phone", "same_name"] }], error: null }
            : saved;
      const r = await confirm({ decision: null });
      expect(r).toMatchObject({ outcome: "saved", blocks: [{ type: "success", contactHref: "/contatos/c9", leadHref: "/leads/l9", replayed: true }] });
      expect(state.rpcCalls.map((c) => c.fn)).toEqual(["assistant_find_registration"]);
      expect(state.scheduled).toEqual([]);
    });

    it("mesma chave com outros dados continua recusada", async () => {
      state.rpc = db(saved, dbError("assistant_request_conflict"));
      const r = await confirm({ draft: { ...draft, name: "Ana Ribeiro Corrigida" } });
      expect(r.outcome).toBe("failed");
      expect(r.message).toContain("Esta confirmação já foi usada com outros dados");
      expect(r.message).toContain("Nada foi gravado.");
      expect(state.rpcCalls.map((c) => c.fn)).toEqual(["assistant_find_registration"]);
    });

    it("não deu para consultar o resultado anterior: incerto, e não grava nada agora", async () => {
      state.rpc = db(saved, lostResponse);
      const r = await confirm();
      expect(r.outcome).toBe("uncertain");
      expect(r.message).toContain("Não consegui conferir se esta confirmação já tinha sido gravada");
      expect(state.rpcCalls.map((c) => c.fn)).toEqual(["assistant_find_registration"]);
    });

    it("resposta da gravação perdida: diz que não sabe se gravou e orienta confirmar de novo", async () => {
      state.rpc = db(lostResponse);
      const r = await confirm();
      expect(r.outcome).toBe("uncertain");
      expect(r.message).toContain("Não consegui confirmar se o cadastro foi gravado");
      expect(r.message).toContain("sem criar outro");
      expect(r.message).not.toContain("Nada foi gravado");
    });

    it("gravação respondida sem os identificadores: incerto", async () => {
      state.rpc = db({ data: { replayed: false }, error: null });
      const r = await confirm();
      expect(r.outcome).toBe("uncertain");
    });

    it("solicitação ainda em andamento no banco: incerto", async () => {
      state.rpc = db(dbError("assistant_request_unavailable"));
      const r = await confirm();
      expect(r.outcome).toBe("uncertain");
    });
  });

  it("sem decisão e sem gravação anterior, confere a duplicidade de novo antes de gravar", async () => {
    state.rpc = (fn) =>
      fn === "assistant_find_contact_matches"
        ? { data: [{ contact_id: "c1", name: "Ana Ribeiro", signals: ["phone"] }], error: null }
        : fn === "assistant_find_registration"
          ? notYet
          : saved;
    const r = await confirm({ decision: null });
    expect(r.outcome).toBe("duplicate");
    expect(state.rpcCalls.map((c) => c.fn)).toEqual(["assistant_find_registration", "assistant_find_contact_matches"]);
    // O cartão de duplicidade continua com a mesma chave e o mesmo comprovante.
    expect(r.blocks[1]).toMatchObject({ type: "duplicate", requestId: REQ, ticket: ticket() });
  });

  it("contato existente: só o lead, com o nome do contato escolhido", async () => {
    state.rpc = db({ data: { contact_id: "c1", lead_id: "l2", contact_created: false, replayed: false }, error: null });
    const r = await confirm({ decision: { kind: "existing", contactId: "a6400000-0000-4000-8000-000000000001", contactName: "Ana Ribeiro" } });
    expect(state.rpcCalls[1]!.args).toMatchObject({ p_existing_contact_id: "a6400000-0000-4000-8000-000000000001", p_phones: [], p_emails: [] });
    expect(r.blocks[0]).toMatchObject({ type: "success", contactCreated: false });
  });

  it("repetição devolve o mesmo cadastro, sem pedir outra rodada de automação", async () => {
    state.rpc = db({ data: { contact_id: "c9", lead_id: "l9", contact_created: true, replayed: true }, error: null });
    const r = await confirm();
    expect(r.blocks[0]).toMatchObject({ type: "success", replayed: true, leadHref: "/leads/l9" });
    expect(state.scheduled).toEqual([]);
  });

  it("permissão revalidada na hora de confirmar", async () => {
    state.role = "viewer";
    const r = await confirm();
    expect(r.outcome).toBe("denied");
    expect(state.rpcCalls).toEqual([]);
  });

  it("recusa do banco por permissão vira a mesma recusa", async () => {
    state.rpc = () => dbError("insufficient_permission");
    const r = await confirm();
    expect(r).toMatchObject({ outcome: "denied", blocks: [{ type: "denied" }] });
  });

  it.each([
    ["assistant_request_conflict", "Esta confirmação já foi usada com outros dados"],
    ["contact_not_found", "não está disponível neste escritório"],
    ["erro_qualquer", "Não foi possível concluir a operação"],
  ])("recusa %s: mensagem clara e “Nada foi gravado”", async (code, text) => {
    state.rpc = db(dbError(code));
    const r = await confirm();
    expect(r.outcome).toBe("failed");
    expect(r.message).toContain(text);
    expect(r.message).toContain("Nada foi gravado.");
  });

  it("dado inválido mantém o cartão aberto para corrigir", async () => {
    const r = await confirm({ draft: { ...draft, phone: "12" } });
    expect(r).toEqual({ outcome: "invalid", blocks: [], message: "Telefone inválido." });
    expect(state.rpcCalls).toEqual([]);
  });

  it("chave de solicitação inválida não chega ao banco", async () => {
    const r = await confirm({ requestId: "1" });
    expect(r.outcome).toBe("invalid");
    expect(state.rpcCalls).toEqual([]);
  });
});
