/**
 * @vitest-environment node
 *
 * C3b — orquestração da retenção e da anonimização: ator e workspace ativo vêm SÓ do contexto
 * confiável, as RPCs passam pelo cliente administrativo (nunca pela sessão), recusa e falha viram
 * resultado fechado, formato inesperado nunca vira dado parcial, e nada vai para o log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CONTACT = "c0000000-0000-4000-8000-000000000001";
const HOLD = "d0000000-0000-4000-8000-000000000001";
const ACTOR = "a0000000-0000-4000-8000-000000000001";
const WS = "b0000000-0000-4000-8000-0000000000b1";

type RpcResult = { data: unknown; error: { message: string } | null };

const state = vi.hoisted(() => ({
  guard: null as unknown as { ctx?: { userId: string; workspaceId: string; role: string }; error?: string },
  rpc: null as unknown as (fn: string, args: Record<string, unknown>) => RpcResult | Promise<RpcResult>,
  clientThrows: false,
  clientCreated: 0,
}));
const { rpcMock, sessionClientMock } = vi.hoisted(() => ({ rpcMock: vi.fn(), sessionClientMock: vi.fn() }));

vi.mock("@/server/authz/safe", () => ({ requirePermissionSafe: async () => state.guard }));
vi.mock("@/server/privacy/admin/supabase", () => ({
  createPrivacyAdminSupabaseClient: () => {
    state.clientCreated += 1;
    if (state.clientThrows) throw new Error("SUPABASE_SECRET_KEY ausente: 12345678901");
    return { rpc: rpcMock };
  },
}));
// A sessão do usuário NÃO pode ser usada neste fluxo: se alguém a importar, o teste vê.
vi.mock("@/server/supabase/server", () => ({ createServerSupabaseClient: sessionClientMock }));

import { anonymizeContact, createLegalHold, getRetentionStatus, releaseLegalHold } from "@/server/privacy/retention";

const status = (over: Record<string, unknown> = {}) => ({
  state: "eligible",
  eligible: true,
  reasons: [],
  lead_count: 1,
  archived_lead_count: 1,
  retention_due_at: "2026-01-01T00:00:00+00:00",
  anonymized_at: null,
  retention_months: 12,
  holds: [],
  ...over,
});

const calls = () => rpcMock.mock.calls.map(([fn, args]) => [fn, args] as [string, Record<string, unknown>]);
const names = () => calls().map(([fn]) => fn);
const FAILED = { ok: false, status: 500, error: "retention_failed" };

let spies: Array<ReturnType<typeof vi.spyOn>> = [];
beforeEach(() => {
  vi.clearAllMocks();
  state.clientThrows = false;
  state.clientCreated = 0;
  state.guard = { ctx: { userId: ACTOR, workspaceId: WS, role: "owner" } };
  state.rpc = (fn) => {
    if (fn === "get_privacy_retention_status") return { data: status(), error: null };
    if (fn === "create_privacy_legal_hold") return { data: HOLD, error: null };
    if (fn === "anonymize_privacy_contact") return { data: { result: "anonymized" }, error: null };
    return { data: null, error: null };
  };
  rpcMock.mockImplementation(async (fn: string, args: Record<string, unknown>) => state.rpc(fn, args));
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => spies.forEach((spy) => spy.mockRestore()));

describe("escopo confiável", () => {
  it("ator e workspace ativo do contexto vão em TODA chamada ao banco", async () => {
    await getRetentionStatus(CONTACT);
    await createLegalHold(CONTACT, "judicial_process");
    await releaseLegalHold(CONTACT, HOLD);
    await anonymizeContact(CONTACT);
    expect(calls().length).toBeGreaterThanOrEqual(7);
    for (const [, args] of calls()) {
      expect(args.p_actor_user_id).toBe(ACTOR);
      expect(args.p_workspace_id).toBe(WS);
    }
  });

  it("as chamadas levam só ids e o código fechado — nenhum prazo, nenhum texto", async () => {
    await createLegalHold(CONTACT, "case_in_progress");
    expect(calls()[0]).toEqual([
      "create_privacy_legal_hold",
      { p_actor_user_id: ACTOR, p_workspace_id: WS, p_contact_id: CONTACT, p_reason_code: "case_in_progress" },
    ]);
    await anonymizeContact(CONTACT);
    const anonymize = calls().find(([fn]) => fn === "anonymize_privacy_contact")!;
    expect(Object.keys(anonymize[1]).sort()).toEqual(["p_actor_user_id", "p_contact_id", "p_workspace_id"]);
  });

  it("sem permissão: 403, o cliente do banco nem é criado e nenhuma RPC roda", async () => {
    state.guard = { error: "Você não tem permissão para fazer isso." };
    for (const result of [
      await getRetentionStatus(CONTACT),
      await createLegalHold(CONTACT, "other_legal"),
      await releaseLegalHold(CONTACT, HOLD),
      await anonymizeContact(CONTACT),
    ]) {
      expect(result).toEqual({ ok: false, status: 403, error: "forbidden" });
    }
    expect(state.clientCreated).toBe(0);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("a sessão do usuário nunca é usada", async () => {
    await anonymizeContact(CONTACT);
    expect(sessionClientMock).not.toHaveBeenCalled();
  });
});

describe("estado", () => {
  it("devolve o estado validado, sem conteúdo", async () => {
    const result = await getRetentionStatus(CONTACT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status.state).toBe("eligible");
    expect(names()).toEqual(["get_privacy_retention_status"]);
  });

  it("formato inesperado do banco vira falha fechada — nunca estado parcial", async () => {
    state.rpc = () => ({ data: { state: "eligible", reasons: ["texto-livre-qualquer"] }, error: null });
    expect(await getRetentionStatus(CONTACT)).toEqual(FAILED);
    state.rpc = () => ({ data: null, error: null });
    expect(await getRetentionStatus(CONTACT)).toEqual(FAILED);
  });

  it("contato inexistente, de outro workspace ou já anonimizado: 404; sem papel: 403", async () => {
    state.rpc = () => ({ data: null, error: { message: "contact_not_found" } });
    expect(await getRetentionStatus(CONTACT)).toEqual({ ok: false, status: 404, error: "not_found" });
    state.rpc = () => ({ data: null, error: { message: "insufficient_permission" } });
    expect(await getRetentionStatus(CONTACT)).toEqual({ ok: false, status: 403, error: "forbidden" });
    state.rpc = () => ({ data: null, error: { message: "contact_already_anonymized" } });
    expect(await createLegalHold(CONTACT, "other_legal")).toEqual({ ok: false, status: 404, error: "not_found" });
    state.rpc = () => ({ data: null, error: { message: "legal_hold_not_found" } });
    expect(await releaseLegalHold(CONTACT, HOLD)).toEqual({ ok: false, status: 404, error: "not_found" });
  });
});

describe("preservação legal", () => {
  it("criar e encerrar devolvem o estado atualizado", async () => {
    state.rpc = (fn) =>
      fn === "get_privacy_retention_status"
        ? { data: status({ holds: [{ id: HOLD, reason_code: "judicial_process", status: "active", created_at: "2026-11-10T00:00:00+00:00", released_at: null }] }), error: null }
        : { data: HOLD, error: null };
    const created = await createLegalHold(CONTACT, "judicial_process");
    expect(created.ok && created.status.holds[0]?.reason_code).toBe("judicial_process");
    expect(names()).toEqual(["create_privacy_legal_hold", "get_privacy_retention_status"]);
    rpcMock.mockClear();
    const released = await releaseLegalHold(CONTACT, HOLD);
    expect(released.ok).toBe(true);
    expect(calls()[0]).toEqual(["release_privacy_legal_hold", { p_actor_user_id: ACTOR, p_workspace_id: WS, p_hold_id: HOLD }]);
  });

  it("motivo inválido recusado pelo banco não vira sucesso", async () => {
    state.rpc = () => ({ data: null, error: { message: "invalid_legal_hold_reason" } });
    expect(await createLegalHold(CONTACT, "other_legal")).toEqual(FAILED);
  });
});

describe("anonimização", () => {
  it.each(["anonymized", "already_anonymized", "refused", "failed"] as const)("resultado %s volta com o estado atualizado", async (outcome) => {
    state.rpc = (fn) =>
      fn === "anonymize_privacy_contact"
        ? { data: { result: outcome, reasons: ["legal_hold_active"] }, error: null }
        : { data: status(outcome === "anonymized" ? { state: "anonymized", eligible: false, anonymized_at: "2026-11-11T00:00:00+00:00" } : {}), error: null };
    const result = await anonymizeContact(CONTACT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe(outcome);
    expect(names()).toEqual(["anonymize_privacy_contact", "get_privacy_retention_status"]);
  });

  it("resultado desconhecido do banco é falha fechada", async () => {
    state.rpc = () => ({ data: { result: "talvez" }, error: null });
    expect(await anonymizeContact(CONTACT)).toEqual(FAILED);
    state.rpc = () => ({ data: null, error: null });
    expect(await anonymizeContact(CONTACT)).toEqual(FAILED);
  });

  it("permissão negada no banco: 403 e nenhuma consulta de estado depois", async () => {
    state.rpc = () => ({ data: null, error: { message: "insufficient_permission" } });
    expect(await anonymizeContact(CONTACT)).toEqual({ ok: false, status: 403, error: "forbidden" });
    expect(names()).toEqual(["anonymize_privacy_contact"]);
  });
});

describe("falha fechada e sem vazamento", () => {
  it("exceção de transporte, de cliente ou erro desconhecido: código fechado, sem mensagem", async () => {
    rpcMock.mockRejectedValue(new Error("ECONNRESET 12345678901 Titular ALFA"));
    for (const result of [await getRetentionStatus(CONTACT), await anonymizeContact(CONTACT), await createLegalHold(CONTACT, "other_legal")]) {
      expect(result).toEqual(FAILED);
    }
    state.clientThrows = true;
    expect(await getRetentionStatus(CONTACT)).toEqual(FAILED);
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ data: null, error: { message: "relation public.contacts: Titular ALFA 12345678901" } });
    const unknown = await getRetentionStatus(CONTACT);
    expect(unknown).toEqual(FAILED);
    expect(JSON.stringify(unknown)).not.toMatch(/ALFA|12345678901|relation/);
  });

  it("nada é escrito em log", async () => {
    await getRetentionStatus(CONTACT);
    await anonymizeContact(CONTACT);
    rpcMock.mockRejectedValue(new Error("falha com Titular ALFA"));
    await anonymizeContact(CONTACT);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
