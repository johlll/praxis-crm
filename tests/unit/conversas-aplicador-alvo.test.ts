/**
 * Conversas + IA — aplicador: alvo estável até a gravação (20261126120000). A prova de comportamento é a
 * concorrência real (scripts/aplicador-concurrency-check.sh, cenários 7 e 8); aqui, a forma da correção.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { applyStatusTrackAutomation } from "@/server/status-automation/apply";

const root = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8").split("\r").join("");
const FILE = "20261126120000_conversas_aplicador_alvo_estavel.sql";
const fix = read(`supabase/migrations/${FILE}`);
const published = read("supabase/migrations/20261125120000_conversas_aplicador_automatico.sql");
const body = (sql: string) => {
  const start = sql.search(/create (or replace )?function public\.apply_status_track_automation\(/);
  return sql.slice(sql.indexOf("$body$", start), sql.indexOf("$body$;", start));
};

describe("migration do alvo estável", () => {
  it("vem depois do aplicador publicado", () => {
    const m = readdirSync(resolve(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
    expect(m[m.indexOf(FILE) - 1]).toBe("20261125120000_conversas_aplicador_automatico.sql");
  });

  it("é a MESMA função (mesma assinatura), só com linhas acrescentadas ao corpo publicado", () => {
    expect(fix).toContain("create or replace function public.apply_status_track_automation(");
    expect(fix).not.toMatch(/\b(grant|revoke|alter table|create table|drop)\b/i);
    // A ÚNICA linha trocada: a leitura da conversa passa a travar (sem espera) dentro de um bloco.
    const READ = "  select * into v_conv from public.conversations where id = p_conversation_id and workspace_id = p_workspace_id;";
    expect(body(published).split("\n").filter((l) => l === READ)).toHaveLength(1);
    expect(body(fix)).toContain(
      "    select * into v_conv from public.conversations where id = p_conversation_id and workspace_id = p_workspace_id\n    for share nowait;",
    );
    const before = body(published).split("\n").filter((l) => l !== READ);
    const after = body(fix).split("\n");
    // Todo o corpo publicado continua, na mesma ordem (subsequência): nada removido nem alterado.
    let i = 0;
    for (const line of after) if (i < before.length && line === before[i]) i += 1;
    expect(i).toBe(before.length);
  });

  it("trava o alvo SEM espera antes de ler e antes da trava da trilha", () => {
    const b = body(fix);
    const lockAt = b.indexOf("private.status_track_lock(");
    for (const needle of [
      "for share nowait",
      "from public.contacts where id = v_conv.contact_id for update nowait",
      "order by l.id for update nowait",
      "order by o.id for share nowait",
      "pg_advisory_xact_lock(hashtextextended('praxis.aplicador.contato:'",
    ]) {
      const at = b.indexOf(needle);
      expect(at, needle).toBeGreaterThan(0);
      expect(at, needle).toBeLessThan(lockAt);
    }
    expect(b.match(/when lock_not_available then\s+raise exception 'target_busy'/g)?.length).toBe(2);
    // A resolução do caso é lida DEPOIS das travas do alvo.
    expect(b.indexOf("private.conversation_case_resolution(")).toBeGreaterThan(b.indexOf("order by o.id for share nowait"));
  });

  it("target_busy chega ao chamador como código (erro, sem gravação)", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "target_busy" } }));
    await expect(
      applyStatusTrackAutomation({ rpc } as never, {
        workspaceId: "10000000-0000-4000-8000-000000000001",
        conversationId: "20000000-0000-4000-8000-000000000002",
        change: "set_status",
        track: "attendance",
        toStatus: "aguardando_escritorio",
        expectedVersion: 0,
        evidenceMessageIds: ["40000000-0000-4000-8000-000000000001"],
        idempotencyKey: "50000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toMatchObject({ code: "target_busy" });
  });
});
