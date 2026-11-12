/**
 * @vitest-environment node
 *
 * B6a — agendador periódico da C1 no app geral do Inngest (`praxis-crm`,
 * `/api/inngest`). Só as proteções essenciais:
 *
 *  - o payload real da sincronização (SDK real, sem rede) leva a função da C1
 *    com cron de 2 em 2 minutos, concorrência 1 e 0 retries, e a da A11 intacta;
 *  - a função chama só `process_automation_events_system`, com lote 100, e
 *    devolve só `{ events, executions }`;
 *  - erro do banco falha a execução com código fixo, sem mensagem original,
 *    payload, dado pessoal ou segredo, e sem nenhum log;
 *  - sem a configuração obrigatória a rota continua falhando fechada (503);
 *  - nenhum módulo da agenda ou do WhatsApp, e nenhuma chamada externa.
 *
 * Chaves fictícias. O banco é simulado no cliente do Supabase.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rpc: vi.fn(), createClient: vi.fn() }));

vi.mock("@supabase/supabase-js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createClient: h.createClient,
}));

const SIGNING_KEY = `signkey-prod-${"c3".repeat(32)}`;
const BASE = "https://praxis-crm-exemplo.vercel.app";
const URL_ROTA = `${BASE}/api/inngest`;
const FN_C1 = "praxis-crm-c1-automations-scheduler";
const FN_A11 = "praxis-crm-a11-process-form-submission";
const FN_C3B = "praxis-crm-c3b-privacy-retention-scheduler";
const SEGREDO_NO_ERRO = "senha=segredo-ficticio +5511999990000 maria@exemplo.com payload={cpf:123}";
const RAIZ = process.cwd();
const A11_ENV = [
  "A11_PAYLOAD_ACTIVE_KEY_VERSION",
  "A11_PAYLOAD_KEY_VERSIONS",
  "A11_IP_HMAC_KEY",
  "TURNSTILE_SECRET_KEY",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "INNGEST_EVENT_KEY",
  "CRON_SECRET",
];

let spies: ReturnType<typeof vi.spyOn>[] = [];
const fetchFalso = vi.fn();
// O próprio SDK registra a falha da etapa em console.error (nome do erro + o erro já
// sanitizado). Esse é o único log permitido, e o conteúdo dele é conferido no teste.
let logDoSdk = false;

beforeEach(() => {
  vi.resetModules();
  logDoSdk = false;
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("INNGEST_SIGNING_KEY", SIGNING_KEY);
  vi.stubEnv("INNGEST_DEV", "");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://projeto-ficticio.supabase.co");
  vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_ficticia");
  h.rpc.mockReset();
  h.createClient.mockReset();
  h.createClient.mockImplementation(() => ({ rpc: h.rpc }));
  fetchFalso.mockReset();
  fetchFalso.mockImplementation(async () => Response.json({ ok: true, modified: true }));
  vi.stubGlobal("fetch", fetchFalso);
});

afterEach(() => {
  for (const spy of spies) {
    if (logDoSdk && spy === spies[3]) continue;
    expect(spy).not.toHaveBeenCalled();
  }
  vi.doUnmock("@/server/ingest/config");
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A11 "configurada": o validador é trocado, as demais camadas são as reais. */
function withIngestConfig() {
  vi.doMock("@/server/ingest/config", () => ({
    IngestConfigError: class extends Error {},
    getIngestConfig: () => ({
      NEXT_PUBLIC_SUPABASE_URL: "https://projeto-ficticio.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_ficticia",
    }),
  }));
}

type SyncedFunction = { id: string; concurrency?: unknown; triggers: unknown[]; steps: Record<string, { retries?: unknown }> };

async function funcoesSincronizadas(): Promise<SyncedFunction[]> {
  withIngestConfig();
  const route = await import("@/app/api/inngest/route");
  const response = await route.PUT(new NextRequest(URL_ROTA, { method: "PUT" }), undefined);
  expect(response.status).toBe(200);
  expect(fetchFalso).toHaveBeenCalledTimes(1);
  const [, init] = fetchFalso.mock.calls[0] as unknown as [unknown, { body: string }];
  return (JSON.parse(init.body) as { functions: SyncedFunction[] }).functions;
}

describe("1–4. o payload real da sincronização", () => {
  it("registra a função da C1 no app praxis-crm, ao lado da A11 e da C3b (B6b)", async () => {
    const functions = await funcoesSincronizadas();
    expect(functions.map((fn) => fn.id).sort()).toEqual([FN_A11, FN_C1, FN_C3B].sort());
  });

  it("cron exatamente `*/2 * * * *`, e nenhum outro gatilho", async () => {
    const fn = (await funcoesSincronizadas()).find((f) => f.id === FN_C1);
    expect(fn?.triggers).toEqual([{ cron: "*/2 * * * *" }]);
  });

  it("concorrência exatamente 1", async () => {
    const fn = (await funcoesSincronizadas()).find((f) => f.id === FN_C1);
    expect(fn?.concurrency).toEqual({ limit: 1 });
  });

  it("retries exatamente 0 (o banco controla tentativas e espera)", async () => {
    const fn = (await funcoesSincronizadas()).find((f) => f.id === FN_C1);
    const retries = Object.values(fn?.steps ?? {}).map((step) => step.retries);
    expect(retries).toEqual([{ attempts: 0 }]);
  });

  it("10. a função da A11 mantém gatilho, retries e concorrência", async () => {
    const fn = (await funcoesSincronizadas()).find((f) => f.id === FN_A11);
    expect(fn?.triggers).toEqual([{ event: "praxis/form.submission.received" }]);
    expect(fn?.concurrency).toEqual({ limit: 5 });
    expect(Object.values(fn?.steps ?? {}).map((step) => step.retries)).toEqual([{ attempts: 9 }]);
  });

  it("o gatilho é só o relógio: o agendador não escuta nem publica evento", () => {
    const fonte = readFileSync(join(RAIZ, "src/app/api/inngest/automations-scheduler.ts"), "utf8");
    expect(fonte).not.toMatch(/event:\s*["'`A-Z]|\.send\(|inngestClient|publisher/);
    expect(fonte).toContain('triggers: [{ cron: "*/2 * * * *" }]');
  });
});

describe("5–9. a execução", () => {
  const step = { run: async (_id: string, fn: () => Promise<unknown>) => fn() };

  it("5–6. chama só process_automation_events_system, com lote exatamente 100", async () => {
    withIngestConfig();
    h.rpc.mockResolvedValue({ data: { events: 4, executions: 3 }, error: null });
    const { handleAutomationsScheduler } = await import("@/app/api/inngest/automations-scheduler");
    await handleAutomationsScheduler({ step });
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith("process_automation_events_system", { p_limit: 100 });
    expect(h.createClient).toHaveBeenCalledTimes(1);
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("7. devolve só as contagens, mesmo que o banco mande outro campo", async () => {
    withIngestConfig();
    h.rpc.mockResolvedValue({ data: { events: 2, executions: 5, payload: SEGREDO_NO_ERRO, lead_id: "x" }, error: null });
    const { handleAutomationsScheduler } = await import("@/app/api/inngest/automations-scheduler");
    const resultado = await handleAutomationsScheduler({ step });
    expect(resultado).toEqual({ events: 2, executions: 5 });
    expect(JSON.stringify(resultado)).not.toMatch(/segredo|maria|payload|lead_id/);
  });

  it.each([
    ["erro do banco", () => h.rpc.mockResolvedValue({ data: null, error: { message: SEGREDO_NO_ERRO } })],
    ["banco não responde", () => h.rpc.mockRejectedValue(new TypeError(`fetch failed ${SEGREDO_NO_ERRO}`))],
    ["resposta vazia", () => h.rpc.mockResolvedValue({ data: null, error: null })],
    ["contagem inválida", () => h.rpc.mockResolvedValue({ data: { events: -1, executions: "3" }, error: null })],
  ])("8–9. %s: a execução FALHA só com o código, sem mensagem, pilha, PII nem log", async (_nome, preparar) => {
    withIngestConfig();
    preparar();
    const { handleAutomationsScheduler, AutomationsSchedulerFailed } = await import("@/app/api/inngest/automations-scheduler");
    const erro = await handleAutomationsScheduler({ step }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(AutomationsSchedulerFailed);
    const falha = erro as InstanceType<typeof AutomationsSchedulerFailed>;
    expect(falha.code).toBe("automations_scheduler_failed");
    expect(falha.message).toBe("automations_scheduler_failed");
    expect(falha.stack).toBe("AutomationsSchedulerFailed: automations_scheduler_failed");
    expect(`${falha.message}${falha.stack}${JSON.stringify(falha)}`).not.toMatch(/segredo|maria|\+55|payload|cpf|fetch failed/);
  });

  it("configuração do banco ausente: falha com código próprio, sem citar variável", async () => {
    vi.doMock("@/server/ingest/config", () => ({
      IngestConfigError: class extends Error {},
      getIngestConfig: () => {
        throw new Error("Configuração de ingestão ausente: SUPABASE_SECRET_KEY, TURNSTILE_SECRET_KEY");
      },
    }));
    const { handleAutomationsScheduler } = await import("@/app/api/inngest/automations-scheduler");
    const erro = (await handleAutomationsScheduler({ step }).catch((e: unknown) => e)) as Error & { code: string };
    expect(erro.code).toBe("automations_scheduler_not_configured");
    expect(`${erro.message}${erro.stack}`).not.toMatch(/SUPABASE|TURNSTILE|ingestão/);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("na execução real do SDK, o erro do banco vira StepFailed sem nova tentativa e sem vazar nada", async () => {
    withIngestConfig();
    h.rpc.mockResolvedValue({ data: null, error: { message: SEGREDO_NO_ERRO } });
    const route = await import("@/app/api/inngest/route");
    const body = JSON.stringify({
      event: { name: "inngest/scheduled.timer", data: { cron: "*/2 * * * *" }, id: "evt-1", ts: Date.now() },
      events: [{ name: "inngest/scheduled.timer", data: { cron: "*/2 * * * *" }, id: "evt-1", ts: Date.now() }],
      steps: {},
      ctx: { run_id: "run-1", attempt: 0, disable_immediate_execution: false, use_api: false, stack: { stack: [], current: 0 }, fn_id: FN_C1 },
      version: 1,
    });
    const res = await route.POST(
      new NextRequest(`${URL_ROTA}?fnId=${FN_C1}&stepId=step`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-inngest-signature": signature(body) },
        body,
      }),
      undefined,
    );
    const text = await res.text();
    logDoSdk = true;
    const logs = JSON.stringify(spies[3]?.mock.calls.map((call: unknown[]) => call.map(String)));
    expect(logs).toContain("automations_scheduler_failed");
    expect(logs).not.toMatch(/segredo|maria|\+55|payload|cpf|sb_secret|SUPABASE/);
    expect(res.status).toBe(206);
    expect(res.headers.get("x-inngest-no-retry")).toBe("true");
    expect(JSON.parse(text)[0]).toMatchObject({ op: "StepFailed", error: { name: "AutomationsSchedulerFailed", message: "automations_scheduler_failed" } });
    expect(text).not.toMatch(/segredo|maria|\+55|payload|cpf|sb_secret|praxis-crm\/src/);
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith("process_automation_events_system", { p_limit: 100 });
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("na execução real do SDK, o sucesso devolve só as contagens", async () => {
    withIngestConfig();
    h.rpc.mockResolvedValue({ data: { events: 1, executions: 1 }, error: null });
    const route = await import("@/app/api/inngest/route");
    const body = JSON.stringify({
      event: { name: "inngest/scheduled.timer", data: { cron: "*/2 * * * *" }, id: "evt-2", ts: Date.now() },
      events: [{ name: "inngest/scheduled.timer", data: { cron: "*/2 * * * *" }, id: "evt-2", ts: Date.now() }],
      steps: {},
      ctx: { run_id: "run-2", attempt: 0, disable_immediate_execution: false, use_api: false, stack: { stack: [], current: 0 }, fn_id: FN_C1 },
      version: 1,
    });
    const res = await route.POST(
      new NextRequest(`${URL_ROTA}?fnId=${FN_C1}&stepId=step`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-inngest-signature": signature(body) },
        body,
      }),
      undefined,
    );
    const text = await res.text();
    expect(res.status).toBeLessThan(300);
    expect(text).toContain('"events":1');
    expect(text).toContain('"executions":1');
  });
});

describe("11. falha fechada sem a configuração obrigatória", () => {
  it.each(["GET", "POST", "PUT"] as const)("%s sem as variáveis da ingestão: 503 sanitizado e o banco não é tocado", async (metodo) => {
    for (const nome of A11_ENV) vi.stubEnv(nome, "");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    const route = await import("@/app/api/inngest/route");
    const res = await route[metodo](new NextRequest(URL_ROTA, { method: metodo }), undefined);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "service_unavailable" });
    expect(h.createClient).not.toHaveBeenCalled();
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});

describe("12–13. isolamento e nenhuma chamada externa", () => {
  const fonte = readFileSync(join(RAIZ, "src/app/api/inngest/automations-scheduler.ts"), "utf8");
  const imports = [...fonte.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);

  it("importa só o SDK do Inngest e o cliente administrativo (nada da agenda nem do WhatsApp)", () => {
    expect(imports).toEqual(["inngest", "@/server/supabase/admin"]);
    expect(imports.join(" ")).not.toMatch(/calendar|whatsapp|ingest\//i);
  });

  it("a rota geral continua sem referência ao WhatsApp e soma as funções da C1 e da C3b (B6b)", () => {
    const rota = readFileSync(join(RAIZ, "src/app/api/inngest/route.ts"), "utf8");
    expect(rota).not.toMatch(/whatsapp/i);
    expect(rota).toContain("functions: [processFormSubmission, automationsScheduler, privacyRetentionScheduler]");
    expect(rota).toContain("concurrency: { limit: 5 }");
    expect(rota).toContain("retries: A11_INGEST_MAX_RETRIES");
    expect(rota).toContain("triggers: [{ event: FORM_EVENT_NAME }]");
    expect(rota).toContain("export const A11_INGEST_MAX_RETRIES = 9;");
  });

  it("sem fetch, HTTP, log nem acesso a variáveis no agendador", () => {
    expect(fonte).not.toMatch(/\bfetch\(|http|console\.|process\.env/);
  });

  it("a rota manual /api/cron/automations segue como estava (mesmo lote, mesmo segredo)", () => {
    const cron = readFileSync(join(RAIZ, "src/app/api/cron/automations/route.ts"), "utf8");
    expect(cron).toContain('rpc("process_automation_events_system", { p_limit: 100 })');
    expect(cron).toContain("isAuthorizedCalendarCron");
  });
});

// ---- assinatura como o Inngest assina (JSON canônico + timestamp) ----
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function signature(body: string, key = SIGNING_KEY, ts = Math.floor(Date.now() / 1000)) {
  const raw = key.replace(/^signkey-[\w]+-/, "");
  const data = body === "" ? "" : canonical(JSON.parse(body));
  return `t=${ts}&s=${createHmac("sha256", raw).update(data + ts).digest("hex")}`;
}
