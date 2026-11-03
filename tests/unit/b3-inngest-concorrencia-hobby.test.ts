/**
 * @vitest-environment node
 *
 * B3 — concorrência do app `praxis-crm-whatsapp` dentro do teto do plano.
 *
 * Em 03/11/2026 o Inngest Cloud recusou a sincronização do app porque o consumidor
 * declarava concorrência 10 e o plano Hobby da organização permite 5 (§28.14).
 *
 * O teto é conferido no payload que o SDK real manda na sincronização (PUT na rota
 * própria, com `fetch` falso e sem rede), porque é esse payload que o Inngest aceita
 * ou recusa. O teto fica aqui, em literal, e não vem do código testado: subir o valor
 * no código não pode subir o teste junto.
 *
 * Escritos ANTES da correção, contra a main ba7f818. Chaves fictícias.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TETO_DO_PLANO = 5;
const APP = "praxis-crm-whatsapp";
const CONSUMIDOR = "b3-whatsapp-inbox-consumer";
const RECONCILIADOR = "b3-whatsapp-inbox-reconciler";
const URL_ROTA = "https://praxis-preview.example/api/inngest/whatsapp";
const RAIZ = process.cwd();

/** Variáveis que alguém poderia supor capazes de subir o limite. Nenhuma pode. */
const VARIAVEIS_QUE_NAO_PODEM_SUBIR = [
  "WHATSAPP_INNGEST_CONCURRENCY",
  "WHATSAPP_INNGEST_CONCURRENCY_LIMIT",
  "WHATSAPP_INNGEST_MAX_CONCURRENCY",
  "WHATSAPP_INBOX_CONCURRENCY",
  "WHATSAPP_INBOX_CONSUMER_CONCURRENCY",
  "WHATSAPP_CONSUMER_CONCURRENCY",
  "WHATSAPP_CONCURRENCY",
  "INNGEST_CONCURRENCY",
  "INNGEST_MAX_CONCURRENCY",
  "CONCURRENCY",
];

type SyncedFunction = {
  id: string;
  name: string;
  concurrency?: unknown;
  triggers: unknown[];
  steps: Record<string, { retries?: { attempts?: number } }>;
};

/** Todas as formas de concorrência que o SDK aceita. Forma desconhecida falha. */
function limitesDeclarados(concurrency: unknown): number[] {
  if (concurrency === undefined || concurrency === null) return [];
  if (typeof concurrency === "number") return [concurrency];
  if (Array.isArray(concurrency)) return concurrency.flatMap(limitesDeclarados);
  if (typeof concurrency === "object" && typeof (concurrency as { limit?: unknown }).limit === "number") {
    return [(concurrency as { limit: number }).limit];
  }
  throw new Error("forma de concorrência desconhecida");
}

/** Faz a sincronização real pelo SDK e devolve o que iria para o Inngest. */
async function funcoesSincronizadas(): Promise<{ app: string; functions: SyncedFunction[] }> {
  const fetchFalso = vi.fn(async () => Response.json({ ok: true, modified: true }));
  vi.stubGlobal("fetch", fetchFalso);
  const route = await import("@/app/api/inngest/whatsapp/route");
  const response = await route.PUT(new Request(URL_ROTA, { method: "PUT" }) as never, undefined as never);
  expect(response.status).toBe(200);
  expect(fetchFalso).toHaveBeenCalledTimes(1);
  const [, init] = fetchFalso.mock.calls[0] as unknown as [unknown, { body: string }];
  const body = JSON.parse(init.body) as { appName: string; functions: SyncedFunction[] };
  return { app: body.appName, functions: body.functions };
}

const porId = (functions: SyncedFunction[], id: string) => functions.find((fn) => fn.id === `${APP}-${id}`);

function importsDe(arquivo: string): string[] {
  const fonte = readFileSync(arquivo, "utf8");
  return [...fonte.matchAll(/(?:from\s+|import\s*\(\s*|^import\s+)["']([^"']+)["']/gm)].map((m) => m[1] as string);
}

function resolverImport(de: string, alvo: string): string | null {
  const base = alvo.startsWith("@/") ? join(RAIZ, "src", alvo.slice(2)) : alvo.startsWith(".") ? resolve(dirname(de), alvo) : null;
  if (!base) return null;
  return [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find((caminho) => existsSync(caminho)) ?? null;
}

/** Todos os arquivos de `src` alcançados a partir da rota, seguindo os imports. */
function grafoDaRota(): string[] {
  const inicio = join(RAIZ, "src/app/api/inngest/whatsapp/route.ts");
  const vistos = new Set<string>([inicio]);
  const fila = [inicio];
  while (fila.length > 0) {
    const atual = fila.pop() as string;
    for (const alvo of importsDe(atual)) {
      const caminho = resolverImport(atual, alvo);
      if (caminho && !vistos.has(caminho)) {
        vistos.add(caminho);
        fila.push(caminho);
      }
    }
  }
  return [...vistos].map((caminho) => caminho.slice(RAIZ.length + 1).replaceAll("\\", "/"));
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "chave-de-teste-b3-whatsapp-0123456789");
  vi.stubEnv("WHATSAPP_INNGEST_SIGNING_KEY", `signkey-test-${"a1".repeat(32)}`);
  vi.stubEnv("INNGEST_DEV", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("configuração declarada", () => {
  it("o consumidor declara concorrência 5", async () => {
    const { WHATSAPP_INBOX_CONSUMER_FUNCTION_CONFIG } = await import("@/server/whatsapp/inngest-consumer");
    expect(WHATSAPP_INBOX_CONSUMER_FUNCTION_CONFIG.concurrency.limit).toBe(5);
  });

  it("o reconciliador continua com concorrência 1", async () => {
    const { WHATSAPP_RECONCILER_FUNCTION_CONFIG } = await import("@/server/whatsapp/inngest-reconciler");
    expect(WHATSAPP_RECONCILER_FUNCTION_CONFIG.concurrency).toEqual({ limit: 1 });
  });

  it("id, nome, gatilho e novas tentativas do consumidor não mudam", async () => {
    const { WHATSAPP_INBOX_CONSUMER_FUNCTION_CONFIG: config } = await import("@/server/whatsapp/inngest-consumer");
    const { concurrency: _ignorada, ...resto } = config;
    expect(resto).toEqual({
      id: "b3-whatsapp-inbox-consumer",
      name: "B3 — consumidor da inbox do WhatsApp",
      retries: 3,
      triggers: [{ event: "praxis/whatsapp.inbox.received" }],
    });
  });

  it("id, nome, gatilho e novas tentativas do reconciliador não mudam", async () => {
    const { WHATSAPP_RECONCILER_FUNCTION_CONFIG: config } = await import("@/server/whatsapp/inngest-reconciler");
    const { concurrency: _ignorada, ...resto } = config;
    expect(resto).toEqual({
      id: "b3-whatsapp-inbox-reconciler",
      name: "B3 — reconciliador da inbox do WhatsApp",
      retries: 0,
      triggers: [{ cron: "TZ=UTC */5 * * * *" }],
    });
  });
});

describe("teto de todas as funções do app, no payload da sincronização", () => {
  it.each([
    ["desligado", "", [CONSUMIDOR]],
    ["ligado", "true", [CONSUMIDOR, RECONCILIADOR]],
  ])("reconciliador %s: nenhuma função declara acima do teto", async (_nome, valor, ids) => {
    vi.stubEnv("WHATSAPP_RECONCILER_ENABLED", valor);
    const { app, functions } = await funcoesSincronizadas();
    expect(app).toBe(APP);
    expect(functions.map((fn) => fn.id).sort()).toEqual(ids.map((id) => `${APP}-${id}`).sort());
    for (const fn of functions) {
      for (const limite of limitesDeclarados(fn.concurrency)) expect(limite, fn.id).toBeLessThanOrEqual(TETO_DO_PLANO);
    }
  });

  it("a conferência do teto reconhece todas as formas do SDK e recusa as desconhecidas", () => {
    expect(limitesDeclarados(6)).toEqual([6]);
    expect(limitesDeclarados({ limit: 6 })).toEqual([6]);
    expect(limitesDeclarados([{ limit: 1 }, { limit: 6, key: "event.data.x" }])).toEqual([1, 6]);
    expect(limitesDeclarados(undefined)).toEqual([]);
    expect(() => limitesDeclarados({ limite: 6 })).toThrow("forma de concorrência desconhecida");
  });

  it("o payload leva o id, o nome, o gatilho e as novas tentativas de cada função", async () => {
    vi.stubEnv("WHATSAPP_RECONCILER_ENABLED", "true");
    const { functions } = await funcoesSincronizadas();
    const consumidor = porId(functions, CONSUMIDOR);
    const reconciliador = porId(functions, RECONCILIADOR);
    expect(consumidor).toMatchObject({ name: "B3 — consumidor da inbox do WhatsApp", concurrency: { limit: 5 }, triggers: [{ event: "praxis/whatsapp.inbox.received" }] });
    expect(reconciliador).toMatchObject({ name: "B3 — reconciliador da inbox do WhatsApp", concurrency: { limit: 1 }, triggers: [{ cron: "TZ=UTC */5 * * * *" }] });
    expect(Object.values(consumidor?.steps ?? {})[0]?.retries).toEqual({ attempts: 3 });
    expect(Object.values(reconciliador?.steps ?? {})[0]?.retries).toEqual({ attempts: 0 });
  });

  it("ligar ou desligar o reconciliador não altera o limite do consumidor", async () => {
    vi.stubEnv("WHATSAPP_RECONCILER_ENABLED", "");
    const desligado = porId((await funcoesSincronizadas()).functions, CONSUMIDOR);
    vi.resetModules();
    vi.stubEnv("WHATSAPP_RECONCILER_ENABLED", "true");
    const ligado = porId((await funcoesSincronizadas()).functions, CONSUMIDOR);
    expect(desligado?.concurrency).toEqual({ limit: 5 });
    expect(ligado?.concurrency).toEqual(desligado?.concurrency);
  });
});

describe("nenhuma variável de ambiente sobe o limite", () => {
  it.each(VARIAVEIS_QUE_NAO_PODEM_SUBIR)("%s=100 não muda nada", async (nome) => {
    vi.stubEnv("WHATSAPP_RECONCILER_ENABLED", "true");
    vi.stubEnv(nome, "100");
    const { functions } = await funcoesSincronizadas();
    expect(porId(functions, CONSUMIDOR)?.concurrency).toEqual({ limit: 5 });
    expect(porId(functions, RECONCILIADOR)?.concurrency).toEqual({ limit: 1 });
  });

  it("os limites são literais no código, e nenhum arquivo do app lê variável de concorrência", () => {
    const fonte = (arquivo: string) => readFileSync(join(RAIZ, arquivo), "utf8");
    const consumidor = "src/server/whatsapp/inngest-consumer.ts";
    const reconciliador = "src/server/whatsapp/inngest-reconciler.ts";
    for (const arquivo of [consumidor, reconciliador, "src/server/whatsapp/inngest.ts", "src/app/api/inngest/whatsapp/route.ts"]) {
      expect(fonte(arquivo), arquivo).not.toMatch(/[A-Z_]*CONCURREN[A-Z_]*/);
    }
    expect(fonte(consumidor)).toMatch(/concurrency: \{ limit: \d+ \}/);
    expect(fonte(consumidor)).not.toContain("process.env");
    expect(fonte(reconciliador)).toMatch(/concurrency: \{ limit: \d+ \}/);
  });
});

describe("separação da A11 e da agenda", () => {
  it("a rota do WhatsApp não alcança nenhum módulo da A11 nem da agenda", () => {
    const grafo = grafoDaRota();
    expect(grafo).toEqual(expect.arrayContaining(["src/server/whatsapp/inngest-consumer.ts", "src/server/whatsapp/inngest-reconciler.ts"]));
    const proibidos = grafo.filter((arquivo) => /^src\/server\/(calendar|ingest)\//.test(arquivo) || /^src\/app\/api\/inngest\/(route|calendar\/)/.test(arquivo));
    expect(proibidos).toEqual([]);
  });

  it("a A11 e a agenda continuam sem referência ao app do WhatsApp", () => {
    for (const arquivo of ["src/app/api/inngest/route.ts", "src/server/calendar/inngest.ts"]) {
      expect(readFileSync(join(RAIZ, arquivo), "utf8"), arquivo).not.toMatch(/whatsapp/i);
    }
  });

  it("o payload só traz funções do próprio app, com a configuração da A11 e da agenda presente", async () => {
    vi.stubEnv("WHATSAPP_RECONCILER_ENABLED", "true");
    vi.stubEnv("INNGEST_SIGNING_KEY", `signkey-prod-${"c3".repeat(32)}`);
    vi.stubEnv("CALENDAR_SCHEDULER_ENABLED", "true");
    const { functions } = await funcoesSincronizadas();
    for (const fn of functions) expect(fn.id).toMatch(/^praxis-crm-whatsapp-b3-whatsapp-inbox-/);
  });
});
