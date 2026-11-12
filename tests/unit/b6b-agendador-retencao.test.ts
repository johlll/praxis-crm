/**
 * @vitest-environment node
 *
 * B6b — agendador diário do lote de retenção da C3b no app geral do Inngest (`praxis-crm`,
 * `/api/inngest`). Só as proteções essenciais:
 *
 *  - o payload real da sincronização (SDK real, sem rede) leva EXATAMENTE as três funções:
 *    A11 (evento, concorrência 5, 9 retries), C1 (cron de 2 min, concorrência 1, 0 retries) e C3b
 *    (cron diário 06:17 UTC, concorrência 1, 0 retries);
 *  - a função da C3b chama só `run_privacy_retention_batch`, uma vez, com limite 50, num único step, e
 *    devolve só `{ processed, blocked, failed }`;
 *  - resposta inválida, erro ou ausência de resposta do banco, `failed > 0` e configuração ausente
 *    falham com CÓDIGO FECHADO, sem mensagem do banco, pilha, id, PII ou log;
 *  - nenhuma rota nova, nenhum evento, nenhuma chamada externa, nenhuma leitura direta de tabela.
 *
 * Chaves fictícias. O banco é simulado no cliente do Supabase.
 */
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), createClient: vi.fn() }));

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
// O próprio SDK registra a falha da etapa em console.error (nome do erro + o erro já sanitizado).
// Esse é o único log permitido, e o conteúdo dele é conferido nos testes de execução real.
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
  h.from.mockReset();
  h.createClient.mockReset();
  h.createClient.mockImplementation(() => ({ rpc: h.rpc, from: h.from }));
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

/** Executa a função da C3b com o SDK real (assinatura válida, sem rede). */
async function executarNoSdk(eventId: string, runId: string) {
  const route = await import("@/app/api/inngest/route");
  const ev = { name: "inngest/scheduled.timer", data: { cron: "17 6 * * *" }, id: eventId, ts: Date.now() };
  const body = JSON.stringify({
    event: ev,
    events: [ev],
    steps: {},
    ctx: { run_id: runId, attempt: 0, disable_immediate_execution: false, use_api: false, stack: { stack: [], current: 0 }, fn_id: FN_C3B },
    version: 1,
  });
  return route.POST(
    new NextRequest(`${URL_ROTA}?fnId=${FN_C3B}&stepId=step`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-inngest-signature": signature(body) },
      body,
    }),
    undefined,
  );
}

describe("1–4 e 13. o payload real da sincronização", () => {
  it("1/13. serve exatamente as três funções esperadas: A11, C1 e C3b", async () => {
    const functions = await funcoesSincronizadas();
    expect(functions.map((fn) => fn.id).sort()).toEqual([FN_A11, FN_C1, FN_C3B].sort());
    expect(functions).toHaveLength(3);
  });

  it("2. a A11 permanece com o mesmo evento, concorrência e retries", async () => {
    const fn = (await funcoesSincronizadas()).find((f) => f.id === FN_A11);
    expect(fn?.triggers).toEqual([{ event: "praxis/form.submission.received" }]);
    expect(fn?.concurrency).toEqual({ limit: 5 });
    expect(Object.values(fn?.steps ?? {}).map((step) => step.retries)).toEqual([{ attempts: 9 }]);
  });

  it("3. a C1 permanece com cron de 2 minutos, concorrência 1 e 0 retries", async () => {
    const fn = (await funcoesSincronizadas()).find((f) => f.id === FN_C1);
    expect(fn?.triggers).toEqual([{ cron: "*/2 * * * *" }]);
    expect(fn?.concurrency).toEqual({ limit: 1 });
    expect(Object.values(fn?.steps ?? {}).map((step) => step.retries)).toEqual([{ attempts: 0 }]);
  });

  it("4. a C3b registra exatamente o cron diário 06:17 UTC, concorrência 1, 0 retries e um único step", async () => {
    const fn = (await funcoesSincronizadas()).find((f) => f.id === FN_C3B);
    expect(fn?.triggers).toEqual([{ cron: "17 6 * * *" }]);
    expect(fn?.concurrency).toEqual({ limit: 1 });
    expect(Object.values(fn?.steps ?? {}).map((step) => step.retries)).toEqual([{ attempts: 0 }]);
    expect(Object.keys(fn?.steps ?? {})).toHaveLength(1);
  });

  it("o gatilho é só o relógio: o agendador não escuta nem publica evento", () => {
    const fonte = readFileSync(join(RAIZ, "src/app/api/inngest/privacy-retention-scheduler.ts"), "utf8");
    expect(fonte).not.toMatch(/event:\s*["'`A-Z]|\.send\(|inngestClient|publisher/);
    expect(fonte).toContain('triggers: [{ cron: "17 6 * * *" }]');
    expect(fonte).toContain('id: "c3b-privacy-retention-scheduler"');
  });
});

describe("5–10. a execução", () => {
  const step = { run: async (_id: string, fn: () => Promise<unknown>) => fn() };
  const SEM_VAZAR = /segredo|maria|\+55|payload|cpf|fetch failed|[0-9a-f]{8}-[0-9a-f]{4}-/;

  it("5. chama só run_privacy_retention_batch, uma vez, com limite exatamente 50, e nada mais", async () => {
    withIngestConfig();
    h.rpc.mockResolvedValue({ data: { processed: 2, blocked: 5, failed: 0 }, error: null });
    const { handlePrivacyRetentionScheduler } = await import("@/app/api/inngest/privacy-retention-scheduler");
    await handlePrivacyRetentionScheduler({ step });
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith("run_privacy_retention_batch", { p_limit: 50 });
    expect(h.createClient).toHaveBeenCalledTimes(1);
    expect(h.from).not.toHaveBeenCalled();
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("6. devolve só as três contagens, mesmo que o banco mande outro campo", async () => {
    withIngestConfig();
    h.rpc.mockResolvedValue({
      data: {
        processed: 2,
        blocked: 5,
        failed: 0,
        contact_id: "c0000000-0000-0000-0000-000000000001",
        workspace_id: "w",
        reasons: ["client_present"],
        payload: SEGREDO_NO_ERRO,
      },
      error: null,
    });
    const { handlePrivacyRetentionScheduler } = await import("@/app/api/inngest/privacy-retention-scheduler");
    const resultado = await handlePrivacyRetentionScheduler({ step });
    expect(resultado).toEqual({ processed: 2, blocked: 5, failed: 0 });
    expect(Object.keys(resultado as object).sort()).toEqual(["blocked", "failed", "processed"]);
    expect(JSON.stringify(resultado)).not.toMatch(/segredo|contact_id|workspace|reasons|payload|client_present/);
  });

  it("aceita o limite exato (soma 50) e o lote vazio", async () => {
    withIngestConfig();
    const { runPrivacyRetentionScheduler } = await import("@/app/api/inngest/privacy-retention-scheduler");
    h.rpc.mockResolvedValue({ data: { processed: 20, blocked: 30, failed: 0 }, error: null });
    await expect(runPrivacyRetentionScheduler()).resolves.toEqual({ processed: 20, blocked: 30, failed: 0 });
    h.rpc.mockResolvedValue({ data: { processed: 0, blocked: 0, failed: 0 }, error: null });
    await expect(runPrivacyRetentionScheduler()).resolves.toEqual({ processed: 0, blocked: 0, failed: 0 });
  });

  it.each([
    ["erro do banco", () => h.rpc.mockResolvedValue({ data: null, error: { message: SEGREDO_NO_ERRO } })],
    ["erro do banco com dados junto", () => h.rpc.mockResolvedValue({ data: { processed: 1, blocked: 0, failed: 0 }, error: { message: SEGREDO_NO_ERRO } })],
    ["banco não responde", () => h.rpc.mockRejectedValue(new TypeError(`fetch failed ${SEGREDO_NO_ERRO}`))],
    ["resposta vazia", () => h.rpc.mockResolvedValue({ data: null, error: null })],
    ["resposta que não é objeto", () => h.rpc.mockResolvedValue({ data: "ok", error: null })],
    ["campo ausente", () => h.rpc.mockResolvedValue({ data: { processed: 1, blocked: 0 }, error: null })],
    ["contagem negativa", () => h.rpc.mockResolvedValue({ data: { processed: -1, blocked: 0, failed: 0 }, error: null })],
    ["contagem fracionária", () => h.rpc.mockResolvedValue({ data: { processed: 1.5, blocked: 0, failed: 0 }, error: null })],
    ["contagem em texto", () => h.rpc.mockResolvedValue({ data: { processed: "1", blocked: 0, failed: 0 }, error: null })],
    ["contagem nula", () => h.rpc.mockResolvedValue({ data: { processed: null, blocked: 0, failed: 0 }, error: null })],
    ["soma acima do limite (51)", () => h.rpc.mockResolvedValue({ data: { processed: 26, blocked: 25, failed: 0 }, error: null })],
    ["soma acima do limite com falha", () => h.rpc.mockResolvedValue({ data: { processed: 0, blocked: 0, failed: 500 }, error: null })],
  ])("7–8. %s: a execução FALHA só com o código fechado, sem mensagem, pilha, PII nem log", async (_nome, preparar) => {
    withIngestConfig();
    preparar();
    const { handlePrivacyRetentionScheduler, PrivacyRetentionSchedulerFailed } = await import("@/app/api/inngest/privacy-retention-scheduler");
    const erro = await handlePrivacyRetentionScheduler({ step }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(PrivacyRetentionSchedulerFailed);
    const falha = erro as InstanceType<typeof PrivacyRetentionSchedulerFailed>;
    expect(falha.code).toBe("privacy_retention_failed");
    expect(falha.message).toBe("privacy_retention_failed");
    expect(falha.stack).toBe("PrivacyRetentionSchedulerFailed: privacy_retention_failed");
    expect(`${falha.message}${falha.stack}${JSON.stringify(falha)}`).not.toMatch(SEM_VAZAR);
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });

  it("9. failed > 0 faz a execução falhar com código próprio, sem revelar contagens, ids nem motivos", async () => {
    withIngestConfig();
    h.rpc.mockResolvedValue({
      data: { processed: 3, blocked: 4, failed: 2, contact_id: "c0000000-0000-0000-0000-000000000001", reasons: ["client_present"] },
      error: null,
    });
    const { handlePrivacyRetentionScheduler, PrivacyRetentionSchedulerFailed } = await import("@/app/api/inngest/privacy-retention-scheduler");
    const erro = await handlePrivacyRetentionScheduler({ step }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(PrivacyRetentionSchedulerFailed);
    const falha = erro as InstanceType<typeof PrivacyRetentionSchedulerFailed>;
    expect(falha.code).toBe("privacy_retention_batch_has_failures");
    expect(falha.message).toBe("privacy_retention_batch_has_failures");
    expect(falha.stack).toBe("PrivacyRetentionSchedulerFailed: privacy_retention_batch_has_failures");
    expect(`${falha.message}${falha.stack}${JSON.stringify(falha)}`).not.toMatch(/contact_id|c0000000|client_present|reasons|[0-9]/);
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });

  it("10. configuração ausente: falha com código próprio, sem citar variável e SEM tocar no banco", async () => {
    vi.doMock("@/server/ingest/config", () => ({
      IngestConfigError: class extends Error {},
      getIngestConfig: () => {
        throw new Error("Configuração de ingestão ausente: SUPABASE_SECRET_KEY, TURNSTILE_SECRET_KEY");
      },
    }));
    const { handlePrivacyRetentionScheduler } = await import("@/app/api/inngest/privacy-retention-scheduler");
    const erro = (await handlePrivacyRetentionScheduler({ step }).catch((e: unknown) => e)) as Error & { code: string };
    expect(erro.code).toBe("privacy_retention_not_configured");
    expect(erro.message).toBe("privacy_retention_not_configured");
    expect(`${erro.message}${erro.stack}`).not.toMatch(/SUPABASE|TURNSTILE|ingestão/);
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.from).not.toHaveBeenCalled();
  });

  it("o step é um só, com id fixo", async () => {
    withIngestConfig();
    h.rpc.mockResolvedValue({ data: { processed: 0, blocked: 0, failed: 0 }, error: null });
    const ids: string[] = [];
    const { handlePrivacyRetentionScheduler } = await import("@/app/api/inngest/privacy-retention-scheduler");
    await handlePrivacyRetentionScheduler({
      step: {
        run: async (id, fn) => {
          ids.push(id);
          return fn();
        },
      },
    });
    expect(ids).toEqual(["run-privacy-retention-batch"]);
  });

  it("na execução real do SDK, failed > 0 vira StepFailed sem nova tentativa e sem vazar nada", async () => {
    withIngestConfig();
    h.rpc.mockResolvedValue({ data: { processed: 1, blocked: 0, failed: 1, contact_id: "c0000000-0000-0000-0000-000000000001" }, error: null });
    const res = await executarNoSdk("evt-1", "run-1");
    const text = await res.text();
    logDoSdk = true;
    const logs = JSON.stringify(spies[3]?.mock.calls.map((call: unknown[]) => call.map(String)));
    expect(logs).toContain("privacy_retention_batch_has_failures");
    expect(logs).not.toMatch(/segredo|maria|\+55|payload|cpf|sb_secret|SUPABASE|c0000000/);
    expect(res.status).toBe(206);
    expect(res.headers.get("x-inngest-no-retry")).toBe("true");
    expect(JSON.parse(text)[0]).toMatchObject({
      op: "StepFailed",
      error: { name: "PrivacyRetentionSchedulerFailed", message: "privacy_retention_batch_has_failures" },
    });
    expect(text).not.toMatch(/segredo|maria|\+55|payload|cpf|sb_secret|c0000000|praxis-crm\/src/);
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith("run_privacy_retention_batch", { p_limit: 50 });
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("na execução real do SDK, o erro do banco vira StepFailed sem nova tentativa e sem vazar nada", async () => {
    withIngestConfig();
    h.rpc.mockResolvedValue({ data: null, error: { message: SEGREDO_NO_ERRO } });
    const res = await executarNoSdk("evt-2", "run-2");
    const text = await res.text();
    logDoSdk = true;
    const logs = JSON.stringify(spies[3]?.mock.calls.map((call: unknown[]) => call.map(String)));
    expect(logs).toContain("privacy_retention_failed");
    expect(logs).not.toMatch(/segredo|maria|\+55|payload|cpf|sb_secret|SUPABASE/);
    expect(res.status).toBe(206);
    expect(res.headers.get("x-inngest-no-retry")).toBe("true");
    expect(JSON.parse(text)[0]).toMatchObject({
      op: "StepFailed",
      error: { name: "PrivacyRetentionSchedulerFailed", message: "privacy_retention_failed" },
    });
    expect(text).not.toMatch(/segredo|maria|\+55|payload|cpf|sb_secret|praxis-crm\/src/);
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("na execução real do SDK, o sucesso devolve só as três contagens", async () => {
    withIngestConfig();
    h.rpc.mockResolvedValue({ data: { processed: 1, blocked: 2, failed: 0, contact_id: "c0000000-0000-0000-0000-000000000001" }, error: null });
    const res = await executarNoSdk("evt-3", "run-3");
    const text = await res.text();
    expect(res.status).toBeLessThan(300);
    expect(text).toContain('"processed":1');
    expect(text).toContain('"blocked":2');
    expect(text).toContain('"failed":0');
    expect(text).not.toMatch(/contact_id|c0000000/);
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});

describe("falha fechada sem a configuração obrigatória", () => {
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

describe("11–12. isolamento, nenhuma chamada externa, nenhum log", () => {
  const lerFonte = () => readFileSync(join(RAIZ, "src/app/api/inngest/privacy-retention-scheduler.ts"), "utf8");

  it("importa só o SDK do Inngest e o cliente administrativo (nada da agenda, do WhatsApp nem da ingestão)", () => {
    const imports = [...lerFonte().matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports).toEqual(["inngest", "@/server/supabase/admin"]);
    expect(imports.join(" ")).not.toMatch(/calendar|whatsapp|ingest\//i);
  });

  it("sem fetch, HTTP, log nem acesso a variáveis; só a RPC do lote, sem leitura direta de tabela", () => {
    const fonte = lerFonte();
    expect(fonte).not.toMatch(/\bfetch\(|http|console\.|process\.env|\.from\(/);
    expect([...fonte.matchAll(/\.rpc\(\s*"([a-z_]+)"/g)].map((m) => m[1])).toEqual(["run_privacy_retention_batch"]);
  });

  it("a rota geral soma só a função da C3b e mantém a A11 e a C1 como estavam", () => {
    const rota = readFileSync(join(RAIZ, "src/app/api/inngest/route.ts"), "utf8");
    expect(rota).not.toMatch(/whatsapp/i);
    expect(rota).toContain("functions: [processFormSubmission, automationsScheduler, privacyRetentionScheduler]");
    expect(rota).toContain("concurrency: { limit: 5 }");
    expect(rota).toContain("retries: A11_INGEST_MAX_RETRIES");
    expect(rota).toContain("triggers: [{ event: FORM_EVENT_NAME }]");
    expect(rota).toContain("export const A11_INGEST_MAX_RETRIES = 9;");
    const c1 = readFileSync(join(RAIZ, "src/app/api/inngest/automations-scheduler.ts"), "utf8");
    expect(c1).toContain('triggers: [{ cron: "*/2 * * * *" }]');
    expect(c1).toContain("concurrency: { limit: 1 }");
    expect(c1).toContain("retries: 0 as const");
  });

  it("não existe rota alternativa: só o agendador chama run_privacy_retention_batch (fora os tipos gerados)", () => {
    const achados: string[] = [];
    const varrer = (dir: string) => {
      for (const entrada of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entrada.name}`;
        if (entrada.isDirectory()) varrer(rel);
        else if (/\.(ts|tsx)$/.test(entrada.name) && readFileSync(join(RAIZ, rel), "utf8").includes("run_privacy_retention_batch")) achados.push(rel);
      }
    };
    varrer("src");
    expect(achados.sort()).toEqual(["src/app/api/inngest/privacy-retention-scheduler.ts", "src/server/types/database.ts"]);
  });

  it("nenhuma variável nem segredo novo: o agendador não lê ambiente", () => {
    const fonte = lerFonte();
    expect(fonte).not.toMatch(/process\.env|INNGEST_|CRON_SECRET/);
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
