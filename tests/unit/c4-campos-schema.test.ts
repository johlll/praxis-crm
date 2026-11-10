/**
 * C4 — campos personalizados: contrato fechado do lado da aplicação. Tipos e
 * entidades são listas fixas; o formulário de definição valida nome, posição e
 * opções; a conversão de valores segue o TIPO que o banco informou; permissão
 * de administrar é só de owner/admin e a de editar valores é a da entidade.
 */
import { describe, expect, it } from "vitest";

import { AUDIT_ACTION_GROUPS } from "@/modules/audit/catalog";
import { toUserMessage } from "@/lib/errors";
import { ROLES, roleHasPermission } from "@/lib/roles";
import {
  coerceCustomFieldValue,
  customFieldDefinitionFormSchema,
  customFieldInputName,
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_TYPES,
  optionsRpcArg,
  parseOptionsField,
} from "@/modules/custom-fields/schema";

const OPT = "50000000-0000-0000-0000-000000000001";
const form = (over: Record<string, unknown> = {}) => ({
  definitionId: "",
  entity: "lead",
  name: "Fase processual",
  type: "text",
  position: "",
  options: [],
  ...over,
});

describe("listas fechadas", () => {
  it("só quatro entidades e cinco tipos (nada de texto rico, múltipla seleção, fórmula, arquivo)", () => {
    expect([...CUSTOM_FIELD_ENTITIES]).toEqual(["contact", "lead", "opportunity", "client"]);
    expect([...CUSTOM_FIELD_TYPES]).toEqual(["text", "number", "date", "boolean", "select"]);
  });

  it.each(["multiselect", "formula", "file", "rich_text", "json", "relation", "calculated"])("o tipo %s é recusado", (type) => {
    expect(customFieldDefinitionFormSchema.safeParse(form({ type })).success).toBe(false);
  });

  it.each(["proposal", "activity", "workspace", ""])("a entidade %j é recusada", (entity) => {
    expect(customFieldDefinitionFormSchema.safeParse(form({ entity })).success).toBe(false);
  });
});

describe("formulário de definição", () => {
  it("aceita campo simples e normaliza o nome e a posição", () => {
    const parsed = customFieldDefinitionFormSchema.parse(form({ name: "  Número da pasta  ", position: " 3 " }));
    expect(parsed).toMatchObject({ name: "Número da pasta", position: 3, definitionId: null, options: [] });
  });

  it("posição vazia = automática (null); fora de 0 a 1000 ou não numérica é recusada", () => {
    expect(customFieldDefinitionFormSchema.parse(form()).position).toBeNull();
    for (const position of ["-1", "1001", "abc", "1.5", "99999"]) {
      expect(customFieldDefinitionFormSchema.safeParse(form({ position })).success, position).toBe(false);
    }
  });

  it("nome em branco ou com mais de 80 caracteres é recusado", () => {
    expect(customFieldDefinitionFormSchema.safeParse(form({ name: "   " })).success).toBe(false);
    expect(customFieldDefinitionFormSchema.safeParse(form({ name: "a".repeat(81) })).success).toBe(false);
    expect(customFieldDefinitionFormSchema.safeParse(form({ name: "a".repeat(80) })).success).toBe(true);
  });

  it("seleção única exige opções, sem repetir (sem diferenciar maiúscula); outros tipos não aceitam opções", () => {
    expect(customFieldDefinitionFormSchema.safeParse(form({ type: "select", options: [] })).success).toBe(false);
    expect(
      customFieldDefinitionFormSchema.safeParse(form({ type: "select", options: [{ label: "Sim" }, { label: " sim " }] })).success,
    ).toBe(false);
    expect(customFieldDefinitionFormSchema.safeParse(form({ type: "select", options: [{ label: "Sim" }, { label: "Não" }] })).success).toBe(true);
    expect(customFieldDefinitionFormSchema.safeParse(form({ type: "text", options: [{ label: "x" }] })).success).toBe(false);
  });

  it("no máximo 30 opções e 80 caracteres por opção; a opção não aceita chave extra", () => {
    const many = Array.from({ length: 31 }, (_, i) => ({ label: `Opção ${i}` }));
    expect(customFieldDefinitionFormSchema.safeParse(form({ type: "select", options: many })).success).toBe(false);
    expect(customFieldDefinitionFormSchema.safeParse(form({ type: "select", options: [{ label: "a".repeat(81) }] })).success).toBe(false);
    expect(
      customFieldDefinitionFormSchema.safeParse(form({ type: "select", options: [{ label: "a", peso: 1 }] })).success,
    ).toBe(false);
  });

  it("opções vão para a RPC só com id (se salvas) e rótulo", () => {
    expect(optionsRpcArg([{ id: OPT, label: "Ouro" }, { label: "Prata" }])).toEqual([{ id: OPT, label: "Ouro" }, { label: "Prata" }]);
  });

  it("o campo de opções do formulário é JSON validado: lixo e tamanho exagerado viram null", () => {
    expect(parseOptionsField(null)).toEqual([]);
    expect(parseOptionsField("")).toEqual([]);
    expect(parseOptionsField('[{"label":"a"}]')).toEqual([{ label: "a" }]);
    expect(parseOptionsField("{não é json")).toBeNull();
    expect(parseOptionsField("x".repeat(20_001))).toBeNull();
    expect(parseOptionsField(new File([], "a") as unknown as FormDataEntryValue)).toBeNull();
  });
});

describe("conversão do valor pelo TIPO informado pelo banco", () => {
  it("vazio limpa o campo em qualquer tipo", () => {
    for (const type of CUSTOM_FIELD_TYPES) expect(coerceCustomFieldValue(type, "   ")).toEqual({ ok: true, value: null });
  });

  it("texto: mantém o conteúdo sem as pontas; recusa mais de 500 caracteres", () => {
    expect(coerceCustomFieldValue("text", "  olá  ")).toEqual({ ok: true, value: "olá" });
    expect(coerceCustomFieldValue("text", "x".repeat(501)).ok).toBe(false);
  });

  it("número: aceita vírgula ou ponto decimal; recusa lixo, mais de 4 casas e excesso de dígitos", () => {
    expect(coerceCustomFieldValue("number", "1234,5")).toEqual({ ok: true, value: 1234.5 });
    expect(coerceCustomFieldValue("number", "-7.25")).toEqual({ ok: true, value: -7.25 });
    expect(coerceCustomFieldValue("number", "0")).toEqual({ ok: true, value: 0 });
    for (const bad of ["abc", "1,2,3", "1.23456", "12345678901234567", "1e5", "R$ 10"]) {
      expect(coerceCustomFieldValue("number", bad).ok, bad).toBe(false);
    }
  });

  it("data: só AAAA-MM-DD", () => {
    expect(coerceCustomFieldValue("date", "2026-12-15")).toEqual({ ok: true, value: "2026-12-15" });
    for (const bad of ["15/12/2026", "2026-1-5", "hoje"]) expect(coerceCustomFieldValue("date", bad).ok, bad).toBe(false);
  });

  it("sim ou não: só true/false (falso é um valor, não 'vazio')", () => {
    expect(coerceCustomFieldValue("boolean", "true")).toEqual({ ok: true, value: true });
    expect(coerceCustomFieldValue("boolean", "false")).toEqual({ ok: true, value: false });
    expect(coerceCustomFieldValue("boolean", "sim").ok).toBe(false);
  });

  it("seleção: só identificador de opção (uuid)", () => {
    expect(coerceCustomFieldValue("select", OPT)).toEqual({ ok: true, value: OPT });
    expect(coerceCustomFieldValue("select", "Ouro").ok).toBe(false);
  });

  it("o nome do campo de formulário é derivado do id da definição", () => {
    expect(customFieldInputName(OPT)).toBe(`cf_${OPT}`);
  });
});

describe("permissões", () => {
  it("administrar definições: só owner e admin", () => {
    expect(ROLES.filter((role) => roleHasPermission(role, "custom_field.manage"))).toEqual(["owner", "admin"]);
  });

  it("não existe permissão própria para valores: valem as da entidade (nenhuma ampliação)", () => {
    // Quem edita valores de lead é quem edita lead; de cliente, quem gerencia cliente.
    expect(ROLES.filter((role) => roleHasPermission(role, "lead.edit"))).toEqual(["owner", "admin", "manager", "lawyer", "sales"]);
    expect(ROLES.filter((role) => roleHasPermission(role, "client.manage"))).toEqual(["owner", "admin", "manager"]);
  });
});

describe("mensagens e auditoria", () => {
  it.each([
    "custom_field_not_found",
    "custom_field_record_not_found",
    "custom_field_name_taken",
    "custom_field_limit_reached",
    "custom_field_archived",
    "custom_field_immutable",
    "custom_field_option_in_use",
    "custom_field_invalid_value",
    "custom_field_invalid_option",
    "custom_field_invalid_options",
  ])("o código %s tem mensagem própria (não cai no texto genérico)", (code) => {
    const message = toUserMessage({ message: code });
    expect(message).not.toBe(toUserMessage({ message: "algo_desconhecido" }));
    expect(message).not.toContain(code);
  });

  it("as cinco ações de campo personalizado estão no catálogo de auditoria", () => {
    const codes = AUDIT_ACTION_GROUPS.flatMap((group) => group.actions.map((action) => action.code));
    for (const code of ["created", "updated", "archived", "restored", "value_set"]) {
      expect(codes).toContain(`custom_field.${code}`);
    }
  });
});
