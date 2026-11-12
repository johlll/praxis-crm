/**
 * @vitest-environment node
 *
 * C4 — forma estática da migration e consistência SQL ↔ TypeScript:
 * forward-only, nada existente é reescrito, RLS forçada e sem grant de tabela,
 * funções fechadas, auditoria sem conteúdo de valor, tipos gerados no mesmo
 * conjunto de funções/argumentos, e a seção ligada nas quatro telas.
 * O comportamento (permissão, alcance, isolamento, tipos, atomicidade) é provado
 * no banco: supabase/tests/database/48_c4_campos_personalizados.test.sql.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), "utf8").split("\r").join("");
const sql = read("supabase/migrations/20261111120000_c4_campos_personalizados.sql");
const code = sql.replace(/--[^\n]*/g, "");
const types = read("src/server/types/database.ts");

const TABLES = ["custom_field_definitions", "custom_field_options", "custom_field_values"];
const PUBLIC_FUNCTIONS = [
  "create_custom_field",
  "update_custom_field",
  "set_custom_field_archived",
  "list_custom_field_definitions",
  "get_custom_field_values",
  "set_custom_field_values",
];
const PRIVATE_FUNCTIONS = [
  "custom_field_definition_immutable",
  "custom_field_limit",
  "custom_field_record_scope",
  "custom_field_definition_for_admin",
  "custom_field_normalize_options",
];

describe("migration da C4: forward-only e fechada", () => {
  it("só cria objetos novos: 3 tabelas, 6 RPCs, 5 funções privadas e 4 triggers próprios", () => {
    expect((code.match(/create table /g) ?? []).length).toBe(3);
    expect((code.match(/create function /g) ?? []).length).toBe(PUBLIC_FUNCTIONS.length + PRIVATE_FUNCTIONS.length);
    expect(code).not.toMatch(/create or replace/);
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/alter type/i);
    expect(code).not.toMatch(/alter table public\.(?!custom_field_)/);
    expect(code).not.toMatch(/create (unique )?index [^;]*\bon public\.(?!custom_field_)/);
    expect(code).not.toMatch(/\bcreate (type|extension|schema|role|policy)\b/i);
    const triggers = [...code.matchAll(/create trigger (\w+)\s+(before|after) ([\w ]+?) on (public\.\w+)/g)].map((m) => `${m[1]}:${m[4]}`);
    expect(triggers.sort()).toEqual(
      [
        "custom_field_definitions_immutable:public.custom_field_definitions",
        "custom_field_definitions_limit:public.custom_field_definitions",
        "custom_field_definitions_set_updated_at:public.custom_field_definitions",
        "custom_field_values_set_updated_at:public.custom_field_values",
      ].sort(),
    );
    // Nenhum DML solto fora de corpo de função (nada de seed ou backfill).
    const outside = code.replace(/\$body\$[\s\S]*?\$body\$/g, "");
    expect(outside).not.toMatch(/\b(insert|update|delete|truncate)\b\s+(into|public|from)/i);
  });

  it.each(TABLES)("%s: RLS habilitada E forçada, sem policy e sem nenhum grant", (table) => {
    expect(code).toContain(`alter table public.${table} enable row level security;`);
    expect(code).toContain(`alter table public.${table} force row level security;`);
    expect(code).toContain(`revoke all on table public.${table} from public, anon, authenticated;`);
    expect(code).not.toMatch(new RegExp(`grant[^;]*on (table )?public\\.${table}`, "i"));
  });

  it("toda função é SECURITY DEFINER com search_path vazio (o normalizador puro é só imutável)", () => {
    for (const name of [...PUBLIC_FUNCTIONS, ...PRIVATE_FUNCTIONS]) {
      const header = new RegExp(`create function (?:public|private)\\.${name}\\([\\s\\S]*?as \\$body\\$`).exec(code)?.[0] ?? "";
      expect(header, name).toContain("set search_path = ''");
      if (name !== "custom_field_normalize_options") expect(header, name).toContain("security definer");
    }
  });

  it("EXECUTE mínimo: as 6 RPCs só para authenticated; as privadas sem nenhum papel de cliente", () => {
    for (const name of PUBLIC_FUNCTIONS) {
      expect(code).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon;`));
      expect(code).toMatch(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to authenticated;`));
    }
    expect([...code.matchAll(/grant execute on function ([\w.]+)/g)].map((m) => m[1]?.replace("public.", "")).sort()).toEqual([...PUBLIC_FUNCTIONS].sort());
    for (const name of PRIVATE_FUNCTIONS) {
      expect(code).toMatch(new RegExp(`revoke all on function private\\.${name}\\([^)]*\\) from public, anon, authenticated;`));
    }
  });

  it("tipos fechados no CHECK: 4 entidades e 5 tipos, nada de JSON livre em coluna de valor", () => {
    expect(code).toContain("entity_type in ('contact', 'lead', 'opportunity', 'client')");
    expect(code).toContain("field_type in ('text', 'number', 'date', 'boolean', 'select')");
    const values = /create table public\.custom_field_values \([\s\S]*?\n\);/.exec(code)?.[0] ?? "";
    expect(values).not.toMatch(/jsonb?\b/);
    for (const column of ["value_text text", "value_number numeric(18, 4)", "value_date date", "value_boolean boolean", "option_id uuid"]) {
      expect(values).toContain(column);
    }
  });

  it("o banco prende registro, definição, workspace, entidade, tipo e opção por chaves compostas", () => {
    expect(code).toContain("foreign key (workspace_id, definition_id, entity_type, field_type)");
    expect(code).toContain("foreign key (workspace_id, definition_id, option_id)");
    for (const [column, table] of [
      ["contact_id", "contacts"],
      ["lead_id", "leads"],
      ["opportunity_id", "opportunities"],
      ["client_id", "clients"],
    ] as const) {
      expect(code).toContain(`foreign key (workspace_id, ${column}) references public.${table} (workspace_id, id)`);
    }
    expect(code).toContain("custom_field_values_record_shape");
    expect(code).toContain("custom_field_values_value_shape");
    for (const column of ["contact_id", "lead_id", "opportunity_id", "client_id"]) {
      expect(code).toContain(`on public.custom_field_values (definition_id, ${column}) where ${column} is not null`);
    }
  });

  it("limites no banco: 50 ativos por entidade (sob trava), tipo e entidade imutáveis, valor ou opção nunca apagados", () => {
    expect(code).toContain("pg_advisory_xact_lock(hashtextextended('custom_field_limit:'");
    expect(code).toMatch(/\) >= 50 then\s+raise exception 'custom_field_limit_reached'/);
    expect(code).toContain("raise exception 'custom_field_immutable'");
    expect(code).toContain("raise exception 'custom_field_option_in_use'");
    // As funções nunca apagam valores nem definições (só opções sem uso).
    expect(code).not.toMatch(/delete from public\.(custom_field_values|custom_field_definitions)/);
    expect(code).toContain("on delete restrict");
  });

  it("a gravação é uma só função (uma transação) e o alcance sai de UMA função compartilhada", () => {
    const setBody = /create function public\.set_custom_field_values[\s\S]*?\$body\$([\s\S]*?)\$body\$/.exec(code)?.[1] ?? "";
    const getBody = /create function public\.get_custom_field_values[\s\S]*?\$body\$([\s\S]*?)\$body\$/.exec(code)?.[1] ?? "";
    expect(setBody).toContain("private.custom_field_record_scope(p_entity_type, p_record_id, true)");
    expect(getBody).toContain("private.custom_field_record_scope(p_entity_type, p_record_id, false)");
    // O workspace NUNCA é parâmetro de valor: vem do registro.
    expect(/create function public\.set_custom_field_values\(([^)]*)\)/.exec(code)?.[1]).not.toMatch(/workspace/);
    expect(/create function public\.get_custom_field_values\(([^)]*)\)/.exec(code)?.[1]).not.toMatch(/workspace/);
    const scope = /create function private\.custom_field_record_scope[\s\S]*?\$body\$([\s\S]*?)\$body\$/.exec(code)?.[1] ?? "";
    expect(scope).toContain("private.lead_accessible_to_role(v_role, v_assigned, v_actor)");
    expect(scope).toContain("v_role not in ('owner', 'admin', 'manager')");
    expect(scope).toContain("v_role not in ('owner', 'admin', 'manager', 'lawyer', 'sales')");
  });

  it("auditoria: só ids e ação — nenhum insert de auditoria referencia valor, texto, opção ou nome", () => {
    const audits = [...code.matchAll(/insert into public\.audit_logs[\s\S]*?\);/g)].map((m) => m[0]);
    expect(audits).toHaveLength(5);
    for (const audit of audits) {
      expect(audit, audit).not.toMatch(/v_text|v_number|v_date|v_bool|v_option|v_raw|p_values|value_text|label|p_name|v_name|v_item/);
    }
    expect([...code.matchAll(/'(custom_field\.[a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual(
      ["custom_field.archived", "custom_field.created", "custom_field.restored", "custom_field.updated", "custom_field.value_set"].sort(),
    );
  });
});

describe("tipos gerados × migration", () => {
  const block = (name: string) =>
    new RegExp(`\\n      ${name}: \\{ Args: [^\\n]*\\}\\n`).exec(types)?.[0] ??
    new RegExp(`\\n      ${name}: \\{\\n[\\s\\S]*?\\n      \\}\\n`).exec(types)?.[0] ??
    "";
  const tableBlock = (name: string) => new RegExp(`\\n      ${name}: \\{\\n[\\s\\S]*?\\n      \\}\\n`).exec(types)?.[0] ?? "";

  it.each(PUBLIC_FUNCTIONS)("%s: os argumentos de database.ts são exatamente os parâmetros do SQL", (name) => {
    const params = /create function public\.\w+\(([\s\S]*?)\)\s*returns/.exec(code.slice(code.indexOf(`create function public.${name}(`)))?.[1] ?? "";
    const sqlParams = params
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => ({ name: /^(\w+)/.exec(p)?.[1] ?? "", optional: /\bdefault\b/i.test(p) }));
    const typed = block(name);
    expect(typed, name).not.toBe("");
    for (const param of sqlParams) {
      expect(typed, `${name}.${param.name}`).toMatch(new RegExp(`${param.name}${param.optional ? "\\?" : ""}: `));
    }
    expect((typed.match(/p_\w+\??:/g) ?? []).length).toBe(sqlParams.length);
  });

  it.each(TABLES)("%s existe em database.ts com Row, Insert e Update", (table) => {
    const typed = tableBlock(table);
    expect(typed, table).toContain("Row: {");
    expect(typed).toContain("Insert: {");
    expect(typed).toContain("Update: {");
  });

  it("nenhum enum novo foi criado: o tipo e a entidade ficam em texto com CHECK", () => {
    expect(types).not.toMatch(/custom_field_(type|entity)/);
  });
});

describe("integração nas telas existentes", () => {
  const page = (path: string) => read(path);
  const cases: Array<[string, string, string, string]> = [
    ["src/app/(app)/contatos/[id]/page.tsx", "contact", "contact.id", 'roleHasPermission(user.role, "contact.edit")'],
    ["src/app/(app)/leads/[id]/page.tsx", "lead", "lead.id", 'may("lead.edit")'],
    ["src/app/(app)/oportunidades/[id]/page.tsx", "opportunity", "opportunity.id", 'roleHasPermission(user.role, "opportunity.edit")'],
    ["src/app/(app)/clientes/[id]/page.tsx", "client", "client.id", 'roleHasPermission(user.role, "client.manage")'],
  ];

  it.each(cases)("%s mostra a seção da entidade %s com a permissão de edição dela", (path, entity, record, permission) => {
    const source = page(path);
    expect(source).toContain('import { CustomFieldsSection } from "@/components/custom-fields/custom-fields-section";');
    expect(source).toMatch(new RegExp(`<CustomFieldsSection[^>]*entity="${entity}"[^>]*recordId=\\{${record.replace(".", "\\.")}\\}`));
    expect(source).toContain(permission);
  });

  it("o detalhe do lead também mostra os campos da oportunidade principal, e só de quem edita oportunidade", () => {
    const source = page("src/app/(app)/leads/[id]/page.tsx");
    expect(source).toMatch(/entity="opportunity"\s+recordId=\{primaryOpportunity\.id\}\s+canEdit=\{canEditOpportunities\}/);
  });

  it("os componentes de campo não importam o cliente administrativo do banco nem tabelas", () => {
    for (const file of ["custom-fields-section.tsx", "custom-fields-form.tsx", "definition-dialog.tsx", "definition-list.tsx"]) {
      const source = read(`src/components/custom-fields/${file}`);
      expect(source, file).not.toMatch(/supabase\/admin|\.from\(/);
    }
    for (const file of ["queries.ts", "actions.ts"]) {
      const source = read(`src/modules/custom-fields/${file}`);
      expect(source, file).not.toMatch(/supabase\/admin|\.from\(/);
    }
  });
});
