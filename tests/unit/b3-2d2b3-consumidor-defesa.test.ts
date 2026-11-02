/**
 * @vitest-environment node
 *
 * B3.2d-2b3 — defesa em profundidade do consumidor: o despachante dos efeitos
 * nunca deve lançar nem devolver uma disposição fora do contrato, mas, se o
 * fizer, o consumidor falha fechado — nova tentativa do Inngest, SEM
 * finalizar a entrada, SEM log e SEM o erro original. (Estes caminhos não são
 * alcançáveis com o despachante real; por isso ele é substituído aqui.)
 *
 * Escritos depois da primeira rodada de mutações (a mutação "erro bruto no log
 * do consumidor" sobreviveu a este caminho inalcançável). Tudo fictício.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as DispatchModule from "@/server/whatsapp/effects/dispatch";
import type * as ProviderModule from "@/server/whatsapp/provider";
import { claimRow, EVENTS, ev, fakeAdapter, INBOX_ID, INBOX_KEY, PHONE, rawTypeOf, ROUTING, TOKEN, WS } from "../support/whatsapp-consumer-harness";

const h = vi.hoisted(() => ({ rpc: vi.fn(), resolve: vi.fn(), dispatch: vi.fn() }));

vi.mock("@/server/whatsapp/admin/supabase", () => ({
  createWhatsAppAdminSupabaseClient: () => ({ rpc: h.rpc, from: () => ({}) }),
}));
vi.mock("@/server/whatsapp/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderModule>();
  return { ...actual, resolveWhatsAppProvider: h.resolve };
});
vi.mock("@/server/whatsapp/effects/dispatch", async (importOriginal) => ({
  ...(await importOriginal<typeof DispatchModule>()),
  applyWhatsAppDomainEffect: h.dispatch,
}));

const FINALIZERS = ["whatsapp_inbox_complete", "whatsapp_inbox_fail", "whatsapp_inbox_release", "whatsapp_inbox_dispose"];
let rpcNames: string[] = [];

beforeEach(() => {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("WHATSAPP_PROVIDER", "simulated");
  vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "chave-de-teste-b3-whatsapp-0123456789");
  vi.stubEnv("WHATSAPP_INBOX_KEY_VERSIONS", JSON.stringify({ "1": INBOX_KEY }));
  vi.stubEnv("WHATSAPP_INBOX_ACTIVE_KEY_VERSION", "1");
  rpcNames = [];
  h.rpc.mockReset();
  h.rpc.mockImplementation(async (name: string) => {
    rpcNames.push(name);
    if (name === "whatsapp_inbox_claim") return { data: claimRow({ provider_event_type: rawTypeOf(EVENTS.status) }), error: null };
    return { data: { outcome: "released" }, error: null };
  });
  h.resolve.mockReset();
  h.resolve.mockReturnValue({ status: "enabled", provider: fakeAdapter({ events: [ev(EVENTS.status)], envelopeType: rawTypeOf(EVENTS.status) }) });
  h.dispatch.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function run() {
  const { processWhatsAppInboxEntry } = await import("@/server/whatsapp/consumer");
  return processWhatsAppInboxEntry({ inboxId: INBOX_ID });
}

describe("despachante fora do contrato → o consumidor falha fechado", () => {
  it.each([
    ["lança um erro com dados", () => Promise.reject(new Error(`falha com ${PHONE} ${ROUTING} ${TOKEN} ${WS}`))],
    ["lança um valor que não é erro", () => Promise.reject(`texto solto com ${PHONE}`)],
    ["devolve uma disposição de nova tentativa", () => Promise.resolve({ action: "retry" })],
    ["devolve uma ação desconhecida", () => Promise.resolve({ action: "banana", code: "applied" })],
    ["devolve nada", () => Promise.resolve(undefined)],
  ])("%s: nova tentativa, nenhuma finalização, nenhum log, nada do erro original", async (_name, behavior) => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    h.dispatch.mockImplementation(behavior);
    const { WhatsAppConsumerRetryableError } = await import("@/server/whatsapp/consumer");
    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WhatsAppConsumerRetryableError);
    expect(error).toMatchObject({ code: "effect_unavailable", message: "effect_unavailable" });
    const dump = `${(error as Error).message}|${(error as Error).stack}|${String((error as { cause?: unknown }).cause)}`;
    for (const secret of [PHONE, ROUTING, TOKEN, WS, "falha com", "texto solto"]) expect(dump).not.toContain(secret);
    expect(rpcNames.filter((n) => FINALIZERS.includes(n))).toEqual([]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it("o claim chega ao despachante uma única vez, e o consumidor não o devolve", async () => {
    h.dispatch.mockResolvedValue({ action: "done", outcome: "processed", code: "applied" });
    await expect(run()).resolves.toEqual({ outcome: "processed", code: "applied" });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(rpcNames).toEqual(["whatsapp_inbox_claim"]);
  });
});
