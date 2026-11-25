/**
 * @vitest-environment node
 *
 * Conversas + IA — horário de ORIGEM das mensagens (docs/decisoes/conversas-horario-origem.md).
 *
 * Separa três instantes: quando a mensagem OCORREU na origem (`originTime`), quando chegou ao CRM
 * (`created_at`, no banco) e qual fonte comprova o horário. Aqui: o que o adaptador entrega a partir
 * dos eventos de teste (fixtures modeladas na documentação da YCloud — NÃO são eventos reais da
 * YCloud), o módulo que repassa o horário ao banco e as checagens estáticas da migration. As
 * regras do banco (limites, contradição, quem preenche, comparação com a decisão humana) são
 * provadas em `supabase/tests/database/57_conversas_horario_origem.test.sql`.
 *
 * Tudo fictício.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  body,
  bytes,
  FICT,
  inboundGroup,
  inboundSystemNumberChange,
  inboundText,
  NOW_MS,
  signedHeaders,
  smbEcho,
  smbMessageCreated,
  statusUpdated,
} from "../support/ycloud-fixtures";

const loadProvider = () => import("@/server/whatsapp/provider/ycloud");

async function normalizeRaw(raw: Uint8Array) {
  const { YCloudWhatsAppProvider } = await loadProvider();
  const provider = new YCloudWhatsAppProvider();
  const verified = provider.verifyWebhook({ rawBody: raw, headers: signedHeaders(raw), secret: FICT.secret, nowMs: NOW_MS });
  if (!verified.ok) throw new Error(`assinatura recusada no teste: ${verified.reason}`);
  return provider.normalizeEvents(verified.verified);
}

const normalize = (event: unknown) => normalizeRaw(bytes(body(event)));

async function single(event: unknown) {
  const result = await normalize(event);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  expect(result.events).toHaveLength(1);
  return result.events[0]!;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function withSendTime(event: typeof inboundText, sendTime: unknown) {
  const copy = clone(event);
  (copy.whatsappInboundMessage as Record<string, unknown>).sendTime = sendTime;
  return copy;
}

// ---------------------------------------------------------------------
// 1. Mensagem recebida: a origem é o sendTime da mensagem, e só ele
// ---------------------------------------------------------------------

describe("1. mensagem recebida (YCloud): horário de origem", () => {
  it("o sendTime da mensagem vira o horário de origem, distinto do createTime do evento", async () => {
    const event = await single(inboundText);
    expect(event).toMatchObject({
      kind: "message.inbound",
      originTime: { kind: "provider_send_time", at: new Date("2026-10-20T11:59:59.000Z") },
      occurredAt: new Date("2026-10-20T11:59:59.000Z"),
    });
    // O createTime do envelope (12:00:00) é o momento em que o evento foi criado: não é a origem.
    expect(inboundText.createTime).not.toBe("2026-10-20T11:59:59.000Z");
    expect((event as { originTime: { at: Date } }).originTime.at.toISOString()).not.toBe(inboundText.createTime);
  });

  it("sem sendTime: a origem é `missing` — NUNCA o createTime do envelope — e occurredAt mantém o significado de antes", async () => {
    const event = clone(inboundText);
    delete (event.whatsappInboundMessage as Partial<typeof event.whatsappInboundMessage>).sendTime;
    const normalized = await single(event);
    expect(normalized).toMatchObject({
      kind: "message.inbound",
      originTime: { kind: "missing" },
      occurredAt: new Date(inboundText.createTime),
    });
    expect(JSON.stringify((normalized as { originTime: unknown }).originTime)).not.toContain(inboundText.createTime);
  });

  it.each([
    ["null explícito", null],
  ])("sendTime %s é ausência, não erro", async (_name, sendTime) => {
    const normalized = await single(withSendTime(inboundText, sendTime));
    expect(normalized).toMatchObject({ originTime: { kind: "missing" } });
  });

  it("fuso: o mesmo instante com outro deslocamento dá o mesmo horário de origem", async () => {
    const utc = await single(withSendTime(inboundText, "2026-10-20T11:59:59.000Z"));
    const brasilia = await single(withSendTime(inboundText, "2026-10-20T08:59:59.000-03:00"));
    const tokyo = await single(withSendTime(inboundText, "2026-10-20T20:59:59+09:00"));
    const at = (e: unknown) => (e as { originTime: { at: Date } }).originTime.at.getTime();
    expect(at(brasilia)).toBe(at(utc));
    expect(at(tokyo)).toBe(at(utc));
  });

  it("precisão: os milissegundos informados são preservados (o banco os compara depois)", async () => {
    const normalized = await single(withSendTime(inboundText, "2026-10-20T11:59:59.123Z"));
    expect((normalized as { originTime: { at: Date } }).originTime.at.toISOString()).toBe("2026-10-20T11:59:59.123Z");
  });

  it.each([
    ["texto livre", "ontem"],
    ["vazio", ""],
    ["data sem horário", "2026-10-20"],
    ["horário sem fuso (não se adivinha o fuso)", "2026-10-20T11:59:59"],
    ["espaço no lugar do T", "2026-10-20 11:59:59Z"],
    ["segundos desde a época, como número (unidade errada)", 1_792_497_599],
    ["milissegundos desde a época, como número (unidade errada)", 1_792_497_599_000],
    ["segundos desde a época, como texto", "1792497599"],
    ["milissegundos desde a época, como texto", "1792497599000"],
    ["booleano", true],
    ["objeto", { at: "2026-10-20T11:59:59Z" }],
    ["mês 13", "2026-13-20T11:59:59Z"],
  ])("sendTime presente e malformado (%s): o evento inteiro é recusado, como antes — nada é adivinhado nem reparado", async (_name, sendTime) => {
    await expect(normalize(withSendTime(inboundText, sendTime))).resolves.toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("mensagem de sistema e de grupo não carregam horário de origem de mensagem", async () => {
    const system = await single(inboundSystemNumberChange);
    expect(system).not.toHaveProperty("originTime");
    const group = await single(inboundGroup);
    expect(group).not.toHaveProperty("originTime");
  });
});

// ---------------------------------------------------------------------
// 2. Saída observada: o createTime da mensagem não é a origem
// ---------------------------------------------------------------------

describe("2. eco do aplicativo (YCloud): horário de origem", () => {
  it.each([
    ["eco (smb.message.echoes)", smbEcho],
    ["mensagem criada pelo aplicativo (smb.message.created)", smbMessageCreated],
  ])("%s: o sendTime da mensagem é a origem", async (_name, fixture) => {
    const event = await single(fixture);
    expect(event).toMatchObject({
      kind: "message.outbound_observed",
      originTime: { kind: "provider_send_time", at: new Date(fixture.whatsappMessage.sendTime) },
    });
  });

  it("sem sendTime, só com o createTime da mensagem: a origem é `missing` (createTime é o registro na YCloud, não a ocorrência)", async () => {
    const event = clone(smbEcho);
    delete (event.whatsappMessage as Partial<typeof event.whatsappMessage>).sendTime;
    const normalized = await single(event);
    expect(normalized).toMatchObject({ kind: "message.outbound_observed", originTime: { kind: "missing" } });
    // occurredAt mantém a reserva de antes (createTime da mensagem), só para ordenação.
    expect(normalized).toMatchObject({ occurredAt: new Date(event.whatsappMessage.createTime) });
  });

  it("sem sendTime nem createTime da mensagem: missing, e occurredAt cai no createTime do envelope como antes", async () => {
    const event = clone(smbEcho);
    delete (event.whatsappMessage as Partial<typeof event.whatsappMessage>).sendTime;
    delete (event.whatsappMessage as Partial<typeof event.whatsappMessage>).createTime;
    const normalized = await single(event);
    expect(normalized).toMatchObject({ originTime: { kind: "missing" }, occurredAt: new Date(event.createTime) });
  });

  it.each([
    ["texto livre", "ontem"],
    ["milissegundos como número", 1_792_497_660_000],
  ])("sendTime malformado (%s): evento recusado, como antes", async (_name, sendTime) => {
    const event = clone(smbEcho);
    (event.whatsappMessage as Record<string, unknown>).sendTime = sendTime;
    await expect(normalize(event)).resolves.toEqual({ ok: false, reason: "invalid_payload" });
  });
});

// ---------------------------------------------------------------------
// 3. Status NUNCA é horário de origem
// ---------------------------------------------------------------------

describe("3. status de entrega, leitura e falha: nunca horário de origem", () => {
  it.each(["sent", "delivered", "read", "failed"])("status %s: o evento não tem horário de origem, mesmo com sendTime no payload", async (status) => {
    const event = await single(statusUpdated(status));
    expect(event.kind).toBe("message.status");
    expect(event).not.toHaveProperty("originTime");
    // O horário do status é o do evento (createTime do envelope), nunca o sendTime da mensagem.
    expect(event).toMatchObject({ occurredAt: new Date("2026-10-20T12:02:00.000Z") });
  });
});

// ---------------------------------------------------------------------
// 4. Provedor simulado: coberto em b3-whatsapp-provider.test.ts (originTime `missing`, porque o
//    horário é escolhido por quem monta o evento).
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// 5. Gravação no banco: só a entrada e o que o evento trouxe
// ---------------------------------------------------------------------

const h = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/server/whatsapp/admin/supabase", () => ({
  createWhatsAppAdminSupabaseClient: () => ({ rpc: h.rpc }),
}));

afterEach(() => {
  h.rpc.mockReset();
});

describe("5. módulo de gravação do horário de origem", () => {
  async function trustedClaim() {
    const inbox = await import("@/server/whatsapp/inbox");
    // Um claim emitido pela própria inbox (a RPC do claim é simulada, como nos testes do consumidor).
    const harness = await import("../support/whatsapp-consumer-harness");
    h.rpc.mockImplementation(async (name: string) => {
      if (name === "whatsapp_inbox_claim") return { data: harness.claimRow(), error: null };
      return { data: { outcome: "recorded" }, error: null };
    });
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("WHATSAPP_PROVIDER", "simulated");
    vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "chave-de-teste-b3-whatsapp-0123456789");
    vi.stubEnv("WHATSAPP_INBOX_KEY_VERSIONS", JSON.stringify({ "1": harness.INBOX_KEY }));
    vi.stubEnv("WHATSAPP_INBOX_ACTIVE_KEY_VERSION", "1");
    const claimed = await inbox.claimWhatsAppInboxEntry({ inboxId: harness.INBOX_ID });
    if (claimed.outcome !== "claimed") throw new Error("sem claim");
    h.rpc.mockClear();
    return { claim: claimed.claim, inboxId: harness.INBOX_ID };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("horário do provedor: manda a entrada e o horário em ISO — sem token, mensagem, fonte, veredito ou dica", async () => {
    const { claim, inboxId } = await trustedClaim();
    const { recordWhatsAppMessageOriginTime } = await import("@/server/whatsapp/effects/message-origin-time");
    await expect(recordWhatsAppMessageOriginTime(claim, { kind: "provider_send_time", at: new Date("2026-10-20T11:59:59.123Z") })).resolves.toEqual({ outcome: "recorded" });
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenCalledWith("whatsapp_record_message_origin_time", { p_inbox_id: inboxId, p_origin_at: "2026-10-20T11:59:59.123Z" });
  });

  it("ausente: manda só a dica `missing`, sem horário", async () => {
    const { claim, inboxId } = await trustedClaim();
    const { recordWhatsAppMessageOriginTime } = await import("@/server/whatsapp/effects/message-origin-time");
    await recordWhatsAppMessageOriginTime(claim, { kind: "missing" });
    expect(h.rpc).toHaveBeenCalledWith("whatsapp_record_message_origin_time", { p_inbox_id: inboxId, p_origin_at: null, p_origin_issue: "missing" });
  });

  it("não é o horário de chegada: nenhuma chamada usa a hora atual", async () => {
    const { claim } = await trustedClaim();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    try {
      const { recordWhatsAppMessageOriginTime } = await import("@/server/whatsapp/effects/message-origin-time");
      await recordWhatsAppMessageOriginTime(claim, { kind: "missing" });
      await recordWhatsAppMessageOriginTime(claim, { kind: "provider_send_time", at: new Date("2026-10-20T11:59:59.000Z") });
    } finally {
      vi.useRealTimers();
    }
    expect(JSON.stringify(h.rpc.mock.calls)).not.toContain("2030");
  });

  it("claim montado à mão ou copiado: recusado, sem chamar o banco", async () => {
    await trustedClaim();
    h.rpc.mockClear();
    const { recordWhatsAppMessageOriginTime } = await import("@/server/whatsapp/effects/message-origin-time");
    await expect(recordWhatsAppMessageOriginTime({ inboxId: "forjado" } as never, { kind: "missing" })).rejects.toMatchObject({ code: "inbox_claim_untrusted" });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["Date inválida", { kind: "provider_send_time", at: new Date("não é data") }],
    ["tipo desconhecido", { kind: "created_at" }],
    ["sem objeto", undefined],
    ["horário como texto", { kind: "provider_send_time", at: "2026-10-20T11:59:59Z" }],
  ])("origem malformada (%s): falha fechada, sem chamar o banco e sem virar `missing`", async (_name, originTime) => {
    const { claim } = await trustedClaim();
    const { recordWhatsAppMessageOriginTime } = await import("@/server/whatsapp/effects/message-origin-time");
    await expect(recordWhatsAppMessageOriginTime(claim, originTime as never)).rejects.toMatchObject({ code: "invalid_origin_time" });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["erro do banco com código conhecido", { data: null, error: { message: "invalid_origin_time" } }, "invalid_origin_time"],
    ["ambiente não autenticado", { data: null, error: { message: "whatsapp_environment_required" } }, "whatsapp_environment_required"],
    ["erro desconhecido", { data: null, error: { message: "connection refused 10.0.0.1" } }, "unknown"],
    ["resposta fora do contrato", { data: { outcome: "outro" }, error: null }, "invalid_response"],
    ["resposta com chave a mais", { data: { outcome: "recorded", message_id: "x" }, error: null }, "invalid_response"],
    ["resposta vazia", { data: null, error: null }, "invalid_response"],
  ])("%s: erro com código fixo, sem texto do banco", async (_name, answer, code) => {
    const { claim } = await trustedClaim();
    h.rpc.mockImplementation(async () => answer);
    const { recordWhatsAppMessageOriginTime } = await import("@/server/whatsapp/effects/message-origin-time");
    const error = await recordWhatsAppMessageOriginTime(claim, { kind: "missing" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "WhatsAppMessageOriginTimeError", code });
    expect(JSON.stringify(error)).not.toContain("10.0.0.1");
  });

  it.each(["recorded", "unverified", "unchanged", "contradictory", "not_found", "not_applicable"])("resultado %s do banco é repassado como veio", async (outcome) => {
    const { claim } = await trustedClaim();
    h.rpc.mockImplementation(async () => ({ data: { outcome, issue: outcome === "unverified" ? "missing" : null }, error: null }));
    const { recordWhatsAppMessageOriginTime } = await import("@/server/whatsapp/effects/message-origin-time");
    await expect(recordWhatsAppMessageOriginTime(claim, { kind: "missing" })).resolves.toEqual({ outcome });
  });
});

// ---------------------------------------------------------------------
// 6. Checagens estáticas da migration e dos tipos
// ---------------------------------------------------------------------

const root = resolve(__dirname, "..", "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8").split("\r").join("");
const MIGRATION_FILE = "20261124120000_conversas_horario_origem.sql";
const migration = read(`supabase/migrations/${MIGRATION_FILE}`);
/** Só o SQL, sem os comentários de linha. */
const sql = migration
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

describe("6. migration 20261124120000: forma e superfície", () => {
  it("vem depois de todas as publicadas (renumerada da antiga 20261119120000, nunca aplicada)", () => {
    const migrations = readdirSync(resolve(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
    const at = migrations.indexOf(MIGRATION_FILE);
    expect(at).toBeGreaterThan(0);
    // A última publicada (ledger 124 no hospedado) vem imediatamente antes.
    expect(migrations[at - 1]).toBe("20261123120000_conversas_documentos_caso.sql");
    expect(migrations).not.toContain("20261119120000_conversas_horario_origem.sql");
  });

  it("é aditiva: nada é apagado e nenhum efeito da B3 é recriado", () => {
    expect(sql).not.toMatch(/\bdrop\s+(table|column|function|trigger)\b/i);
    expect(sql).not.toMatch(/create\s+(or\s+replace\s+)?function\s+public\.whatsapp_effect_/i);
    expect(sql).not.toMatch(/\balter\s+table\s+public\.messages\s+(drop|alter)\b/i);
    // Nenhum UPDATE/INSERT/DELETE de dado existente fora do corpo da função do servidor.
    expect(sql).not.toMatch(/\bdelete\s+from\b/i);
    expect(sql.match(/\bupdate\s+public\.messages\b/gi)?.length ?? 0).toBe(2);
  });

  it("não faz backfill: nenhuma linha anterior ganha origem", () => {
    // Os dois únicos UPDATE são os da função do servidor, por mensagem do ledger de UM evento.
    expect(sql).not.toMatch(/update\s+public\.messages\s+set\s+origin_time_at\s*=\s*(m\.)?created_at/i);
    expect(sql).not.toMatch(/update\s+public\.messages[^;]*created_at/i);
    expect(sql).not.toMatch(/insert\s+into\s+public\.messages/i);
  });

  it("três colunas anuláveis, com restrição de formato e limites", () => {
    expect(sql).toMatch(/add column origin_time_at timestamptz,\s+add column origin_time_source text,\s+add column origin_time_issue text/);
    expect(sql).toContain("messages_origin_time_shape");
    expect(sql).toContain("'provider_send_time', 'crm_accepted'");
    expect(sql).toContain("'missing', 'invalid', 'future', 'too_old', 'contradictory'");
    expect(sql).toContain("timestamptz '2009-01-01 00:00:00+00'");
  });

  it("a gravação do provedor é só do service_role", () => {
    expect(sql).toMatch(/revoke all on function public\.whatsapp_record_message_origin_time\(uuid, timestamptz, text\) from public, anon, authenticated;/);
    expect(sql).toMatch(/grant execute on function public\.whatsapp_record_message_origin_time\(uuid, timestamptz, text\) to service_role;/);
    expect(sql).not.toMatch(/grant execute on function public\.whatsapp_record_message_origin_time[^;]*to (authenticated|anon|public)/i);
  });

  it("as funções privadas não são executáveis por papel de API", () => {
    for (const fn of [
      "private.messages_origin_time_insert()",
      "private.messages_origin_time_guard()",
      "private.message_origin_time_issue(timestamptz, text, timestamptz)",
      "private.message_origin_time_verdict(timestamptz, text, text, timestamptz, timestamptz, timestamptz)",
      "private.message_origin_time_evidence_verdict(uuid, timestamptz, timestamptz)",
    ]) {
      const escaped = fn.replace(/[()]/g, "\\$&");
      expect(sql, fn).toMatch(new RegExp(`revoke all on function ${escaped}\\s+from public, anon, authenticated, service_role;`));
    }
  });

  it("a gravação lê só o ledger de mensagens e não toca status, custo nem identidade", () => {
    const record = sql.slice(sql.indexOf("create function public.whatsapp_record_message_origin_time"), sql.indexOf("create or replace function private.privacy_export_payload"));
    expect(record).toContain("l.effect in ('message.inbound', 'message.outbound_observed')");
    expect(record).not.toMatch(/message_status_events|provider_cost|whatsapp_identities|status_updated_at|created_at\s*=\s*now|now\(\)/);
    // A fonte é fixa; o chamador não a informa.
    expect(record).toContain("'provider_send_time'");
    expect(record).not.toMatch(/p_origin_source|p_source/);
  });

  it("limites e margens documentados são os do código: 2009, 5 minutos à frente, 5 segundos de margem", () => {
    expect(sql).toContain("interval '5 minutes'");
    expect(sql).toContain("interval '5 seconds'");
    expect(sql).toContain("2009-01-01");
  });

  it("a exportação do titular só ganha a chave origin_time na seção de mensagens", () => {
    expect(sql).toContain("'origin_time', jsonb_build_object(");
    expect(sql).toContain("'at', x.origin_time_at, 'source', x.origin_time_source, 'issue', x.origin_time_issue");
    expect((sql.match(/'origin_time'/g) ?? []).length).toBe(1);
    // Nada de identificadores internos nem do ledger na exportação.
    const exportBody = sql.slice(sql.indexOf("create or replace function private.privacy_export_payload"));
    expect(exportBody).not.toMatch(/inbox_id|whatsapp_effect_ledger|provider_event_id/);
  });

  it("o corpo da exportação é o PUBLICADO por último (documentos por caso), byte a byte, exceto a chave nova", () => {
    // Partir de uma versão anterior apagaria as seções case_notes e case_documents.
    const previous = read("supabase/migrations/20261123120000_conversas_documentos_caso.sql");
    const take = (text: string) => {
      const start = text.lastIndexOf("create or replace function private.privacy_export_payload");
      const body = text.slice(text.indexOf("$body$", start));
      return body.slice(0, body.indexOf("$body$;") + 7);
    };
    const withoutNewKey = take(migration).replace(
      "        'origin_time', jsonb_build_object(\n          'at', x.origin_time_at, 'source', x.origin_time_source, 'issue', x.origin_time_issue),\n",
      "",
    );
    expect(withoutNewKey).toBe(take(previous));
  });
});

describe("7. tipos do banco e documentação", () => {
  const types = read("src/server/types/database.ts");

  it("messages tem as três colunas, e a função do servidor está declarada", () => {
    for (const column of ["origin_time_at", "origin_time_issue", "origin_time_source"]) {
      expect((types.match(new RegExp(`\\b${column}\\??: string \\| null`, "g")) ?? []).length, column).toBe(3);
    }
    expect(types).toMatch(/whatsapp_record_message_origin_time: \{\s+Args: \{\s+p_inbox_id: string\s+p_origin_at: string\s+p_origin_issue\?: string\s+\}\s+Returns: Json/);
  });

  it("a decisão documenta fontes, motivos de inelegibilidade, a regra de comparação e os limites", () => {
    const doc = read("docs/decisoes/conversas-horario-origem.md");
    for (const term of [
      "provider_send_time",
      "crm_accepted",
      "created_at",
      "manual_decided_at",
      "not_after_decision",
      "origin_contradictory",
      "decision_marker_suspect",
      "fixtures",
      "YCloud real",
      "sem backfill",
      "9h",
      "10h30",
    ]) {
      expect(doc, term).toContain(term);
    }
  });
});
