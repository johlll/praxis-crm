/**
 * @vitest-environment node
 *
 * B3.2c — evento interno publicado depois da gravação na inbox cifrada.
 *
 * Contrato exato: `{ id: inboxId, name: "praxis/whatsapp.inbox.received",
 * data: { inboxId } }`. Nada de workspace, canal, ambiente, provedor ou
 * routing key: o consumidor (B3.2d) resolve tudo pelo `inboxId` no banco.
 *
 * Cliente Inngest PRÓPRIO do WhatsApp: app `praxis-crm-whatsapp` e chave
 * `WHATSAPP_INNGEST_EVENT_KEY`, sem fallback para `INNGEST_EVENT_KEY` e sem
 * importar nada da A11 (`@/server/ingest/*`) nem da agenda
 * (`@/server/calendar/*`). Sem a chave própria, falha fechada.
 *
 * Escritos ANTES da implementação, contra a main 7e30e2c; revisados (cliente
 * próprio, evento mínimo) ANTES da correção, contra o HEAD 68c5f47.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { InngestMock, sendMock } = vi.hoisted(() => {
  const sendMock = vi.fn();
  const InngestMock = vi.fn(function (this: unknown, options: Record<string, unknown>) {
    return { options, send: sendMock };
  });
  return { InngestMock, sendMock };
});

vi.mock("inngest", () => ({ Inngest: InngestMock }));

const loadEvents = () => import("@/server/whatsapp/inbox-events");
const loadClient = () => import("@/server/whatsapp/inngest");

const INBOX_ID = "44000000-0000-0000-0000-000000000031";
const WA_KEY = "chave-de-evento-do-whatsapp-ficticia";
const A11_KEY = "chave-de-evento-da-a11-ficticia";

beforeEach(() => {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("WHATSAPP_INNGEST_EVENT_KEY", WA_KEY);
  vi.stubEnv("INNGEST_EVENT_KEY", "");
  InngestMock.mockClear();
  sendMock.mockReset();
  sendMock.mockResolvedValue({ ids: ["x"] });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("1. contrato exato do evento", () => {
  it("id = id da inbox, nome fixo e dados só { inboxId }", async () => {
    const { publishWhatsAppInboxReceived, WHATSAPP_INBOX_RECEIVED_EVENT } = await loadEvents();
    expect(WHATSAPP_INBOX_RECEIVED_EVENT).toBe("praxis/whatsapp.inbox.received");
    await publishWhatsAppInboxReceived({ inboxId: INBOX_ID });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]).toEqual([{ id: INBOX_ID, name: "praxis/whatsapp.inbox.received", data: { inboxId: INBOX_ID } }]);
    expect(Object.keys(sendMock.mock.calls[0]![0].data)).toEqual(["inboxId"]);
  });

  it("publicar duas vezes a mesma entrada gera exatamente o mesmo evento", async () => {
    const { publishWhatsAppInboxReceived } = await loadEvents();
    await publishWhatsAppInboxReceived({ inboxId: INBOX_ID });
    await publishWhatsAppInboxReceived({ inboxId: INBOX_ID });
    expect(sendMock.mock.calls[1]).toEqual(sendMock.mock.calls[0]);
  });

  it("campos a mais na chamada nunca entram no evento", async () => {
    const { publishWhatsAppInboxReceived } = await loadEvents();
    await publishWhatsAppInboxReceived({ inboxId: INBOX_ID, workspaceId: "w", channelId: "c", routingKey: "r" } as never);
    expect(sendMock.mock.calls[0]).toEqual([{ id: INBOX_ID, name: "praxis/whatsapp.inbox.received", data: { inboxId: INBOX_ID } }]);
  });

  it.each(["", "x", "44000000-0000-0000-0000-00000000003Z", undefined])("id da inbox inválido (%s): recusado, nada é enviado", async (inboxId) => {
    const { publishWhatsAppInboxReceived } = await loadEvents();
    await expect(publishWhatsAppInboxReceived({ inboxId } as never)).rejects.toMatchObject({ code: "invalid_inbox_id" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("falha do Inngest vira erro com código fixo, sem a mensagem original", async () => {
    const { publishWhatsAppInboxReceived } = await loadEvents();
    sendMock.mockRejectedValue(new Error(`detalhe interno ${WA_KEY}`));
    const error = await publishWhatsAppInboxReceived({ inboxId: INBOX_ID }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "inbox_event_publish_failed" });
    expect(String(error)).not.toContain("detalhe interno");
    expect(JSON.stringify(error)).not.toContain(WA_KEY);
  });
});

describe("2. cliente Inngest próprio do WhatsApp", () => {
  it("app id praxis-crm-whatsapp, com a chave própria passada explicitamente", async () => {
    const { WHATSAPP_INNGEST_APP_ID } = await loadClient();
    expect(WHATSAPP_INNGEST_APP_ID).toBe("praxis-crm-whatsapp");
    const { publishWhatsAppInboxReceived } = await loadEvents();
    await publishWhatsAppInboxReceived({ inboxId: INBOX_ID });
    expect(InngestMock).toHaveBeenCalledTimes(1);
    expect(InngestMock.mock.calls[0]![0]).toMatchObject({ id: "praxis-crm-whatsapp", eventKey: WA_KEY });
  });

  it("INNGEST_EVENT_KEY da A11, sozinho, não habilita a publicação", async () => {
    vi.stubEnv("WHATSAPP_INNGEST_EVENT_KEY", undefined as unknown as string);
    vi.stubEnv("INNGEST_EVENT_KEY", A11_KEY);
    const { publishWhatsAppInboxReceived } = await loadEvents();
    await expect(publishWhatsAppInboxReceived({ inboxId: INBOX_ID })).rejects.toMatchObject({ code: "inbox_event_not_configured" });
    expect(InngestMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it.each([
    ["vazia", ""],
    ["só espaços", "   "],
  ])("chave do WhatsApp %s, mesmo com a da A11 presente: falha fechada", async (_name, value) => {
    vi.stubEnv("WHATSAPP_INNGEST_EVENT_KEY", value);
    vi.stubEnv("INNGEST_EVENT_KEY", A11_KEY);
    const { publishWhatsAppInboxReceived } = await loadEvents();
    await expect(publishWhatsAppInboxReceived({ inboxId: INBOX_ID })).rejects.toMatchObject({ code: "inbox_event_not_configured" });
    expect(InngestMock).not.toHaveBeenCalled();
  });

  it("com as duas chaves, só a do WhatsApp é usada", async () => {
    vi.stubEnv("INNGEST_EVENT_KEY", A11_KEY);
    const { publishWhatsAppInboxReceived } = await loadEvents();
    await publishWhatsAppInboxReceived({ inboxId: INBOX_ID });
    const options = InngestMock.mock.calls[0]![0];
    expect(options.eventKey).toBe(WA_KEY);
    expect(JSON.stringify(options)).not.toContain(A11_KEY);
  });

  it("o erro de configuração não leva nome nem valor de chave", async () => {
    vi.stubEnv("WHATSAPP_INNGEST_EVENT_KEY", "");
    vi.stubEnv("INNGEST_EVENT_KEY", A11_KEY);
    const { publishWhatsAppInboxReceived } = await loadEvents();
    const error = await publishWhatsAppInboxReceived({ inboxId: INBOX_ID }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "inbox_event_not_configured" });
    expect(String(error)).not.toContain(A11_KEY);
    expect(String(error)).not.toContain("INNGEST_EVENT_KEY");
  });
});

describe("3. isolamento do código: nada da A11 nem da agenda", () => {
  const root = process.cwd();
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }
  const whatsappFiles = [...files(join(root, "src", "server", "whatsapp")), ...files(join(root, "src", "app", "api", "webhooks", "whatsapp"))];

  it.each(whatsappFiles.map((f) => [relative(root, f)]))("%s não importa @/server/ingest nem @/server/calendar", (file) => {
    const source = readFileSync(join(root, file), "utf8");
    expect(source).not.toMatch(/from\s+["']@\/server\/ingest/);
    expect(source).not.toMatch(/from\s+["']@\/server\/calendar/);
    expect(source).not.toMatch(/import\(\s*["']@\/server\/(ingest|calendar)/);
  });

  it("o cliente e o evento do WhatsApp não leem INNGEST_EVENT_KEY nem usam o app praxis-crm", () => {
    for (const rel of ["src/server/whatsapp/inngest.ts", "src/server/whatsapp/inbox-events.ts"]) {
      const source = readFileSync(join(root, rel), "utf8");
      expect(source).not.toMatch(/(?<!WHATSAPP_)INNGEST_EVENT_KEY/);
      expect(source).not.toMatch(/["']praxis-crm["']/);
    }
  });
});
