/**
 * @vitest-environment node
 *
 * B3.2a — adaptador YCloud puro: assinatura sobre os bytes exatos do corpo.
 *
 * Contrato oficial (guia "Implement a webhook receiver", conferido em
 * 20/10/2026):
 *  - cabeçalho `YCloud-Signature: t=<unix em segundos>,s=<hex>`;
 *  - HMAC-SHA256 com o segredo do endpoint sobre `<t>.` + bytes brutos;
 *  - comparação em tempo constante; nunca reserializar o JSON;
 *  - tolerância de horário é política da aplicação (o exemplo usa 300 s).
 *
 * Escritos ANTES do adaptador, contra a main 7b97297.
 */
import { describe, expect, it } from "vitest";

import {
  body,
  bytes,
  FICT,
  inboundText,
  NOW_MS,
  NOW_S,
  referenceSignature,
  signedHeaders,
} from "../support/ycloud-fixtures";

const load = () => import("@/server/whatsapp/provider/ycloud");

async function adapter(options?: { signatureToleranceSeconds?: number }) {
  const { YCloudWhatsAppProvider } = await load();
  return new YCloudWhatsAppProvider(options);
}

async function verify(raw: Uint8Array, headers: Headers, opts: { secret?: string; nowMs?: number } = {}) {
  const provider = await adapter();
  return provider.verifyWebhook({ rawBody: raw, headers, secret: opts.secret ?? FICT.secret, nowMs: opts.nowMs ?? NOW_MS });
}

const RAW = bytes(body(inboundText));

describe("1. assinatura válida sobre os bytes recebidos", () => {
  it("aceita a assinatura de referência e devolve o corpo verificado", async () => {
    const result = await verify(RAW, signedHeaders(RAW));
    expect(result.ok).toBe(true);
  });

  it("é um adaptador do provedor ycloud, sem envio, consulta ou mídia nesta etapa", async () => {
    const provider = await adapter();
    expect(provider.kind).toBe("ycloud");
    expect(provider.describeCapabilities()).toEqual({
      verifyWebhook: true,
      normalizeEvents: true,
      sendText: false,
      sendTemplate: false,
      lookupMessage: false,
      fetchMedia: false,
    });
  });

  it("aceita o nome do cabeçalho em qualquer caixa (Headers do Fetch)", async () => {
    const headers = new Headers({ "ycloud-signature": `t=${NOW_S},s=${referenceSignature(RAW)}` });
    expect((await verify(RAW, headers)).ok).toBe(true);
  });

  it("aceita hexadecimal maiúsculo, como o exemplo oficial", async () => {
    const headers = new Headers({ "YCloud-Signature": `t=${NOW_S},s=${referenceSignature(RAW).toUpperCase()}` });
    expect((await verify(RAW, headers)).ok).toBe(true);
  });

  it("aceita quando alguma das assinaturas `s` confere (o exemplo oficial usa `some`)", async () => {
    const wrong = "0".repeat(64);
    const headers = new Headers({ "YCloud-Signature": `t=${NOW_S},s=${wrong},s=${referenceSignature(RAW)}` });
    expect((await verify(RAW, headers)).ok).toBe(true);
  });

  it("um corpo com espaçamento e ordem de chaves incomuns continua válido: nada é reserializado", async () => {
    const odd = bytes(
      '{ "type" :"whatsapp.inbound_message.received",\t"id":"evt_ficticio_odd_0001",' +
        '"apiVersion":"v2","createTime":"2026-10-20T12:00:00.000Z","whatsappInboundMessage":{"id":"650000000000000000000f01",' +
        '"wabaId":"100000000000001","from":"+12025550101","to":"+12025550199","type":"text","text":{"body":"ol\\u00e1"}}}   ',
    );
    const reserialized = bytes(JSON.stringify(JSON.parse(new TextDecoder().decode(odd))));
    expect(Array.from(reserialized)).not.toEqual(Array.from(odd));
    expect((await verify(odd, signedHeaders(odd))).ok).toBe(true);
    expect(await verify(reserialized, signedHeaders(odd))).toEqual({ ok: false, reason: "signature_mismatch" });
  });
});

describe("2. qualquer diferença de byte é detectada", () => {
  const headers = signedHeaders(RAW);

  it("um byte trocado", async () => {
    const altered = RAW.slice();
    altered[10] = altered[10]! ^ 0x01;
    expect(await verify(altered, headers)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("BOM acrescentado depois da assinatura", async () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...RAW]);
    expect(await verify(withBom, headers)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("LF trocado por CRLF e vice-versa", async () => {
    const lf = RAW;
    const crlf = bytes(body(inboundText).replaceAll("\n", "\r\n"));
    expect(await verify(crlf, signedHeaders(lf))).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(await verify(lf, signedHeaders(crlf))).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("byte UTF-8 inválido substituído por U+FFFD depois de decodificar", async () => {
    const invalid = new Uint8Array([...bytes('{"id":"evt_ficticio_0001","x":"'), 0xff, ...bytes('"}')]);
    const replaced = bytes(new TextDecoder().decode(invalid));
    expect(await verify(replaced, signedHeaders(invalid))).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("corpo truncado ou com sobra no fim", async () => {
    expect(await verify(RAW.slice(0, -1), headers)).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(await verify(new Uint8Array([...RAW, 0x20]), headers)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("segredo de outro endpoint", async () => {
    expect(await verify(RAW, signedHeaders(RAW, { secret: "outro-segredo-ficticio" }))).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("horário `t` trocado depois de assinar (o horário faz parte do texto assinado)", async () => {
    const headersT = new Headers({ "YCloud-Signature": `t=${NOW_S - 1},s=${referenceSignature(RAW)}` });
    expect(await verify(RAW, headersT)).toEqual({ ok: false, reason: "signature_mismatch" });
  });
});

describe("3. formato do cabeçalho", () => {
  it("sem cabeçalho", async () => {
    expect(await verify(RAW, new Headers())).toEqual({ ok: false, reason: "missing_signature" });
  });

  it.each([
    ["sem t", `s=${"a".repeat(64)}`],
    ["sem s", `t=${NOW_S}`],
    ["dois t", `t=${NOW_S},t=${NOW_S},s=${"a".repeat(64)}`],
    ["t não numérico", `t=abc,s=${"a".repeat(64)}`],
    ["t com 13 dígitos", `t=1${"0".repeat(12)},s=${"a".repeat(64)}`],
    ["t negativo", `t=-${NOW_S},s=${"a".repeat(64)}`],
    ["s curto", `t=${NOW_S},s=${"a".repeat(63)}`],
    ["s não hexadecimal", `t=${NOW_S},s=${"g".repeat(64)}`],
    ["vazio", ""],
    ["lixo", "assinatura"],
  ])("recusa cabeçalho malformado: %s", async (_name, header) => {
    const result = await verify(RAW, new Headers({ "YCloud-Signature": header }));
    expect(result.ok).toBe(false);
    if (!result.ok && header !== "") expect(result.reason).toBe("malformed_signature");
  });
});

describe("4. tolerância de horário (política da aplicação; padrão do exemplo oficial: 300 s)", () => {
  it("exporta o padrão de 300 s", async () => {
    const { YCLOUD_SIGNATURE_TOLERANCE_SECONDS } = await load();
    expect(YCLOUD_SIGNATURE_TOLERANCE_SECONDS).toBe(300);
  });

  it("aceita no limite e recusa um segundo além, para o passado e para o futuro", async () => {
    for (const delta of [-300, 300]) {
      const t = NOW_S + delta;
      expect((await verify(RAW, signedHeaders(RAW, { t }))).ok).toBe(true);
    }
    for (const delta of [-301, 301]) {
      const t = NOW_S + delta;
      expect(await verify(RAW, signedHeaders(RAW, { t }))).toEqual({ ok: false, reason: "stale_signature" });
    }
  });

  it("a tolerância é configurável dentro de um teto explícito", async () => {
    const provider = await adapter({ signatureToleranceSeconds: 3600 });
    const t = NOW_S - 3000;
    expect(provider.verifyWebhook({ rawBody: RAW, headers: signedHeaders(RAW, { t }), secret: FICT.secret, nowMs: NOW_MS }).ok).toBe(
      true,
    );
    const { YCloudWhatsAppProvider } = await load();
    for (const bad of [0, -1, 1.5, Number.NaN, 21_601]) {
      expect(() => new YCloudWhatsAppProvider({ signatureToleranceSeconds: bad })).toThrow();
    }
  });
});

describe("5. corpo, segredo e limite de tamanho", () => {
  it("recusa texto já decodificado no lugar dos bytes", async () => {
    const provider = await adapter();
    const result = provider.verifyWebhook({
      rawBody: body(inboundText) as unknown as Uint8Array,
      headers: signedHeaders(RAW),
      secret: FICT.secret,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_body" });
  });

  it("recusa segredo vazio sem calcular nada", async () => {
    expect(await verify(RAW, signedHeaders(RAW, { secret: "" }), { secret: "" })).toEqual({ ok: false, reason: "invalid_secret" });
  });

  it("recusa corpo acima do limite explícito, mesmo com assinatura válida", async () => {
    const { YCLOUD_WEBHOOK_MAX_BYTES } = await load();
    expect(YCLOUD_WEBHOOK_MAX_BYTES).toBe(256 * 1024);
    const big = new Uint8Array(YCLOUD_WEBHOOK_MAX_BYTES + 1).fill(0x20);
    expect(await verify(big, signedHeaders(big))).toEqual({ ok: false, reason: "body_too_large" });
    const atLimit = new Uint8Array(YCLOUD_WEBHOOK_MAX_BYTES).fill(0x20);
    expect((await verify(atLimit, signedHeaders(atLimit))).ok).toBe(true);
  });

  it("a cópia verificada não muda se o buffer original for alterado depois", async () => {
    const provider = await adapter();
    const raw = RAW.slice();
    const result = provider.verifyWebhook({ rawBody: raw, headers: signedHeaders(raw), secret: FICT.secret, nowMs: NOW_MS });
    expect(result.ok).toBe(true);
    raw.fill(0x20);
    const normalized = result.ok ? provider.normalizeEvents(result.verified) : null;
    expect(normalized?.ok).toBe(true);
  });
});

describe("6. nenhum segredo ou conteúdo em resposta de erro", () => {
  it("as recusas só carregam um código", async () => {
    const results = [
      await verify(RAW, new Headers()),
      await verify(RAW, new Headers({ "YCloud-Signature": "lixo" })),
      await verify(RAW, signedHeaders(RAW, { secret: "outro-segredo-ficticio" })),
      await verify(RAW, signedHeaders(RAW, { t: NOW_S - 10_000 })),
    ];
    for (const result of results) {
      expect(Object.keys(result).sort()).toEqual(["ok", "reason"]);
      const text = JSON.stringify(result);
      expect(text).not.toContain(FICT.secret);
      expect(text).not.toContain(FICT.customerPhone);
      expect(text).not.toContain(referenceSignature(RAW));
    }
  });
});
