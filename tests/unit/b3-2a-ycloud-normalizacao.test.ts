/**
 * @vitest-environment node
 *
 * B3.2a — normalização dos eventos da YCloud em fatos do provedor.
 *
 * O adaptador entrega FATOS: não cria lead, contato, conversa ou mensagem;
 * não decide identidade interna, automação, vínculo nem origem `chatbot`
 * (docs/decisoes/b3-whatsapp-real.md §15.10). A origem que ele relata é só
 * uma CANDIDATA: `inbound` (recebida), `business_app` (eco do aplicativo) ou
 * `external_api` (mensagem de API sem prova específica).
 *
 * Escritos ANTES do adaptador, contra a main 7b97297.
 */
import { describe, expect, it } from "vitest";

import {
  agentEcho,
  body,
  businessAccountDeleted,
  businessAccountUpdated,
  bytes,
  FICT,
  historyInbound,
  historyOutbound,
  historyProgressOnly,
  inboundGroup,
  inboundImage,
  inboundSystemNumberChange,
  inboundText,
  inboundUnsupported,
  NOW_MS,
  phoneNumberQuality,
  signedHeaders,
  smbEcho,
  smbMessageCreated,
  statusUpdated,
  templateReviewed,
  unknownType,
} from "../support/ycloud-fixtures";

const load = () => import("@/server/whatsapp/provider/ycloud");

const ROUTING = `${FICT.wabaId}:${FICT.businessPhone}`;

async function normalizeRaw(raw: Uint8Array) {
  const { YCloudWhatsAppProvider } = await load();
  const provider = new YCloudWhatsAppProvider();
  const verified = provider.verifyWebhook({ rawBody: raw, headers: signedHeaders(raw), secret: FICT.secret, nowMs: NOW_MS });
  if (!verified.ok) throw new Error(`assinatura recusada no teste: ${verified.reason}`);
  return provider.normalizeEvents(verified.verified);
}

async function normalize(event: unknown) {
  return normalizeRaw(bytes(body(event)));
}

async function single(event: unknown) {
  const result = await normalize(event);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  expect(result.events).toHaveLength(1);
  return result.events[0]!;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("1. chave de roteamento e identificador do evento", () => {
  it("monta a routing key a partir do wabaId e do número do escritório", async () => {
    const { ycloudRoutingKey } = await load();
    expect(ycloudRoutingKey(FICT.wabaId, FICT.businessPhone)).toBe(ROUTING);
    expect(() => ycloudRoutingKey("", FICT.businessPhone)).toThrow();
    expect(() => ycloudRoutingKey(FICT.wabaId, "12025550199")).toThrow();
  });

  it("extrai o id do evento (chave de deduplicação oficial) e a routing key", async () => {
    const event = await single(inboundText);
    expect(event).toMatchObject({ providerEventId: inboundText.id, routingKey: ROUTING });
  });

  it.each([
    ["sem id", { ...inboundText, id: undefined }],
    ["id curto (mínimo oficial de 6)", { ...inboundText, id: "evt_1" }],
    ["id com espaço", { ...inboundText, id: "evt ficticio 0001" }],
    ["sem type", { ...inboundText, type: undefined }],
    ["type malformado", { ...inboundText, type: "Whatsapp Inbound!" }],
    ["sem createTime", { ...inboundText, createTime: undefined }],
    ["createTime inválido", { ...inboundText, createTime: "ontem" }],
  ])("envelope inválido falha de forma controlada: %s", async (_name, event) => {
    expect(await normalize(event)).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("JSON inválido, BOM assinado e UTF-8 inválido assinado viram invalid_payload, sem exceção", async () => {
    expect(await normalizeRaw(bytes("{ não é json"))).toEqual({ ok: false, reason: "invalid_payload" });
    expect(await normalizeRaw(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(body(inboundText))]))).toEqual({
      ok: false,
      reason: "invalid_payload",
    });
    expect(await normalizeRaw(new Uint8Array([...bytes('{"id":"'), 0xff, ...bytes('"}')]))).toEqual({
      ok: false,
      reason: "invalid_payload",
    });
    expect(await normalizeRaw(bytes("[]"))).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("recusa um corpo que não passou pela verificação", async () => {
    const { YCloudWhatsAppProvider } = await load();
    const provider = new YCloudWhatsAppProvider();
    const fake = bytes(body(inboundText)) as never;
    expect(provider.normalizeEvents(fake)).toEqual({ ok: false, reason: "unverified_body" });
  });
});

describe("2. mensagem recebida: candidata a `inbound`", () => {
  it("texto: identidade com telefone e BSUID, ids, horário e conteúdo", async () => {
    const event = await single(inboundText);
    expect(event).toEqual({
      kind: "message.inbound",
      originCandidate: "inbound",
      providerEventId: inboundText.id,
      routingKey: ROUTING,
      providerMessageId: inboundText.whatsappInboundMessage.id,
      waMessageId: inboundText.whatsappInboundMessage.wamid,
      occurredAt: new Date(inboundText.whatsappInboundMessage.sendTime),
      sender: { kind: "phone_and_bsuid", phoneE164: FICT.customerPhone, bsuid: FICT.bsuid },
      senderProfileName: FICT.profileName,
      contentKind: "text",
      text: inboundText.whatsappInboundMessage.text.body,
    });
  });

  it("não decide nada além do fato: sem lead, contato, classificação do remetente ou origem chatbot", async () => {
    const event = await single(inboundText);
    const keys = Object.keys(event);
    for (const forbidden of ["senderClassification", "sender_classification", "origin", "leadId", "contactId", "isInternal", "isNewCustomer"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("só telefone", async () => {
    const event = clone(inboundText);
    delete (event.whatsappInboundMessage as Partial<typeof event.whatsappInboundMessage>).fromUserId;
    expect(await single(event)).toMatchObject({ sender: { kind: "phone", phoneE164: FICT.customerPhone, bsuid: null } });
  });

  it("só BSUID: nunca fabrica telefone a partir do BSUID", async () => {
    const event = clone(inboundText);
    delete (event.whatsappInboundMessage as Partial<typeof event.whatsappInboundMessage>).from;
    const normalized = await single(event);
    expect(normalized).toMatchObject({ sender: { kind: "bsuid", phoneE164: null, bsuid: FICT.bsuid } });
  });

  it("sem nenhuma identidade do remetente: recusa", async () => {
    const event = clone(inboundText);
    const message = event.whatsappInboundMessage as Partial<typeof event.whatsappInboundMessage>;
    delete message.from;
    delete message.fromUserId;
    expect(await normalize(event)).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it.each([
    ["telefone sem +", { from: "12025550101" }],
    ["telefone com letras", { from: "+1202555ABCD" }],
    ["BSUID com espaço", { fromUserId: "US 1000" }],
    ["BSUID vazio com telefone válido", { fromUserId: "" }],
    ["telefone vazio com BSUID válido", { from: "" }],
  ])("identificador malformado invalida o evento: %s", async (_name, patch) => {
    const event = clone(inboundText);
    Object.assign(event.whatsappInboundMessage, patch);
    expect(await normalize(event)).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it.each([
    ["sem wabaId", { wabaId: undefined }],
    ["sem número do escritório (to)", { to: undefined }],
    ["número do escritório malformado", { to: "BUSINESS-PHONE-NUMBER" }],
    ["sem id da mensagem", { id: undefined }],
  ])("sem roteamento ou id não há fato: %s", async (_name, patch) => {
    const event = clone(inboundText);
    Object.assign(event.whatsappInboundMessage, patch);
    expect(await normalize(event)).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("mídia: registra o tipo, sem link, id ou legenda (mídia é da B3.4)", async () => {
    const event = await single(inboundImage);
    expect(event).toMatchObject({ kind: "message.inbound", contentKind: "image", text: null });
    const text = JSON.stringify(event);
    expect(text).not.toContain("exemplo.invalid");
    expect(text).not.toContain("legenda");
  });

  it("tipo não suportado pela Meta: vira contentKind `unsupported`, sem conteúdo", async () => {
    expect(await single(inboundUnsupported)).toMatchObject({
      kind: "message.inbound",
      contentKind: "unsupported",
      text: null,
      sender: { kind: "bsuid", bsuid: FICT.bsuid },
    });
  });

  it("sem sendTime, usa o createTime do evento", async () => {
    const event = clone(inboundText);
    delete (event.whatsappInboundMessage as Partial<typeof event.whatsappInboundMessage>).sendTime;
    expect(await single(event)).toMatchObject({ occurredAt: new Date(inboundText.createTime) });
  });

  it("mensagem de grupo é ignorada, sem conteúdo nem identidade", async () => {
    const event = await single(inboundGroup);
    expect(event).toEqual({
      kind: "ignored",
      reason: "group_message",
      providerType: "whatsapp.inbound_message.received",
      providerEventId: inboundGroup.id,
      routingKey: ROUTING,
      occurredAt: new Date(inboundGroup.createTime),
    });
  });
});

describe("3. troca de número ou de identidade (mensagem de sistema)", () => {
  it("user_changed_number: identidade anterior e nova, sem usar o texto livre", async () => {
    const event = await single(inboundSystemNumberChange);
    expect(event).toEqual({
      kind: "contact.identity_changed",
      change: "phone_number",
      providerEventId: inboundSystemNumberChange.id,
      routingKey: ROUTING,
      occurredAt: new Date(inboundSystemNumberChange.whatsappInboundMessage.sendTime),
      previous: { kind: "phone_and_bsuid", phoneE164: FICT.customerPhone, bsuid: FICT.bsuid },
      next: { kind: "phone_and_bsuid", phoneE164: FICT.customerNewPhone, bsuid: FICT.newBsuid },
    });
    expect(JSON.stringify(event)).not.toContain("texto livre");
  });

  it("wa_id e new_wa_id divergentes invalidam o evento", async () => {
    const event = clone(inboundSystemNumberChange);
    Object.assign(event.whatsappInboundMessage.system, { new_wa_id: "12025550103" });
    expect(await normalize(event)).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("número novo malformado invalida o evento", async () => {
    const event = clone(inboundSystemNumberChange);
    Object.assign(event.whatsappInboundMessage.system, { wa_id: "+12025550102" });
    expect(await normalize(event)).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("user_identity_changed: registra a mudança sem inventar a identidade nova", async () => {
    const event = clone(inboundSystemNumberChange);
    event.whatsappInboundMessage.system = { type: "user_identity_changed", body: "fictício" } as never;
    expect(await single(event)).toMatchObject({ kind: "contact.identity_changed", change: "identity", next: null });
  });

  it("tipo de sistema desconhecido: unsupported, sem conteúdo", async () => {
    const event = clone(inboundSystemNumberChange);
    event.whatsappInboundMessage.system = { type: "algo_novo" } as never;
    expect(await single(event)).toMatchObject({ kind: "unsupported", providerType: "whatsapp.inbound_message.received" });
  });
});

describe("4. eco do WhatsApp Business: candidato a `business_app`", () => {
  it.each([
    ["whatsapp.smb.message.echoes", smbEcho],
    ["whatsapp.smb.message.created", smbMessageCreated],
  ])("%s", async (providerType, fixture) => {
    const event = await single(fixture);
    expect(event).toMatchObject({
      kind: "message.outbound_observed",
      originCandidate: "business_app",
      providerType,
      providerEventId: fixture.id,
      routingKey: ROUTING,
      providerMessageId: fixture.whatsappMessage.id,
      waMessageId: fixture.whatsappMessage.wamid,
      contentKind: "text",
      text: fixture.whatsappMessage.text.body,
    });
  });

  it("destinatário com telefone e BSUID (toUserId)", async () => {
    expect(await single(smbEcho)).toMatchObject({
      recipient: { kind: "phone_and_bsuid", phoneE164: FICT.customerPhone, bsuid: FICT.bsuid },
    });
  });

  it("recipientUserId e o alias toUserId divergentes invalidam o evento", async () => {
    const event = clone(smbEcho);
    Object.assign(event.whatsappMessage, { recipientUserId: "US.10000000000000000009" });
    expect(await normalize(event)).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("sem destinatário: recusa", async () => {
    const event = clone(smbEcho);
    const message = event.whatsappMessage as Partial<typeof event.whatsappMessage>;
    delete message.to;
    delete message.toUserId;
    expect(await normalize(event)).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("o eco de agente da Meta (echo_message.*) NÃO é eco do aplicativo", async () => {
    expect(await single(agentEcho)).toMatchObject({ kind: "unsupported", providerType: "whatsapp.echo_message.created" });
  });
});

describe("5. status: candidato a `external_api`, externalId opaco", () => {
  it.each(["accepted", "sent", "delivered", "read", "failed"])("normaliza %s", async (status) => {
    const event = await single(statusUpdated(status));
    expect(event).toMatchObject({
      kind: "message.status",
      originCandidate: "external_api",
      providerEventId: `evt_ficticio_status_${status}`,
      routingKey: ROUTING,
      providerMessageId: "650000000000000000000c01",
      waMessageId: "wamid.FICTICIO0201",
      externalId: "ref-opaca-ficticia-0001",
      status,
      recipient: { kind: "phone_and_bsuid", phoneE164: FICT.customerPhone, bsuid: FICT.bsuid },
    });
  });

  it("não carrega o texto da mensagem", async () => {
    expect(JSON.stringify(await single(statusUpdated("sent")))).not.toContain("Texto fictício");
  });

  it("failed traz o código de erro", async () => {
    expect(await single(statusUpdated("failed", { errorCode: "131026", errorMessage: "fictício" }))).toMatchObject({
      status: "failed",
      errorCode: "131026",
    });
  });

  it("externalId com formato de id do chatbot continua sendo só valor opaco: nunca vira origem chatbot", async () => {
    for (const externalId of ["msg-bot_0123456789abcdef01234567", "dr-reply_0123456789abcdef01234567", "chatbot"]) {
      const event = await single(statusUpdated("delivered", { externalId }));
      expect(event).toMatchObject({ originCandidate: "external_api", externalId });
      expect(JSON.stringify(event)).not.toContain('"originCandidate":"chatbot"');
    }
  });

  it("sem externalId: null", async () => {
    const event = statusUpdated("sent");
    delete (event.whatsappMessage as Partial<typeof event.whatsappMessage>).externalId;
    expect(await single(event)).toMatchObject({ externalId: null });
  });

  it.each([
    ["status desconhecido", { status: "played" }],
    ["sem status", { status: undefined }],
    ["externalId com caractere de controle", { externalId: "ref\u0000ficticia" }],
    ["externalId vazio", { externalId: "" }],
    ["externalId longo demais", { externalId: "x".repeat(513) }],
    ["sem from (schema oficial: obrigatório)", { from: undefined }],
    ["sem wabaId (schema oficial: obrigatório)", { wabaId: undefined }],
    ["BSUID do destinatário malformado", { recipientUserId: "US 1" }],
  ])("recusa: %s", async (_name, patch) => {
    expect(await normalize(statusUpdated("sent", patch))).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("status sem destinatário é aceito (o exemplo oficial pode omitir `to`)", async () => {
    const event = statusUpdated("sent");
    const message = event.whatsappMessage as Partial<typeof event.whatsappMessage>;
    delete message.to;
    delete message.recipientUserId;
    expect(await single(event)).toMatchObject({ recipient: null });
  });

  it("mensagem do produto Verify não é mensagem de WhatsApp do canal: ignorada", async () => {
    expect(await single(statusUpdated("sent", { bizType: "verify" }))).toMatchObject({
      kind: "ignored",
      reason: "non_whatsapp_product",
    });
  });

  it("repetidos e fora de ordem: cada entrega vira um fato próprio, sem descarte nem reordenação", async () => {
    const sequence = [
      statusUpdated("failed", {}, "evt_ficticio_seq_0001"),
      statusUpdated("delivered", {}, "evt_ficticio_seq_0002"),
      statusUpdated("delivered", {}, "evt_ficticio_seq_0003"),
      statusUpdated("sent", {}, "evt_ficticio_seq_0004"),
      statusUpdated("delivered", {}, "evt_ficticio_seq_0002"),
    ];
    const statuses = [];
    for (const event of sequence) statuses.push(await single(event));
    expect(statuses.map((s) => (s.kind === "message.status" ? [s.providerEventId, s.status] : null))).toEqual([
      ["evt_ficticio_seq_0001", "failed"],
      ["evt_ficticio_seq_0002", "delivered"],
      ["evt_ficticio_seq_0003", "delivered"],
      ["evt_ficticio_seq_0004", "sent"],
      ["evt_ficticio_seq_0002", "delivered"],
    ]);
  });
});

describe("6. histórico: ignorado no piloto", () => {
  it.each([
    ["entrada", historyInbound, ROUTING],
    ["saída", historyOutbound, ROUTING],
    ["só progresso", historyProgressOnly, null],
  ])("%s: ignored, sem conteúdo nem identidade", async (_name, fixture, routingKey) => {
    const event = await single(fixture);
    expect(event).toEqual({
      kind: "ignored",
      reason: "history",
      providerType: "whatsapp.smb.history",
      providerEventId: fixture.id,
      routingKey,
      occurredAt: new Date(fixture.createTime),
    });
    const text = JSON.stringify(event);
    expect(text).not.toContain("Histórico fictício");
    expect(text).not.toContain(FICT.customerPhone);
    expect(text).not.toContain(FICT.bsuid);
  });
});

describe("7. eventos de conta e de número (contrato oficial conhecido)", () => {
  it("whatsapp.business_account.deleted", async () => {
    expect(await single(businessAccountDeleted)).toEqual({
      kind: "account",
      scope: "business_account",
      providerType: "whatsapp.business_account.deleted",
      providerEventId: businessAccountDeleted.id,
      providerAccountRef: FICT.wabaId,
      businessPhoneE164: null,
      routingKey: null,
      occurredAt: new Date(businessAccountDeleted.createTime),
      code: "ACCOUNT_DISCONNECTED",
    });
  });

  it("whatsapp.business_account.updated preserva o código como valor opaco", async () => {
    expect(await single(businessAccountUpdated)).toMatchObject({ kind: "account", code: "ACCOUNT_VIOLATION" });
  });

  it("whatsapp.phone_number.quality_updated: roteável para o canal do número", async () => {
    expect(await single(phoneNumberQuality)).toEqual({
      kind: "account",
      scope: "phone_number",
      providerType: "whatsapp.phone_number.quality_updated",
      providerEventId: phoneNumberQuality.id,
      providerAccountRef: FICT.wabaId,
      businessPhoneE164: FICT.businessPhone,
      routingKey: ROUTING,
      occurredAt: new Date(phoneNumberQuality.createTime),
      code: "YELLOW",
    });
  });

  it("conta sem id: recusa", async () => {
    const event = clone(businessAccountDeleted);
    delete (event.whatsappBusinessAccount as Partial<typeof event.whatsappBusinessAccount>).id;
    expect(await normalize(event)).toEqual({ ok: false, reason: "invalid_payload" });
  });
});

describe("8. tipos sem processamento e tipos desconhecidos", () => {
  it.each([
    ["conhecido, fora do escopo (template)", templateReviewed],
    ["desconhecido, com envelope válido", unknownType],
  ])("%s: unsupported, registrado e sem conteúdo", async (_name, fixture) => {
    const event = await single(fixture);
    expect(event).toEqual({
      kind: "unsupported",
      providerEventId: fixture.id,
      routingKey: null,
      occurredAt: new Date(fixture.createTime),
      providerType: fixture.type,
    });
  });
});
