/**
 * C3a — o montador do arquivo: todas as categorias sempre presentes (com
 * "sem dados" explícito), CPF/CNPJ só quando decifrado, estrutura inesperada
 * vira falha com código fechado (nunca arquivo parcial) e o nome do arquivo
 * não carrega PII.
 */
import { describe, expect, it } from "vitest";

import {
  buildSubjectExport,
  exportFileName,
  PRIVACY_EXPORT_FAILURES,
  PRIVACY_EXPORT_FORMAT,
  PRIVACY_EXPORT_LIST_CATEGORIES,
  PrivacyExportDataError,
} from "@/modules/privacy/export-format";

const CONTACT = "c0000000-0000-0000-0000-000000000001";
const AT = new Date("2026-11-12T15:30:00.000Z");

function dataWith(over: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = { contact: { id: CONTACT, name: "Titular ALFA" } };
  for (const key of PRIVACY_EXPORT_LIST_CATEGORIES) base[key] = [];
  return { ...base, ...over };
}

describe("formato do arquivo", () => {
  it("versão, horário, titular e uma seção por categoria", () => {
    const doc = buildSubjectExport({ contactId: CONTACT, generatedAt: AT, data: dataWith(), cpfCnpj: null });
    expect(doc.format).toBe("praxis_data_subject_export_v1");
    expect(PRIVACY_EXPORT_FORMAT).toBe(doc.format);
    expect(doc.generated_at).toBe("2026-11-12T15:30:00.000Z");
    expect(doc.subject).toEqual({ contact_id: CONTACT });
    expect(Object.keys(doc.sections)).toEqual([
      "contact",
      "phones",
      "emails",
      "identifiers",
      "sensitive_data",
      ...PRIVACY_EXPORT_LIST_CATEGORIES.filter((key) => !["phones", "emails", "identifiers"].includes(key)),
    ]);
  });

  it("categoria sem dados diz isso claramente; categoria com dados traz os itens", () => {
    const doc = buildSubjectExport({
      contactId: CONTACT,
      generatedAt: AT,
      data: dataWith({ phones: [{ id: "p1", value: "+5541999990001" }] }),
      cpfCnpj: null,
    });
    expect(doc.sections.phones).toEqual({ has_data: true, items: [{ id: "p1", value: "+5541999990001" }] });
    expect(doc.sections.emails).toEqual({ has_data: false, items: [] });
    expect(doc.sections.sensitive_data).toEqual({ has_data: false, items: [] });
    expect(doc.sections.contact?.has_data).toBe(true);
  });

  it("o CPF/CNPJ decifrado entra em formato utilizável, só na seção própria", () => {
    const doc = buildSubjectExport({ contactId: CONTACT, generatedAt: AT, data: dataWith(), cpfCnpj: "12345678901" });
    expect(doc.sections.sensitive_data).toEqual({ has_data: true, items: [{ field: "cpf_cnpj", value: "12345678901" }] });
    const others = Object.entries(doc.sections).filter(([key]) => key !== "sensitive_data");
    expect(JSON.stringify(others)).not.toContain("12345678901");
  });

  it("campos personalizados e demais categorias passam sem alteração", () => {
    const custom = [{ entity_type: "contact", field: "Origem", field_type: "select", archived: false, value: "Indicação" }];
    const doc = buildSubjectExport({ contactId: CONTACT, generatedAt: AT, data: dataWith({ custom_fields: custom }), cpfCnpj: null });
    expect(doc.sections.custom_fields).toEqual({ has_data: true, items: custom });
  });
});

describe("estrutura inesperada = falha com código fechado, nunca arquivo parcial", () => {
  it.each([
    ["dados nulos", null],
    ["dados em lista", []],
    ["sem contato", dataWith({ contact: null })],
    ["contato em lista", dataWith({ contact: [] })],
    ["categoria ausente", (() => { const d = dataWith(); delete d.messages; return d; })()],
    ["categoria que não é lista", dataWith({ messages: "texto" })],
  ])("%s", (_name, data) => {
    expect.assertions(2);
    try {
      buildSubjectExport({ contactId: CONTACT, generatedAt: AT, data, cpfCnpj: null });
    } catch (error) {
      expect(error).toBeInstanceOf(PrivacyExportDataError);
      expect(PRIVACY_EXPORT_FAILURES).toContain((error as PrivacyExportDataError).code);
    }
  });
});

describe("nome do arquivo", () => {
  it("só o id do contato e a data — sem nome, e-mail ou documento", () => {
    expect(exportFileName(CONTACT, AT)).toBe(`titular-${CONTACT}-2026-11-12.json`);
  });
});
