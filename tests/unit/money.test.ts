import { describe, expect, it } from "vitest";

import { parseMoneyBRToCents } from "@/lib/money";

describe("parseMoneyBRToCents", () => {
  it("converte reais e centavos com separador de milhar", () => {
    expect(parseMoneyBRToCents("5.500,00")).toBe(550000);
  });

  it("converte só reais, sem centavos", () => {
    expect(parseMoneyBRToCents("5500")).toBe(550000);
  });

  it("converte com um único dígito de centavos", () => {
    expect(parseMoneyBRToCents("10,5")).toBe(1050);
  });

  it("aceita vários separadores de milhar", () => {
    expect(parseMoneyBRToCents("1.234.567,89")).toBe(123456789);
  });

  it("nunca perde precisão em valores que dariam erro de ponto flutuante em JS", () => {
    // 0.1 + 0.2 !== 0.3 em float — a função nunca soma frações, só inteiros.
    expect(parseMoneyBRToCents("0,10")).toBe(10);
    expect(parseMoneyBRToCents("0,20")).toBe(20);
  });

  it("string vazia é 'não informado' (null), não um erro", () => {
    expect(parseMoneyBRToCents("")).toBeNull();
    expect(parseMoneyBRToCents("   ")).toBeNull();
  });

  it("formato inválido devolve undefined (erro de validação)", () => {
    expect(parseMoneyBRToCents("abc")).toBeUndefined();
    expect(parseMoneyBRToCents("5.500,999")).toBeUndefined();
    expect(parseMoneyBRToCents("-100")).toBeUndefined();
  });
});
