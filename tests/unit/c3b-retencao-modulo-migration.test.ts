/**
 * @vitest-environment node
 *
 * C3b — a parte pura (códigos, textos, validação do estado) e a migration lida como texto: tabela
 * fechada, RPCs só de service_role, gatilho do marco, prazo fixo de 12 meses, nada de PII em
 * auditoria, tipos gerados e catálogo de auditoria no mesmo commit. O comportamento está provado no
 * pgTAP 50 e nos scripts de concorrência e de atualização.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ANONYMIZE_CONFIRMATION,
  BLOCK_REASON_CODES,
  HOLD_REASON_CODES,
  HOLD_REASON_LABEL,
  RETENTION_MONTHS,
  describeBlockReason,
  parseRetentionStatus,
} from "@/modules/privacy/retention";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8").split("\r").join("");
const sql = read("supabase/migrations/20261113120000_c3b_retencao_anonimizacao.sql");
const code = sql.replace(/--.*$/gm, "");
const types = read("src/server/types/database.ts");
const catalog = read("src/modules/audit/catalog.ts");
const workflow = read(".github/workflows/ci.yml");

const PUBLIC_RPCS = [
  "get_privacy_retention_status(uuid, uuid, uuid)",
  "create_privacy_legal_hold(uuid, uuid, uuid, text)",
  "release_privacy_legal_hold(uuid, uuid, uuid)",
  "anonymize_privacy_contact(uuid, uuid, uuid)",
  "run_privacy_retention_batch(integer)",
];

describe("parte pura", () => {
  it("prazo fixo de 12 meses e confirmação forte", () => {
    expect(RETENTION_MONTHS).toBe(12);
    expect(ANONYMIZE_CONFIRMATION).toBe("ANONIMIZAR");
  });

  it("todo código de bloqueio e de preservação tem texto claro", () => {
    for (const reason of BLOCK_REASON_CODES) {
      const text = describeBlockReason(reason, "2027-03-10T12:00:00+00:00");
      expect(text.length).toBeGreaterThan(15);
      expect(text).not.toContain(reason);
    }
    expect(describeBlockReason("retention_period_open", "2027-03-10T12:00:00+00:00")).toContain("10/03/2027");
    expect(describeBlockReason("retention_period_open", null)).toContain("12 meses");
    expect(Object.keys(HOLD_REASON_LABEL).sort()).toEqual([...HOLD_REASON_CODES].sort());
  });

  it("os códigos do front são exatamente os que o banco usa", () => {
    for (const reason of BLOCK_REASON_CODES) expect(code).toContain(`'${reason}'`);
    for (const reason of HOLD_REASON_CODES) expect(code).toContain(`'${reason}'`);
    // E o banco não inventa código de bloqueio que a tela não conheça.
    const used = [...code.matchAll(/array_append\(v_reasons, '([a-z_]+)'\)/g)].map((m) => m[1]).sort();
    expect(used).toEqual([...BLOCK_REASON_CODES].sort());
  });

  it("o estado do banco é validado de forma estrita", () => {
    const ok = {
      state: "blocked", eligible: false, reasons: ["client_present"], lead_count: 2, archived_lead_count: 2,
      retention_due_at: null, anonymized_at: null, retention_months: 12, holds: [],
    };
    expect(parseRetentionStatus(ok).reasons).toEqual(["client_present"]);
    expect(() => parseRetentionStatus({ ...ok, reasons: ["texto livre"] })).toThrow();
    expect(() => parseRetentionStatus({ ...ok, state: "talvez" })).toThrow();
    expect(() => parseRetentionStatus({ ...ok, holds: [{ id: "x", reason_code: "porque sim", status: "active", created_at: "2026-11-11T00:00:00Z", released_at: null }] })).toThrow();
    expect(() => parseRetentionStatus(null)).toThrow();
  });
});

describe("marco da retenção", () => {
  it("coluna própria + constraint de consistência + gatilho como única fonte", () => {
    expect(code).toContain("alter table public.leads add column archived_at timestamptz;");
    expect(code).toContain("check ((status = 'arquivado') = (archived_at is not null))");
    expect(code).toContain("create trigger leads_retention_mark");
    expect(code).toContain("before insert or update on public.leads");
  });

  it("os já arquivados começam a contar na migration (now()), sem alterar updated_at", () => {
    expect(code).toContain("update public.leads set archived_at = now() where status = 'arquivado';");
    expect(code.indexOf("disable trigger leads_set_updated_at")).toBeLessThan(code.indexOf("update public.leads set archived_at = now()"));
    expect(code.indexOf("update public.leads set archived_at = now()")).toBeLessThan(code.indexOf("enable trigger leads_set_updated_at"));
    // O gatilho do marco só nasce DEPOIS do backfill (senão apagaria o que acabou de gravar).
    expect(code.indexOf("update public.leads set archived_at = now()")).toBeLessThan(code.indexOf("create trigger leads_retention_mark"));
  });

  it("prazo fixo: 12 meses numa só função, sem parâmetro de prazo em nenhuma RPC", () => {
    expect(code).toContain("select interval '12 months';");
    expect(code.match(/interval '\d+ months?'/g)).toEqual(["interval '12 months'"]);
    // Nenhuma RPC recebe prazo: só ator, workspace, ids, o código do motivo e o limite do lote.
    for (const rpc of PUBLIC_RPCS) expect(rpc.slice(rpc.indexOf("("))).toMatch(/^[(](uuid|integer|text)(, (uuid|text))*[)]$/);
    expect(code).not.toMatch(/p_(months|interval|retention|prazo)/);
  });

  it("o marco não depende de updated_at", () => {
    const assess = code.split("create function private.privacy_retention_assess")[1]!.split("$body$;")[0]!;
    expect(assess).toContain("max(archived_at)");
    expect(assess).not.toContain("updated_at");
  });
});

describe("preservação legal", () => {
  it("tabela fechada, código fechado, sem texto livre", () => {
    expect([...code.matchAll(/create table public\.([a-z_]+)/g)].map((m) => m[1])).toEqual(["privacy_legal_holds"]);
    expect(code).toContain("alter table public.privacy_legal_holds enable row level security");
    expect(code).toContain("alter table public.privacy_legal_holds force row level security");
    expect(code).toContain("revoke all on table public.privacy_legal_holds from public, anon, authenticated");
    expect(code).not.toMatch(/create policy/i);
    const table = code.split("create table public.privacy_legal_holds")[1]!.split(");")[0]!;
    const columns = [...table.matchAll(/^\s{2}([a-z_]+) (uuid|text|timestamptz)/gm)].map((m) => m[1]);
    expect(columns).toEqual(["id", "workspace_id", "contact_id", "reason_code", "status", "created_by", "created_at", "released_by", "released_at"]);
    expect(table).toContain("check (reason_code in ('judicial_process', 'legal_obligation', 'case_in_progress', 'regulatory_inquiry', 'other_legal'))");
  });
});

describe("funções", () => {
  it("todas SECURITY DEFINER com search_path vazio (as públicas e as privadas com dados)", () => {
    // 5 RPCs + assess + lock_subtree + anonymize (as SQL puras e o gatilho não são definer).
    expect(code.match(/security definer/g)).toHaveLength(8);
    expect(code.match(/set search_path = ''/g)!.length).toBeGreaterThanOrEqual(8);
  });

  it("ACL: as RPCs só executam para service_role; nada para anon, authenticated ou PUBLIC", () => {
    for (const fn of PUBLIC_RPCS) {
      expect(code).toContain(`revoke all on function public.${fn} from public, anon, authenticated;`);
      expect(code).toContain(`grant execute on function public.${fn} to service_role;`);
    }
    expect(code).not.toMatch(/grant execute on function [^;]* to (authenticated|anon|public)/);
    for (const fn of ["leads_retention_mark()", "privacy_retention_interval()", "privacy_retention_assess(uuid, uuid)", "privacy_lock_subtree(uuid, uuid)", "privacy_anonymize_contact(uuid, uuid)", "privacy_batch_count(jsonb, uuid, text)"]) {
      expect(code).toContain(`revoke all on function private.${fn} from public, anon, authenticated, service_role;`);
    }
  });

  it("ator e workspace chegam como parâmetros do servidor; nada depende de auth.uid()", () => {
    expect(code).not.toContain("auth.uid()");
    expect(code).not.toContain("auth.jwt()");
    for (const fn of ["get_privacy_retention_status", "create_privacy_legal_hold", "release_privacy_legal_hold", "anonymize_privacy_contact"]) {
      expect(code).toMatch(new RegExp(`create function public\\.${fn}\\(p_actor_user_id uuid, p_workspace_id uuid`));
    }
  });

  it("o lote é do sistema: sem ator, limitado, sem concorrência e sem retorno de conteúdo", () => {
    const batch = code.split("create function public.run_privacy_retention_batch")[1]!.split("$body$;")[0]!;
    expect(batch).not.toContain("p_actor_user_id");
    expect(batch).toContain("least(coalesce(p_limit, 50), 200)");
    expect(batch).toContain("for update of c skip locked");
    expect(batch).toContain("exception when others then");
    expect(batch).toContain("return jsonb_build_object('processed', v_processed, 'blocked', v_blocked, 'failed', v_failures);");
  });

  it("a anonimização reavalia sob trava, usa subtransação e nunca guarda a mensagem do erro", () => {
    const manual = code.split("create function public.anonymize_privacy_contact")[1]!.split("$body$;")[0]!;
    expect(manual.indexOf("for update;")).toBeLessThan(manual.indexOf("private.privacy_lock_subtree"));
    expect(manual.indexOf("private.privacy_lock_subtree")).toBeLessThan(manual.indexOf("private.privacy_retention_assess"));
    expect(manual).toContain("exception when others then");
    expect(code).not.toMatch(/sqlerrm|sqlstate|get stacked diagnostics/i);
  });

  it("a conferência final desfaz tudo se algo previsto continuar acessível", () => {
    expect(code).toContain("raise exception 'anonymization_incomplete';");
  });
});

describe("auditoria sem conteúdo", () => {
  it("eventos do módulo só carregam ids, códigos fechados e contagens", () => {
    const events = [...code.matchAll(/'(privacy\.[a-z_]+)'/g)].map((m) => m[1]);
    expect(new Set(events)).toEqual(
      new Set([
        "privacy.legal_hold_created",
        "privacy.legal_hold_released",
        "privacy.anonymization_requested",
        "privacy.anonymization_completed",
        "privacy.anonymization_refused",
        "privacy.anonymization_failed",
        "privacy.retention_processed",
      ]),
    );
    // Nenhum metadata de auditoria do módulo toca campo de conteúdo pessoal.
    const inserts = [...code.matchAll(/insert into public[.]audit_logs [(]workspace_id, actor_user_id, action, resource_type, resource_id, metadata[)]([\s\S]*?);/g)].map((m) => m[1]!);
    expect(inserts.length).toBeGreaterThanOrEqual(8);
    for (const block of inserts) expect(block).not.toMatch(/(^|[^a-z_])(name|phone|email|cpf|cnpj|body|note|address|text|summary|title|message)([^a-z_]|$)/i);
  });

  it("todas as ações novas estão no catálogo de auditoria", () => {
    for (const action of ["legal_hold_created", "legal_hold_released", "anonymization_requested", "anonymization_completed", "anonymization_refused", "anonymization_failed", "retention_processed"]) {
      expect(catalog).toContain(`"privacy.${action}"`);
    }
  });
});

describe("tipos e CI", () => {
  it("tipos gerados no mesmo commit", () => {
    expect(types).toContain("privacy_legal_holds: {");
    expect(types).toContain("archived_at: string | null");
    expect(types).toContain("anonymized_at: string | null");
    for (const fn of ["get_privacy_retention_status", "create_privacy_legal_hold", "release_privacy_legal_hold", "anonymize_privacy_contact", "run_privacy_retention_batch"]) {
      expect(types).toContain(`${fn}: {`);
    }
  });

  it("concorrência real e atualização a partir da versão anterior rodam no CI", () => {
    expect(workflow).toContain("bash scripts/c3b-retention-concurrency-check.sh");
    expect(workflow).toContain("bash scripts/check-upgrade-c3b-retencao.sh");
  });
});
