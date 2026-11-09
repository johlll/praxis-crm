import { WHATSAPP_PROVIDER_MESSAGE_ID_PATTERN, type SendResult, type SendTemplateRequest, type SendTextRequest } from "@/server/whatsapp/provider/contract";

/**
 * Envio da YCloud (B3.3, docs/decisoes/b3-whatsapp-real.md §28.19): a ÚNICA
 * chamada HTTP de saída do CRM para a YCloud. Texto livre e template já
 * aprovado, nada mais.
 *
 * Contrato oficial usado (docs.ycloud.com, conferido em 08/11/2026):
 *  - `POST https://api.ycloud.com/v2/whatsapp/messages` ("Enqueue a message",
 *    guia "Send a WhatsApp message"): a YCloud enfileira e envia à Meta de
 *    forma assíncrona; o resultado posterior vem pelo webhook
 *    `whatsapp.message.updated`, já tratado pela B3.2d;
 *  - autenticação: cabeçalho `X-API-Key`;
 *  - corpo de texto: `{ from, to, type: "text", text: { body }, externalId }`;
 *  - corpo de template: `{ from, to, type: "template", template: { name,
 *    language: { code }, components: [{ type: "body", parameters: [{ type:
 *    "text", text }] }] }, externalId }`;
 *  - resposta 200: objeto `WhatsappMessage` (`id`, `wabaId`, `from`, `status`,
 *    `externalId`...); "accepted" quer dizer que entrou em processamento, não
 *    que o cliente recebeu;
 *  - erro: `{ "error": { "status", "code", "message", "requestId" } }`; o
 *    código legível por máquina é `code` (a `message` nunca é lida);
 *  - `externalId` é só correlação, NÃO é chave de idempotência: a YCloud
 *    avisa que repetir o POST pode duplicar a mensagem. Por isso este módulo
 *    nunca repete uma chamada.
 *
 * Regras (o resto do CRM depende delas):
 *  - UMA tentativa por intenção, sem retry no cliente HTTP, no adaptador nem
 *    em lugar nenhum; `redirect: "error"` (o cabeçalho de chave nunca segue
 *    redirecionamento); tempo limite explícito cobrindo também a leitura do
 *    corpo; corpo da resposta limitado.
 *  - `accepted` só com resposta 200 válida E identificador conferido. 2xx sem
 *    identificador, resposta inválida, `externalId`/`wabaId` divergentes, 429,
 *    5xx, 408/409/425, tempo esgotado ou conexão interrompida = `uncertain`:
 *    não dá para provar que a YCloud não recebeu.
 *  - Só um 4xx definitivo e conhecido (400, 401, 403, 404, 422...) ou um 200
 *    com `status: "failed"` vira `rejected`, com um código SANITIZADO.
 *  - Nada é registrado: nem chave, nem cabeçalhos, nem telefone, nem texto,
 *    nem a mensagem de erro do provedor. Os códigos devolvidos são fixos ou
 *    passam por uma lista estrita de caracteres.
 */

export const YCLOUD_API_BASE_URL = "https://api.ycloud.com/v2";
export const YCLOUD_SEND_URL = `${YCLOUD_API_BASE_URL}/whatsapp/messages`;
export const YCLOUD_API_KEY_HEADER = "X-API-Key";
/** Cobre a requisição e a leitura da resposta. Estourou = incerto. */
export const YCLOUD_SEND_TIMEOUT_MS = 10_000;
export const YCLOUD_SEND_RESPONSE_MAX_BYTES = 65_536;

export type YCloudFetch = (url: string, init: RequestInit) => Promise<Response>;

const API_KEY = /^[A-Za-z0-9._~+/=-]{8,512}$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const ROUTING_KEY = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63}):(\+[1-9][0-9]{7,14})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const TEMPLATE_LANGUAGE = /^[a-z]{2,3}(_[A-Z]{2})?$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const ERROR_CODE = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
/** Estados que a YCloud documenta para uma mensagem que ela aceitou. */
const ACCEPTED_STATUSES: ReadonlySet<string> = new Set(["accepted", "sent", "delivered", "read"]);
/** 4xx em que NÃO dá para afirmar que a mensagem não foi aceita. */
const AMBIGUOUS_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 409, 425, 429]);

export const YCLOUD_TEXT_MAX_LENGTH = 4096;
export const YCLOUD_TEMPLATE_PARAM_MAX = 10;
export const YCLOUD_TEMPLATE_PARAM_MAX_LENGTH = 128;

function uncertain(): SendResult {
  return { ok: false, reason: "uncertain" };
}

function rejected(errorCode: string): SendResult {
  return { ok: false, reason: "rejected", errorCode };
}

/** Correlação estável da intenção: nada de telefone nem de conteúdo. Igual ao
 * `wa_message_id` que o banco grava (`praxis.out.<outbox sem hífens>`). */
export function ycloudExternalId(correlationId: string): string | null {
  return UUID.test(correlationId) ? `praxis.out.${correlationId.toLowerCase().replaceAll("-", "")}` : null;
}

type Prepared = { apiKey: string; from: string; wabaId: string; to: string; externalId: string };

/** Tudo o que pode ser conferido ANTES da rede. `string` = código de recusa. */
function prepare(request: { routingKey: string; recipient: SendTextRequest["recipient"]; correlationId: string; credential?: string | undefined }): Prepared | string {
  const apiKey = request.credential;
  if (typeof apiKey !== "string" || !API_KEY.test(apiKey)) return "credential_unavailable";
  const routing = ROUTING_KEY.exec(request.routingKey);
  if (!routing) return "invalid_channel_state";
  const to = request.recipient.phoneE164;
  if (to === null || !E164.test(to)) return "recipient_unavailable";
  const externalId = ycloudExternalId(request.correlationId);
  if (externalId === null) return "invalid_channel_data";
  return { apiKey, wabaId: routing[1]!, from: routing[2]!, to, externalId };
}

export async function sendYCloudText(request: SendTextRequest, fetchImpl?: YCloudFetch): Promise<SendResult> {
  const prepared = prepare(request);
  if (typeof prepared === "string") return rejected(prepared);
  if (typeof request.text !== "string" || request.text.length === 0 || request.text.length > YCLOUD_TEXT_MAX_LENGTH) {
    return rejected("invalid_message_body");
  }
  return submit(prepared, { from: prepared.from, to: prepared.to, type: "text", text: { body: request.text }, externalId: prepared.externalId }, fetchImpl);
}

export async function sendYCloudTemplate(request: SendTemplateRequest, fetchImpl?: YCloudFetch): Promise<SendResult> {
  const prepared = prepare(request);
  if (typeof prepared === "string") return rejected(prepared);

  const params = request.parameters;
  const validParams =
    Array.isArray(params) &&
    params.length <= YCLOUD_TEMPLATE_PARAM_MAX &&
    params.every(
      (p) =>
        typeof p === "string" &&
        p.trim().length > 0 &&
        p.length <= YCLOUD_TEMPLATE_PARAM_MAX_LENGTH &&
        !CONTROL.test(p) &&
        !p.includes("{{") &&
        !p.includes("}}"),
    );
  if (!TEMPLATE_NAME.test(request.templateName) || !TEMPLATE_LANGUAGE.test(request.templateLanguage) || !validParams) {
    return rejected("invalid_template");
  }

  const template: Record<string, unknown> = { name: request.templateName, language: { code: request.templateLanguage } };
  if (params.length > 0) {
    template.components = [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }];
  }
  return submit(prepared, { from: prepared.from, to: prepared.to, type: "template", template, externalId: prepared.externalId }, fetchImpl);
}

// ---------------------------------------------------------------------
// A chamada única e a classificação da resposta
// ---------------------------------------------------------------------

async function submit(prepared: Prepared, payload: Record<string, unknown>, fetchImpl?: YCloudFetch): Promise<SendResult> {
  const call: YCloudFetch = fetchImpl ?? ((url, init) => fetch(url, init));

  let response: Response;
  let text: string | null;
  try {
    const signal = AbortSignal.timeout(YCLOUD_SEND_TIMEOUT_MS);
    response = await call(YCLOUD_SEND_URL, {
      method: "POST",
      headers: { [YCLOUD_API_KEY_HEADER]: prepared.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal,
      redirect: "error",
      cache: "no-store",
    });
    try {
      text = await readBounded(response, signal);
    } catch {
      text = null;
    }
  } catch {
    // Tempo esgotado, DNS, TLS, conexão interrompida, redirecionamento: a
    // YCloud pode ter recebido. Incerto, nunca repetido.
    return uncertain();
  }

  return classify(response.status, text, prepared);
}

/** Lê o corpo até o limite; estourou o limite ou o tempo = `null`. */
async function readBounded(response: Response, signal: AbortSignal): Promise<string | null> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) return null;
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > YCLOUD_SEND_RESPONSE_MAX_BYTES) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function parseJson(text: string | null): unknown {
  if (text === null || text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

/** Código de erro do provedor como código simbólico fixo; nunca a mensagem. */
function providerErrorCode(candidate: unknown, fallback: string): string {
  return typeof candidate === "string" && ERROR_CODE.test(candidate) ? `ycloud_${candidate.toLowerCase()}` : fallback;
}

function classify(status: number, text: string | null, prepared: Prepared): SendResult {
  const json = parseJson(text);

  if (status === 200) {
    // 2xx NUNCA basta: a resposta precisa trazer o identificador exigido.
    if (!isObj(json)) return uncertain();
    const id = json.id;
    if (typeof id !== "string" || !WHATSAPP_PROVIDER_MESSAGE_ID_PATTERN.test(id)) return uncertain();
    // A resposta tem de ser a DESTA intenção, na conta e no número do canal.
    if (json.externalId !== undefined && json.externalId !== null && json.externalId !== prepared.externalId) return uncertain();
    if (json.wabaId !== undefined && json.wabaId !== null && json.wabaId !== prepared.wabaId) return uncertain();
    if (json.from !== undefined && json.from !== null && json.from !== prepared.from) return uncertain();

    const state = json.status;
    if (state === "failed") return rejected(providerErrorCode(json.errorCode, "ycloud_failed"));
    if (typeof state !== "string" || !ACCEPTED_STATUSES.has(state)) return uncertain();
    return { ok: true, providerMessageId: id, state: "accepted" };
  }

  if (status >= 400 && status < 500 && !AMBIGUOUS_CLIENT_STATUSES.has(status)) {
    // Rejeição definitiva e conhecida: só o código legível por máquina.
    const error = isObj(json) && isObj(json.error) ? json.error : null;
    return rejected(providerErrorCode(error?.code, `ycloud_http_${status}`));
  }

  // 3xx, 408/409/425, 429, 5xx e qualquer outro: incerto.
  return uncertain();
}
