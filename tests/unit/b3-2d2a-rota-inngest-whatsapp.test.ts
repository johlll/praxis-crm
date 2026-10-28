/**
 * @vitest-environment node
 *
 * B3.2d-2a — rota e app PRÓPRIOS do Inngest do WhatsApp
 * (`/api/inngest/whatsapp`, app `praxis-crm-whatsapp`).
 *
 *  - assinatura só com `WHATSAPP_INNGEST_SIGNING_KEY` (e a reserva
 *    `WHATSAPP_INNGEST_SIGNING_KEY_FALLBACK`); a signing key e a reserva da
 *    A11/agenda (`INNGEST_SIGNING_KEY`, `INNGEST_SIGNING_KEY_FALLBACK`) não
 *    autenticam nada aqui, nem por queda do SDK nas variáveis genéricas;
 *  - a chave de evento nunca cai para `INNGEST_EVENT_KEY`;
 *  - em Preview e Production, sem a configuração própria: 503 sanitizado
 *    antes do SDK; `INNGEST_DEV` não desliga a assinatura;
 *  - uma função, disparada só por `praxis/whatsapp.inbox.received`;
 *  - nada no console.
 *
 * A introspecção (GET) do SDK em modo cloud é autenticada pela assinatura
 * HMAC-SHA256 de `"" + ts` com a signing key (sem prefixo), no cabeçalho
 * `X-Inngest-Signature: t=<ts>&s=<hex>` — conferido no SDK instalado
 * (inngest 4.20.0, helpers/net.js). Nenhuma chamada de rede.
 *
 * Escritos ANTES da implementação, contra a main 10e617f. Chaves fictícias.
 */
import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WHATSAPP_KEY = `signkey-test-${"a1".repeat(32)}`;
const WHATSAPP_FALLBACK = `signkey-test-${"b2".repeat(32)}`;
const A11_KEY = `signkey-prod-${"c3".repeat(32)}`;
const A11_FALLBACK = `signkey-prod-${"d4".repeat(32)}`;
const A11_EVENT_KEY = "chave-de-evento-da-a11-ficticia";
const WHATSAPP_EVENT_KEY = "chave-de-evento-do-whatsapp-ficticia";
const URL_ROTA = "https://praxis-preview.example/api/inngest/whatsapp";

function sign(key: string, body = "", ts = Math.floor(Date.now() / 1000)) {
  const raw = key.replace(/^signkey-[\w]+-/, "");
  return `t=${ts}&s=${createHmac("sha256", raw).update(body + ts).digest("hex")}`;
}

/** Troca SEMPRE o último dígito da assinatura (nunca fica igual). */
function tamper(signature: string) {
  return signature.slice(0, -1) + (signature.endsWith("0") ? "1" : "0");
}

function hosted(env: "preview" | "production" = "preview") {
  vi.stubEnv("VERCEL_ENV", env);
  vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "chave-de-teste-b3-whatsapp-0123456789");
  // A configuração da A11 e da agenda existe no mesmo deployment.
  vi.stubEnv("INNGEST_SIGNING_KEY", A11_KEY);
  vi.stubEnv("INNGEST_SIGNING_KEY_FALLBACK", A11_FALLBACK);
  vi.stubEnv("INNGEST_EVENT_KEY", A11_EVENT_KEY);
  vi.stubEnv("INNGEST_DEV", "");
}

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  vi.resetModules();
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});

afterEach(() => {
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const loadRoute = () => import("@/app/api/inngest/whatsapp/route");
const loadInngest = () => import("@/server/whatsapp/inngest");

async function get(signature?: string) {
  const route = await loadRoute();
  const headers = new Headers();
  if (signature) headers.set("X-Inngest-Signature", signature);
  return route.GET(new Request(URL_ROTA, { headers }) as never, undefined as never);
}

describe("1. falha fechada sem a configuração própria", () => {
  it.each(["preview", "production"] as const)("%s sem WHATSAPP_INNGEST_SIGNING_KEY (com as chaves da A11 presentes): 503 sanitizado nos três métodos", async (env) => {
    hosted(env);
    const route = await loadRoute();
    for (const method of ["GET", "POST", "PUT"] as const) {
      const response = await route[method](new Request(URL_ROTA, { method, headers: { "X-Inngest-Signature": sign(A11_KEY) } }) as never, undefined as never);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "service_unavailable" });
    }
  });

  it("chave própria vazia ou só com espaços: 503", async () => {
    hosted();
    vi.stubEnv("WHATSAPP_INNGEST_SIGNING_KEY", "   ");
    expect((await get(sign(A11_KEY))).status).toBe(503);
  });

  it("sem o ambiente assinado do WhatsApp: 503", async () => {
    hosted();
    vi.stubEnv("WHATSAPP_INNGEST_SIGNING_KEY", WHATSAPP_KEY);
    vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "");
    expect((await get(sign(WHATSAPP_KEY))).status).toBe(503);
  });

  it("fora da Vercel, sem chave própria e sem modo de desenvolvimento explícito: 503", async () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("INNGEST_SIGNING_KEY", A11_KEY);
    vi.stubEnv("INNGEST_DEV", "");
    vi.stubEnv("WHATSAPP_INNGEST_SIGNING_KEY", "");
    expect((await get(sign(A11_KEY))).status).toBe(503);
  });
});

describe("2. assinatura só com a chave do WhatsApp", () => {
  beforeEach(() => {
    hosted();
    vi.stubEnv("WHATSAPP_INNGEST_SIGNING_KEY", WHATSAPP_KEY);
  });

  it("assinada com a chave do WhatsApp: autenticada, app praxis-crm-whatsapp, uma função", async () => {
    const response = await get(sign(WHATSAPP_KEY));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ authentication_succeeded: true, app_id: "praxis-crm-whatsapp", function_count: 1, mode: "cloud" });
  });

  it.each([
    ["sem assinatura", undefined],
    ["com a signing key da A11/agenda", sign(A11_KEY)],
    ["com a signing key reserva da A11/agenda", sign(A11_FALLBACK)],
    ["com assinatura adulterada", tamper(sign(WHATSAPP_KEY))],
  ])("%s: 401", async (_name, signature) => {
    expect((await get(signature)).status).toBe(401);
  });

  it("chave reserva PRÓPRIA (rotação): aceita", async () => {
    vi.stubEnv("WHATSAPP_INNGEST_SIGNING_KEY_FALLBACK", WHATSAPP_FALLBACK);
    expect((await get(sign(WHATSAPP_FALLBACK))).status).toBe(200);
    expect((await get(sign(A11_FALLBACK))).status).toBe(401);
  });

  it("INNGEST_DEV ligado em ambiente hospedado não desliga a assinatura", async () => {
    vi.stubEnv("INNGEST_DEV", "1");
    expect((await get()).status).toBe(401);
    expect((await get(sign(A11_KEY))).status).toBe(401);
  });
});

describe("3. cliente e configuração isolados", () => {
  it("chaves do cliente: nunca as da A11 — assinatura, reserva e evento", async () => {
    hosted("production");
    vi.stubEnv("WHATSAPP_INNGEST_SIGNING_KEY", WHATSAPP_KEY);
    const { whatsappInngestServeConfig, whatsappInngestServeClient, WHATSAPP_INNGEST_APP_ID } = await loadInngest();
    const config = whatsappInngestServeConfig();
    if (!config.ok) throw new Error("configuração deveria estar completa");
    const client = whatsappInngestServeClient(config);
    expect(client.id).toBe(WHATSAPP_INNGEST_APP_ID);
    expect(client.signingKey).toBe(WHATSAPP_KEY);
    expect(client.signingKeyFallback).not.toBe(A11_FALLBACK);
    expect(client.signingKeyFallback).not.toBe(A11_KEY);
    expect(client.eventKey).not.toBe(A11_EVENT_KEY);
  });

  it("com a chave de evento própria, o cliente usa ela", async () => {
    hosted();
    vi.stubEnv("WHATSAPP_INNGEST_SIGNING_KEY", WHATSAPP_KEY);
    vi.stubEnv("WHATSAPP_INNGEST_EVENT_KEY", WHATSAPP_EVENT_KEY);
    const { whatsappInngestServeConfig, whatsappInngestServeClient } = await loadInngest();
    const config = whatsappInngestServeConfig();
    if (!config.ok) throw new Error("configuração deveria estar completa");
    expect(whatsappInngestServeClient(config).eventKey).toBe(WHATSAPP_EVENT_KEY);
  });

  it("a configuração nunca lê as variáveis da A11", async () => {
    const { whatsappInngestServeConfig } = await loadInngest();
    expect(whatsappInngestServeConfig({ VERCEL_ENV: "preview", INNGEST_SIGNING_KEY: A11_KEY, INNGEST_EVENT_KEY: A11_EVENT_KEY })).toEqual({ ok: false });
    const ok = whatsappInngestServeConfig({ VERCEL_ENV: "production", WHATSAPP_INNGEST_SIGNING_KEY: WHATSAPP_KEY, INNGEST_SIGNING_KEY_FALLBACK: A11_FALLBACK, INNGEST_EVENT_KEY: A11_EVENT_KEY });
    expect(ok).toMatchObject({ ok: true, signingKey: WHATSAPP_KEY, isDev: false });
    expect(JSON.stringify(ok)).not.toContain(A11_FALLBACK.slice(-16));
    expect(JSON.stringify(ok)).not.toContain(A11_EVENT_KEY);
  });

  it("a função: id próprio, só o evento da inbox, sem cron, com nova tentativa limitada", async () => {
    const { WHATSAPP_INBOX_CONSUMER_FUNCTION_CONFIG } = await import("@/server/whatsapp/inngest-consumer");
    const { WHATSAPP_INBOX_RECEIVED_EVENT } = await import("@/server/whatsapp/inbox-events");
    expect(WHATSAPP_INBOX_CONSUMER_FUNCTION_CONFIG.id).toBe("b3-whatsapp-inbox-consumer");
    expect(WHATSAPP_INBOX_CONSUMER_FUNCTION_CONFIG.triggers).toEqual([{ event: WHATSAPP_INBOX_RECEIVED_EVENT }]);
    expect(WHATSAPP_INBOX_CONSUMER_FUNCTION_CONFIG.retries).toBeGreaterThanOrEqual(1);
    expect(WHATSAPP_INBOX_CONSUMER_FUNCTION_CONFIG.retries).toBeLessThanOrEqual(5);
  });
});
