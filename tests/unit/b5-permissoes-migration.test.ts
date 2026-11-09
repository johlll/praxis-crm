/**
 * @vitest-environment node
 *
 * B5 — matriz de permissões e forma da migration.
 *
 * As regras de verdade estão no banco e provadas em
 * supabase/tests/database/45_b5_auditoria_e_posse.test.sql; aqui, o que se
 * fixa sem banco: quem tem cada permissão, que a migration é aditiva e só
 * abre as duas funções a `authenticated`, e que os tipos gerados espelham as
 * assinaturas SQL (evita um ciclo de CI só para descobrir divergência).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ROLES, roleHasPermission } from "@/lib/roles";

describe("matriz de permissões da B5", () => {
  it("audit_log.view: só owner e admin", () => {
    expect(ROLES.filter((role) => roleHasPermission(role, "audit_log.view"))).toEqual(["owner", "admin"]);
  });

  it("workspace.transfer_ownership: só o proprietário (nem admin)", () => {
    expect(ROLES.filter((role) => roleHasPermission(role, "workspace.transfer_ownership"))).toEqual(["owner"]);
  });

  it("a B5 não mexeu em permissões existentes", () => {
    // Fotografia das permissões que a B5 poderia ter afetado por engano.
    expect(ROLES.filter((r) => roleHasPermission(r, "membership.manage"))).toEqual(["owner", "admin"]);
    expect(ROLES.filter((r) => roleHasPermission(r, "invitation.manage"))).toEqual(["owner", "admin"]);
    expect(ROLES.filter((r) => roleHasPermission(r, "membership.view"))).toEqual([...ROLES]);
    expect(ROLES.filter((r) => roleHasPermission(r, "workspace.rename"))).toEqual(["owner", "admin"]);
  });
});

const root = resolve(import.meta.dirname, "../..");
// A cópia de trabalho pode estar em CRLF (git autocrlf no Windows); o repositório guarda LF.
const read = (path: string) => readFileSync(resolve(root, path), "utf8").split("\r").join("");
const sql = read("supabase/migrations/20261109140000_b5_auditoria_e_posse.sql");
const parts = sql.split("$body$");
const bodies = parts.filter((_, i) => i % 2 === 1);
const outside = parts
  .filter((_, i) => i % 2 === 0)
  .join(" ")
  .replace(/--[^\n]*/g, "");
// O SQL sem comentários: os testes de GRANT olham o código, não o que os comentários dizem.
const code = sql.replace(/--[^\n]*/g, "");
const [safeDetailsBody, listBody, transferBody, updateRoleBody, removeBody] = bodies as [
  string,
  string,
  string,
  string,
  string,
];

describe("migration da B5: fechada", () => {
  it("três funções novas (um auxiliar privado e duas públicas) e a substituição das duas funções da A2, nada além disso", () => {
    expect(bodies).toHaveLength(5);
    expect((sql.match(/create function /g) ?? []).length).toBe(3);
    // Única alteração de objetos existentes: as duas funções do último owner (item 3 do cabeçalho).
    expect([...sql.matchAll(/create or replace function ([a-z_.]+)\(/g)].map((m) => m[1])).toEqual([
      "public.update_membership_role",
      "public.remove_membership",
    ]);
    expect(outside).not.toMatch(/\b(create|alter|drop)\s+(table|index|type|trigger|policy|schema|extension|constraint|view)\b/i);
    expect(outside).not.toMatch(/\b(insert|update|delete|truncate)\b/i);
    expect(outside).not.toMatch(/\balter\b/i);
  });

  it("todas travam o search_path; as públicas são SECURITY DEFINER", () => {
    expect((sql.match(/set search_path = ''/g) ?? []).length).toBe(5);
    expect(sql).toMatch(/function public\.list_audit_log\([\s\S]*?language plpgsql\s+security definer\s+stable\s+set search_path = ''/);
    expect(sql).toMatch(/function public\.transfer_workspace_ownership\([\s\S]*?language plpgsql\s+security definer\s+set search_path = ''/);
  });

  it("EXECUTE: só authenticated nas públicas; o auxiliar privado não tem grant", () => {
    const listSig = "public.list_audit_log(uuid, text, uuid, date, date, timestamptz, uuid, integer)";
    const transferSig = "public.transfer_workspace_ownership(uuid, uuid)";
    for (const sig of [listSig, transferSig]) {
      expect(sql).toContain(`revoke all on function ${sig} from public, anon;`);
      expect(sql).toContain(`grant execute on function ${sig} to authenticated;`);
    }
    expect(sql).toContain("revoke all on function private.audit_log_safe_details(jsonb) from public, anon, authenticated;");
    expect(code).not.toMatch(/grant[^;]*audit_log_safe_details/i);
    // Nada concedido a anon/public, e audit_logs continua sem grant de tabela.
    expect(code).not.toMatch(/grant\s[^;]*\bto\s+[^;]*\b(anon|public)\b/i);
    expect(code).not.toMatch(/grant\s[^;]*\bon\s+(table\s+)?(public\.)?audit_logs\b/i);
  });
});

describe("list_audit_log: somente leitura e sem metadata crua", () => {
  it("não escreve nada", () => {
    expect(listBody).not.toMatch(/\b(insert|update|delete|truncate|alter|drop|create)\b/i);
  });

  it("só owner/admin, workspace alheio = inexistente, filtros validados", () => {
    expect(listBody).toContain("private.has_workspace_role(");
    expect(listBody).toMatch(/array\['owner', 'admin'\]::public\.membership_role\[\]/);
    expect(listBody).toContain("raise exception 'insufficient_permission'");
    expect(listBody).toContain("a.workspace_id = p_workspace_id");
    for (const code of ["authentication_required", "invalid_cursor", "invalid_filter", "invalid_period"]) {
      expect(listBody).toContain(`raise exception '${code}'`);
    }
  });

  it("o item devolvido tem exatamente as chaves do contrato; metadata só entra pela lista de permissão", () => {
    const build = /jsonb_build_object\(([\s\S]*?)\)\s*order by/.exec(listBody)?.[1] ?? "";
    const keys = [...build.matchAll(/'([a-z_]+)',/g)].map((m) => m[1]);
    expect(keys).toEqual(["id", "created_at", "action", "actor_user_id", "actor_name", "target_name", "details"]);
    expect(build).toContain("private.audit_log_safe_details(s.metadata)");
    expect(build).not.toMatch(/'metadata'|s\.metadata,|resource_id|workspace_id/);
  });

  it("a lista de permissão do auxiliar é fechada", () => {
    expect(safeDetailsBody).toContain("'role', 'from_role', 'to_role', 'new_owner_previous_role', 'previous_owner_new_role'");
    expect(safeDetailsBody).toContain("kv.key = 'environment'");
    expect(safeDetailsBody).toContain("kv.key = 'provider'");
    expect(safeDetailsBody).not.toMatch(/email|name|label|token|secret|phone|body|api_key/i);
  });
});

describe("transfer_workspace_ownership: atômica e enxuta", () => {
  it("trava em ordem fixa, troca os papéis numa só instrução e grava UMA auditoria", () => {
    expect(transferBody).toMatch(/order by m\.id\s+for update/);
    expect((transferBody.match(/\bupdate public\.memberships\b/g) ?? []).length).toBe(1);
    expect((transferBody.match(/\binsert into public\.audit_logs\b/g) ?? []).length).toBe(1);
    expect(transferBody).toMatch(/'owner'::public\.membership_role[\s\S]*?'admin'::public\.membership_role/);
    expect(transferBody).toContain("where m.id in (v_current.id, v_target.id)");
  });

  it("o destinatário é procurado dentro do workspace informado", () => {
    expect(transferBody).toMatch(/where m\.id = p_target_membership_id\s+and m\.workspace_id = p_workspace_id/);
  });

  it("as recusas são códigos simbólicos", () => {
    for (const code of [
      "authentication_required",
      "insufficient_permission",
      "membership_not_found",
      "cannot_transfer_to_self",
      "membership_not_active",
      "ownership_transfer_failed",
    ]) {
      expect(transferBody).toContain(`raise exception '${code}'`);
    }
  });

  it("a auditoria carrega só ids e papéis, nunca e-mail ou nome", () => {
    const meta = /jsonb_build_object\(\s*'new_owner_user_id'([\s\S]*?)\)\s*\);/.exec(transferBody)?.[0] ?? "";
    expect(meta).toContain("'new_owner_user_id', v_target.user_id");
    expect(meta).toContain("'new_owner_previous_role', v_target.role");
    expect(meta).toContain("'previous_owner_new_role', 'admin'");
    expect(meta).not.toMatch(/email|full_name|name/i);
  });
});

describe("tipos gerados espelham as assinaturas SQL", () => {
  const types = read("src/server/types/database.ts");
  const block = (name: string) => new RegExp(`\\n      ${name}: \\{[\\s\\S]*?\\n      \\}\\n`).exec(types)?.[0] ?? "";

  it("list_audit_log: parâmetros com default são opcionais, o workspace é obrigatório", () => {
    const decl = /function public\.list_audit_log\(([\s\S]*?)\)\s*returns table/.exec(sql)?.[1] ?? "";
    const params = [...decl.matchAll(/(p_[a-z_]+)\s+[a-z]+(?:\s+default\s+[^,\n]+)?/g)].map((m) => ({
      name: m[1]!,
      optional: /default/.test(m[0]),
    }));
    expect(params.map((p) => p.name).sort()).toEqual(
      ["p_action", "p_actor_user_id", "p_before", "p_before_id", "p_from", "p_limit", "p_to", "p_workspace_id"],
    );
    const ts = block("list_audit_log");
    expect(ts).not.toBe("");
    for (const p of params) expect(ts).toContain(`${p.name}${p.optional ? "?" : ""}: `);
    expect(ts).toMatch(/Returns: \{\s+has_more: boolean\s+items: Json\s+\}\[\]/);
  });

  it("transfer_workspace_ownership", () => {
    const ts = block("transfer_workspace_ownership");
    expect(ts).toContain("Args: { p_target_membership_id: string; p_workspace_id: string }");
    expect(ts).toContain("Returns: undefined");
  });
});

describe("update_membership_role e remove_membership: o último owner sob concorrência", () => {
  // A prova de concorrência é scripts/b5-last-owner-concurrency-check.sh (sessões reais);
  // aqui se fixa a FORMA que a torna verdadeira e que nada fora dela mudou em relação à A2.
  const a2 = read("supabase/migrations/20260907120300_a2_business_functions.sql");
  const bodyOf = (src: string, fn: string) => {
    const start = src.indexOf(`function public.${fn}(`);
    const open = src.indexOf("$body$", start) + "$body$".length;
    return src.slice(open, src.indexOf("$body$", open));
  };
  const tailFrom = (body: string, marker: string) => body.slice(body.indexOf(marker));

  it("mesma assinatura, retorno e atributos da A2; CREATE OR REPLACE não mexe nos GRANTs", () => {
    expect(code).toMatch(
      /create or replace function public\.update_membership_role\(p_membership_id uuid, p_new_role public\.membership_role\)\s+returns public\.memberships\s+language plpgsql\s+security definer\s+set search_path = ''/,
    );
    expect(code).toMatch(
      /create or replace function public\.remove_membership\(p_membership_id uuid\)\s+returns void\s+language plpgsql\s+security definer\s+set search_path = ''/,
    );
    // Os mesmos atributos da A2 (a A2 é a fonte da assinatura).
    expect(a2).toMatch(/create function public\.update_membership_role\(p_membership_id uuid, p_new_role public\.membership_role\)\s+returns public\.memberships\s+language plpgsql\s+security definer\s+set search_path = ''/);
    expect(a2).toMatch(/create function public\.remove_membership\(p_membership_id uuid\)\s+returns void\s+language plpgsql\s+security definer\s+set search_path = ''/);
    // Nenhum revoke/grant sobre elas: as permissões continuam exatamente as existentes.
    expect(code).not.toMatch(/\b(grant|revoke)\b[^;]*\b(update_membership_role|remove_membership)\b/i);
  });

  it.each([
    ["update_membership_role", updateRoleBody, "cannot_demote_last_owner", /update public\.memberships\s+set role = p_new_role/],
    ["remove_membership", removeBody, "cannot_remove_last_owner", /delete from public\.memberships where id = p_membership_id;/],
  ] as const)(
    "%s: lê sem travar, recusa quem é de fora, trava o workspace inteiro em ordem de id e só então decide",
    (_name, body, lastOwnerCode, write) => {
      const where = {
        firstRead: body.search(/select m\.workspace_id into v_workspace_id from public\.memberships m where m\.id = p_membership_id;/),
        gate: body.search(/private\.has_workspace_role\(v_workspace_id, array\['owner', 'admin'\]/),
        lock: body.search(/perform 1\s+from public\.memberships m\s+where m\.workspace_id = v_workspace_id\s+order by m\.id\s+for update;/),
        reread: body.search(/select \* into v_membership from public\.memberships where id = p_membership_id;/),
        recheck: body.search(/private\.has_workspace_role\(v_membership\.workspace_id, array\['owner', 'admin'\]/),
        count: body.search(/select count\(\*\) into v_remaining_owners/),
        refuse: body.indexOf(`raise exception '${lastOwnerCode}'`),
        write: body.search(write),
        audit: body.search(/insert into public\.audit_logs/),
      };
      for (const [step, at] of Object.entries(where)) expect(at, step).toBeGreaterThanOrEqual(0);
      const order = Object.values(where);
      expect(order, "ordem dos passos").toEqual([...order].sort((a, b) => a - b));
      // Uma única trava, no workspace inteiro: nenhuma trava só na linha alvo e nenhuma leitura travada fora dela.
      expect((body.match(/for update/g) ?? []).length).toBe(1);
      expect(body).not.toMatch(/where id = p_membership_id\s+for update/);
    },
  );

  it("fora da concorrência, a decisão e os efeitos são byte a byte os da A2", () => {
    // Do ponto em que o estado já está travado e relido em diante, o texto é o da A2.
    expect(tailFrom(updateRoleBody, "  v_old_role := v_membership.role;")).toBe(
      tailFrom(bodyOf(a2, "update_membership_role"), "  v_old_role := v_membership.role;"),
    );
    expect(tailFrom(removeBody, "  if v_membership.role = 'owner' then")).toBe(
      tailFrom(bodyOf(a2, "remove_membership"), "  if v_membership.role = 'owner' then"),
    );
  });

  it("os códigos de erro são os da A2 (nenhum novo, nenhum a menos)", () => {
    const codes = (body: string) => [...new Set([...body.matchAll(/raise exception '([a-z_]+)'/g)].map((m) => m[1]))].sort();
    expect(codes(updateRoleBody)).toEqual(codes(bodyOf(a2, "update_membership_role")));
    expect(codes(removeBody)).toEqual(codes(bodyOf(a2, "remove_membership")));
    expect(codes(updateRoleBody)).toEqual(["authentication_required", "cannot_demote_last_owner", "insufficient_permission", "membership_not_found"]);
    expect(codes(removeBody)).toEqual(["authentication_required", "cannot_remove_last_owner", "insufficient_permission", "membership_not_found"]);
  });
});
