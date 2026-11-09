/**
 * @vitest-environment node
 *
 * B3.3 — adaptador de ENVIO da YCloud (§28.19). Nenhuma chamada externa real:
 * o `fetch` é sempre um dublê (injetado no adaptador, ou o global trocado por
 * `vi.stubGlobal`). Dados fictícios.
 *
 * Parte 1: o adaptador sozinho (requisição oficial, classificação da
 * resposta, bloqueios antes da rede). Parte 2: o fluxo completo do CRM com o
 * banco em memória (uma tentativa por intenção, incerto sem reenvio, template,
 * canal sem envio, provedor trocado, nenhum segredo/telefone/conteúdo fora do
 * lugar).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rpc: vi.fn(), credential: vi.fn() }));

vi.mock("@/server/whatsapp/admin/supabase", () => ({ createWhatsAppAdminSupabaseClient: () => ({ rpc: h.rpc }) }));
vi.mock("@/server/whatsapp/admin/channels", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  adminReadWhatsAppSendCredential: h.credential,
}));

const { YCloudWhatsAppProvider } = await import("@/server/whatsapp/provider/ycloud");
const { YCLOUD_SEND_TIMEOUT_MS, YCLOUD_SEND_URL, ycloudExternalId } = await import("@/server/whatsapp/provider/ycloud-send");
const { sendWhatsAppHumanMessage } = await import("@/server/whatsapp/outbound");
const { WhatsAppOutboundError } = await import("@/server/whatsapp/admin/outbound");

const API_KEY = "yc-chave-ficticia-0123456789abcdef";
const PHONE = "+5511900001111";
const BUSINESS = "+5511900002222";
const WABA = "waba-ficticia-01";
const ROUTING = `${WABA}:${BUSINESS}`;
const OUTBOX = "70000000-0000-0000-0000-000000000001";
const EXTERNAL_ID = "praxis.out.70000000000000000000000000000001";
const TEXT = "Conteúdo sigiloso do cliente: processo 123";
const WS = "10000000-0000-0000-0000-000000000001";
const USER = "20000000-0000-0000-0000-000000000001";
const CONV = "62000000-0000-0000-0000-00000000000a";
const K1 = "63000000-0000-0000-0000-000000000001";
const K2 = "63000000-0000-0000-0000-000000000002";
const TEMPLATE_ID = "65000000-0000-0000-0000-00000000000a";

const recipient = { kind: "phone" as const, phoneE164: PHONE, bsuid: null };
const textRequest = (over: Record<string, unknown> = {}) => ({ routingKey: ROUTING, recipient, text: TEXT, correlationId: OUTBOX, credential: API_KEY, ...over });
const templateRequest = (over: Record<string, unknown> = {}) => ({
  routingKey: ROUTING,
  recipient,
  templateName: "lembrete_audiencia",
  templateLanguage: "pt_BR",
  parameters: ["Maria", "12/12"],
  correlationId: OUTBOX,
  credential: API_KEY,
  ...over,
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const okBody = (over: Record<string, unknown> = {}) => ({
  id: "ycmsg0001",
  wabaId: WABA,
  from: BUSINESS,
  to: PHONE,
  type: "text",
  status: "accepted",
  externalId: EXTERNAL_ID,
  createTime: "2026-11-08T12:00:00.000Z",
  ...over,
});

let consoleSpies: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  h.rpc.mockReset();
  h.credential.mockReset();
});

/** Nenhum dado sensível pode aparecer em nada que o adaptador devolve. */
function expectNoSensitive(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of [API_KEY, PHONE, BUSINESS, "sigiloso", "processo 123", "Maria", "Authorization", "X-API-Key"]) {
    expect(text).not.toContain(secret);
  }
}

// ---------------------------------------------------------------------
// Parte 1 — o adaptador
// ---------------------------------------------------------------------

describe("requisição oficial", () => {
  it("texto: POST /v2/whatsapp/messages com X-API-Key, from do canal, to, text.body e externalId estável", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => json(200, okBody()));
    const result = await new YCloudWhatsAppProvider({ fetch: fetchMock }).sendText(textRequest());

    expect(result).toEqual({ ok: true, providerMessageId: "ycmsg0001", state: "accepted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.ycloud.com/v2/whatsapp/messages");
    expect(url).toBe(YCLOUD_SEND_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "X-API-Key": API_KEY, "Content-Type": "application/json", Accept: "application/json" });
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal!.aborted).toBe(false);
    expect(JSON.parse(init.body as string)).toEqual({
      from: BUSINESS,
      to: PHONE,
      type: "text",
      text: { body: TEXT },
      externalId: EXTERNAL_ID,
    });
    // O externalId vem só da intenção: sem telefone nem conteúdo, e igual ao wa_message_id do banco.
    expect(ycloudExternalId(OUTBOX)).toBe(EXTERNAL_ID);
    expect(EXTERNAL_ID).not.toContain("55119");
  });

  it("template utility: nome, idioma e parâmetros do CRM em components[body].parameters", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => json(200, okBody({ type: "template" })));
    const result = await new YCloudWhatsAppProvider({ fetch: fetchMock }).sendTemplate(templateRequest());

    expect(result).toEqual({ ok: true, providerMessageId: "ycmsg0001", state: "accepted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1];
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe(API_KEY);
    expect(JSON.parse(init.body as string)).toEqual({
      from: BUSINESS,
      to: PHONE,
      type: "template",
      template: {
        name: "lembrete_audiencia",
        language: { code: "pt_BR" },
        components: [{ type: "body", parameters: [{ type: "text", text: "Maria" }, { type: "text", text: "12/12" }] }],
      },
      externalId: EXTERNAL_ID,
    });
  });

  it("template sem variáveis não leva components", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => json(200, okBody({ type: "template" })));
    await new YCloudWhatsAppProvider({ fetch: fetchMock }).sendTemplate(templateRequest({ parameters: [] }));
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string).template).toEqual({ name: "lembrete_audiencia", language: { code: "pt_BR" } });
  });

  it("o tempo limite é explícito e curto, e a chamada usa um sinal por tentativa", () => {
    expect(YCLOUD_SEND_TIMEOUT_MS).toBe(10_000);
    const source = readFileSync(resolve(import.meta.dirname, "../../src/server/whatsapp/provider/ycloud-send.ts"), "utf8");
    expect(source).toContain("AbortSignal.timeout(YCLOUD_SEND_TIMEOUT_MS)");
    expect(source).not.toMatch(/\bretry\b.*while|for\s*\(\s*let\s+\w+\s*=\s*0[^)]*attempt/i);
    expect((source.match(/\bcall\(/g) ?? []).length).toBe(1);
  });
});

describe("classificação da resposta", () => {
  const send = (response: () => Promise<Response> | Response) => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => response());
    return { fetchMock, run: () => new YCloudWhatsAppProvider({ fetch: fetchMock }).sendText(textRequest()) };
  };

  it("200 com identificador vira accepted (também se a YCloud já informar sent/delivered/read)", async () => {
    for (const status of ["accepted", "sent", "delivered", "read"]) {
      const { run } = send(() => json(200, okBody({ status })));
      expect(await run()).toEqual({ ok: true, providerMessageId: "ycmsg0001", state: "accepted" });
    }
  });

  it("4xx definitivo vira rejected com código sanitizado, sem a mensagem do provedor", async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const { run, fetchMock } = send(() =>
        json(status, { error: { status, code: "INVALID_REQUEST", message: `${API_KEY} ${PHONE} ${TEXT}`, requestId: "req-1" } }),
      );
      const result = await run();
      expect(result).toEqual({ ok: false, reason: "rejected", errorCode: "ycloud_invalid_request" });
      expectNoSensitive(result);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("4xx sem código legível (ou com código malformado) usa o código do status", async () => {
    for (const body of [{}, "texto", { error: { code: "COM ESPAÇO E ' ASPAS" } }, { error: { code: 42 } }, { error: { code: `x${"a".repeat(80)}` } }]) {
      const { run } = send(() => json(403, body));
      expect(await run()).toEqual({ ok: false, reason: "rejected", errorCode: "ycloud_http_403" });
    }
    const { run } = send(() => new Response("<html>não é json</html>", { status: 400 }));
    expect(await run()).toEqual({ ok: false, reason: "rejected", errorCode: "ycloud_http_400" });
  });

  it("200 com status failed é rejeição conhecida (nunca accepted)", async () => {
    const { run } = send(() => json(200, okBody({ status: "failed", errorCode: "RECIPIENT_BLOCKED", errorMessage: TEXT })));
    const result = await run();
    expect(result).toEqual({ ok: false, reason: "rejected", errorCode: "ycloud_recipient_blocked" });
    expectNoSensitive(result);
  });

  it("429, 5xx, 408/409/425 e redirecionamento viram uncertain, com UMA só chamada", async () => {
    for (const status of [429, 500, 502, 503, 504, 408, 409, 425, 302]) {
      const { run, fetchMock } = send(() => json(status, { error: { code: "X", message: TEXT } }, status === 429 ? { "Retry-After": "1" } : {}));
      const result = await run();
      expect(result, String(status)).toEqual({ ok: false, reason: "uncertain" });
      expect(fetchMock, String(status)).toHaveBeenCalledTimes(1);
    }
  });

  it("erro de rede, timeout e abort viram uncertain, sem repetir", async () => {
    for (const error of [new TypeError("fetch failed"), new DOMException("timeout", "TimeoutError"), new DOMException("abort", "AbortError"), new Error(`${API_KEY} ${PHONE}`)]) {
      const { run, fetchMock } = send(() => Promise.reject(error));
      const result = await run();
      expect(result).toEqual({ ok: false, reason: "uncertain" });
      expectNoSensitive(result);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("2xx que não prova o aceite NUNCA vira accepted", async () => {
    const cases: Array<() => Response> = [
      () => json(200, okBody({ id: undefined })), // sem identificador
      () => json(200, okBody({ id: "" })),
      () => json(200, okBody({ id: 12345 })),
      () => json(200, okBody({ id: "com espaço" })),
      () => json(200, {}),
      () => json(200, []),
      () => new Response("", { status: 200 }),
      () => new Response("não é json", { status: 200 }),
      () => json(200, okBody({ externalId: "praxis.out.outra-intencao" })), // resposta de outra intenção
      () => json(200, okBody({ wabaId: "outra-conta" })), // outra conta
      () => json(200, okBody({ from: "+5511999990000" })), // outro número
      () => json(200, okBody({ status: "queued_estranho" })),
      () => json(200, okBody({ status: undefined })),
      () => json(201, okBody()),
      () => json(204, null),
    ];
    for (const [index, make] of cases.entries()) {
      const { run, fetchMock } = send(make);
      expect(await run(), `caso ${index}`).toEqual({ ok: false, reason: "uncertain" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("resposta grande demais ou corpo que falha no meio é incerto", async () => {
    const huge = send(() => new Response("x".repeat(200_000), { status: 200 }));
    expect(await huge.run()).toEqual({ ok: false, reason: "uncertain" });

    const broken = send(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"id":"a'));
              controller.error(new Error("conexão interrompida"));
            },
          }),
          { status: 200 },
        ),
    );
    expect(await broken.run()).toEqual({ ok: false, reason: "uncertain" });
  });
});

describe("o que é barrado antes da rede", () => {
  const blocked = async (request: ReturnType<typeof textRequest>, expected: string) => {
    const fetchMock = vi.fn();
    const result = await new YCloudWhatsAppProvider({ fetch: fetchMock }).sendText(request);
    expect(result).toEqual({ ok: false, reason: "rejected", errorCode: expected });
    expect(fetchMock).not.toHaveBeenCalled();
  };

  it("chave ausente, malformada ou com quebra de linha (injeção de cabeçalho)", async () => {
    await blocked(textRequest({ credential: undefined }), "credential_unavailable");
    await blocked(textRequest({ credential: "" }), "credential_unavailable");
    await blocked(textRequest({ credential: "curta" }), "credential_unavailable");
    await blocked(textRequest({ credential: `${API_KEY}\r\nX-Outro: 1` }), "credential_unavailable");
    await blocked(textRequest({ credential: `${API_KEY} com espaço` }), "credential_unavailable");
  });

  it("canal, destinatário, correlação e texto inválidos", async () => {
    await blocked(textRequest({ routingKey: "r" }), "invalid_channel_state");
    await blocked(textRequest({ routingKey: `${WABA}:5511900002222` }), "invalid_channel_state");
    await blocked(textRequest({ recipient: { kind: "bsuid", phoneE164: null, bsuid: "US.123" } }), "recipient_unavailable");
    await blocked(textRequest({ correlationId: "não-é-uuid" }), "invalid_channel_data");
    await blocked(textRequest({ text: "" }), "invalid_message_body");
    await blocked(textRequest({ text: "x".repeat(4097) }), "invalid_message_body");
  });

  it("template com nome, idioma ou parâmetro fora do contrato", async () => {
    for (const over of [
      { templateName: "Nome Inválido" },
      { templateName: "" },
      { templateLanguage: "portugues" },
      { parameters: ["{{1}}"] },
      { parameters: ["a\nb"] },
      { parameters: [""] },
      { parameters: ["x".repeat(129)] },
      { parameters: Array.from({ length: 11 }, () => "a") },
    ]) {
      const fetchMock = vi.fn();
      const result = await new YCloudWhatsAppProvider({ fetch: fetchMock }).sendTemplate(templateRequest(over));
      expect(result).toEqual({ ok: false, reason: "rejected", errorCode: "invalid_template" });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("sem fetch injetado usa o global, e o global nunca é chamado nos bloqueios", async () => {
    const globalFetch = vi.fn(async () => json(200, okBody()));
    vi.stubGlobal("fetch", globalFetch);
    await new YCloudWhatsAppProvider().sendText(textRequest({ credential: undefined }));
    expect(globalFetch).not.toHaveBeenCalled();
    await new YCloudWhatsAppProvider().sendText(textRequest());
    expect(globalFetch).toHaveBeenCalledTimes(1);
  });
});

describe("estático", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../../src/server/whatsapp/provider/ycloud-send.ts"), "utf8");

  it("sem log, sem env, sem banco, sem chave global e sem outro host", () => {
    expect(source).not.toMatch(/console\.|process\.env|@\/server\/(supabase|whatsapp\/admin)|YCLOUD_API_KEY/);
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual(["@/server/whatsapp/provider/contract"]);
    const urls = [...source.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]).filter((u) => !u.includes("docs.ycloud.com"));
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url.startsWith("https://api.ycloud.com/v2")).toBe(true);
  });

  it("só o módulo de envio chama a rede, e ele não toca em mídia, marketing nem outros endpoints", () => {
    expect(source).not.toMatch(/sendDirectly|useDirectSend|type:\s*"(image|audio|video|document|sticker|interactive)"|marketing/i);
    const adapter = readFileSync(resolve(import.meta.dirname, "../../src/server/whatsapp/provider/ycloud.ts"), "utf8");
    expect(adapter).not.toMatch(/\bfetch\s*\(/);
    expect(source).toContain("redirect: \"error\"");
  });
});

// ---------------------------------------------------------------------
// Parte 2 — o fluxo do CRM com o canal YCloud
// ---------------------------------------------------------------------

type Ctx = { route: "b3"; provider: string; blocked_reason: string | null; window_open: boolean; window_expires_at: string | null; case_linked: boolean; templates: unknown[] };
type Row = { outbox_id: string; message_id: string; kind: string; state: string; error_code: string | null; body: string; status: string; error_reason: string | null; key: string; attempts: number };
let context: Ctx;
let rows: Map<string, Row>;
let reserveError: string | null;
let sendDisabledAtBegin: boolean;
let counter: number;

const APPROVED = { id: TEMPLATE_ID, name: "lembrete_audiencia", language: "pt_BR", body_text: "Olá {{1}}, sua audiência é em {{2}}.", param_count: 2 };

function snapshot(r: Row, dup: boolean) {
  return {
    outbox_id: r.outbox_id, state: r.state, error_code: r.error_code, duplicate_submit: dup, content_conflict: false,
    message_id: r.message_id, direction: "outbound", body_text: r.body, status: r.status, status_updated_at: "2026-11-08T12:00:00Z",
    error_reason: r.error_reason, sent_by: USER, created_at: "2026-11-08T12:00:00Z", wa_message_id: `praxis.out.${r.outbox_id.replaceAll("-", "")}`,
  };
}

function installFakeDatabase() {
  h.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    if (fn === "whatsapp_send_context") return { data: context, error: null };
    if (fn === "whatsapp_reserve_send") {
      const key = args.p_client_dedupe_key as string;
      const existing = rows.get(key);
      if (existing) return { data: snapshot(existing, true), error: null };
      if (reserveError) return { data: null, error: { message: reserveError } };
      counter += 1;
      const n = String(counter).padStart(12, "0");
      const r: Row = {
        outbox_id: `70000000-0000-0000-0000-${n}`, message_id: `71000000-0000-0000-0000-${n}`, kind: args.p_kind as string, state: "reserved", error_code: null,
        body: args.p_kind === "text" ? (args.p_body_text as string) : "Olá Maria, sua audiência é em 12/12.", status: "queued", error_reason: null, key, attempts: 0,
      };
      rows.set(key, r);
      return { data: snapshot(r, false), error: null };
    }
    const r = [...rows.values()].find((x) => x.outbox_id === args.p_outbox_id);
    if (!r) return { data: null, error: { message: "outbox_not_found" } };
    if (fn === "whatsapp_outbox_begin") {
      if (r.state === "sending") return { data: { ...snapshot(r, true), outcome: "in_progress" }, error: null };
      if (r.state !== "reserved") return { data: { ...snapshot(r, true), outcome: "done" }, error: null };
      if (sendDisabledAtBegin) {
        r.state = "rejected"; r.status = "failed"; r.error_code = "send_disabled"; r.error_reason = "send_disabled";
        return { data: { ...snapshot(r, false), outcome: "done" }, error: null };
      }
      r.state = "sending";
      r.attempts = 1;
      const isText = r.kind === "text";
      return {
        data: {
          ...snapshot(r, false), outcome: "begin", kind: r.kind, provider: "ycloud", routing_key: ROUTING, recipient_phone: PHONE,
          text: isText ? r.body : null, template_name: isText ? null : APPROVED.name, template_language: isText ? null : APPROVED.language, template_params: isText ? null : ["Maria", "12/12"],
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

const fetchSpy = vi.fn();
const humanText = (key = K1, text = TEXT) =>
  sendWhatsAppHumanMessage({ workspaceId: WS, actorUserId: USER, conversationId: CONV, clientDedupeKey: key, content: { kind: "text", text } });
const humanTemplate = (key = K1) =>
  sendWhatsAppHumanMessage({ workspaceId: WS, actorUserId: USER, conversationId: CONV, clientDedupeKey: key, content: { kind: "template", templateId: TEMPLATE_ID, params: ["Maria", "12/12"] } });

describe("fluxo do CRM com canal YCloud", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "chave-de-teste-b3-whatsapp-0123456789");
    vi.stubEnv("WHATSAPP_PROVIDER", "ycloud");
    fetchSpy.mockReset();
    fetchSpy.mockImplementation(async () => json(200, okBody({ id: "ycmsg0001" })));
    vi.stubGlobal("fetch", fetchSpy);
    rows = new Map();
    counter = 0;
    reserveError = null;
    sendDisabledAtBegin = false;
    context = { route: "b3", provider: "ycloud", blocked_reason: null, window_open: true, window_expires_at: "2026-11-09T11:00:00Z", case_linked: true, templates: [APPROVED] };
    h.credential.mockResolvedValue(API_KEY);
    installFakeDatabase();
  });

  const reserveCalls = () => h.rpc.mock.calls.filter(([fn]) => fn === "whatsapp_reserve_send").length;

  it("texto na janela: reserva, uma chamada à YCloud com a chave do CANAL, aceite com o id do provedor", async () => {
    const result = await humanText();
    expect(result).toMatchObject({ state: "accepted", errorCode: null, row: { status: "accepted" } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(YCLOUD_SEND_URL);
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe(API_KEY);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ from: BUSINESS, to: PHONE, type: "text", externalId: `praxis.out.${rows.get(K1)!.outbox_id.replaceAll("-", "")}` });
    // A chave vem do canal da sessão: workspace da sessão, provedor e routing key do banco.
    expect(h.credential).toHaveBeenCalledExactlyOnceWith({ workspaceId: WS, provider: "ycloud", routingKey: ROUTING });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("template utility aprovado fora da janela: uma chamada com nome, idioma e parâmetros do CRM", async () => {
    context.window_open = false;
    const result = await humanTemplate();
    expect(result.state).toBe("accepted");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string)).toMatchObject({
      type: "template",
      template: { name: "lembrete_audiencia", language: { code: "pt_BR" }, components: [{ type: "body" }] },
    });
  });

  it("marketing, rejeitado, pausado ou de outra categoria não chega à rede (o banco recusa e o contexto não o lista)", async () => {
    for (const code of ["template_category_not_allowed", "template_not_approved", "template_not_found"]) {
      reserveError = code;
      await expect(humanTemplate(`63000000-0000-0000-0000-00000000010${code.length}`)).rejects.toMatchObject({ code });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.credential).not.toHaveBeenCalled();

    // Defesa em profundidade: mesmo que o banco deixasse passar, um template que o contexto
    // não lista como aprovado + utility é recusado depois do begin, ANTES de ler a chave.
    reserveError = null;
    context.templates = [];
    context.window_open = false;
    const result = await humanTemplate(K2);
    expect(result).toMatchObject({ state: "rejected", errorCode: "template_not_approved" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.credential).not.toHaveBeenCalled();
  });

  it("texto fora da janela é recusado pelo banco, sem rede", async () => {
    context.window_open = false;
    reserveError = "window_closed";
    await expect(humanText()).rejects.toMatchObject({ code: "window_closed" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("send_enabled=false: recusado na reserva ou no begin, e a chave nem é lida", async () => {
    reserveError = "send_disabled";
    await expect(humanText(K1)).rejects.toMatchObject({ code: "send_disabled" });

    reserveError = null;
    sendDisabledAtBegin = true; // desligado entre a reserva e a chamada
    const result = await humanText(K2);
    expect(result).toMatchObject({ state: "rejected", errorCode: "send_disabled" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.credential).not.toHaveBeenCalled();
  });

  it("chave indisponível (envio desligado no banco, canal inativo, outro workspace): recusada, sem rede e sem vazar o erro", async () => {
    h.credential.mockRejectedValue(new Error(`${API_KEY} ${PHONE} ${TEXT}`));
    const result = await humanText();
    expect(result).toMatchObject({ state: "rejected", errorCode: "credential_unavailable" });
    expect(fetchSpy).not.toHaveBeenCalled();
    // O texto da PRÓPRIA mensagem do CRM é legítimo no registro; o erro, a chave e o telefone não.
    expect(JSON.stringify(result)).not.toMatch(/chave-ficticia|5511900001111|X-API-Key/);
    expect(JSON.stringify([result.errorCode, result.row.error_code, result.row.error_reason])).not.toMatch(/sigiloso|chave|5511/);
  });

  it("provedor trocado: variável de outro provedor, ou canal de outro provedor, bloqueia ANTES da reserva e da rede", async () => {
    vi.stubEnv("WHATSAPP_PROVIDER", "simulated");
    await expect(humanText()).rejects.toBeInstanceOf(WhatsAppOutboundError);
    await expect(humanText()).rejects.toMatchObject({ code: "whatsapp_provider_unavailable" });

    vi.stubEnv("WHATSAPP_PROVIDER", "ycloud");
    context.provider = "meta";
    await expect(humanText()).rejects.toMatchObject({ code: "whatsapp_provider_unavailable" });
    expect(reserveCalls()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.credential).not.toHaveBeenCalled();
  });

  it("begin devolve outro provedor que o do adaptador: recusado sem rede", async () => {
    const base = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      const out = (await base(fn, args)) as { data: Record<string, unknown> | null; error: unknown };
      if (fn === "whatsapp_outbox_begin" && out.data?.outcome === "begin") return { ...out, data: { ...out.data, provider: "simulated" } };
      return out;
    });
    const result = await humanText();
    expect(result).toMatchObject({ state: "rejected", errorCode: "recipient_unavailable" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.credential).not.toHaveBeenCalled();
  });

  it("repetir a MESMA intenção nunca faz uma segunda chamada (aceita)", async () => {
    await humanText(K1);
    const again = await humanText(K1);
    expect(again.row.duplicate_submit).toBe(true);
    expect(again.state).toBe("accepted");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(h.credential).toHaveBeenCalledTimes(1);
  });

  it("resultado incerto (429, 5xx, timeout, resposta inválida): fica 'Envio incerto' e NUNCA é reenviado", async () => {
    const outcomes: Array<() => Promise<Response>> = [
      async () => json(429, { error: { code: "RATE_LIMITED" } }, { "Retry-After": "1" }),
      async () => json(503, {}),
      async () => { throw new DOMException("timeout", "TimeoutError"); },
      async () => json(200, {}),
    ];
    for (const [index, outcome] of outcomes.entries()) {
      fetchSpy.mockReset();
      fetchSpy.mockImplementation(outcome);
      const key = `63000000-0000-0000-0000-0000000002${index}0`;
      const first = await humanText(key);
      expect(first, `caso ${index}`).toMatchObject({ state: "uncertain", row: { status: "queued", error_reason: "send_uncertain" } });
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Nova leitura/clique/retomada da MESMA intenção: sem rede.
      const again = await humanText(key);
      expect(again.state).toBe("uncertain");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      // O ponto de entrada de retomada (begin) também não inicia outra tentativa.
      const outboxId = rows.get(key)!.outbox_id;
      const { adminBeginWhatsAppOutboxSend } = await import("@/server/whatsapp/admin/outbound");
      expect((await adminBeginWhatsAppOutboxSend(outboxId)).outcome).toBe("done");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    }
  });

  it("4xx definitivo: rejeitada com código sanitizado; nada sensível no resultado", async () => {
    fetchSpy.mockImplementation(async () => json(422, { error: { status: 422, code: "TEMPLATE_NOT_APPROVED", message: `${API_KEY} ${PHONE} ${TEXT}`, requestId: "r" } }));
    const result = await humanText();
    expect(result).toMatchObject({ state: "rejected", errorCode: "ycloud_template_not_approved", row: { status: "failed" } });
    expect(JSON.stringify(result)).not.toMatch(/chave-ficticia|5511900001111|5511900002222|X-API-Key/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("aceite que o banco não consegue registrar vira incerto, nunca nova chamada", async () => {
    const base = h.rpc.getMockImplementation()!;
    let finishCalls = 0;
    h.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      if (fn === "whatsapp_outbox_finish") {
        finishCalls += 1;
        if (args.p_outcome === "accepted") return { data: null, error: { message: `falha ${API_KEY} ${PHONE}` } };
      }
      return base(fn, args);
    });
    const result = await humanText();
    expect(result.state).toBe("uncertain");
    expect(finishCalls).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("nenhuma chamada real: o global só foi tocado pelo dublê, e o host é sempre o oficial", async () => {
    await humanText(K1);
    await humanTemplate(K2);
    for (const [url] of fetchSpy.mock.calls as Array<[string]>) expect(new URL(url).host).toBe("api.ycloud.com");
  });
});
