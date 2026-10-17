/**
 * @vitest-environment node
 *
 * B2 — autenticação da rota de manutenção (`/api/cron/calendar`) só com o
 * `CRON_SECRET`. Achado da preparação do webhook no Preview (16/10/2026): a
 * rota lia o segredo por `getIngestConfig()`, que exige TODA a configuração
 * da A11 (Turnstile, Upstash, chaves A11, Inngest); num ambiente só com a
 * agenda, a chamada correta recebia 401 e a manutenção nunca rodava.
 *
 * Aqui a rota é a real e a configuração da A11 é a real (ausente); só a
 * manutenção é substituída. Nenhum serviço externo é chamado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  run: vi.fn(),
}));

vi.mock("@/server/calendar/background", () => ({
  runScheduledCalendarMaintenance: (source: string) => m.run(source),
}));

import { POST as cron } from "@/app/api/cron/calendar/route";

const SECRET = "segredo-do-cron-b2-0123";

const A11_ONLY = [
  "A11_PAYLOAD_ACTIVE_KEY_VERSION",
  "A11_PAYLOAD_KEY_VERSIONS",
  "A11_IP_HMAC_KEY",
  "TURNSTILE_SECRET_KEY",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "INNGEST_EVENT_KEY",
  "INNGEST_SIGNING_KEY",
];

const request = (headers: Record<string, string> = {}, query = "") =>
  new Request(`https://crm.exemplo.test/api/cron/calendar${query}`, { method: "POST", headers });

const ok = { outcome: "ok", detector: null, report: { targets: 1, synced: 1 } };

beforeEach(() => {
  m.run.mockReset();
  m.run.mockResolvedValue(ok);
  for (const name of A11_ONLY) vi.stubEnv(name, "");
  vi.stubEnv("CRON_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("/api/cron/calendar — autenticação só com CRON_SECRET", () => {
  it("reprodução: segredo e Bearer corretos, SEM as variáveis da A11 — a manutenção roda uma vez", async () => {
    const res = await cron(request({ authorization: `Bearer ${SECRET}` }));

    expect(res.status).toBe(200);
    expect(m.run).toHaveBeenCalledTimes(1);
    expect(m.run).toHaveBeenCalledWith("manual");
    expect(await res.json()).toEqual({ enabled: true, outcome: "ok", detector: null, targets: 1, synced: 1 });
  });

  it.each([
    ["ausente", undefined],
    ["vazio", ""],
    ["só espaços", "                    "],
    ["com menos de 16 caracteres", "curto-demais-15"],
  ])("segredo do ambiente %s: falha fechada (401), sem manutenção", async (_label, value) => {
    vi.stubEnv("CRON_SECRET", value as string);
    const auths = [`Bearer ${value ?? ""}`, "Bearer ", "Bearer undefined"];
    for (const authorization of auths) {
      expect((await cron(request({ authorization }))).status).toBe(401);
    }
    expect((await cron(request())).status).toBe(401);
    expect(m.run).not.toHaveBeenCalled();
  });

  it.each([
    ["ausente", {}],
    ["Bearer vazio", { authorization: "Bearer " }],
    ["só a palavra Bearer", { authorization: "Bearer" }],
    ["segredo errado", { authorization: "Bearer segredo-errado-0123456789" }],
    ["segredo com sufixo", { authorization: `Bearer ${SECRET}x` }],
    ["prefixo do segredo", { authorization: `Bearer ${SECRET.slice(0, -1)}` }],
    ["sem o esquema", { authorization: SECRET }],
    ["outro esquema", { authorization: `Basic ${SECRET}` }],
  ])("Authorization %s: 401, sem manutenção", async (_label, headers) => {
    const res = await cron(request(headers as Record<string, string>));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(m.run).not.toHaveBeenCalled();
  });

  it("segredo só na URL (query string): recusado", async () => {
    for (const query of [`?secret=${SECRET}`, `?authorization=Bearer%20${SECRET}`, `?CRON_SECRET=${SECRET}&source=github`]) {
      expect((await cron(request({}, query))).status).toBe(401);
    }
    expect(m.run).not.toHaveBeenCalled();
  });

  it("nenhum log com o segredo, o cabeçalho ou a configuração, nem na recusa nem na falha", async () => {
    const logs = [vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "log").mockImplementation(() => {})];
    await cron(request({ authorization: "Bearer segredo-errado-0123456789" }));
    m.run.mockRejectedValueOnce(new Error(`falhou com ${SECRET}`));
    expect((await cron(request({ authorization: `Bearer ${SECRET}` }))).status).toBe(503);
    const printed = logs.flatMap((spy) => spy.mock.calls.flat()).map(String).join("\n");
    expect(printed).not.toContain(SECRET);
    expect(printed).not.toContain("segredo-errado");
    expect(printed.toLowerCase()).not.toContain("bearer");
  });

  it("origem preservada: source=github e qualquer outra coisa como manual", async () => {
    await cron(request({ authorization: `Bearer ${SECRET}` }, "?source=github"));
    await cron(request({ authorization: `Bearer ${SECRET}` }, "?source=inngest"));
    expect(m.run.mock.calls).toEqual([["github"], ["manual"]]);
  });

  it("respostas preservadas: integração desligada, rodada falha (503 com contagens) e exceção (503 sem detalhe)", async () => {
    const auth = { authorization: `Bearer ${SECRET}` };

    m.run.mockResolvedValueOnce(null);
    const off = await cron(request(auth));
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ enabled: false });

    m.run.mockResolvedValueOnce({ outcome: "failed", detector: "scheduler_disabled", report: { targets: 1, failed: 1 } });
    const failed = await cron(request(auth, "?source=github"));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ enabled: true, outcome: "failed", detector: "scheduler_disabled", targets: 1, failed: 1 });

    vi.spyOn(console, "error").mockImplementation(() => {});
    m.run.mockRejectedValueOnce(new Error("detalhe interno"));
    const thrown = await cron(request(auth));
    expect(thrown.status).toBe(503);
    expect(await thrown.json()).toEqual({ error: "maintenance_failed" });
  });
});
