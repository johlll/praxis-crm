/**
 * @vitest-environment node
 *
 * C3a — a migration lida como texto: registro sem conteúdo, tabela fechada, RPCs
 * fechadas, leitura consistente e sem as colunas que NUNCA podem sair, somente
 * leitura nas tabelas do titular, auditoria só com ids, e tipos gerados no mesmo
 * commit. O comportamento está provado no pgTAP 49.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8").split("\r").join("");
const sql = read("supabase/migrations/20261112120000_c3a_exportacao_titular.sql");
const types = read("src/server/types/database.ts");

const code = sql.replace(/--.*$/gm, "");
const payloadFn = code.split("create function private.privacy_export_payload")[1]!.split("$body$;")[0]!;

describe("tabela de registro", () => {
  it("cria só privacy_exports, fechada: RLS forçada, nenhum grant, nenhuma policy", () => {
    expect([...code.matchAll(/create table public\.([a-z_]+)/g)].map((m) => m[1])).toEqual(["privacy_exports"]);
    expect(code).toContain("alter table public.privacy_exports enable row level security");
    expect(code).toContain("alter table public.privacy_exports force row level security");
    expect(code).toContain("revoke all on table public.privacy_exports from public, anon, authenticated");
    expect(code).not.toMatch(/create policy/i);
    expect(code).not.toMatch(/grant (select|insert|update|delete|all)[^;]* on table/i);
  });

  it("só metadados: nenhuma coluna de conteúdo e estados/códigos fechados", () => {
    const table = code.split("create table public.privacy_exports")[1]!.split(");")[0]!;
    const columns = [...table.matchAll(/^\s{2}([a-z_]+) (uuid|text|timestamptz)/gm)].map((m) => m[1]);
    expect(columns).toEqual(["id", "workspace_id", "contact_id", "requested_by", "format_version", "status", "failure_code", "requested_at", "finished_at"]);
    expect(table).toContain("check (status in ('requested', 'completed', 'failed'))");
    expect(table).toContain("check (failure_code in ('data_unavailable', 'decryption_failed', 'internal_error'))");
    expect(table).toContain("check (format_version = 'praxis_data_subject_export_v1')");
    expect(table).toContain("privacy_exports_state_shape");
  });
});

describe("funções", () => {
  it("todas SECURITY DEFINER com search_path vazio; públicas só para authenticated; a privada fechada", () => {
    expect(code.match(/security definer/g)).toHaveLength(4);
    expect(code.match(/set search_path = ''/g)).toHaveLength(4);
    for (const fn of ["request_privacy_export(uuid)", "get_privacy_export_payload(uuid)", "finish_privacy_export(uuid, text)"]) {
      expect(code).toContain(`revoke all on function public.${fn} from public, anon;`);
      expect(code).toContain(`grant execute on function public.${fn} to authenticated;`);
    }
    expect(code).toContain("revoke all on function private.privacy_export_payload(uuid, uuid) from public, anon, authenticated;");
  });

  it("a leitura é STABLE, em uma única instrução (um só instantâneo)", () => {
    expect(code).toMatch(/create function private\.privacy_export_payload[\s\S]*?language sql\s+stable\s+security definer/);
    // Um único SELECT de topo (os demais são subconsultas recuadas): WITH ... SELECT.
    expect(payloadFn.match(/^ {2}select jsonb_build_object\(/gm)).toHaveLength(1);
    expect(payloadFn).not.toMatch(/\bperform\b|\bbegin\b/i);
  });

  it("papel de owner/admin conferido na abertura e de novo na leitura; workspace vem do contato", () => {
    expect(code).toContain("if v_role not in ('owner', 'admin') then raise exception 'insufficient_permission'");
    expect(code).toContain("private.has_workspace_role(v_export.workspace_id, array['owner', 'admin']");
    expect(code).toContain("select c.workspace_id into v_workspace_id");
    expect(code).not.toMatch(/request_privacy_export\([^)]*p_workspace_id/);
  });

  it("contato mesclado = não encontrado (comportamento existente)", () => {
    expect(code).toContain("c.merged_into_contact_id is null");
    expect(payloadFn).toContain("merged_into_contact_id is null");
  });
});

describe("o que NUNCA sai", () => {
  const forbidden = [
    "bsuid_ciphertext", "bsuid_blind_index", "bsuid_key_version", "token_hash", "ip_hmac", "text_hash", "storage_path",
    "checksum_sha256", "payload_ciphertext", "payload_auth_tag", "provider_message_id", "provider_external_id",
    "client_dedupe_key", "idempotency_key", "last_error", "error_message", "link_candidate_contact_ids",
    "link_candidate_lead_ids", "cpf_cnpj_blind_index", "api_key", "webhook_secret", "answers_config_snapshot",
  ];
  it.each(forbidden)("%s não é projetado", (column) => {
    expect(payloadFn).not.toContain(column);
  });

  it("o único ciphertext que sai é o do CPF/CNPJ, em chave separada do conteúdo", () => {
    expect([...payloadFn.matchAll(/ciphertext/g)]).toHaveLength(2);
    expect(payloadFn).toContain("'_sensitive'");
    expect(code).toContain("v_payload - '_sensitive'");
  });

  it("nenhuma tabela do titular é alterada: só leitura (a escrita é o registro, a trilha sensível e a auditoria)", () => {
    expect(payloadFn).not.toMatch(/\b(insert|update|delete)\b/i);
    const writes = [...code.matchAll(/\b(insert into|update|delete from)\s+public\.([a-z_]+)/g)].map((m) => m[2]);
    expect(new Set(writes)).toEqual(new Set(["privacy_exports", "audit_logs", "sensitive_data_access"]));
  });

  it("não lê o payload bruto de inbox nem de formulário", () => {
    expect(payloadFn).not.toMatch(/whatsapp_webhook_inbox|webhook_events/);
  });
});

describe("auditoria sem conteúdo", () => {
  it("só ids, versão do formato e código fechado", () => {
    const audits = [...code.matchAll(/insert into public\.audit_logs[\s\S]*?\);/g)].map((m) => m[0]);
    expect(audits).toHaveLength(2);
    // Chaves de TODO jsonb_build_object dentro das auditorias: só ids, versão e código fechado.
    const keys = audits.flatMap((audit) =>
      [...audit.matchAll(/jsonb_build_object\(([^)]*)\)/g)].flatMap((m) => [...m[1]!.matchAll(/'([a-z_]+)'\s*,/g)].map((k) => k[1]!)),
    );
    expect(new Set(keys)).toEqual(new Set(["contact_id", "format_version", "result_code"]));
    expect(audits.join(" ")).not.toMatch(/name|email|phone|cpf|text_value|body|note/i);
    expect(code).toContain("'privacy.export_requested'");
    expect(code).toContain("'privacy.export_generated'");
    expect(code).toContain("'privacy.export_failed'");
    expect(code).toContain("jsonb_build_object('contact_id', p_contact_id, 'format_version', 'praxis_data_subject_export_v1')");
  });

  it("a leitura do CPF entra na trilha de dado sensível existente, sem o valor", () => {
    expect(code).toContain("insert into public.sensitive_data_access (workspace_id, contact_id, actor_user_id, field, reason)");
    expect(code).toContain("'cpf_cnpj', 'exportacao_titular'");
  });
});

describe("tipos gerados e catálogo", () => {
  it("tabela e RPCs aparecem nos tipos do mesmo commit", () => {
    expect(types).toContain("privacy_exports: {");
    for (const fn of ["request_privacy_export", "get_privacy_export_payload", "finish_privacy_export"]) {
      expect(types).toContain(`${fn}: {`);
    }
  });

  it("as três ações têm rótulo no catálogo de auditoria", () => {
    const catalog = read("src/modules/audit/catalog.ts");
    for (const action of ["privacy.export_requested", "privacy.export_generated", "privacy.export_failed"]) {
      expect(catalog).toContain(`"${action}"`);
    }
  });
});
