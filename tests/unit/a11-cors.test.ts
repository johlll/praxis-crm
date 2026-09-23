import { describe, expect, it } from "vitest";

import { corsPreflightHeaders, corsResponseHeaders, matchAllowedOrigin } from "@/server/ingest/cors";

/**
 * CORS estrito de /api/forms/[endpointKey] (item 3 da auditoria
 * pós-dry-run). A origem permitida é sempre a EXATA que veio no
 * cabeçalho, nunca "*", e só quando o hostname está na lista do
 * endpoint — a mesma lista usada para conferir o hostname do Turnstile.
 */
describe("matchAllowedOrigin", () => {
  it("autoriza a origem exata quando o hostname está na lista", () => {
    expect(matchAllowedOrigin("https://exemplo.test", ["exemplo.test"])).toBe("https://exemplo.test");
  });

  it("recusa hostname fora da lista", () => {
    expect(matchAllowedOrigin("https://atacante.test", ["exemplo.test"])).toBeNull();
  });

  it("comparação de hostname é case-insensitive", () => {
    expect(matchAllowedOrigin("https://EXEMPLO.test", ["exemplo.test"])).toBe("https://EXEMPLO.test");
  });

  it("sem cabeçalho Origin, não há nada a autorizar", () => {
    expect(matchAllowedOrigin(null, ["exemplo.test"])).toBeNull();
  });

  it("Origin malformado é tratado como não autorizado, nunca lança", () => {
    expect(matchAllowedOrigin("não-é-uma-url", ["exemplo.test"])).toBeNull();
  });

  it("porta ou subdomínio diferentes não colam com o hostname configurado", () => {
    expect(matchAllowedOrigin("https://outro.exemplo.test", ["exemplo.test"])).toBeNull();
  });
});

describe("cabeçalhos de CORS", () => {
  it("Access-Control-Allow-Origin é a origem EXATA, nunca curinga", () => {
    const headers = corsResponseHeaders("https://exemplo.test");
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://exemplo.test");
    expect(headers["Access-Control-Allow-Origin"]).not.toBe("*");
    expect(headers.Vary).toBe("Origin");
  });

  it("sem origem autorizada, nenhum cabeçalho de CORS é enviado", () => {
    expect(corsResponseHeaders(null)).toEqual({});
  });

  it("preflight inclui métodos e cabeçalhos permitidos além da origem", () => {
    const headers = corsPreflightHeaders("https://exemplo.test");
    expect(headers["Access-Control-Allow-Methods"]).toContain("POST");
    expect(headers["Access-Control-Allow-Methods"]).toContain("OPTIONS");
    expect(headers["Access-Control-Allow-Headers"]).toContain("Content-Type");
  });
});
