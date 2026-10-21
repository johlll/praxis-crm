/**
 * @vitest-environment node
 *
 * B3.2c — evento interno publicado depois da gravação na inbox cifrada.
 *
 * Só identificadores: id da inbox (também a chave de deduplicação do
 * Inngest), canal, workspace, ambiente e provedor. Nunca corpo, mensagem,
 * telefone, BSUID, segredo ou texto cifrado. Só com o contexto CONFIÁVEL do
 * canal. Sem chave de evento do Inngest, falha fechada (nada é enviado; a
 * entrada continua pendente para o reconciliador da B3.2e).
 *
 * Escritos ANTES da implementação, contra a main 7e30e2c.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock, sendMock } = vi.hoisted(() => ({ rpcMock: vi.fn(), sendMock: vi.fn() }));

vi.mock("@/server/whatsapp/admin/supabase", () => ({
  createWhatsAppAdminSupabaseClient: () => ({ rpc: rpcMock }),
}));

vi.mock("@/server/ingest/publisher", () => ({
  inngestClient: () => ({ send: sendMock }),
}));

const loadEvents = () => import("@/server/whatsapp/inbox-events");
const channels = await import("@/server/whatsapp/admin/channels");

const WS = "10000000-0000-0000-0000-000000000001";
const ACTOR = "20000000-0000-0000-0000-000000000001";
const CHANNEL = "33000000-0000-0000-0000-000000000031";
const INBOX_ID = "44000000-0000-0000-0000-000000000031";

beforeEach(() => {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("INNGEST_EVENT_KEY", "chave-de-evento-ficticia");
  rpcMock.mockReset();
  rpcMock.mockResolvedValue({
    data: {
      id: CHANNEL,
      label: "Canal fictício",
      provider: "simulated",
      environment: "preview",
      routing_key: "sim-evento-1",
      display_phone_number: "+12025550199",
      is_simulator: true,
      status: "active",
      send_enabled: true,
      status_changed_at: null,
      created_at: "2026-10-21T12:00:00Z",
      updated_at: "2026-10-21T12:00:00Z",
      credential_purposes: ["webhook_secret"],
    },
    error: null,
  });
  sendMock.mockReset();
  sendMock.mockResolvedValue({ ids: ["x"] });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function trusted() {
  const { context } = await channels.adminResolveManagedWhatsAppChannel({ channelId: CHANNEL, workspaceId: WS, actorUserId: ACTOR });
  return context;
}

describe("evento interno da inbox", () => {
  it("publica um evento com id = id da inbox e só identificadores", async () => {
    const { publishWhatsAppInboxReceived, WHATSAPP_INBOX_RECEIVED_EVENT } = await loadEvents();
    expect(WHATSAPP_INBOX_RECEIVED_EVENT).toBe("praxis/whatsapp.inbox.received");
    await publishWhatsAppInboxReceived({ channel: await trusted(), inboxId: INBOX_ID });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith({
      id: INBOX_ID,
      name: "praxis/whatsapp.inbox.received",
      data: { inboxId: INBOX_ID, channelId: CHANNEL, workspaceId: WS, environment: "preview", provider: "simulated" },
    });
  });

  it("contexto montado à mão: recusado, nada é enviado", async () => {
    const { publishWhatsAppInboxReceived } = await loadEvents();
    const forged = { channelId: CHANNEL, workspaceId: WS, environment: "preview", provider: "simulated", routingKey: "sim-evento-1" } as never;
    await expect(publishWhatsAppInboxReceived({ channel: forged, inboxId: INBOX_ID })).rejects.toMatchObject({ code: "channel_context_untrusted" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("contexto de outro ambiente: recusado, nada é enviado", async () => {
    const { publishWhatsAppInboxReceived } = await loadEvents();
    const channel = await trusted();
    vi.stubEnv("VERCEL_ENV", "production");
    await expect(publishWhatsAppInboxReceived({ channel, inboxId: INBOX_ID })).rejects.toMatchObject({ code: "channel_environment_mismatch" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it.each(["", "x", "44000000-0000-0000-0000-00000000003Z"])("id da inbox inválido (%s): recusado", async (inboxId) => {
    const { publishWhatsAppInboxReceived } = await loadEvents();
    await expect(publishWhatsAppInboxReceived({ channel: await trusted(), inboxId })).rejects.toMatchObject({ code: "invalid_inbox_id" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it.each([
    ["ausente", undefined],
    ["vazia", ""],
  ])("chave de evento do Inngest %s: falha fechada, nada é enviado", async (_name, value) => {
    const { publishWhatsAppInboxReceived } = await loadEvents();
    const channel = await trusted();
    vi.stubEnv("INNGEST_EVENT_KEY", value as unknown as string);
    await expect(publishWhatsAppInboxReceived({ channel, inboxId: INBOX_ID })).rejects.toMatchObject({ code: "inbox_event_not_configured" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("falha do Inngest vira erro com código fixo, sem a mensagem original", async () => {
    const { publishWhatsAppInboxReceived } = await loadEvents();
    sendMock.mockRejectedValue(new Error("detalhe interno do provedor"));
    const error = await publishWhatsAppInboxReceived({ channel: await trusted(), inboxId: INBOX_ID }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "inbox_event_publish_failed" });
    expect(String(error)).not.toContain("detalhe interno");
  });
});
