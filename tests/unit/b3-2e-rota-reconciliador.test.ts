/**
 * @vitest-environment node
 *
 * B3.2e — o reconciliador na rota própria do Inngest do WhatsApp
 * (`/api/inngest/whatsapp`), com o SDK real e sem rede. A introspecção (GET)
 * em modo cloud diz quantas funções o app oferece.
 *
 *  - sem `WHATSAPP_RECONCILER_ENABLED=true`: só o consumidor (o app nunca fica
 *    vazio, então a sincronização continua possível);
 *  - com a variável: as duas funções;
 *  - nenhuma chave da A11 ou da agenda autentica a rota nem liga o cron;
 *  - sem as chaves próprias: 503, com ou sem a variável.
 *
 * E a execução (POST assinado): o SDK entrega o `id` do evento ao consumidor, que
 * só segue com um id compatível com o `inboxId` do `data`. O servidor do Inngest
 * sempre manda um `id` (o enviado; sem ele, um gerado), então o id é obrigatório
 * nesse gatilho (§28.8).
 *
 * Escritos ANTES da implementação, contra a main ea1fafd. Chaves fictícias.
 */
import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ process: vi.fn() }));

vi.mock("@/server/whatsapp/consumer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/whatsapp/consumer")>()),
  processWhatsAppInboxEntry: h.process,
}));

const WHATSAPP_KEY = `signkey-test-${"a1".repeat(32)}`;
const A11_KEY = `signkey-prod-${"c3".repeat(32)}`;
const URL_ROTA = "https://praxis-preview.example/api/inngest/whatsapp";

function sign(key: string, body = "", ts = Math.floor(Date.now() / 1000)) {
  const raw = key.replace(/^signkey-[\w]+-/, "");
  return `t=${ts}&s=${createHmac("sha256", raw).update(body + ts).digest("hex")}`;
}

let spies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  vi.resetModules();
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "chave-de-teste-b3-whatsapp-0123456789");
  vi.stubEnv("WHATSAPP_INNGEST_SIGNING_KEY", WHATSAPP_KEY);
  // A configuração da A11 e da agenda existe no mesmo deployment.
  vi.stubEnv("INNGEST_SIGNING_KEY", A11_KEY);
  vi.stubEnv("INNGEST_EVENT_KEY", "chave-de-evento-da-a11-ficticia");
  vi.stubEnv("INNGEST_DEV", "");
  vi.stubEnv("CALENDAR_SCHEDULER_ENABLED", "true");
  h.process.mockReset();
  h.process.mockResolvedValue({ outcome: "processed", code: null });
});

afterEach(() => {
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function introspect(key = WHATSAPP_KEY) {
  const route = await import("@/app/api/inngest/whatsapp/route");
  return route.GET(new Request(URL_ROTA, { headers: { "X-Inngest-Signature": sign(key) } }) as never, undefined as never);
}

describe("o reconciliador na rota própria", () => {
  it("sem a variável: uma função, o consumidor", async () => {
    vi.stubEnv("WHATSAPP_RECONCILER_ENABLED", "");
    const response = await introspect();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ authentication_succeeded: true, app_id: "praxis-crm-whatsapp", function_count: 1 });
  });

  it("com a variável exatamente true: duas funções", async () => {
    vi.stubEnv("WHATSAPP_RECONCILER_ENABLED", "true");
    const response = await introspect();
    expect(await response.json()).toMatchObject({ authentication_succeeded: true, app_id: "praxis-crm-whatsapp", function_count: 2 });
  });

  it("valor diferente de true: continua uma função", async () => {
    vi.stubEnv("WHATSAPP_RECONCILER_ENABLED", "TRUE");
    expect(await (await introspect()).json()).toMatchObject({ function_count: 1 });
  });

  it("a signing key da A11 não autentica, com a variável ligada ou não", async () => {
    vi.stubEnv("WHATSAPP_RECONCILER_ENABLED", "true");
    const body = (await (await introspect(A11_KEY)).json()) as { authentication_succeeded?: boolean };
    expect(body.authentication_succeeded).not.toBe(true);
  });

  it("sem a chave própria: 503, mesmo com a variável ligada e as chaves da A11 presentes", async () => {
    vi.stubEnv("WHATSAPP_RECONCILER_ENABLED", "true");
    vi.stubEnv("WHATSAPP_INNGEST_SIGNING_KEY", "");
    const response = await introspect(A11_KEY);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "service_unavailable" });
  });

  it("sem o ambiente assinado do WhatsApp: 503, mesmo com a variável ligada", async () => {
    vi.stubEnv("WHATSAPP_RECONCILER_ENABLED", "true");
    vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "");
    expect((await introspect()).status).toBe(503);
  });
});

// O formato do corpo é o de uma execução real capturada do servidor de
// desenvolvimento local: event, events, steps, ctx, version.
describe("o SDK entrega o id do evento na execução", () => {
  const INBOX = "47000000-0000-4000-8000-000000000001";
  const OTHER = "47000000-0000-4000-8000-000000000002";
  const NAME = "praxis/whatsapp.inbox.received";

  // O SDK confere a assinatura sobre o corpo com as chaves em ordem (RFC 8785).
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
      const entries = Object.entries(value).sort(([x], [y]) => (x < y ? -1 : 1));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
    }
    return JSON.stringify(value);
  };

  async function execute(event: Record<string, unknown>) {
    const route = await import("@/app/api/inngest/whatsapp/route");
    const envelope = { ts: 1, user: {}, ...event };
    const body = canonical({
      event: envelope,
      events: [envelope],
      steps: {},
      ctx: { run_id: "01RUNFICTICIO", attempt: 0, disable_immediate_execution: false, use_api: false, stack: { stack: [], current: 0 } },
      version: 2,
    });
    const url = `${URL_ROTA}?fnId=praxis-crm-whatsapp-b3-whatsapp-inbox-consumer&stepId=step`;
    return route.POST(
      new Request(url, { method: "POST", headers: { "content-type": "application/json", "X-Inngest-Signature": sign(WHATSAPP_KEY, body) }, body }) as never,
      undefined as never,
    );
  }

  it.each([
    ["inboxId puro", INBOX],
    ["inboxId com a tentativa", `${INBOX}:r3`],
  ])("id personalizado compatível (%s): chega ao consumidor, que processa só pelo inboxId", async (_name, id) => {
    const response = await execute({ id, name: NAME, data: { inboxId: INBOX } });
    expect(response.status).toBeLessThan(300);
    expect(h.process.mock.calls).toEqual([[{ inboxId: INBOX }]]);
  });

  it.each([
    ["de outra inbox", `${OTHER}:r3`],
    ["malformado", `${INBOX}:r03`],
    ["gerado pelo servidor quando o envio não traz id", "01M6FC7XC2BC4CA9352TQC4ETJ"],
  ])("id %s: o SDK entrega o id, e o consumidor recusa sem processar", async (_name, id) => {
    const response = await execute({ id, name: NAME, data: { inboxId: INBOX } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "invalid_event", code: null });
    expect(h.process).not.toHaveBeenCalled();
  });

  it("sem id nenhum: recusado, sem processar", async () => {
    const response = await execute({ name: NAME, data: { inboxId: INBOX } });
    expect(await response.json()).toEqual({ outcome: "invalid_event", code: null });
    expect(h.process).not.toHaveBeenCalled();
  });
});
