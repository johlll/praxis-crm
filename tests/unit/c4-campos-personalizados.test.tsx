import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RecordCustomFieldsForm } from "@/components/custom-fields/record-custom-fields-form";
import { ROLES, roleHasPermission } from "@/lib/roles";
import {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_TYPE_LABEL,
  parseOptionLines,
} from "@/modules/custom-fields/schema";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8").split("\r").join("");
const migration = read("supabase/migrations/20261110130000_c4_campos_personalizados.sql");

describe("C4 — contrato fechado", () => {
  it("suporta somente as quatro entidades e os cinco tipos aprovados", () => {
    expect(CUSTOM_FIELD_ENTITIES).toEqual(["contact", "lead", "opportunity", "client"]);
    expect(CUSTOM_FIELD_TYPES).toEqual(["short_text", "number", "date", "boolean", "single_select"]);
    expect(Object.keys(CUSTOM_FIELD_TYPE_LABEL)).toEqual([...CUSTOM_FIELD_TYPES]);
  });

  it("normaliza opções por linha sem criar JSON livre", () => {
    expect(parseOptionLines(" Indicação \n\n Evento\r\n")).toEqual(["Indicação", "Evento"]);
  });

  it("só owner e admin administram definições", () => {
    expect(ROLES.filter((role) => roleHasPermission(role, "custom_field.manage"))).toEqual(["owner", "admin"]);
  });

  it("não altera as permissões de leitura e edição das entidades", () => {
    expect(ROLES.filter((role) => roleHasPermission(role, "contact.edit"))).toEqual(["owner", "admin", "manager", "lawyer", "sales"]);
    expect(ROLES.filter((role) => roleHasPermission(role, "lead.edit"))).toEqual(["owner", "admin", "manager", "lawyer", "sales"]);
    expect(ROLES.filter((role) => roleHasPermission(role, "opportunity.edit"))).toEqual(["owner", "admin", "manager", "lawyer", "sales"]);
    expect(ROLES.filter((role) => roleHasPermission(role, "client.manage"))).toEqual(["owner", "admin", "manager"]);
  });
});

describe("C4 — migration e segurança", () => {
  it("cria exatamente as três estruturas previstas, tipadas e sem JSON de valor", () => {
    expect([...migration.matchAll(/create table public\.([a-z_]+)/g)].map((match) => match[1])).toEqual([
      "custom_field_definitions", "custom_field_options", "custom_field_values",
    ]);
    for (const column of ["text_value text", "number_value numeric", "date_value date", "boolean_value boolean", "option_id uuid"]) {
      expect(migration).toContain(column);
    }
    expect(migration).not.toMatch(/jsonb_value|value\s+jsonb/);
  });

  it("fecha RLS, acesso direto e search_path", () => {
    expect(migration.match(/enable row level security/g)).toHaveLength(3);
    expect(migration.match(/force row level security/g)).toHaveLength(3);
    expect(migration).toContain("revoke all on table public.custom_field_values from public, anon, authenticated");
    expect(migration.match(/security definer/g)?.length).toBeGreaterThanOrEqual(9);
    expect(migration.match(/set search_path = ''/g)?.length).toBeGreaterThanOrEqual(9);
  });

  it("impõe os invariantes de tipo, entidade, workspace, opção e unicidade", () => {
    expect(migration).toContain("custom_field_values_one_record_check");
    expect(migration).toContain("custom_field_values_one_value_check");
    expect(migration).toContain("custom_field_values_option_fkey");
    expect(migration).toContain("custom_field_value_guard");
    expect(migration).toContain("custom_field_values_contact_key");
    expect(migration).toContain("custom_field_values_lead_key");
    expect(migration).toContain("custom_field_values_opportunity_key");
    expect(migration).toContain("custom_field_values_client_key");
  });

  it("mantém o tipo e a entidade imutáveis e limita 50 ativos", () => {
    expect(migration).toMatch(/new\.entity_type <> old\.entity_type[\s\S]*new\.field_type <> old\.field_type/);
    expect(migration).toContain(">= 50");
    expect(migration).toContain("raise exception 'custom_field_limit_reached'");
  });

  it("salva o formulário em uma única transação e não audita conteúdo", () => {
    expect(migration).toMatch(/create function public\.set_custom_field_values[\s\S]*perform public\.set_custom_field_value/);
    const valueBody = migration.split("create function public.set_custom_field_value(")[1]?.split("$body$;")[0] ?? "";
    const audit = valueBody.slice(valueBody.lastIndexOf("insert into public.audit_logs"));
    expect(audit).not.toMatch(/text_value|number_value|date_value|boolean_value|option_id/);
    expect(audit).toContain("'definition_id'");
    expect(audit).toContain("'record_id'");
  });
});

describe("C4 — integração de interface", () => {
  it("não altera a tela quando não existe campo ativo", () => {
    const { container } = render(<RecordCustomFieldsForm entityType="contact" recordId="c4000000-0000-0000-0000-000000000001" fields={[]} canEdit />);
    expect(container).toBeEmptyDOMElement();
  });

  it("as quatro telas carregam a seção compartilhada sem redesenho", () => {
    const pages = [
      "src/app/(app)/contatos/[id]/page.tsx",
      "src/app/(app)/leads/[id]/page.tsx",
      "src/app/(app)/oportunidades/[id]/page.tsx",
      "src/app/(app)/clientes/[id]/page.tsx",
    ];
    for (const page of pages) {
      expect(read(page)).toContain("RecordCustomFieldsForm");
      expect(read(page)).toContain("getCustomFieldsForRecord");
    }
  });

  it("a tela de configuração alerta contra CPF, credenciais e segredos", () => {
    const source = read("src/components/custom-fields/custom-field-manager.tsx");
    expect(source).toContain("Não use campos personalizados para CPF, credenciais, senhas ou segredos.");
    expect(source).toContain("Arquivar este campo? Os valores existentes serão preservados.");
  });
});
