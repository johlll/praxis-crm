/**
 * @vitest-environment node
 *
 * C1 — forma da migration e consistência com o TypeScript, sem banco.
 * As regras de verdade estão provadas em
 * supabase/tests/database/47_c1_automacoes.test.sql e em
 * scripts/c1-automations-concurrency-check.sh; aqui se fixa o que não pode
 * regredir sem alguém perceber: RLS forçada, sem grants, funções fechadas,
 * listas fechadas iguais nos dois lados, nenhum efeito externo e nada de
 * dado pessoal nas leituras.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AUTOMATION_ASSIGNEE_MODES,
  AUTOMATION_ERROR_CODES,
  AUTOMATION_EXECUTION_STATES,
  AUTOMATION_MAX_ATTEMPTS,
  AUTOMATION_SIMULATION_WINDOW_DAYS,
  AUTOMATION_STATUSES,
  AUTOMATION_TRIGGERS,
} from "@/modules/automations/schema";

const root = resolve(import.meta.dirname, "../..");
// A cópia de trabalho pode estar em CRLF (git autocrlf no Windows); o repositório guarda LF.
const read = (path: string) => readFileSync(resolve(root, path), "utf8").split("\r").join("");
const sql = read("supabase/migrations/20261110120000_c1_automacoes_minimas.sql");
const code = sql.replace(/--[^\n]*/g, "");
const parts = sql.split("$body$");
const bodies = parts.filter((_, i) => i % 2 === 1);
const outside = parts
  .filter((_, i) => i % 2 === 0)
  .join(" ")
  .replace(/--[^\n]*/g, "");

/** Corpo de uma função pelo nome (a primeira definição). */
function bodyOf(name: string): string {
  const start = code.indexOf(`function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf("$body$", sql.indexOf(`function ${name}(`)) + "$body$".length;
  return sql.slice(open, sql.indexOf("$body$", open));
}

const PUBLIC_FUNCTIONS = [
  "create_automation_rule",
  "update_automation_rule",
  "simulate_automation_rule",
  "set_automation_rule_status",
  "list_automation_rules",
  "list_automation_executions",
  "process_automation_events",
  "process_automation_events_system",
];
const PRIVATE_FUNCTIONS = [
  "automation_capture_lead_created",
  "automation_capture_stage_change",
  "automation_due_at",
  "automation_assignee_problem",
  "automation_validate_rule",
  "automation_rule_workspace",
  "automation_run_execution",
  "automation_process",
];
const TABLES = ["automation_rules", "automation_events", "automation_executions"];

const listOf = (text: string) => [...text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);

describe("migration da C1: forward-only e fechada", () => {
  it("só cria objetos novos: 3 tabelas, 2 triggers, 8+8 funções; nada existente é reescrito", () => {
    expect((code.match(/create table /g) ?? []).length).toBe(3);
    expect((code.match(/create function /g) ?? []).length).toBe(PUBLIC_FUNCTIONS.length + PRIVATE_FUNCTIONS.length);
    expect(code).not.toMatch(/create or replace/);
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/alter type/i);
    expect(code).not.toMatch(/alter table public\.(?!automation_)/);
    expect(code).not.toMatch(/create (unique )?index [^;]*\bon public\.(?!automation_)/);
    // As duas únicas mexidas em tabelas existentes são os triggers de captura (AFTER INSERT).
    const triggers = [...code.matchAll(/create trigger (\w+)\s+(before|after) (\w+) on (public\.\w+)/g)].map((m) => `${m[1]}:${m[2]}:${m[3]}:${m[4]}`);
    expect(triggers.sort()).toEqual(
      [
        "automation_capture_lead_created:after:insert:public.leads",
        "automation_capture_stage_change:after:insert:public.stage_transitions",
        "automation_rules_set_updated_at:before:update:public.automation_rules",
      ].sort(),
    );
    // Nenhum DML solto fora de corpo de função (nada de seed, backfill ou dado).
    expect(outside).not.toMatch(/\b(insert|update|delete|truncate)\b\s+(into|public|from)/i);
  });

  it.each(TABLES)("%s: RLS habilitada E forçada, sem policy e sem nenhum grant", (table) => {
    expect(code).toContain(`alter table public.${table} enable row level security;`);
    expect(code).toContain(`alter table public.${table} force row level security;`);
    expect(code).toContain(`revoke all on table public.${table} from public, anon, authenticated;`);
    expect(code).not.toMatch(new RegExp(`grant[^;]*on (table )?public\\.${table}`, "i"));
  });

  it("nenhuma policy e nenhum grant de tabela em lugar nenhum", () => {
    expect(code).not.toMatch(/create policy/i);
    expect(code).not.toMatch(/grant\s[^;]*\bon\s+table\b/i);
    expect(code).not.toMatch(/grant\s[^;]*\bto\s+[^;]*\b(anon|public)\b/i);
  });

  it("todas as funções são SECURITY DEFINER com o search_path vazio", () => {
    const headers = [...code.matchAll(/create function ([\w.]+)\(([\s\S]*?)\)\s*returns ([\s\S]*?)\bas \$body\$/g)];
    expect(headers).toHaveLength(PUBLIC_FUNCTIONS.length + PRIVATE_FUNCTIONS.length);
    for (const header of headers) {
      const attributes = header[3]!;
      expect(attributes, header[1]).toMatch(/set search_path = ''/);
      // automation_due_at é SQL puro e sem dados (relógio): a única sem SECURITY DEFINER.
      if (header[1] !== "private.automation_due_at") expect(attributes, header[1]).toMatch(/security definer/);
    }
    expect((sql.match(/set search_path = ''/g) ?? []).length).toBe(PUBLIC_FUNCTIONS.length + PRIVATE_FUNCTIONS.length);
  });

  it("EXECUTE mínimo: RPCs para authenticated, rodada do sistema só service_role, privadas para ninguém", () => {
    for (const name of PUBLIC_FUNCTIONS.filter((n) => n !== "process_automation_events_system")) {
      const signature = new RegExp(`revoke all on function public\\.${name}\\(([^)]*)\\)\\s+from public, anon;\\s+grant execute on function public\\.${name}\\(\\1\\)\\s+to authenticated;`);
      expect(code, name).toMatch(signature);
    }
    expect(code).toMatch(
      /revoke all on function public\.process_automation_events_system\(integer\) from public, anon, authenticated;\s+grant execute on function public\.process_automation_events_system\(integer\) to service_role;/,
    );
    for (const name of PRIVATE_FUNCTIONS) {
      expect(code, name).toMatch(new RegExp(`revoke all on function private\\.${name}\\([^)]*\\)\\s+from public, anon, authenticated;`));
      expect(code, name).not.toMatch(new RegExp(`grant[^;]*function private\\.${name}`, "i"));
    }
    // Um único grant a service_role; os demais, só a authenticated.
    expect((code.match(/grant execute on function/g) ?? []).length).toBe(PUBLIC_FUNCTIONS.length);
    expect((code.match(/to service_role/g) ?? []).length).toBe(1);
  });
});

describe("listas fechadas iguais no banco e no TypeScript", () => {
  const checkList = (column: string) => {
    const match = new RegExp(`${column} text (?:not null )?(?:default '[a-z_]+' )?check \\(${column} in \\(([^)]*)\\)`).exec(code);
    expect(match, column).not.toBeNull();
    return listOf(match![1]!);
  };

  it("gatilhos, estados da regra, modos de responsável, estados da execução", () => {
    expect(checkList("trigger_type").sort()).toEqual([...AUTOMATION_TRIGGERS].sort());
    expect(checkList("status").sort()).toEqual([...AUTOMATION_STATUSES].sort());
    expect(checkList("action_assignee_mode").sort()).toEqual([...AUTOMATION_ASSIGNEE_MODES].sort());
    const execState = /state text not null default 'pending' check \(state in \(([^)]*)\)/.exec(code);
    expect(listOf(execState![1]!).sort()).toEqual([...AUTOMATION_EXECUTION_STATES].sort());
  });

  it("os códigos de erro gravados no banco são exatamente os que a tela sabe explicar", () => {
    const match = /error_code text check \(\s*error_code is null\s+or error_code in \(([\s\S]*?)\)\s*\)/.exec(code);
    expect(match).not.toBeNull();
    expect(listOf(match![1]!).sort()).toEqual([...AUTOMATION_ERROR_CODES].sort());
    // Todo código que o processador pode gravar está na lista.
    const written = new Set([
      ...[...bodyOf("private.automation_run_execution").matchAll(/error_code = '([a-z_]+)'/g)].map((m) => m[1]!),
      ...[...bodyOf("private.automation_run_execution").matchAll(/v_problem := '([a-z_]+)'/g)].map((m) => m[1]!),
      ...[...bodyOf("private.automation_assignee_problem").matchAll(/then '([a-z_]+)'/g)].map((m) => m[1]!),
      ...[...bodyOf("private.automation_run_execution").matchAll(/then '(rule_[a-z]+)'/g)].map((m) => m[1]!),
      ...[...bodyOf("private.automation_run_execution").matchAll(/else '(rule_[a-z]+)'/g)].map((m) => m[1]!),
    ]);
    for (const value of written) expect(AUTOMATION_ERROR_CODES as readonly string[], value).toContain(value);
    expect(written.size).toBeGreaterThanOrEqual(5);
  });

  it("limite de tentativas e janela da simulação são os mesmos nos dois lados", () => {
    expect(bodyOf("private.automation_run_execution")).toContain(`c_max_attempts constant integer := ${AUTOMATION_MAX_ATTEMPTS};`);
    expect(code).toContain(`attempt_count between 0 and ${AUTOMATION_MAX_ATTEMPTS}`);
    expect(bodyOf("public.simulate_automation_rule")).toContain(`c_window_days constant integer := ${AUTOMATION_SIMULATION_WINDOW_DAYS};`);
  });
});

describe("garantias de segurança no código das funções", () => {
  it("uma regra só fica ativa com simulação da versão atual (CHECK sem brecha de NULL)", () => {
    expect(code).toMatch(
      /check \(\s*status <> 'active'\s+or \(simulated_version is not null and simulated_version = version and activated_at is not null\)\s*\)/,
    );
    expect(bodyOf("public.set_automation_rule_status")).toMatch(/simulated_version is distinct from v_rule\.version/);
  });

  it("alterar gatilho/condição/ação sobe a versão e pausa a regra ativa", () => {
    const body = bodyOf("public.update_automation_rule");
    expect(body).toMatch(/version = case when v_changed then version \+ 1 else version end/);
    expect(body).toMatch(/status = case when v_changed and status = 'active' then 'paused' else status end/);
  });

  it("a execução confere regra ativa e versão ANTES de qualquer efeito", () => {
    const body = bodyOf("private.automation_run_execution");
    const cancelRule = body.indexOf("'rule_inactive'");
    const checkTarget = body.indexOf("'target_not_found'");
    const assignee = body.indexOf("private.automation_assignee_problem(");
    const insert = body.indexOf("insert into public.activities");
    expect(cancelRule).toBeGreaterThan(0);
    expect(cancelRule).toBeLessThan(checkTarget);
    expect(checkTarget).toBeLessThan(assignee);
    expect(assignee).toBeLessThan(insert);
    expect(body).toMatch(/v_rule\.version <> v_ex\.rule_version/);
  });

  it("evento anterior à ativação da regra nunca a dispara; reprocessar nunca duplica", () => {
    const body = bodyOf("private.automation_process");
    expect(body).toMatch(/r\.activated_at <= v_event\.occurred_at/);
    expect(body).toMatch(/on conflict \(event_id, rule_id\) do nothing/);
    expect(body).toMatch(/for update skip locked/);
    expect(code).toMatch(/constraint automation_executions_once_per_event_rule unique \(event_id, rule_id\)/);
  });

  it("a execução roda numa subtransação própria e só guarda CÓDIGOS (sqlerrm só mapeia, nunca é gravado)", () => {
    const run = bodyOf("private.automation_run_execution");
    expect(run).toMatch(/exception\s+when others then\s+--[^\n]*\n\s+v_problem := 'unexpected_error';/);
    expect(run).not.toMatch(/sqlerrm|sqlstate/i);
    const all = bodies.join("\n");
    const uses = all.match(/sqlerrm/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    expect((all.match(/case sqlerrm\s+when/g) ?? []).length).toBe(uses.length);
  });

  it("os triggers de captura só INSEREM o evento (não avaliam regra nem criam atividade)", () => {
    for (const name of ["private.automation_capture_lead_created", "private.automation_capture_stage_change"]) {
      const body = bodyOf(name);
      expect((body.match(/insert into public\.automation_events/g) ?? []).length).toBe(1);
      expect(body).not.toMatch(/insert into public\.(activities|automation_executions|audit_logs)|\bupdate\b|\bdelete\b|perform/);
      expect(body).toMatch(/r\.status = 'active'/);
    }
  });

  it("a rodada de um usuário é sempre do PRÓPRIO workspace (membro ativo); a do sistema, só service_role", () => {
    const body = bodyOf("public.process_automation_events");
    expect(body).toMatch(/private\.has_workspace_role\(\s*p_workspace_id/);
    expect(body).toContain("private.automation_process(p_workspace_id, p_limit)");
    expect(bodyOf("public.process_automation_events_system")).toContain("private.automation_process(null, p_limit)");
  });

  it("regra de outro workspace e inexistente dão o mesmo erro; gerir exige owner/admin; consultar, + manager", () => {
    const body = bodyOf("private.automation_rule_workspace");
    expect(body).toMatch(/v_workspace_id is null or not private\.has_workspace_role\([\s\S]*?raise exception 'automation_rule_not_found'/);
    expect(body).toContain("array['owner', 'admin']::public.membership_role[]");
    expect(body).toContain("array['owner', 'admin', 'manager']::public.membership_role[]");
    for (const name of ["update_automation_rule", "simulate_automation_rule", "set_automation_rule_status"]) {
      expect(bodyOf(`public.${name}`), name).toContain("private.automation_rule_workspace(p_rule_id, true)");
    }
    expect(bodyOf("public.create_automation_rule")).toMatch(/has_workspace_role\(p_workspace_id, array\['owner', 'admin'\]/);
    for (const name of ["list_automation_rules", "list_automation_executions"]) {
      expect(bodyOf(`public.${name}`), name).toMatch(/array\['owner', 'admin', 'manager'\]::public\.membership_role\[\]/);
    }
  });
});

describe("sem efeito externo e sem dado pessoal", () => {
  const EXTERNAL = /whatsapp|net\.http|http_post|http_get|pg_net|resend|send_message|pg_notify|\bnotify\b|inngest|outbox|webhook/i;
  const PERSONAL = /contacts|contact_phones|contact_emails|contact_sensitive|conversations|\bmessages\b|lead_values|\.summary|\btags\b|cpf|\bphone|\bemail/i;

  it("nenhuma função da C1 referencia envio, HTTP, notificação, outbox ou webhook", () => {
    for (const body of bodies) expect(body).not.toMatch(EXTERNAL);
  });

  it("simulação e leituras não tocam em contato, conversa, telefone, e-mail, CPF nem resumo do lead", () => {
    for (const name of ["public.simulate_automation_rule", "public.list_automation_rules", "public.list_automation_executions"]) {
      expect(bodyOf(name), name).not.toMatch(PERSONAL);
    }
  });

  it("a simulação só lê leads/transições e só escreve o carimbo na própria regra", () => {
    const body = bodyOf("public.simulate_automation_rule");
    const writes = [...body.matchAll(/\b(insert into|update|delete from)\s+(public\.\w+)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(writes).toEqual(["update public.automation_rules"]);
    expect(body).toMatch(/set simulated_version = version, simulated_at = now\(\), simulated_count = v_count/);
  });

  it("o TypeScript das automações também não faz nenhuma chamada externa", () => {
    const dirs = ["src/modules/automations", "src/components/automations"];
    const files = dirs.flatMap((dir) =>
      readdirSync(resolve(root, dir)).map((file) => `${dir}/${file}`),
    );
    files.push("src/app/api/cron/automations/route.ts", "src/app/(app)/automacoes/page.tsx");
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      expect(read(file), file).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|axios|nodemailer|resend|whatsapp|inngest|twilio|sendMessage/i);
    }
  });
});

describe("tipos gerados e chamadas do TypeScript espelham o SQL", () => {
  const types = read("src/server/types/database.ts");
  const block = (name: string) => new RegExp(`\\n      ${name}: \\{[\\s\\S]*?\\n      \\}\\n`).exec(types)?.[0] ?? "";

  it.each(PUBLIC_FUNCTIONS)("%s: parâmetros (e quais são opcionais) iguais ao SQL", (name) => {
    const declaration = new RegExp(`create function public\\.${name}\\(([\\s\\S]*?)\\)\\s*returns`).exec(code)?.[1] ?? "";
    const params = declaration
      .split(/,\s*(?=p_)/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({ name: line.split(/\s+/)[0]!, optional: /\bdefault\b/.test(line) }));
    expect(params.length).toBeGreaterThan(0);
    const ts = block(name);
    expect(ts, name).not.toBe("");
    const tsKeys = [...ts.matchAll(/(p_[a-z_]+)(\?)?:/g)].map((m) => `${m[1]}${m[2] ?? ""}`).sort();
    expect(tsKeys).toEqual(params.map((p) => `${p.name}${p.optional ? "?" : ""}`).sort());
  });

  it("as três tabelas têm tipos, com as colunas do SQL", () => {
    for (const table of TABLES) {
      const decl = new RegExp(`create table public\\.${table} \\(([\\s\\S]*?)\\n\\);`).exec(code)?.[1] ?? "";
      const columns = decl
        .split("\n")
        .map((line) => /^  ([a-z_]+) (uuid|text|integer|timestamptz|public\.lead_priority)\b/.exec(line)?.[1])
        .filter((c): c is string => Boolean(c));
      expect(columns.length).toBeGreaterThan(8);
      const row = new RegExp(`\\n      ${table}: \\{\\n        Row: \\{([\\s\\S]*?)\\n        \\}`).exec(types)?.[1] ?? "";
      expect(row, table).not.toBe("");
      expect([...row.matchAll(/\n          ([a-z_]+):/g)].map((m) => m[1]).sort()).toEqual([...columns].sort());
    }
  });

  it("toda RPC chamada no TypeScript das automações existe na migration", () => {
    const used = new Set<string>();
    for (const file of [
      "src/modules/automations/actions.ts",
      "src/modules/automations/queries.ts",
      "src/modules/automations/run.ts",
      "src/app/api/cron/automations/route.ts",
    ]) {
      for (const match of read(file).matchAll(/\.rpc\(\s*"([a-z_]+)"/g)) used.add(match[1]!);
    }
    expect([...used].sort()).toEqual([...PUBLIC_FUNCTIONS].sort());
    for (const name of used) expect(code).toContain(`create function public.${name}(`);
  });
});
