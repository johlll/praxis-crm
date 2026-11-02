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
 * Escritos ANTES da implementação, contra a main ea1fafd. Chaves fictícias.
 */
import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
