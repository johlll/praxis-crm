/**
 * Fixtures da YCloud para a B3.2a.
 *
 * Seguem a ESTRUTURA dos exemplos oficiais (docs.ycloud.com, guias de
 * webhook e especificação `testing-webhooks.yaml`, conferidos em
 * 20/10/2026), com TODOS os valores trocados por dados fictícios:
 *  - telefones na faixa reservada para ficção dos EUA (+1 202 555-01xx);
 *  - BSUID, WABA, ids de evento e de mensagem inventados;
 *  - nenhum segredo, endpoint, payload ou dado real.
 *
 * Ficam em TypeScript (e não em .json) para que os bytes assinados sejam os
 * mesmos em qualquer sistema: o git pode trocar LF por CRLF em arquivos de
 * texto no checkout.
 */
import { createHmac } from "node:crypto";

export const FICT = {
  secret: "segredo-ficticio-b3-2a-0001",
  wabaId: "100000000000001",
  businessPhone: "+12025550199",
  customerPhone: "+12025550101",
  customerNewPhone: "+12025550102",
  customerNewWaId: "12025550102",
  bsuid: "US.10000000000000000001",
  parentBsuid: "US.ENT.10000000000000000002",
  newBsuid: "US.10000000000000000003",
  profileName: "Cliente Fictício",
} as const;

export const NOW_MS = 1_800_000_000_000;
export const NOW_S = Math.floor(NOW_MS / 1000);

const encoder = new TextEncoder();

export function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Corpo no formato dos exemplos oficiais (JSON indentado com 2 espaços). */
export function body(event: unknown): string {
  return JSON.stringify(event, null, 2);
}

/**
 * Assinatura de REFERÊNCIA, independente do adaptador, conforme o guia
 * oficial: HMAC-SHA256 com o segredo do endpoint sobre
 * `<t>.` seguido dos bytes exatos do corpo, em hexadecimal.
 */
export function referenceSignature(raw: Uint8Array, secret: string = FICT.secret, t: number = NOW_S): string {
  return createHmac("sha256", secret).update(`${t}.`).update(raw).digest("hex");
}

export function signedHeaders(raw: Uint8Array, opts: { secret?: string; t?: number } = {}): Headers {
  const t = opts.t ?? NOW_S;
  return new Headers({ "YCloud-Signature": `t=${t},s=${referenceSignature(raw, opts.secret ?? FICT.secret, t)}` });
}

// ---------------------------------------------------------------------
// Eventos (estrutura oficial, valores fictícios)
// ---------------------------------------------------------------------

export const inboundText = {
  id: "evt_ficticio_inbound_0001",
  type: "whatsapp.inbound_message.received",
  apiVersion: "v2",
  createTime: "2026-10-20T12:00:00.000Z",
  whatsappInboundMessage: {
    id: "650000000000000000000a01",
    wamid: "wamid.FICTICIO0001",
    wabaId: FICT.wabaId,
    from: FICT.customerPhone,
    fromUserId: FICT.bsuid,
    fromParentUserId: FICT.parentBsuid,
    customerProfile: { name: FICT.profileName, username: "@ficticio" },
    to: FICT.businessPhone,
    sendTime: "2026-10-20T11:59:59.000Z",
    type: "text",
    text: { body: "Olá, ação — mensagem fictícia 🚀" },
    context: { from: "12025550101", id: "wamid.FICTICIO0000" },
  },
};

export const inboundImage = {
  id: "evt_ficticio_inbound_0002",
  type: "whatsapp.inbound_message.received",
  apiVersion: "v2",
  createTime: "2026-10-20T12:00:01.000Z",
  whatsappInboundMessage: {
    id: "650000000000000000000a02",
    wamid: "wamid.FICTICIO0002",
    wabaId: FICT.wabaId,
    from: FICT.customerPhone,
    to: FICT.businessPhone,
    sendTime: "2026-10-20T12:00:01.000Z",
    type: "image",
    image: {
      link: "https://exemplo.invalid/midia-ficticia",
      id: "700000000000001",
      sha256: "ZmljdGljaW8=",
      mime_type: "image/jpeg",
      caption: "legenda fictícia",
    },
  },
};

export const inboundUnsupported = {
  id: "evt_ficticio_inbound_0003",
  type: "whatsapp.inbound_message.received",
  apiVersion: "v2",
  createTime: "2026-10-20T12:00:02.000Z",
  whatsappInboundMessage: {
    id: "650000000000000000000a03",
    wamid: "wamid.FICTICIO0003",
    wabaId: FICT.wabaId,
    fromUserId: FICT.bsuid,
    to: FICT.businessPhone,
    sendTime: "2026-10-20T12:00:02.000Z",
    errors: [{ code: 131051, title: "Message type unknown" }],
    type: "unsupported",
    unsupported: { type: "poll_update" },
  },
};

export const inboundSystemNumberChange = {
  id: "evt_ficticio_system_0001",
  type: "whatsapp.inbound_message.received",
  apiVersion: "v2",
  createTime: "2026-10-20T12:00:03.000Z",
  whatsappInboundMessage: {
    id: "650000000000000000000a04",
    wamid: "wamid.FICTICIO0004",
    wabaId: FICT.wabaId,
    from: FICT.customerPhone,
    fromUserId: FICT.bsuid,
    to: FICT.businessPhone,
    sendTime: "2026-10-20T12:00:03.000Z",
    type: "system",
    system: {
      body: "texto livre fictício que não deve ser usado",
      wa_id: FICT.customerNewWaId,
      user_id: FICT.newBsuid,
      type: "user_changed_number",
    },
  },
};

export const inboundGroup = {
  id: "evt_ficticio_group_0001",
  type: "whatsapp.inbound_message.received",
  apiVersion: "v2",
  createTime: "2026-10-20T12:00:04.000Z",
  whatsappInboundMessage: {
    id: "650000000000000000000a05",
    wabaId: FICT.wabaId,
    from: FICT.customerPhone,
    to: FICT.businessPhone,
    type: "text",
    text: { body: "mensagem de grupo fictícia" },
    groupId: "120000000000000001@g.us",
  },
};

export const smbEcho = {
  id: "evt_ficticio_echo_0001",
  type: "whatsapp.smb.message.echoes",
  apiVersion: "v2",
  createTime: "2026-10-20T12:01:00.000Z",
  whatsappMessage: {
    id: "650000000000000000000b01",
    wamid: "wamid.FICTICIO0101",
    wabaId: FICT.wabaId,
    from: FICT.businessPhone,
    to: FICT.customerPhone,
    type: "text",
    text: { body: "Resposta fictícia pelo aplicativo." },
    status: "sent",
    createTime: "2026-10-20T12:01:00.000Z",
    sendTime: "2026-10-20T12:01:00.000Z",
    toUserId: FICT.bsuid,
    toParentUserId: FICT.parentBsuid,
    customerProfile: { username: "@ficticio" },
  },
};

export const smbMessageCreated = {
  id: "evt_ficticio_smb_created_0001",
  type: "whatsapp.smb.message.created",
  apiVersion: "v2",
  createTime: "2026-10-20T12:01:01.000Z",
  whatsappMessage: {
    id: "650000000000000000000b02",
    wamid: "wamid.FICTICIO0102",
    wabaId: FICT.wabaId,
    from: FICT.businessPhone,
    to: FICT.customerPhone,
    type: "text",
    text: { body: "Outra resposta fictícia pelo aplicativo." },
    status: "sent",
    createTime: "2026-10-20T12:01:01.000Z",
    sendTime: "2026-10-20T12:01:01.000Z",
  },
};

export function statusUpdated(status: string, extra: Record<string, unknown> = {}, eventId = `evt_ficticio_status_${status}`) {
  return {
    id: eventId,
    type: "whatsapp.message.updated",
    apiVersion: "v2",
    createTime: "2026-10-20T12:02:00.000Z",
    whatsappMessage: {
      id: "650000000000000000000c01",
      wamid: "wamid.FICTICIO0201",
      wabaId: FICT.wabaId,
      from: FICT.businessPhone,
      to: FICT.customerPhone,
      recipientUserId: FICT.bsuid,
      parentRecipientUserId: FICT.parentBsuid,
      status,
      pricingCategory: "service",
      totalPrice: 0.0,
      currency: "USD",
      createTime: "2026-10-20T12:01:59.000Z",
      sendTime: "2026-10-20T12:02:00.000Z",
      bizType: "whatsapp",
      type: "text",
      text: { body: "Texto fictício que o status não deve carregar." },
      externalId: "ref-opaca-ficticia-0001",
      ...extra,
    },
  };
}

export const historyInbound = {
  id: "evt_ficticio_history_0001",
  type: "whatsapp.smb.history",
  apiVersion: "v2",
  createTime: "2026-10-20T12:03:00.000Z",
  phase: 1,
  progress: 40,
  whatsappInboundMessage: {
    id: "650000000000000000000d01",
    wamid: "wamid.FICTICIO0301",
    wabaId: FICT.wabaId,
    from: FICT.customerPhone,
    fromUserId: FICT.bsuid,
    to: FICT.businessPhone,
    sendTime: "2026-01-01T12:00:00.000Z",
    type: "text",
    text: { body: "Histórico fictício antigo." },
  },
};

export const historyOutbound = {
  id: "evt_ficticio_history_0002",
  type: "whatsapp.smb.history",
  apiVersion: "v2",
  createTime: "2026-10-20T12:03:01.000Z",
  phase: 1,
  progress: 41,
  whatsappMessage: {
    id: "650000000000000000000d02",
    wabaId: FICT.wabaId,
    from: FICT.businessPhone,
    to: FICT.customerPhone,
    status: "sent",
    type: "text",
    text: { body: "Histórico fictício do escritório." },
  },
};

export const historyProgressOnly = {
  id: "evt_ficticio_history_0003",
  type: "whatsapp.smb.history",
  apiVersion: "v2",
  createTime: "2026-10-20T12:03:02.000Z",
  phase: 1,
  progress: 73,
};

export const businessAccountDeleted = {
  id: "evt_ficticio_waba_deleted_0001",
  type: "whatsapp.business_account.deleted",
  apiVersion: "v2",
  createTime: "2026-10-20T12:04:00.000Z",
  whatsappBusinessAccount: {
    id: FICT.wabaId,
    name: "Empresa fictícia",
    removedReason: "ACCOUNT_DISCONNECTED",
    removedInitiatedBy: "USER",
    removedTime: "2026-10-20T12:04:00.000Z",
  },
};

export const businessAccountUpdated = {
  id: "evt_ficticio_waba_updated_0001",
  type: "whatsapp.business_account.updated",
  apiVersion: "v2",
  createTime: "2026-10-20T12:04:01.000Z",
  whatsappBusinessAccount: {
    id: FICT.wabaId,
    updateEvent: "ACCOUNT_VIOLATION",
    violationType: "SPAM",
  },
};

export const phoneNumberQuality = {
  id: "evt_ficticio_phone_quality_0001",
  type: "whatsapp.phone_number.quality_updated",
  apiVersion: "v2",
  createTime: "2026-10-20T12:04:02.000Z",
  whatsappPhoneNumber: {
    id: "200000000000001",
    phoneNumber: FICT.businessPhone,
    displayPhoneNumber: "+1 202-555-0199",
    wabaId: FICT.wabaId,
    qualityRating: "YELLOW",
  },
};

export const templateReviewed = {
  id: "evt_ficticio_template_0001",
  type: "whatsapp.template.reviewed",
  apiVersion: "v2",
  createTime: "2026-10-20T12:05:00.000Z",
  whatsappTemplate: { wabaId: FICT.wabaId, name: "modelo_ficticio", language: "pt_BR", status: "APPROVED" },
};

export const agentEcho = {
  id: "evt_ficticio_agent_echo_0001",
  type: "whatsapp.echo_message.created",
  apiVersion: "v2",
  createTime: "2026-10-20T12:05:01.000Z",
  whatsappMessage: {
    id: "650000000000000000000e01",
    wabaId: FICT.wabaId,
    from: FICT.businessPhone,
    to: FICT.customerPhone,
    type: "text",
    text: { body: "eco de agente fictício" },
  },
};

export const unknownType = {
  id: "evt_ficticio_unknown_0001",
  type: "whatsapp.algum_evento_novo",
  apiVersion: "v2",
  createTime: "2026-10-20T12:06:00.000Z",
  algumObjetoNovo: { campo: "valor fictício" },
};
