/**
 * @vitest-environment node
 *
 * B2 — app próprio do Inngest para a agenda (`praxis-crm-agenda`,
 * `/api/inngest/calendar`), separado do app da A11 (`praxis-crm`,
 * `/api/inngest`). As variáveis da A11 ficam AUSENTES de verdade; as
 * requisições são assinadas como o Inngest assina (HMAC-SHA256 do corpo +
 * timestamp com a signing key sem o prefixo). Nenhum serviço externo: só
 * introspecção e execução locais do SDK instalado; a manutenção é simulada.
 */
import { createHmac } from "node:crypto";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("@/server/calendar/background", () => ({
  runScheduledCalendarMaintenance: (source: string) => m.run(source),
}));

const SIGNING_KEY = `signkey-branch-${"ab12".repeat(16)}`;
const A11_ONLY = [
  "A11_PAYLOAD_ACTIVE_KEY_VERSION",
  "A11_PAYLOAD_KEY_VERSIONS",
  "A11_IP_HMAC_KEY",
  "TURNSTILE_SECRET_KEY",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "INNGEST_EVENT_KEY",
  "CRON_SECRET",
];
const BASE = "https://praxis-crm-git-validacao-b2-exemplo.vercel.app";

// Mesma forma do SDK: JSON canônico (chaves ordenadas) para corpo com JSON.
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
  let data = body;
  try {
    data = body === "" ? "" : canonical(JSON.parse(body));
  } catch {
    // corpo que não é JSON: assinado como texto
  }
  return `t=${ts}&s=${createHmac("sha256", raw).update(data + ts).digest("hex")}`;
}

async function loadCalendarRoute() {
  vi.resetModules();
  return import("@/app/api/inngest/calendar/route");
}

async function introspect(route: { GET: (req: NextRequest, ctx?: unknown) => Promise<Response> }, path: string, signed = true) {
  const res = await route.GET(
    new NextRequest(`${BASE}${path}`, { method: "GET", headers: signed ? { "x-inngest-signature": signature("") } : {} }),
    undefined,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const CRON_RUN_BODY = (fnId: string) =>
  JSON.stringify({
    event: { name: "inngest/scheduled.timer", data: { cron: "TZ=UTC */15 * * * *" }, id: "evt-1", ts: Date.now() },
    events: [{ name: "inngest/scheduled.timer", data: { cron: "TZ=UTC */15 * * * *" }, id: "evt-1", ts: Date.now() }],
    steps: {},
    ctx: { run_id: "run-1", attempt: 0, disable_immediate_execution: false, use_api: false, stack: { stack: [], current: 0 }, fn_id: fnId },
    version: 1,
  });

async function invoke(route: { POST: (req: NextRequest, ctx?: unknown) => Promise<Response> }, sig: string | null) {
  const fnId = "praxis-crm-agenda-b2-calendar-maintenance";
  const body = CRON_RUN_BODY(fnId);
  const res = await route.POST(
    new NextRequest(`${BASE}/api/inngest/calendar?fnId=${fnId}&stepId=step`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(sig ? { "x-inngest-signature": sig } : {}) },
      body,
    }),
    undefined,
  );
  return { status: res.status, text: await res.text(), body };
}

beforeEach(() => {
  m.run.mockReset();
  m.run.mockResolvedValue({ outcome: "ok", detector: null, report: { targets: 1, synced: 1, failed: 0, busy: 0, accessLost: 0, needsReauth: 0 } });
  for (const name of A11_ONLY) vi.stubEnv(name, "");
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("VERCEL_GIT_COMMIT_REF", "validacao-b2");
  vi.stubEnv("INNGEST_SIGNING_KEY", SIGNING_KEY);
  vi.stubEnv("INNGEST_DEV", "");
  vi.stubEnv("CALENDAR_SCHEDULER_ENABLED", "true");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("/api/inngest/calendar — app próprio da agenda, sem a A11", () => {
  it("configuração válida (sem nenhuma variável da A11): atende o SDK com o app da agenda e só a B2", async () => {
    const route = await loadCalendarRoute();
    const { status, body } = await introspect(route, "/api/inngest/calendar");
    expect(status).toBe(200);
    expect(body).toMatchObject({ authentication_succeeded: true, app_id: "praxis-crm-agenda", function_count: 1, mode: "cloud", has_event_key: false });
  });

  it("ambiente anunciado pelo SDK instalado: o branch da Vercel (VERCEL_GIT_COMMIT_REF)", async () => {
    const route = await loadCalendarRoute();
    const { body } = await introspect(route, "/api/inngest/calendar");
    // `env` é o ambiente do Inngest que o SDK anuncia; o app id não o substitui.
    expect(body).toMatchObject({ env: "validacao-b2", app_id: "praxis-crm-agenda" });
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "main");
    const prod = await introspect(await loadCalendarRoute(), "/api/inngest/calendar");
    expect(prod.body).toMatchObject({ env: "main" });
  });

  // O SDK apresenta zero funções; o serviço do Inngest RECUSA sincronizar
  // app sem funções (17/10/2026) — isto não retira uma função já registrada.
  it("flag desligada: o SDK apresenta lista VAZIA, sem bloquear a rota", async () => {
    vi.stubEnv("CALENDAR_SCHEDULER_ENABLED", "");
    const route = await loadCalendarRoute();
    const { status, body } = await introspect(route, "/api/inngest/calendar");
    expect(status).toBe(200);
    expect(body).toMatchObject({ authentication_succeeded: true, app_id: "praxis-crm-agenda", function_count: 0 });
  });

  it.each([["preview"], ["production"]])("sem signing key em %s: 503 fechado, sem SDK e sem manutenção", async (env) => {
    vi.stubEnv("VERCEL_ENV", env);
    vi.stubEnv("INNGEST_SIGNING_KEY", "");
    const route = await loadCalendarRoute();
    expect((await route.GET(new NextRequest(`${BASE}/api/inngest/calendar`), undefined)).status).toBe(503);
    expect((await invoke(route, signature("x"))).status).toBe(503);
    expect(m.run).not.toHaveBeenCalled();
  });

  it("introspecção sem assinatura: 401 (modo cloud), sem app, ambiente ou hash de chave", async () => {
    const route = await loadCalendarRoute();
    const { status, body } = await introspect(route, "/api/inngest/calendar", false);
    expect(status).toBe(401);
    expect(body).toEqual({ message: "Unauthorized" });
    expect(body).not.toHaveProperty("authentication_succeeded");
    expect(body).not.toHaveProperty("signing_key_hash");
    expect(body).not.toHaveProperty("env");
  });

  it("execução sem assinatura válida: recusada, manutenção NÃO roda", async () => {
    const route = await loadCalendarRoute();
    for (const sig of [null, "t=1&s=00", signature("outro corpo"), signature("x", `signkey-branch-${"cd34".repeat(16)}`)]) {
      const res = await invoke(route, sig);
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    expect(m.run).not.toHaveBeenCalled();
  });

  it("execução assinada: roda a manutenção uma vez, como agendador principal", async () => {
    const route = await loadCalendarRoute();
    const fnId = "praxis-crm-agenda-b2-calendar-maintenance";
    const body = CRON_RUN_BODY(fnId);
    const res = await route.POST(
      new NextRequest(`${BASE}/api/inngest/calendar?fnId=${fnId}&stepId=step`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-inngest-signature": signature(body) },
        body,
      }),
      undefined,
    );
    expect(res.status).toBeLessThan(300);
    expect(m.run).toHaveBeenCalledTimes(1);
    expect(m.run).toHaveBeenCalledWith("inngest");
    const text = await res.text();
    expect(text).toContain('"outcome":"ok"');
    expect(text).not.toContain(SIGNING_KEY);
  });
});

describe("/api/inngest — app da A11 preservado, sem a B2", () => {
  it("sem a configuração da A11: continua 503 (comportamento da A11 inalterado)", async () => {
    vi.resetModules();
    const route = await import("@/app/api/inngest/route");
    expect((await route.GET(new NextRequest(`${BASE}/api/inngest`), undefined)).status).toBe(503);
  });

  it("com a configuração da A11: só a função da A11, mesmo app id, retries e concorrência", async () => {
    vi.resetModules();
    vi.doMock("@/server/ingest/config", () => ({ IngestConfigError: class extends Error {}, getIngestConfig: () => ({}) }));
    const route = await import("@/app/api/inngest/route");
    const { body } = await introspect(route, "/api/inngest");
    expect(body).toMatchObject({ authentication_succeeded: true, app_id: "praxis-crm", function_count: 1 });
    expect(route.A11_INGEST_MAX_RETRIES).toBe(9);
    vi.doUnmock("@/server/ingest/config");
  });
});

describe("resultado técnico da execução × resultado da sincronização", () => {
  async function signedRun() {
    const route = await loadCalendarRoute();
    const fnId = "praxis-crm-agenda-b2-calendar-maintenance";
    const body = CRON_RUN_BODY(fnId);
    const res = await route.POST(
      new NextRequest(`${BASE}/api/inngest/calendar?fnId=${fnId}&stepId=step`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-inngest-signature": signature(body) },
        body,
      }),
      undefined,
    );
    return { status: res.status, text: await res.text(), headers: res.headers };
  }

  it("partial: execução concluída, mas o desfecho parcial fica explícito com as contagens", async () => {
    m.run.mockResolvedValueOnce({ outcome: "partial", detector: null, report: { targets: 2, synced: 1, failed: 1, busy: 0, accessLost: 0, needsReauth: 0 } });
    const { status, text } = await signedRun();
    expect(status).toBeLessThan(300);
    expect(text).toContain('"outcome":"partial"');
    expect(text).toContain('"failed":1');
  });

  // Protocolo do SDK: a falha da etapa vai ao Inngest como operação
  // `StepFailed` (HTTP 206) com `x-inngest-no-retry: true`; o Inngest marca a
  // etapa e a execução como FALHAS.
  const stepFailed = (text: string) => JSON.parse(text)[0] as { op: string; error: { name: string; message: string; stack?: string } };

  it("failed: a execução FALHA no Inngest (StepFailed), com erro sanitizado e sem nova tentativa", async () => {
    m.run.mockResolvedValueOnce({ outcome: "failed", detector: null, report: { targets: 1, synced: 0, failed: 1, busy: 0, accessLost: 0, needsReauth: 0 } });
    const { status, text, headers } = await signedRun();
    expect(status).toBe(206);
    expect(headers.get("x-inngest-no-retry")).toBe("true");
    expect(stepFailed(text)).toMatchObject({ op: "StepFailed", error: { name: "CalendarMaintenanceFailed", message: "calendar_maintenance_failed" } });
    expect(stepFailed(text).error.stack).toBe("CalendarMaintenanceFailed: calendar_maintenance_failed");
    expect(m.run).toHaveBeenCalledTimes(1);
  });

  it("exceção na rodada: falha com código fixo, sem a mensagem original", async () => {
    m.run.mockRejectedValueOnce(new Error("connection refused db.interno:5432 token=ya29.segredo"));
    const { status, text } = await signedRun();
    expect(status).toBe(206);
    expect(stepFailed(text)).toMatchObject({ op: "StepFailed", error: { message: "calendar_maintenance_error" } });
    expect(text).not.toContain("ya29");
    expect(text).not.toContain("db.interno");
    expect(text).not.toContain("praxis-crm/src");
  });

  it("integração desligada (sem provedor): execução concluída com enabled=false", async () => {
    m.run.mockResolvedValueOnce(null);
    const { status, text } = await signedRun();
    expect(status).toBeLessThan(300);
    expect(text).toContain('"enabled":false');
  });
});

describe("batimento registra o desfecho verdadeiro (antes do erro da execução)", () => {
  it.each([
    ["ok", { failed: 0, synced: 1 }],
    ["partial", { failed: 1, synced: 1 }],
    ["failed", { failed: 1, synced: 0 }],
  ] as const)("%s", async (expected, counts) => {
    const { runScheduledMaintenance } = await import("@/server/calendar/sync/scheduled");
    const { runCalendarMaintenanceStep } = await import("@/server/calendar/inngest");
    const { MemorySchedulerStore } = await import("../support/calendar-scheduler-store");
    const now = () => new Date("2026-11-02T12:00:00Z");
    const store = new MemorySchedulerStore(now);
    const report = { targets: 1, busy: 0, accessLost: 0, needsReauth: 0, full: 0, conflicts: 0, channelsCreated: 0, channelsRenewed: 0, channelsStopped: 0, pollingOnly: 0, ...counts };
    const step = runCalendarMaintenanceStep(() =>
      runScheduledMaintenance(
        { maintenance: async () => report, store, now, schedulerEnabled: true, alertsEnabled: false, sendAlert: null },
        "inngest",
      ),
    );
    if (expected === "failed") await expect(step).rejects.toThrow("calendar_maintenance_failed");
    else await expect(step).resolves.toMatchObject({ outcome: expected, synced: counts.synced, failed: counts.failed });
    expect(store.heartbeats.get("inngest")).toMatchObject({ lastOutcome: expected });
  });
});

describe("proxy", () => {
  it("a rota do app da agenda é pública no proxy (o Inngest chega sem sessão; a assinatura protege)", async () => {
    const { isPublicPath } = await import("@/proxy");
    expect(isPublicPath("/api/inngest/calendar")).toBe(true);
  });
});
