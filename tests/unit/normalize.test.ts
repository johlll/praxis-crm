import { describe, expect, it } from "vitest";

import { normalizeEmail, normalizePhoneBR } from "@/lib/normalize";

describe("normalizePhoneBR", () => {
  it("normaliza número com DDD e pontuação para E.164", () => {
    expect(normalizePhoneBR("(11) 99999-9999")).toBe("+5511999999999");
  });

  it("aceita já vindo com DDI 55", () => {
    expect(normalizePhoneBR("+55 11 99999-9999")).toBe("+5511999999999");
  });

  it("aceita só dígitos, sem pontuação", () => {
    expect(normalizePhoneBR("11999999999")).toBe("+5511999999999");
  });

  it("aceita DDI de outro país", () => {
    expect(normalizePhoneBR("+1 415 555 0100")).toBe("+14155550100");
  });

  it("devolve null para algo curto demais para ser telefone", () => {
    expect(normalizePhoneBR("123")).toBeNull();
  });

  it("devolve null para string vazia", () => {
    expect(normalizePhoneBR("")).toBeNull();
  });
});

describe("normalizeEmail", () => {
  it("normaliza para minúsculo e remove espaços nas pontas", () => {
    expect(normalizeEmail("  Contato@Exemplo.COM  ")).toBe("contato@exemplo.com");
  });

  it("rejeita e-mail sem @", () => {
    expect(normalizeEmail("naoeemail")).toBeNull();
  });

  it("rejeita e-mail sem domínio com ponto", () => {
    expect(normalizeEmail("a@b")).toBeNull();
  });
});
