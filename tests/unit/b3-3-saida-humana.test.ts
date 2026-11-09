/**
 * @vitest-environment node
 *
 * B3.3 — saída humana pelo CRM, camada do servidor (§28.18). O banco é um
 * modelo em memória que segue o contrato das funções (a prova das regras do
 * próprio banco está em supabase/tests/database/43_b3_3_saida_humana.test.sql);
 * o adaptador é o SIMULADO de verdade, com a chamada espionada. Aqui:
 * permissão pela sessão; workspace da sessão; bloqueios do banco vistos como
 * mensagem segura; fluxo texto e template; no máximo UMA chamada por
 * intenção; repetição sem duplicar; resultado incerto sem reenvio; nenhum
 * segredo, telefone ou conteúdo em erro ou log; nenhuma rede real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rpc: vi.fn(), legacyRpc: vi.fn(), guard: vi.fn() }));

vi.mock("@/server/authz/safe", () => ({ requirePermissionSafe: h.guard }));
vi.mock("@/server/whatsapp/admin/supabase", () => ({ createWhatsAppAdminSupabaseClient: () => ({ rpc: h.rpc }) }));
vi.mock("@/server/supabase/server", () => ({ createServerSupabaseClient: async () => ({ rpc: h.legacyRpc }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { sendMessageAction, sendWhatsAppTemplateAction } = await import("@/modules/conversations/actions");
const { SimulatedWhatsAppProvider } = await import("@/server/whatsapp/provider/simulated");

const WS = "10000000-0000-0000-0000-000000000001";
const OTHER_WS = "10000000-0000-0000-0000-000000000002";
const USER = "20000000-0000-0000-0000-000000000001";
const CONV = "62000000-0000-0000-0000-00000000000a";
const TEMPLATE = "65000000-0000-0000-0000-00000000000a";
const K1 = "63000000-0000-0000-0000-000000000001";
const K2 = "63000000-0000-0000-0000-000000000002";
const PHONE = "+5511900005001";
const SECRET_IN_ERROR = "senha=segredo-ficticio-9999 +5511987654321 Conteúdo sigiloso do cliente";

type Ctx = { route: "legacy" } | { route: "b3"; provider: string; blocked_reason: string | null; window_open: boolean; window_expires_at: string | null; case_linked: boolean; templates: unknown[] };
let context: Ctx;
let reserveError: string | null;

type Row = { outbox_id: string; message_id: string; state: string; error_code: string | null; body: string; status: string; error_reason: string | null; key: string; attempts: number };
let rows: Map<string, Row>;
let messageCount: number;

function snapshot(r: Row, dup: boolean, conflict = false) {
  return {
    outbox_id: r.outbox_id, state: r.state, error_code: r.error_code, duplicate_submit: dup, content_conflict: conflict,
    message_id: r.message_id, direction: "outbound", body_text: r.body, status: r.status, status_updated_at: "2026-11-08T12:00:00Z",
    error_reason: r.error_reason, sent_by: USER, created_at: "2026-11-08T12:00:00Z", wa_message_id: `praxis.out.${r.outbox_id}`,
  };
}

/** Modelo mínimo das funções do banco: contexto, reserva, begin e finish. */
function installFakeDatabase() {
  h.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    if (fn === "whatsapp_send_context") return { data: context, error: null };
    if (fn === "whatsapp_reserve_send") {
      const key = args.p_client_dedupe_key as string;
      const existing = rows.get(key);
      const body = args.p_kind === "text" ? (args.p_body_text as string) : "Olá Maria, sua audiência é em 12/12.";
      if (existing) return { data: snapshot(existing, true, existing.body !== body), error: null };
      if (reserveError) return { data: null, error: { message: reserveError } };
      messageCount += 1;
      const r: Row = { outbox_id: `70000000-0000-0000-0000-00000000000${messageCount}`, message_id: `71000000-0000-0000-0000-00000000000${messageCount}`, state: "reserved", error_code: null, body, status: "queued", error_reason: null, key, attempts: 0 };
      rows.set(key, r);
      return { data: snapshot(r, false), error: null };
    }
    const r = [...rows.values()].find((x) => x.outbox_id === args.p_outbox_id);
    if (!r) return { data: null, error: { message: "outbox_not_found" } };
    if (fn === "whatsapp_outbox_begin") {
      if (r.state === "sending") return { data: { ...snapshot(r, true), outcome: "in_progress" }, error: null };
      if (r.state !== "reserved") return { data: { ...snapshot(r, true), outcome: "done" }, error: null };
      r.state = "sending";
      r.attempts = 1;
      const isText = !r.body.startsWith("Olá Maria");
      return {
        data: {
          ...snapshot(r, false), outcome: "begin", kind: isText ? "text" : "template", provider: "simulated", routing_key: "b33-sim",
          recipient_phone: PHONE, text: isText ? r.body : null,
          template_name: isText ? null : "lembrete_audiencia", template_language: isText ? null : "pt_BR", template_params: isText ? null : ["Maria", "12/12"],
        },
        error: null,
      };
    }
    if (fn === "whatsapp_outbox_finish") {
      if (r.state !== "sending") return { data: null, error: { message: "invalid_outbox_state" } };
      r.state = args.p_outcome as string;
      if (r.state === "accepted") r.status = "accepted";
      if (r.state === "rejected") { r.status = "failed"; r.error_code = args.p_error_code as string; r.error_reason = r.error_code; }
      if (r.state === "uncertain") r.error_reason = "send_uncertain";
      return { data: snapshot(r, false), error: null };
    }
    return { data: null, error: { message: "unknown" } };
  });
}

let sendTextSpy: ReturnType<typeof vi.spyOn>;
let sendTemplateSpy: ReturnType<typeof vi.spyOn>;
let consoleSpies: ReturnType<typeof vi.spyOn>[];
const fetchSpy = vi.fn();

beforeEach(() => {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "chave-de-teste-b3-whatsapp-0123456789");
  vi.stubEnv("WHATSAPP_PROVIDER", "simulated");
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockReset();
  h.rpc.mockReset();
  h.legacyRpc.mockReset();
  h.guard.mockReset();
  h.guard.mockResolvedValue({ ctx: { userId: USER, workspaceId: WS, membershipId: "m", role: "owner" } });
  rows = new Map();
  messageCount = 0;
  reserveError = null;
  context = { route: "b3", provider: "simulated", blocked_reason: null, window_open: true, window_expires_at: "2026-11-09T11:00:00Z", case_linked: true, templates: [] };
  installFakeDatabase();
  sendTextSpy = vi.spyOn(SimulatedWhatsAppProvider.prototype, "sendText");
  sendTemplateSpy = vi.spyOn(SimulatedWhatsAppProvider.prototype, "sendTemplate");
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});

afterEach(() => {
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const calls = () => h.rpc.mock.calls.map(([fn]) => fn as string);

describe("quem envia e por onde", () => {
  it("usuário autorizado envia texto: reserva, uma tentativa e aceite, com workspace e ator da sessão", async () => {
    const result = await sendMessageAction(CONV, "Olá, tudo bem?", K1);
    expect(h.guard).toHaveBeenCalledWith("conversation.send");
    expect(result).toMatchObject({ ok: true, duplicateSubmit: false, message: { bodyText: "Olá, tudo bem?", status: "accepted", direction: "outbound" } });
    expect(calls()).toEqual(["whatsapp_send_context", "whatsapp_reserve_send", "whatsapp_outbox_begin", "whatsapp_outbox_finish"]);
    const reserve = h.rpc.mock.calls.find(([fn]) => fn === "whatsapp_reserve_send")![1] as Record<string, unknown>;
    expect(reserve).toMatchObject({ p_workspace_id: WS, p_actor_user_id: USER, p_conversation_id: CONV, p_client_dedupe_key: K1, p_kind: "text", p_body_text: "Olá, tudo bem?" });
    expect(sendTextSpy).toHaveBeenCalledTimes(1);
    expect(sendTextSpy.mock.calls[0]![0]).toMatchObject({ routingKey: "b33-sim", text: "Olá, tudo bem?", correlationId: rows.get(K1)!.outbox_id });
    expect(h.legacyRpc).not.toHaveBeenCalled();
  });

  it("sem permissão: nada é pedido ao banco nem ao provedor", async () => {
    h.guard.mockResolvedValue({ error: "Você não tem permissão para fazer isso." });
    const results = [await sendMessageAction(CONV, "Olá", K1), await sendWhatsAppTemplateAction(CONV, TEMPLATE, ["Maria", "12/12"], K2)];
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("o workspace e o ator vêm só da sessão, nunca de quem chama", async () => {
    h.guard.mockResolvedValue({ ctx: { userId: USER, workspaceId: OTHER_WS, membershipId: "m", role: "admin" } });
    await sendMessageAction(CONV, "Olá", K1);
    for (const [, args] of h.rpc.mock.calls) {
      if ("p_workspace_id" in (args as object)) expect(args).toMatchObject({ p_workspace_id: OTHER_WS, p_actor_user_id: USER });
    }
  });

  it("conversa de outro workspace: o banco recusa e o usuário vê mensagem fixa, sem chamada ao provedor", async () => {
    reserveError = "conversation_not_found";
    const result = await sendMessageAction(CONV, "Olá", K1);
    expect(result).toEqual({ ok: false, error: "Conversa não encontrada." });
    expect(sendTextSpy).not.toHaveBeenCalled();
    expect(rows.size).toBe(0);
  });

  it("canal legado da A7 continua no send_message da A7", async () => {
    context = { route: "legacy" };
    h.legacyRpc.mockResolvedValue({
      data: { message_id: "m1", duplicate_submit: false, content_conflict: false, direction: "outbound", body_text: "Olá", status: "sent", status_updated_at: "2026-11-08T12:00:00Z", error_reason: null, sent_by: USER, created_at: "2026-11-08T12:00:00Z", wa_message_id: "wamid.sim.x" },
      error: null,
    });
    const result = await sendMessageAction(CONV, "Olá", K1);
    expect(result.ok).toBe(true);
    expect(h.legacyRpc).toHaveBeenCalledWith("send_message", { p_conversation_id: CONV, p_body_text: "Olá", p_client_dedupe_key: K1 });
    expect(calls()).toEqual(["whatsapp_send_context"]);
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("sem a integração configurada neste ambiente: segue o caminho da A7 sem tocar no banco do WhatsApp", async () => {
    vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "");
    h.legacyRpc.mockResolvedValue({ data: null, error: { message: "channel_uses_whatsapp_outbox" } });
    const result = await sendMessageAction(CONV, "Olá", K1);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("fila do WhatsApp") });
  });
});

describe("bloqueios vindos do banco", () => {
  it.each([
    ["send_disabled", "O envio está desligado neste canal. Peça a um administrador para ligá-lo."],
    ["window_closed", "A janela de 24 horas desta conversa está fechada. Só é possível enviar um template aprovado."],
    ["consent_required", "Sem consentimento vigente para enviar mensagem por este canal — registre o consentimento do contato primeiro."],
    ["channel_not_active", "O canal de WhatsApp está pausado ou desativado — reative-o antes de enviar."],
  ])("%s: mensagem segura e nenhuma tentativa ao provedor", async (code, message) => {
    reserveError = code;
    const result = await sendMessageAction(CONV, "Olá", K1);
    expect(result).toEqual({ ok: false, error: message });
    expect(calls()).toEqual(["whatsapp_send_context", "whatsapp_reserve_send"]);
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("provedor não habilitado neste ambiente: falha antes de gravar qualquer coisa", async () => {
    vi.stubEnv("WHATSAPP_PROVIDER", "");
    const result = await sendMessageAction(CONV, "Olá", K1);
    expect(result).toEqual({ ok: false, error: "O provedor de WhatsApp não está disponível neste ambiente." });
    expect(calls()).toEqual(["whatsapp_send_context"]);
    expect(rows.size).toBe(0);
  });

  it("marketing é bloqueado: o banco recusa a categoria e nada sai", async () => {
    reserveError = "template_category_not_allowed";
    const result = await sendWhatsAppTemplateAction(CONV, TEMPLATE, ["Maria"], K1);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("utilidade") });
    expect(sendTemplateSpy).not.toHaveBeenCalled();
  });
});

describe("template", () => {
  it("template utility aprovado fora da janela: uma tentativa, com nome, idioma e parâmetros", async () => {
    // O contexto lista o template aprovado + utility (B3.3, §28.19: só ele chega ao provedor).
    const approved = { id: TEMPLATE, name: "lembrete_audiencia", language: "pt_BR", body_text: "Olá {{1}}, sua audiência é em {{2}}.", param_count: 2 };
    context = { ...(context as Extract<Ctx, { route: "b3" }>), window_open: false, templates: [approved] };
    const result = await sendWhatsAppTemplateAction(CONV, TEMPLATE, ["Maria", "12/12"], K2);
    expect(result).toMatchObject({ ok: true, message: { status: "accepted", bodyText: "Olá Maria, sua audiência é em 12/12." } });
    expect(sendTemplateSpy).toHaveBeenCalledTimes(1);
    expect(sendTemplateSpy.mock.calls[0]![0]).toMatchObject({ templateName: "lembrete_audiencia", templateLanguage: "pt_BR", parameters: ["Maria", "12/12"], correlationId: rows.get(K2)!.outbox_id });
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("entrada inválida do template: recusada antes de qualquer banco", async () => {
    for (const bad of [[""], ["x".repeat(129)], new Array(11).fill("a")]) {
      expect((await sendWhatsAppTemplateAction(CONV, TEMPLATE, bad, K2)).ok).toBe(false);
    }
    expect((await sendWhatsAppTemplateAction(CONV, "nao-e-uuid", ["a"], K2)).ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe("idempotência e no máximo uma tentativa", () => {
  it("repetir a mesma intenção não duplica a mensagem nem chama o provedor de novo", async () => {
    const first = await sendMessageAction(CONV, "Olá", K1);
    const second = await sendMessageAction(CONV, "Olá", K1);
    expect(first.ok && second.ok).toBe(true);
    expect(second).toMatchObject({ ok: true, duplicateSubmit: true });
    expect(messageCount).toBe(1);
    expect(sendTextSpy).toHaveBeenCalledTimes(1);
    expect(first.ok && second.ok && first.message.id === second.message.id).toBe(true);
  });

  it("a mesma chave com outro texto é conflito: devolve o que foi gravado e não envia", async () => {
    await sendMessageAction(CONV, "Olá", K1);
    const result = await sendMessageAction(CONV, "Outro texto", K1);
    expect(result).toMatchObject({ ok: false, conflict: true, persisted: { bodyText: "Olá" } });
    expect(sendTextSpy).toHaveBeenCalledTimes(1);
  });

  it("intenção que ainda está em andamento: não faz nova chamada", async () => {
    await sendMessageAction(CONV, "Olá", K1);
    rows.get(K1)!.state = "sending";
    const result = await sendMessageAction(CONV, "Olá", K1);
    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["exceção do provedor", () => sendTextSpy.mockRejectedValue(new TypeError(`fetch failed ${SECRET_IN_ERROR}`))],
    ["resposta incerta", () => sendTextSpy.mockResolvedValue({ ok: false, reason: "uncertain" })],
  ])("resultado incerto (%s): fica incerto e a mesma intenção NUNCA é reenviada", async (_nome, prepare) => {
    prepare();
    const first = await sendMessageAction(CONV, "Olá", K1);
    expect(first).toMatchObject({ ok: false, error: expect.stringContaining("incerto"), persisted: { errorReason: "send_uncertain" } });
    expect(rows.get(K1)!.state).toBe("uncertain");
    const again = await sendMessageAction(CONV, "Olá", K1);
    expect(again.ok).toBe(false);
    expect(sendTextSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([first, again])).not.toMatch(/segredo|5511987654321|sigiloso/);
  });

  it("rejeição do provedor: falha com o código seguro e a mensagem gravada como falha", async () => {
    sendTextSpy.mockResolvedValue({ ok: false, reason: "rejected", errorCode: "Janela VENCIDA!" });
    const result = await sendMessageAction(CONV, "Olá", K1);
    expect(result).toMatchObject({ ok: false, persisted: { status: "failed" } });
    expect(rows.get(K1)!.error_code).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
  });

  it("provedor sem capacidade de envio: rejeita sem chamar", async () => {
    vi.spyOn(SimulatedWhatsAppProvider.prototype, "describeCapabilities").mockReturnValue({
      verifyWebhook: true, normalizeEvents: true, sendText: false, sendTemplate: false, lookupMessage: false, fetchMedia: false,
    });
    const result = await sendMessageAction(CONV, "Olá", K1);
    expect(result.ok).toBe(false);
    expect(sendTextSpy).not.toHaveBeenCalled();
    expect(rows.get(K1)!.error_code).toBe("send_unsupported");
  });

  it("o provedor aceitou mas o banco não registrou: tenta registrar incerta e, sem sucesso, avisa sem reenviar", async () => {
    const base = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) =>
      fn === "whatsapp_outbox_finish" ? { data: null, error: { message: `queda ${SECRET_IN_ERROR}` } } : base(fn, args),
    );
    const result = await sendMessageAction(CONV, "Olá", K1);
    expect(result).toEqual({ ok: false, error: "Não foi possível confirmar o resultado do envio. Confira a conversa antes de tentar novamente." });
    expect(sendTextSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/segredo|5511987654321|sigiloso/);
  });
});

describe("nada sensível em erro ou log", () => {
  it("erro cru do banco vira mensagem genérica, sem repetir o texto original", async () => {
    h.rpc.mockImplementation(async (fn: string) =>
      fn === "whatsapp_send_context" ? { data: context, error: null } : { data: null, error: { message: SECRET_IN_ERROR } },
    );
    const result = await sendMessageAction(CONV, "Olá", K1);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/segredo|5511987654321|sigiloso/);
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("o telefone da conversa só vai ao provedor, nunca ao retorno", async () => {
    const result = await sendMessageAction(CONV, "Olá", K1);
    expect(JSON.stringify(result)).not.toContain("5511900005001");
    expect(sendTextSpy.mock.calls[0]![0]).toMatchObject({ recipient: { kind: "phone", phoneE164: PHONE } });
  });
});
