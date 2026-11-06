/**
 * @vitest-environment node
 *
 * B3.2d-2a — conferências estáticas do código da B3:
 *  - nenhum arquivo da B3 importa módulos da A11 (`@/server/ingest`) ou da
 *    agenda (`@/server/calendar`), nem lê as variáveis genéricas do Inngest;
 *  - nenhuma API antiga da inbox reaparece, e nenhum arquivo acessa a tabela
 *    da inbox diretamente;
 *  - o consumidor e a rota não escrevem no domínio: sem `.from(`, sem
 *    cliente do domínio, só RPCs `whatsapp_inbox_*`;
 *  - o claim não aparece no retorno do step nem em tipo serializável: o
 *    único `step.run` da função chama `processWhatsAppInboxEntry`, e só a
 *    inbox e o consumidor tocam no claim.
 *
 * Escritos ANTES da implementação, contra a main 10e617f. A seção 5 foi
 * acrescentada na B3.2d-2b3 (ligação do consumidor aos efeitos), contra a main
 * 8cd9191.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";

import type { processWhatsAppInboxEntry } from "@/server/whatsapp/consumer";

const ROOT = process.cwd();

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const rel = (path: string) => relative(ROOT, path).replaceAll("\\", "/");
const read = (path: string) => readFileSync(path, "utf8");
/** Sem comentários: a documentação pode citar o que o código não usa. */
const code = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const B3_FILES = [
  ...files(join(ROOT, "src/server/whatsapp")),
  ...files(join(ROOT, "src/app/api/inngest/whatsapp")),
  ...files(join(ROOT, "src/app/api/webhooks/whatsapp")),
];
const CONSUMER_FILES = [
  join(ROOT, "src/server/whatsapp/consumer.ts"),
  join(ROOT, "src/server/whatsapp/inngest-consumer.ts"),
  join(ROOT, "src/app/api/inngest/whatsapp/route.ts"),
];

describe("1. isolamento da A11 e da agenda", () => {
  it("os arquivos do consumidor e da rota existem", () => {
    expect(CONSUMER_FILES.filter((f) => !existsSync(f)).map(rel)).toEqual([]);
  });

  it("nenhum arquivo da B3 importa @/server/ingest ou @/server/calendar", () => {
    const offenders = B3_FILES.filter((f) => /from\s+["'](@\/server\/(ingest|calendar)|\.\.?\/.*(ingest|calendar))[^"']*["']|import\(\s*["']@\/server\/(ingest|calendar)/.test(read(f)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it("nenhum arquivo da B3 lê as variáveis genéricas do Inngest", () => {
    const offenders = B3_FILES.filter((f) => /(?<![A-Z_])INNGEST_(EVENT_KEY|SIGNING_KEY|SIGNING_KEY_FALLBACK)\b/.test(code(f)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it("a rota do WhatsApp tem app próprio e não reaproveita os clientes da A11 ou da agenda", () => {
    const route = code(join(ROOT, "src/app/api/inngest/whatsapp/route.ts"));
    expect(route).toMatch(/@\/server\/whatsapp\/inngest/);
    expect(route).not.toMatch(/inngestClient\(|calendarInngestClient|getIngestConfig/);
  });
});

describe("2. inbox só pelas RPCs com claim", () => {
  const SRC = files(join(ROOT, "src"));

  it("nenhuma API antiga da inbox reaparece", () => {
    const offenders = SRC.filter((f) =>
      /whatsapp_inbox_(get_pending|mark_processed|mark_failed)|whatsapp_inbox_lock_entry|readPendingWhatsAppWebhookDelivery|markWhatsAppWebhookDelivery/.test(read(f)),
    );
    expect(offenders.map(rel)).toEqual([]);
  });

  it("nenhum arquivo acessa a tabela da inbox diretamente", () => {
    const offenders = SRC.filter((f) => /from\(\s*["']whatsapp_webhook_inbox["']/.test(read(f)));
    expect(offenders.map(rel)).toEqual([]);
  });
});

describe("3. o consumidor não escreve no domínio", () => {
  it.each(CONSUMER_FILES.map((f) => [rel(f), f]))("%s: sem .from(<tabela>), sem cliente do domínio, sem módulos do domínio", (_name, file) => {
    if (!existsSync(file)) throw new Error("arquivo ausente");
    const src = code(file);
    expect(src).not.toMatch(/\.from\(\s*["'`]/);
    expect(src).not.toMatch(/@\/server\/supabase|@\/modules\/|@\/server\/data|createAdminSupabaseClient/);
    for (const rpc of src.match(/rpc\(\s*["'][a-z_]+["']/g) ?? []) expect(rpc).toMatch(/whatsapp_inbox_/);
    expect(src).not.toMatch(/send_message|simulate_inbound_whatsapp_message|conversations|contacts|leads|activities|opportunit/);
  });
});

describe("4. o claim não atravessa o step.run", () => {
  it("a função tem um único step.run, que chama processWhatsAppInboxEntry", () => {
    const src = code(join(ROOT, "src/server/whatsapp/inngest-consumer.ts"));
    const runs = src.match(/step\.run\(/g) ?? [];
    expect(runs).toHaveLength(1);
    expect(src).toMatch(/step\.run\(\s*WHATSAPP_INBOX_CONSUMER_STEP_ID\s*,\s*\(\)\s*=>\s*processWhatsAppInboxEntry\(/);
    expect(src).not.toMatch(/claimWhatsAppInboxEntry|WhatsAppInboxClaim\b|step\.sendEvent|\.send\(/);
  });

  it("só a inbox, o consumidor e os efeitos no domínio tocam no claim", () => {
    // Os efeitos da B3.2d-2b2 recebem o claim para a RPC conferir token e
    // lease (§19.9); o token continua só na inbox.
    const offenders = files(join(ROOT, "src"))
      .filter((f) => /claimWhatsAppInboxEntry|WhatsAppInboxClaim\b/.test(code(f)))
      .map(rel)
      .filter(
        (f) =>
          f !== "src/server/whatsapp/inbox.ts" && f !== "src/server/whatsapp/consumer.ts" && !f.startsWith("src/server/whatsapp/effects/"),
      );
    expect(offenders).toEqual([]);
  });

  it("o resultado do consumidor é só { outcome, code } com textos fixos", async () => {
    type Result = Awaited<ReturnType<typeof processWhatsAppInboxEntry>>;
    expectTypeOf<keyof Result>().toEqualTypeOf<"outcome" | "code">();
    expectTypeOf<Result["code"]>().toMatchTypeOf<string | null>();
    expectTypeOf<Result["outcome"]>().toMatchTypeOf<string>();
    const src = code(join(ROOT, "src/server/whatsapp/consumer.ts"));
    expect(src).toMatch(/processWhatsAppInboxEntry\([^)]*\)\s*:\s*Promise<WhatsAppConsumerResult>/);
  });
});

// ---------------------------------------------------------------------
// 5. B3.2d-2b3 — o consumidor ligado aos cinco efeitos
// ---------------------------------------------------------------------

describe("5. ligação do consumidor aos efeitos (B3.2d-2b3)", () => {
  const DISPATCH = join(ROOT, "src/server/whatsapp/effects/dispatch.ts");
  const CONSUMER = join(ROOT, "src/server/whatsapp/consumer.ts");
  const EFFECT_FUNCTIONS = [
    "applyWhatsAppInboundMessage",
    "applyWhatsAppOutboundObserved",
    "applyWhatsAppMessageStatus",
    "applyWhatsAppIdentityChange",
    "applyWhatsAppAccountEvent",
  ];
  const FINALIZERS = ["completeWhatsAppInboxClaim", "disposeWhatsAppInboxClaim", "failWhatsAppInboxClaim", "releaseWhatsAppInboxClaim"];

  it("o despachante existe e chama cada um dos cinco efeitos em um único ponto", () => {
    expect(existsSync(DISPATCH)).toBe(true);
    const src = code(DISPATCH);
    for (const fn of EFFECT_FUNCTIONS) {
      expect(src.match(new RegExp(`${fn}\\(`, "g")) ?? [], fn).toHaveLength(1);
    }
  });

  it("os efeitos são chamados só pelo despachante (nem o consumidor, nem a rota, nem outro arquivo)", () => {
    const offenders = files(join(ROOT, "src"))
      .filter((f) => EFFECT_FUNCTIONS.some((fn) => new RegExp(`${fn}\\(`).test(code(f))))
      .map(rel)
      .filter((f) => f !== "src/server/whatsapp/effects/dispatch.ts" && !/^src\/server\/whatsapp\/effects\/(inbound-message|outbound-observed|message-status|identity-change|account-event)\.ts$/.test(f));
    expect(offenders).toEqual([]);
  });

  it("só o consumidor finaliza: o despachante e os módulos dos efeitos não chamam complete, dispose, fail nem release", () => {
    const targets = [DISPATCH, ...files(join(ROOT, "src/server/whatsapp/effects"))].filter((f) => existsSync(f));
    const offenders = targets.filter((f) => FINALIZERS.some((fn) => new RegExp(`${fn}\\b`).test(code(f))));
    expect(offenders.map(rel)).toEqual([]);
  });

  it("o consumidor finaliza em um único ponto: dispose, fail e release uma vez cada, complete nunca", () => {
    const src = code(CONSUMER);
    expect(src.match(/disposeWhatsAppInboxClaim\(/g) ?? []).toHaveLength(1);
    expect(src.match(/failWhatsAppInboxClaim\(/g) ?? []).toHaveLength(1);
    expect(src.match(/releaseWhatsAppInboxClaim\(/g) ?? []).toHaveLength(1);
    expect(src).not.toMatch(/completeWhatsAppInboxClaim/);
    expect(src.match(/\bfinalize\(/g) ?? []).toHaveLength(2); // a definição e a única chamada
  });

  it("o claim não é copiado, espalhado, clonado nem serializado no consumidor ou no despachante", () => {
    for (const file of [CONSUMER, DISPATCH]) {
      const src = code(file);
      expect(src, rel(file)).not.toMatch(/\.\.\.\s*claim\b|Object\.assign\([^)]*claim|structuredClone\(|JSON\.(stringify|parse)\(|\{\s*claim\s*[,}]/);
      // A única atribuição a `claim` é a do objeto devolvido pelo claim da inbox.
      const assigns = (src.match(/\bclaim\s*=(?!=)[^;]*;/g) ?? []).map((a) => a.replace(/\s+/g, " "));
      expect(assigns.filter((a) => a !== "claim = claimed.claim;"), rel(file)).toEqual([]);
    }
  });

  it("o despachante não usa relógio, timers, log, variáveis de ambiente nem o cliente do banco", () => {
    const src = code(DISPATCH);
    expect(src).not.toMatch(/Date\.now|new Date\(|setTimeout|setInterval|console\.|process\.env|createWhatsAppAdminSupabaseClient|createAdminSupabaseClient|\.rpc\(|\.from\(/);
  });

  it("o consumidor e o despachante não criam variáveis nem leem as do Inngest, da YCloud, da Meta ou do Cloudflare", () => {
    for (const file of [CONSUMER, DISPATCH]) {
      const src = code(file);
      expect(src, rel(file)).not.toMatch(/process\.env|INNGEST_|YCLOUD_|META_|CLOUDFLARE_/);
    }
  });

  it("o despachante não importa a A11, a agenda nem o adaptador de nenhum provedor", () => {
    const src = code(DISPATCH);
    expect(src).not.toMatch(/@\/server\/(ingest|calendar)|whatsapp\/provider\/(ycloud|simulated)|\/provider\/index|inngest/);
  });

  it("canal ycloud recebe só o adaptador YCloud, e só com a variável dele (§28.16); meta continua sem adaptador", async () => {
    const { resolveWhatsAppProvider } = await import("@/server/whatsapp/provider");
    const env = { WHATSAPP_PROVIDER: "ycloud", VERCEL_ENV: "preview" };
    const ycloud = resolveWhatsAppProvider({ channelProvider: "ycloud", env });
    expect(ycloud.status === "enabled" && ycloud.provider.kind).toBe("ycloud");
    expect(resolveWhatsAppProvider({ channelProvider: "ycloud", env: { ...env, WHATSAPP_PROVIDER: "simulated" } }).status).toBe("disabled");
    expect(resolveWhatsAppProvider({ channelProvider: "meta", env: { ...env, WHATSAPP_PROVIDER: "meta" } }).status).toBe("disabled");
  });

  it("o marcador provisório domain_effect_not_implemented não existe mais no código", () => {
    const offenders = files(join(ROOT, "src")).filter((f) => /domain_effect_not_implemented/.test(read(f)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it("o consumidor continua sem importar o chatbot, as filas de envio ou o adaptador do provedor", () => {
    for (const file of [CONSUMER, DISPATCH]) {
      expect(code(file), rel(file)).not.toMatch(/chatbot|outbox|sendText|sendTemplate|@\/server\/whatsapp\/provider\/(ycloud|simulated)/);
    }
  });
});
