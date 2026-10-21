/**
 * @vitest-environment node
 *
 * B3.2d-1 — claim atômico da inbox, no servidor.
 *
 * O consumidor futuro (B3.2d-2) recebe do evento interno SÓ o `inboxId`.
 * Daqui:
 *  - o claim manda ao banco só o id e a duração da lease; nada do evento
 *    (workspace, canal, ambiente, provedor, routing key) é usado;
 *  - o retorno é conferido campo por campo; o contexto confiável é montado
 *    no servidor a partir da linha;
 *  - decifra com a AAD desse contexto e confere o SHA-256 em tempo
 *    constante ANTES de devolver o corpo;
 *  - complete, fail e release só aceitam o claim emitido por aqui; o token
 *    não aparece no objeto, em JSON nem em erro;
 *  - as APIs antigas de leitura e marcação sem claim não existem mais.
 *
 * Escritos ANTES da implementação, contra a main 4e7c004. O banco é
 * simulado: só se observa o que é pedido a ele. Tudo fictício.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/server/whatsapp/admin/supabase", () => ({
  createWhatsAppAdminSupabaseClient: () => ({ rpc: rpcMock }),
}));

const loadInbox = () => import("@/server/whatsapp/inbox");
const { encryptWhatsAppInboxBody } = await import("@/server/whatsapp/inbox-crypto");
const { VerifiedWebhookBody } = await import("@/server/whatsapp/provider/contract");

const WS = "10000000-0000-0000-0000-000000000001";
const OTHER_WS = "10000000-0000-0000-0000-000000000002";
const CHANNEL = "35000000-0000-0000-0000-000000000001";
const OTHER_CHANNEL = "35000000-0000-0000-0000-000000000002";
const INBOX_ID = "45000000-0000-4000-8000-000000000001";
const OTHER_INBOX = "45000000-0000-4000-8000-000000000002";
const TOKEN = "6f1d2c3b-4a59-4e8f-9a1b-2c3d4e5f6a7b";
const ROUTING = "sim-claim-1";
const INBOX_KEY = Buffer.alloc(32, 9).toString("base64");
const PHONE = "+5511999990000";
const TEXT = "Olá, ação — mensagem fictícia 🚀";
const EVENT_ID = "evt-claim-1";

function configure() {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "chave-de-teste-b3-whatsapp-0123456789");
  vi.stubEnv("WHATSAPP_INBOX_KEY_VERSIONS", JSON.stringify({ "1": INBOX_KEY }));
  vi.stubEnv("WHATSAPP_INBOX_ACTIVE_KEY_VERSION", "1");
}

type RpcHandler = (args: Record<string, unknown>) => { data: unknown; error: unknown };
let handlers: Record<string, RpcHandler> = {};

beforeEach(() => {
  configure();
  handlers = {
    whatsapp_inbox_complete: () => ({ data: { outcome: "completed" }, error: null }),
    whatsapp_inbox_fail: () => ({ data: { outcome: "failed" }, error: null }),
    whatsapp_inbox_release: () => ({ data: { outcome: "released" }, error: null }),
  };
  rpcMock.mockReset();
  rpcMock.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    const handler = handlers[name];
    if (!handler) return { data: null, error: { message: `rpc_nao_esperada:${name}` } };
    return handler(args);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const bytesOf = (text: string) => new TextEncoder().encode(text);
const sha256 = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex");
const RAW = bytesOf(`{"version":1,\r\n"events":[{"type":"message.inbound","id":"${EVENT_ID}","from":"${PHONE}","text":"${TEXT}"}]}`);

type Aad = Partial<{ environment: string; workspaceId: string; channelId: string; provider: string; providerEventId: string }>;

/** Linha que o banco devolve num claim bem-sucedido. */
function claimRow(overrides: Record<string, unknown> = {}, aad: Aad = {}, raw: Uint8Array = RAW) {
  const enc = encryptWhatsAppInboxBody(raw, {
    environment: "preview",
    workspaceId: WS,
    channelId: CHANNEL,
    provider: "simulated",
    providerEventId: EVENT_ID,
    ...aad,
  } as never);
  return {
    outcome: "claimed",
    inbox_id: INBOX_ID,
    claim_token: TOKEN,
    claim_count: 1,
    claimed_at: "2026-10-21T12:00:00.000000+00:00",
    lease_until: "2026-10-21T12:05:00.000000+00:00",
    environment: "preview",
    workspace_id: WS,
    channel_id: CHANNEL,
    channel_status: "active",
    provider: "simulated",
    routing_key: ROUTING,
    provider_event_id: EVENT_ID,
    provider_event_type: "message.inbound",
    body_sha256: sha256(raw),
    received_at: "2026-10-21T11:59:59.000000+00:00",
    retain_until: "2026-10-21T12:59:59.000000+00:00",
    key_version: enc.keyVersion,
    nonce: enc.nonce,
    ciphertext: enc.ciphertext,
    auth_tag: enc.authTag,
    ...overrides,
  };
}

const calls = (name: string) => rpcMock.mock.calls.filter(([n]) => n === name) as [string, Record<string, unknown>][];

async function claimed(row: Record<string, unknown> = claimRow()) {
  const inbox = await loadInbox();
  handlers.whatsapp_inbox_claim = () => ({ data: row, error: null });
  const result = await inbox.claimWhatsAppInboxEntry({ inboxId: INBOX_ID });
  if (result.outcome !== "claimed") throw new Error(`claim não obtido no teste: ${result.outcome}`);
  return { inbox, claim: result.claim };
}

// ---------------------------------------------------------------------
// 1. O claim pede só o id da inbox e a lease
// ---------------------------------------------------------------------

describe("1. o claim recebe só o inboxId", () => {
  it("manda ao banco exatamente o id e a lease padrão de 300 s", async () => {
    await claimed();
    expect(calls("whatsapp_inbox_claim")).toEqual([["whatsapp_inbox_claim", { p_inbox_id: INBOX_ID, p_lease_seconds: 300 }]]);
  });

  it("contexto que viesse junto do evento (workspace, canal, ambiente, provedor, routing key) é ignorado", async () => {
    const { claimWhatsAppInboxEntry } = await loadInbox();
    handlers.whatsapp_inbox_claim = () => ({ data: claimRow(), error: null });
    await claimWhatsAppInboxEntry({
      inboxId: INBOX_ID,
      workspaceId: OTHER_WS,
      channelId: OTHER_CHANNEL,
      environment: "production",
      provider: "ycloud",
      routingKey: "100000000000001:+12025550199",
    } as never);
    expect(calls("whatsapp_inbox_claim")).toEqual([["whatsapp_inbox_claim", { p_inbox_id: INBOX_ID, p_lease_seconds: 300 }]]);
  });

  it("lease explícita dentro de 15 a 900 s é repassada", async () => {
    const { claimWhatsAppInboxEntry, WHATSAPP_INBOX_MIN_LEASE_SECONDS, WHATSAPP_INBOX_MAX_LEASE_SECONDS } = await loadInbox();
    expect([WHATSAPP_INBOX_MIN_LEASE_SECONDS, WHATSAPP_INBOX_MAX_LEASE_SECONDS]).toEqual([15, 900]);
    handlers.whatsapp_inbox_claim = () => ({ data: { outcome: "busy" }, error: null });
    await claimWhatsAppInboxEntry({ inboxId: INBOX_ID, leaseSeconds: 15 });
    await claimWhatsAppInboxEntry({ inboxId: INBOX_ID, leaseSeconds: 900 });
    expect(calls("whatsapp_inbox_claim").map(([, a]) => a.p_lease_seconds)).toEqual([15, 900]);
  });

  it.each([0, 14, 901, 1.5, Number.NaN, -60])("lease %s: invalid_lease antes do banco", async (leaseSeconds) => {
    const { claimWhatsAppInboxEntry } = await loadInbox();
    await expect(claimWhatsAppInboxEntry({ inboxId: INBOX_ID, leaseSeconds })).rejects.toMatchObject({ code: "invalid_lease" });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it.each(["", "x", ROUTING, "100000000000001:+12025550199", `${INBOX_ID} `, undefined])(
    "inboxId inválido (%s): not_found sem consultar o banco",
    async (inboxId) => {
      const { claimWhatsAppInboxEntry } = await loadInbox();
      await expect(claimWhatsAppInboxEntry({ inboxId: inboxId as never })).resolves.toEqual({ outcome: "not_found" });
      expect(rpcMock).not.toHaveBeenCalled();
    },
  );

  it("UUID em maiúsculas é o mesmo id", async () => {
    const { claimWhatsAppInboxEntry } = await loadInbox();
    handlers.whatsapp_inbox_claim = () => ({ data: claimRow(), error: null });
    const result = await claimWhatsAppInboxEntry({ inboxId: INBOX_ID.toUpperCase() });
    expect(result.outcome).toBe("claimed");
    expect(calls("whatsapp_inbox_claim")[0]![1]).toEqual({ p_inbox_id: INBOX_ID, p_lease_seconds: 300 });
  });
});

// ---------------------------------------------------------------------
// 2. Contexto confiável montado a partir da linha do banco
// ---------------------------------------------------------------------

describe("2. contexto e corpo depois do claim", () => {
  it("contexto vem da linha do banco e o corpo verificado tem os bytes exatos (CRLF incluso)", async () => {
    const { claim } = await claimed();
    expect(claim).toMatchObject({
      inboxId: INBOX_ID,
      environment: "preview",
      workspaceId: WS,
      channelId: CHANNEL,
      channelStatus: "active",
      provider: "simulated",
      routingKey: ROUTING,
      providerEventId: EVENT_ID,
      providerEventType: "message.inbound",
      claimCount: 1,
      leaseUntil: "2026-10-21T12:05:00.000000+00:00",
    });
    expect(VerifiedWebhookBody.is(claim.verified)).toBe(true);
    expect(Array.from(claim.verified.copyBytes())).toEqual(Array.from(RAW));
    expect(Object.isFrozen(claim)).toBe(true);
  });

  it("a AAD sai da própria linha: entrada de outro workspace, canal e provedor decifra com a identidade dela", async () => {
    const other = { workspace_id: OTHER_WS, channel_id: OTHER_CHANNEL, provider: "ycloud", routing_key: "100000000000001:+12025550199", provider_event_id: "evt-outro-1" };
    const { claim } = await claimed(
      claimRow(other, { workspaceId: OTHER_WS, channelId: OTHER_CHANNEL, provider: "ycloud", providerEventId: "evt-outro-1" }),
    );
    expect(claim).toMatchObject({ workspaceId: OTHER_WS, channelId: OTHER_CHANNEL, provider: "ycloud", providerEventId: "evt-outro-1" });
    expect(Array.from(claim.verified.copyBytes())).toEqual(Array.from(RAW));
  });

  it.each(["paused", "disconnected", "disabled"] as const)("canal %s depois do recebimento: claim com o estado atual", async (status) => {
    const { claim } = await claimed(claimRow({ channel_status: status }));
    expect(claim.channelStatus).toBe(status);
    expect(VerifiedWebhookBody.is(claim.verified)).toBe(true);
  });

  it("o token não é propriedade do claim nem aparece em JSON", async () => {
    const { claim } = await claimed();
    expect(Object.keys(claim)).not.toContain("claimToken");
    expect(Object.values(claim)).not.toContain(TOKEN);
    expect(JSON.stringify(claim)).not.toContain(TOKEN);
    expect((claim as Record<string, unknown>).claimToken).toBeUndefined();
  });

  it("nem o texto cifrado nem a chave aparecem no claim", async () => {
    const row = claimRow();
    const { claim } = await claimed(row);
    const json = JSON.stringify(claim);
    for (const leaked of [row.ciphertext, row.nonce, row.auth_tag, INBOX_KEY]) expect(json).not.toContain(leaked);
  });
});

// ---------------------------------------------------------------------
// 3. Conferências antes de devolver o corpo
// ---------------------------------------------------------------------

describe("3. nada de corpo antes de todas as conferências", () => {
  it("linha de outra entrada: recusada sem decifrar nem finalizar nada", async () => {
    const { claimWhatsAppInboxEntry } = await loadInbox();
    handlers.whatsapp_inbox_claim = () => ({ data: claimRow({ inbox_id: OTHER_INBOX }), error: null });
    await expect(claimWhatsAppInboxEntry({ inboxId: INBOX_ID })).rejects.toMatchObject({ code: "inbox_claim_invalid" });
    expect(calls("whatsapp_inbox_fail")).toHaveLength(0);
    expect(calls("whatsapp_inbox_release")).toHaveLength(0);
  });

  it("linha de outro ambiente que o do servidor: recusada", async () => {
    const { claimWhatsAppInboxEntry } = await loadInbox();
    handlers.whatsapp_inbox_claim = () => ({ data: claimRow({ environment: "production" }, { environment: "production" }), error: null });
    await expect(claimWhatsAppInboxEntry({ inboxId: INBOX_ID })).rejects.toMatchObject({ code: "channel_environment_mismatch" });
  });

  it.each([
    ["corpo em texto puro", { body: TEXT }],
    ["segredo do webhook", { webhook_secret: "segredo-ficticio" }],
    ["chave de API", { api_key: "chave-ficticia" }],
    ["credencial cifrada", { credential_ciphertext: "QUJD" }],
    ["campo desconhecido", { extra: 1 }],
  ])("retorno com %s: recusado e nada é devolvido", async (_name, extra) => {
    const { claimWhatsAppInboxEntry } = await loadInbox();
    handlers.whatsapp_inbox_claim = () => ({ data: { ...claimRow(), ...extra }, error: null });
    const error = await claimWhatsAppInboxEntry({ inboxId: INBOX_ID }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "inbox_claim_invalid" });
    expect(JSON.stringify(error) + String(error)).not.toContain(TEXT);
  });

  it.each([
    ["sem token", { claim_token: undefined }],
    ["token inválido", { claim_token: "x" }],
    ["claim_count zero", { claim_count: 0 }],
    ["estado de canal desconhecido", { channel_status: "archived" }],
    ["provedor desconhecido", { provider: "telegram" }],
    ["routing key vazia", { routing_key: "" }],
    ["hash malformado", { body_sha256: "XYZ" }],
    ["sem texto cifrado", { ciphertext: undefined }],
  ])("retorno %s: recusado", async (_name, patch) => {
    const { claimWhatsAppInboxEntry } = await loadInbox();
    handlers.whatsapp_inbox_claim = () => ({ data: claimRow(patch), error: null });
    await expect(claimWhatsAppInboxEntry({ inboxId: INBOX_ID })).rejects.toMatchObject({ code: "inbox_claim_invalid" });
  });

  it.each([
    ["workspace", { workspaceId: OTHER_WS }],
    ["canal", { channelId: OTHER_CHANNEL }],
    ["provedor", { provider: "ycloud" }],
    ["ambiente", { environment: "production" }],
    ["id do evento", { providerEventId: "evt-outro" }],
  ])("texto cifrado com a AAD de outro %s, rotulado com o meu: falha terminal, sem corpo", async (_name, aad) => {
    const { claimWhatsAppInboxEntry } = await loadInbox();
    handlers.whatsapp_inbox_claim = () => ({ data: claimRow({}, aad), error: null });
    await expect(claimWhatsAppInboxEntry({ inboxId: INBOX_ID })).rejects.toMatchObject({ code: "inbox_decrypt_failed" });
    expect(calls("whatsapp_inbox_fail")).toEqual([
      ["whatsapp_inbox_fail", { p_inbox_id: INBOX_ID, p_claim_token: TOKEN, p_error_code: "inbox_decrypt_failed" }],
    ]);
    expect(calls("whatsapp_inbox_complete")).toHaveLength(0);
  });

  it("hash que não confere com os bytes decifrados: falha terminal inbox_integrity_failed, sem corpo", async () => {
    const { claimWhatsAppInboxEntry } = await loadInbox();
    handlers.whatsapp_inbox_claim = () => ({ data: claimRow({ body_sha256: sha256(bytesOf("outro corpo")) }), error: null });
    await expect(claimWhatsAppInboxEntry({ inboxId: INBOX_ID })).rejects.toMatchObject({ code: "inbox_integrity_failed" });
    expect(calls("whatsapp_inbox_fail")).toEqual([
      ["whatsapp_inbox_fail", { p_inbox_id: INBOX_ID, p_claim_token: TOKEN, p_error_code: "inbox_integrity_failed" }],
    ]);
  });

  it("o hash é conferido em tempo constante", () => {
    const source = readFileSync(join(process.cwd(), "src/server/whatsapp/inbox.ts"), "utf8");
    expect(source).toMatch(/timingSafeEqual\(/);
    expect(source).not.toMatch(/body_sha256\s*[!=]==?\s*sha256Hex/);
  });

  it("chave da inbox ausente: libera para nova tentativa (falha transitória) e não devolve corpo", async () => {
    const { claimWhatsAppInboxEntry } = await loadInbox();
    const row = claimRow();
    handlers.whatsapp_inbox_claim = () => ({ data: row, error: null });
    vi.stubEnv("WHATSAPP_INBOX_KEY_VERSIONS", "");
    await expect(claimWhatsAppInboxEntry({ inboxId: INBOX_ID })).rejects.toMatchObject({ code: "inbox_crypto_not_configured" });
    expect(calls("whatsapp_inbox_release")).toEqual([
      ["whatsapp_inbox_release", { p_inbox_id: INBOX_ID, p_claim_token: TOKEN, p_error_code: "inbox_crypto_not_configured" }],
    ]);
    expect(calls("whatsapp_inbox_fail")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// 4. Outros resultados do claim
// ---------------------------------------------------------------------

describe("4. resultados sem claim", () => {
  it.each(["busy", "already_processed", "terminal_failed", "expired", "not_found"])("%s: repassado, sem corpo nem contexto", async (outcome) => {
    const { claimWhatsAppInboxEntry } = await loadInbox();
    handlers.whatsapp_inbox_claim = () => ({ data: { outcome }, error: null });
    await expect(claimWhatsAppInboxEntry({ inboxId: INBOX_ID })).resolves.toEqual({ outcome });
  });

  it.each([
    ["resultado desconhecido", { outcome: "stolen" }],
    ["busy com campos a mais", { outcome: "busy", claim_token: TOKEN }],
    ["sem resposta", null],
  ])("resposta fora do contrato (%s): inbox_claim_invalid", async (_name, data) => {
    const { claimWhatsAppInboxEntry } = await loadInbox();
    handlers.whatsapp_inbox_claim = () => ({ data, error: null });
    await expect(claimWhatsAppInboxEntry({ inboxId: INBOX_ID })).rejects.toMatchObject({ code: "inbox_claim_invalid" });
  });
});

// ---------------------------------------------------------------------
// 5. complete, fail e release: só com o claim emitido aqui
// ---------------------------------------------------------------------

describe("5. finalizações presas ao token do claim", () => {
  it("complete manda só o id e o token do claim", async () => {
    const { inbox, claim } = await claimed();
    await expect(inbox.completeWhatsAppInboxClaim(claim)).resolves.toEqual({ outcome: "completed" });
    expect(calls("whatsapp_inbox_complete")).toEqual([["whatsapp_inbox_complete", { p_inbox_id: INBOX_ID, p_claim_token: TOKEN }]]);
  });

  it("complete repetido: already_processed do banco é repassado", async () => {
    const { inbox, claim } = await claimed();
    await inbox.completeWhatsAppInboxClaim(claim);
    handlers.whatsapp_inbox_complete = () => ({ data: { outcome: "already_processed" }, error: null });
    await expect(inbox.completeWhatsAppInboxClaim(claim)).resolves.toEqual({ outcome: "already_processed" });
  });

  it.each(["claim_lost", "terminal_failed", "not_found"])("complete com resultado %s: repassado", async (outcome) => {
    const { inbox, claim } = await claimed();
    handlers.whatsapp_inbox_complete = () => ({ data: { outcome }, error: null });
    await expect(inbox.completeWhatsAppInboxClaim(claim)).resolves.toEqual({ outcome });
  });

  it("fail terminal com código sanitizado", async () => {
    const { inbox, claim } = await claimed();
    await expect(inbox.failWhatsAppInboxClaim(claim, "normalizacao_invalida")).resolves.toEqual({ outcome: "failed" });
    expect(calls("whatsapp_inbox_fail")).toEqual([
      ["whatsapp_inbox_fail", { p_inbox_id: INBOX_ID, p_claim_token: TOKEN, p_error_code: "normalizacao_invalida" }],
    ]);
  });

  it("release para nova tentativa com código sanitizado", async () => {
    const { inbox, claim } = await claimed();
    await expect(inbox.releaseWhatsAppInboxClaim(claim, "banco_indisponivel")).resolves.toEqual({ outcome: "released" });
    expect(calls("whatsapp_inbox_release")).toEqual([
      ["whatsapp_inbox_release", { p_inbox_id: INBOX_ID, p_claim_token: TOKEN, p_error_code: "banco_indisponivel" }],
    ]);
  });

  it.each([`Telefone ${PHONE} inválido`, "Error: connection refused", "", "x".repeat(65), "Maiúscula", "com espaço", undefined])(
    "fail e release com código fora do formato (%s): recusados antes do banco",
    async (code) => {
      const { inbox, claim } = await claimed();
      rpcMock.mockClear();
      await expect(inbox.failWhatsAppInboxClaim(claim, code as never)).rejects.toMatchObject({ code: "invalid_error_code" });
      await expect(inbox.releaseWhatsAppInboxClaim(claim, code as never)).rejects.toMatchObject({ code: "invalid_error_code" });
      expect(rpcMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["objeto montado à mão com os mesmos campos", (c: Record<string, unknown>) => ({ ...c })],
    ["objeto com o token", (c: Record<string, unknown>) => ({ ...c, claimToken: TOKEN })],
    ["só o id da inbox", () => ({ inboxId: INBOX_ID })],
  ])("claim falsificado (%s): recusado antes do banco", async (_name, forge) => {
    const { inbox, claim } = await claimed();
    rpcMock.mockClear();
    const forged = forge(claim as unknown as Record<string, unknown>) as never;
    await expect(inbox.completeWhatsAppInboxClaim(forged)).rejects.toMatchObject({ code: "inbox_claim_untrusted" });
    await expect(inbox.failWhatsAppInboxClaim(forged, "normalizacao_invalida")).rejects.toMatchObject({ code: "inbox_claim_untrusted" });
    await expect(inbox.releaseWhatsAppInboxClaim(forged, "banco_indisponivel")).rejects.toMatchObject({ code: "inbox_claim_untrusted" });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it.each([
    ["resultado desconhecido", { outcome: "overwritten" }],
    ["campos a mais", { outcome: "completed", state: "processed" }],
    ["sem resposta", null],
  ])("resposta da finalização fora do contrato (%s): inbox_claim_invalid", async (_name, data) => {
    const { inbox, claim } = await claimed();
    handlers.whatsapp_inbox_complete = () => ({ data, error: null });
    await expect(inbox.completeWhatsAppInboxClaim(claim)).rejects.toMatchObject({ code: "inbox_claim_invalid" });
  });
});

// ---------------------------------------------------------------------
// 6. Caminho antigo aposentado
// ---------------------------------------------------------------------

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("6. sem leitura nem marcação fora do claim", () => {
  it("as APIs antigas de leitura de pendente e marcação não existem mais", async () => {
    const inbox = (await loadInbox()) as Record<string, unknown>;
    for (const name of ["readPendingWhatsAppWebhookDelivery", "markWhatsAppWebhookDeliveryProcessed", "markWhatsAppWebhookDeliveryFailed"]) {
      expect(inbox).not.toHaveProperty(name);
    }
  });

  it("nenhum arquivo de src chama as RPCs antigas nem lê ou escreve a tabela da inbox diretamente", () => {
    const root = process.cwd();
    const offenders = sourceFiles(join(root, "src"))
      .map((file) => [relative(root, file).replaceAll("\\", "/"), readFileSync(file, "utf8")] as const)
      .filter(
        ([file, source]) =>
          /whatsapp_inbox_(get_pending|mark_processed|mark_failed)/.test(source) ||
          (file !== "src/server/types/database.ts" && /\.from\(\s*["'`]whatsapp_webhook_inbox["'`]/.test(source)),
      )
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// 7. Erros e logs sem conteúdo
// ---------------------------------------------------------------------

describe("7. nenhum erro bruto, token ou conteúdo", () => {
  it("código conhecido do banco é repassado; mensagem desconhecida vira unknown sem o texto original", async () => {
    const { claimWhatsAppInboxEntry } = await loadInbox();
    handlers.whatsapp_inbox_claim = () => ({ data: null, error: { message: "whatsapp_environment_required" } });
    await expect(claimWhatsAppInboxEntry({ inboxId: INBOX_ID })).rejects.toMatchObject({ code: "whatsapp_environment_required" });

    handlers.whatsapp_inbox_claim = () => ({ data: null, error: { message: `falha com ${PHONE}, ${TEXT} e ${TOKEN}` } });
    const error = await claimWhatsAppInboxEntry({ inboxId: INBOX_ID }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "unknown" });
    for (const leaked of [PHONE, TEXT, TOKEN]) expect(String(error) + JSON.stringify(error)).not.toContain(leaked);
  });

  it("erro do banco numa finalização não leva token nem mensagem original", async () => {
    const { inbox, claim } = await claimed();
    handlers.whatsapp_inbox_complete = () => ({ data: null, error: { message: `deadlock em ${TOKEN}` } });
    const error = await inbox.completeWhatsAppInboxClaim(claim).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "unknown" });
    expect(String(error) + JSON.stringify(error)).not.toContain(TOKEN);
  });

  it("falha de integridade não leva token, texto cifrado ou conteúdo", async () => {
    const { claimWhatsAppInboxEntry } = await loadInbox();
    const row = claimRow({ body_sha256: "f".repeat(64) });
    handlers.whatsapp_inbox_claim = () => ({ data: row, error: null });
    const error = await claimWhatsAppInboxEntry({ inboxId: INBOX_ID }).catch((e: unknown) => e);
    for (const leaked of [TOKEN, row.ciphertext, TEXT, PHONE]) expect(String(error) + JSON.stringify(error)).not.toContain(leaked);
  });

  it("nenhuma operação escreve no console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const { inbox, claim } = await claimed();
    await inbox.completeWhatsAppInboxClaim(claim);
    await inbox.failWhatsAppInboxClaim(claim, "normalizacao_invalida");
    await inbox.releaseWhatsAppInboxClaim(claim, "banco_indisponivel");
    handlers.whatsapp_inbox_claim = () => ({ data: claimRow({ body_sha256: "f".repeat(64) }), error: null });
    await inbox.claimWhatsAppInboxEntry({ inboxId: INBOX_ID }).catch(() => undefined);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
