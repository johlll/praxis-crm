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
 * Escritos ANTES da implementação, contra a main 10e617f.
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
