/**
 * @vitest-environment node
 *
 * B3 — expurgo agendado da inbox do WhatsApp (§28.15), no app próprio
 * `praxis-crm-whatsapp`. Só as proteções essenciais:
 *
 *  - desligado (sem `WHATSAPP_INBOX_PURGE_ENABLED=true`): não registra;
 *  - ligado: registra com o cron de hora em hora, concorrência 1 e 0 retries,
 *    conferido no payload real da sincronização (SDK real, sem rede);
 *  - chama a operação existente no ambiente assinado da execução;
 *  - não usa chave nem módulo da A11 ou da agenda;
 *  - devolve só a contagem, sem log; banco fora do ar vira falha da execução só
 *    com o código.
 *
 * Chaves fictícias. O banco é simulado no cliente do Supabase.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rpc: vi.fn(), createClient: vi.fn() }));

vi.mock("@supabase/supabase-js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createClient: h.createClient,
}));

const APP = "praxis-crm-whatsapp";
const EXPURGO = "b3-whatsapp-inbox-purge";
const URL_ROTA = "https://praxis-preview.example/api/inngest/whatsapp";
const SEGREDO_NO_ERRO = "senha=segredo-ficticio +5511999990000 conteudo";
const RAIZ = process.cwd();

let spies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  vi.resetModules();
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "chave-de-teste-b3-whatsapp-0123456789");
  vi.stubEnv("WHATSAPP_INNGEST_SIGNING_KEY", `signkey-test-${"a1".repeat(32)}`);
  vi.stubEnv("INNGEST_DEV", "");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://projeto-ficticio.supabase.co");
  vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_ficticia");
  vi.stubEnv("WHATSAPP_RECONCILER_ENABLED", "");
  vi.stubEnv("WHATSAPP_INBOX_PURGE_ENABLED", "");
  h.rpc.mockReset();
  h.createClient.mockReset();
  h.createClient.mockImplementation(() => ({ rpc: h.rpc }));
});

afterEach(() => {
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type SyncedFunction = { id: string; concurrency?: unknown; triggers: unknown[]; steps: Record<string, { retries?: unknown }> };

async function funcoesSincronizadas(): Promise<SyncedFunction[]> {
  const fetchFalso = vi.fn(async () => Response.json({ ok: true, modified: true }));
  vi.stubGlobal("fetch", fetchFalso);
  const route = await import("@/app/api/inngest/whatsapp/route");
  const response = await route.PUT(new Request(URL_ROTA, { method: "PUT" }) as never, undefined as never);
  expect(response.status).toBe(200);
  const [, init] = fetchFalso.mock.calls[0] as unknown as [unknown, { body: string }];
  return (JSON.parse(init.body) as { functions: SyncedFunction[] }).functions;
}

const ids = (functions: SyncedFunction[]) => functions.map((fn) => fn.id.replace(`${APP}-`, ""));

async function registradas(): Promise<string[]> {
  const { whatsappInngestFunctions } = await import("@/server/whatsapp/inngest-consumer");
  const client = { createFunction: vi.fn((config: { id: string }) => config.id) };
  return whatsappInngestFunctions(client as never) as unknown as string[];
}

describe("ativação", () => {
  it("desligado: o expurgo não é registrado", async () => {
    await expect(registradas()).resolves.toEqual(["b3-whatsapp-inbox-consumer"]);
  });

  it.each(["TRUE", "1", "yes", " true", "true "])("valor %j não liga", async (valor) => {
    vi.stubEnv("WHATSAPP_INBOX_PURGE_ENABLED", valor);
    await expect(registradas()).resolves.not.toContain(EXPURGO);
  });

  it("nenhuma variável da A11, da agenda ou do reconciliador liga o expurgo", async () => {
    vi.stubEnv("INNGEST_EVENT_KEY", "chave-de-evento-da-a11-ficticia");
    vi.stubEnv("INNGEST_SIGNING_KEY", `signkey-prod-${"c3".repeat(32)}`);
    vi.stubEnv("CALENDAR_SCHEDULER_ENABLED", "true");
    vi.stubEnv("A11_RECONCILER_ENABLED", "true");
    vi.stubEnv("WHATSAPP_RECONCILER_ENABLED", "true");
    await expect(registradas()).resolves.toEqual(["b3-whatsapp-inbox-consumer", "b3-whatsapp-inbox-reconciler"]);
  });

  it("ligado: a sincronização real leva o expurgo com cron de hora em hora, concorrência 1 e 0 retries", async () => {
    vi.stubEnv("WHATSAPP_INBOX_PURGE_ENABLED", "true");
    const functions = await funcoesSincronizadas();
    expect(ids(functions)).toEqual(["b3-whatsapp-inbox-consumer", EXPURGO]);
    const expurgo = functions.find((fn) => fn.id === `${APP}-${EXPURGO}`);
    expect(expurgo).toMatchObject({ concurrency: { limit: 1 }, triggers: [{ cron: "TZ=UTC 17 * * * *" }] });
    expect(Object.values(expurgo?.steps ?? {})[0]?.retries).toEqual({ attempts: 0 });
  });

  it("com o reconciliador e o expurgo ligados, as três funções sincronizam", async () => {
    vi.stubEnv("WHATSAPP_RECONCILER_ENABLED", "true");
    vi.stubEnv("WHATSAPP_INBOX_PURGE_ENABLED", "true");
    expect(ids(await funcoesSincronizadas())).toEqual(["b3-whatsapp-inbox-consumer", "b3-whatsapp-inbox-reconciler", EXPURGO]);
  });
});

describe("execução", () => {
  const step = { run: async (_id: string, fn: () => Promise<unknown>) => fn() };

  it.each(["preview", "production"] as const)("chama o expurgo existente no ambiente assinado (%s), com o lote do teto", async (ambiente) => {
    vi.stubEnv("VERCEL_ENV", ambiente);
    h.rpc.mockResolvedValue({ data: { purged: 3 }, error: null });
    const { handleWhatsAppInboxPurge } = await import("@/server/whatsapp/inngest-purge");
    await expect(handleWhatsAppInboxPurge({ step })).resolves.toEqual({ purged: 3 });
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith("whatsapp_inbox_purge_expired", { p_limit: 5000 });
    const headers = (h.createClient.mock.calls[0]?.[2] as { global: { headers: Record<string, string> } }).global.headers;
    expect(Object.keys(headers)).toEqual(["X-Praxis-WhatsApp-Env"]);
    expect(headers["X-Praxis-WhatsApp-Env"]?.split(".").slice(0, 2)).toEqual(["v1", ambiente]);
  });

  it("devolve só a contagem, mesmo que o banco mande outro campo", async () => {
    h.rpc.mockResolvedValue({ data: { purged: 2, payload: SEGREDO_NO_ERRO }, error: null });
    const { handleWhatsAppInboxPurge } = await import("@/server/whatsapp/inngest-purge");
    const resultado = await handleWhatsAppInboxPurge({ step });
    expect(resultado).toEqual({ purged: 2 });
    expect(JSON.stringify(resultado)).not.toContain("segredo");
  });

  it.each([
    ["erro do banco", () => h.rpc.mockResolvedValue({ data: null, error: { message: SEGREDO_NO_ERRO } })],
    ["banco não responde", () => h.rpc.mockRejectedValue(new TypeError(`fetch failed ${SEGREDO_NO_ERRO}`))],
    ["resposta inválida", () => h.rpc.mockResolvedValue({ data: { purged: -1 }, error: null })],
  ])("%s: falha da execução, sem nova tentativa e só com o código", async (_nome, preparar) => {
    preparar();
    const { handleWhatsAppInboxPurge, WhatsAppInboxPurgeFailed } = await import("@/server/whatsapp/inngest-purge");
    const { NonRetriableError } = await import("inngest");
    const erro = await handleWhatsAppInboxPurge({ step }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(WhatsAppInboxPurgeFailed);
    expect(erro).toBeInstanceOf(NonRetriableError);
    expect(erro).toMatchObject({ code: "inbox_purge_failed", message: "inbox_purge_failed" });
    expect(`${(erro as Error).stack} ${JSON.stringify(erro)} ${String((erro as Error).cause ?? "")}`).not.toMatch(/segredo|5511|fetch failed/);
  });

  it("uma nova execução depois da falha volta a expurgar", async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: "unknown" } }).mockResolvedValueOnce({ data: { purged: 1 }, error: null });
    const { handleWhatsAppInboxPurge } = await import("@/server/whatsapp/inngest-purge");
    await expect(handleWhatsAppInboxPurge({ step })).rejects.toMatchObject({ code: "inbox_purge_failed" });
    await expect(handleWhatsAppInboxPurge({ step })).resolves.toEqual({ purged: 1 });
  });

  it("sem o ambiente assinado do WhatsApp: falha antes do banco", async () => {
    vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "");
    const { handleWhatsAppInboxPurge } = await import("@/server/whatsapp/inngest-purge");
    await expect(handleWhatsAppInboxPurge({ step })).rejects.toMatchObject({ code: "inbox_purge_not_configured" });
    expect(h.createClient).not.toHaveBeenCalled();
  });
});

describe("fronteiras", () => {
  const codigo = () =>
    readFileSync(join(RAIZ, "src/server/whatsapp/inngest-purge.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

  it("não importa a A11 nem a agenda e não lê as chaves genéricas do Inngest", () => {
    expect(codigo()).not.toMatch(/@\/server\/(ingest|calendar)|(?<![A-Z_])INNGEST_(EVENT_KEY|SIGNING_KEY)|CALENDAR_|A11/);
  });

  it("só lê a própria variável de ativação, sem log, sem tabela e com um único step.run", () => {
    const src = codigo();
    for (const nome of src.match(/env\.[A-Z_]+/g) ?? []) expect(nome).toBe("env.WHATSAPP_INBOX_PURGE_ENABLED");
    expect(src).not.toMatch(/console\.|\.from\(|\.send\(|sendEvent/);
    expect(src.match(/step\.run\(/g) ?? []).toHaveLength(1);
  });
});
