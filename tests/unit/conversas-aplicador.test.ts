/**
 * Conversas + IA — aplicador determinístico (docs/decisoes/conversas-aplicador.md).
 *
 * 1. A proposta é estrita: horário, remetente, autoridade, papel ou permissão declarados são recusados
 *    antes de chegar ao banco (a futura resposta de IA não decide fatos).
 * 2. O módulo repassa ao banco exatamente os campos da proposta e devolve só códigos.
 * 3. Erros do banco viram códigos conhecidos; resposta fora do contrato é erro.
 * 4. Checagens estáticas da migration: superfície, portão, catálogo fechado, autoria sem usuário.
 * 5. Rótulo de autoria no histórico: aplicação automática nunca aparece como pessoa da equipe.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { historyActorLabel, toHistoryActorKind } from "@/modules/status-tracks/schema";
import {
  STATUS_AUTOMATION_REFUSALS,
  StatusAutomationError,
  applyStatusTrackAutomation,
  statusAutomationProposalSchema,
} from "@/server/status-automation/apply";

const WS = "10000000-0000-4000-8000-000000000001";
const CONV = "20000000-0000-4000-8000-000000000002";
const OPP = "30000000-0000-4000-8000-000000000003";
const M1 = "40000000-0000-4000-8000-000000000004";
const M2 = "40000000-0000-4000-8000-000000000005";
const KEY = "50000000-0000-4000-8000-000000000006";
const DECISION = "60000000-0000-4000-8000-000000000007";
const EVENT = "70000000-0000-4000-8000-000000000008";

const base = {
  workspaceId: WS,
  conversationId: CONV,
  change: "set_status",
  track: "attendance",
  toStatus: "aguardando_escritorio",
  expectedVersion: 3,
  evidenceMessageIds: [M1],
  idempotencyKey: KEY,
} as const;

function client(result: { data?: unknown; error?: { message: string } | null }) {
  const rpc = vi.fn(async () => ({ data: result.data ?? null, error: result.error ?? null }));
  return { rpc } as unknown as Parameters<typeof applyStatusTrackAutomation>[0] & { rpc: typeof rpc };
}

describe("1. proposta estrita", () => {
  it("aceita a forma mínima e completa os opcionais com nulo", () => {
    const p = statusAutomationProposalSchema.parse(base);
    expect(p.opportunityId).toBeNull();
    expect(p.stepId).toBeNull();
    expect(p.extractorRef).toBeNull();
  });

  it.each([
    ["horário declarado", { occurredAt: "2026-11-24T10:00:00Z" }],
    ["horário de origem declarado", { originTimeAt: "2026-11-24T10:00:00Z" }],
    ["remetente declarado", { senderIsClient: true }],
    ["autoridade declarada", { senderAuthority: "titular" }],
    ["papel declarado", { actorRole: "owner" }],
    ["usuário declarado", { actorUserId: "20000000-0000-0000-0000-000000000001" }],
    ["permissão declarada", { permission: "case.progress_edit" }],
    ["decisão humana declarada", { manualDecidedAt: null }],
    ["texto da mensagem", { quote: "enviei os documentos" }],
  ])("recusa %s", async (_label, extra) => {
    expect(statusAutomationProposalSchema.safeParse({ ...base, ...extra }).success).toBe(false);
    const c = client({ data: null });
    await expect(applyStatusTrackAutomation(c, { ...base, ...extra })).rejects.toMatchObject({ code: "invalid_proposal" });
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["sem evidência", { evidenceMessageIds: [] }],
    ["mais de 20 evidências", { evidenceMessageIds: Array.from({ length: 21 }, (_, i) => `40000000-0000-4000-8000-${String(i).padStart(12, "0")}`) }],
    ["evidência repetida", { evidenceMessageIds: [M1, M1] }],
    ["versão negativa", { expectedVersion: -1 }],
    ["versão fracionária", { expectedVersion: 1.5 }],
    ["chave que não é uuid", { idempotencyKey: "chave" }],
    ["referência do extrator com texto livre", { extractorRef: "resposta do modelo: o cliente enviou" }],
    ["mudança fora do catálogo", { change: "mark_won" }],
    ["estado com caracteres livres", { toStatus: "Concluído!" }],
  ])("recusa %s", (_label, extra) => {
    expect(statusAutomationProposalSchema.safeParse({ ...base, ...extra }).success).toBe(false);
  });
});

describe("2. repasse ao banco", () => {
  it("envia exatamente os campos da proposta, sem acrescentar nada", async () => {
    const c = client({ data: { outcome: "applied", reason: null, decision_id: DECISION, event_source: "status_track_events", event_id: EVENT, replayed: false } });
    const r = await applyStatusTrackAutomation(c, { ...base, evidenceMessageIds: [M1, M2], extractorRef: "extrator:7" });
    expect(c.rpc).toHaveBeenCalledWith("apply_status_track_automation", {
      p_workspace_id: WS,
      p_conversation_id: CONV,
      p_change: "set_status",
      p_track: "attendance",
      p_opportunity_id: null,
      p_to_status: "aguardando_escritorio",
      p_step_id: null,
      p_expected_version: 3,
      p_evidence_message_ids: [M1, M2],
      p_idempotency_key: KEY,
      p_extractor_ref: "extrator:7",
    });
    expect(r).toEqual({ outcome: "applied", decisionId: DECISION, eventSource: "status_track_events", eventId: EVENT, replayed: false });
  });

  it("sem referência do extrator, o parâmetro não é enviado (o banco usa nulo)", async () => {
    const c = client({ data: { outcome: "refused", reason: "version_stale", decision_id: DECISION, replayed: true } });
    const r = await applyStatusTrackAutomation(c, { ...base, track: "case_progress", opportunityId: OPP, toStatus: "aguardando_documentos" });
    const args = (c.rpc.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(args).not.toHaveProperty("p_extractor_ref");
    expect(args.p_opportunity_id).toBe(OPP);
    expect(r).toEqual({ outcome: "refused", reason: "version_stale", decisionId: DECISION, replayed: true });
  });

  it.each(STATUS_AUTOMATION_REFUSALS)("recusa %s chega como código", async (reason) => {
    const c = client({ data: { outcome: "refused", reason, decision_id: DECISION, replayed: false } });
    await expect(applyStatusTrackAutomation(c, base)).resolves.toMatchObject({ outcome: "refused", reason });
  });
});

describe("3. erros", () => {
  it.each(["invalid_proposal", "automation_disabled", "target_not_found", "contact_anonymized", "idempotency_conflict"])(
    "erro %s do banco vira o mesmo código",
    async (code) => {
      const c = client({ error: { message: code } });
      await expect(applyStatusTrackAutomation(c, base)).rejects.toMatchObject({ code });
    },
  );
  it("erro desconhecido não vaza a mensagem do banco", async () => {
    const c = client({ error: { message: "relation x does not exist" } });
    const err = await applyStatusTrackAutomation(c, base).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StatusAutomationError);
    expect((err as StatusAutomationError).code).toBe("unknown");
  });
  it.each([
    ["motivo fora da lista", { outcome: "refused", reason: "porque sim", decision_id: DECISION, replayed: false }],
    ["aplicada sem evento", { outcome: "applied", reason: null, decision_id: DECISION, replayed: false }],
    ["resultado desconhecido", { outcome: "talvez", decision_id: DECISION, replayed: false }],
    ["vazio", null],
  ])("resposta fora do contrato (%s) é erro", async (_label, data) => {
    await expect(applyStatusTrackAutomation(client({ data }), base)).rejects.toMatchObject({ code: "invalid_response" });
  });
});

// ---------------------------------------------------------------------
// 4. Checagens estáticas da migration
// ---------------------------------------------------------------------

const root = resolve(__dirname, "..", "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8").split("\r").join("");
const MIGRATION_FILE = "20261125120000_conversas_aplicador_automatico.sql";
const migration = read(`supabase/migrations/${MIGRATION_FILE}`);
const sql = migration
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const applier = sql.slice(sql.indexOf("create function public.apply_status_track_automation"), sql.indexOf("comment on function public.apply_status_track_automation"));

describe("4. migration do aplicador", () => {
  it("vem logo depois da migration do horário de origem (#358), de que depende", () => {
    const migrations = readdirSync(resolve(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
    const at = migrations.indexOf(MIGRATION_FILE);
    expect(migrations[at - 1]).toBe("20261124120000_conversas_horario_origem.sql");
  });

  it("só o service_role executa; anônimo e usuário autenticado não", () => {
    expect(sql).toMatch(/revoke all on function public\.apply_status_track_automation\([^)]*\)\s+from public, anon, authenticated;/);
    expect(sql).toMatch(/grant execute on function public\.apply_status_track_automation\([^)]*\)\s+to service_role;/);
    expect(sql).not.toMatch(/grant execute on function public\.apply_status_track_automation[^;]*to (authenticated|anon|public)/);
  });

  it("o portão nasce fechado, sem função de API para abrir", () => {
    expect(sql).toContain("insert into public.status_track_automation_gate (singleton, enabled) values (true, false);");
    expect(sql).toContain("activation_ref is not null and activation_ref ~");
    expect(sql).not.toMatch(/create function public\.[a-z_]*gate/);
  });

  it("a aplicação automática nunca grava manual_decided_at nem inventa usuário", () => {
    expect(applier).not.toMatch(/manual_decided_at\s*=/);
    expect(applier).not.toMatch(/auth\.uid\(\)/);
    expect(applier).toMatch(/'automation', null, cardinality\(v_ids\), null, v_d\.id/);
    expect(sql).toContain("(actor_kind = 'user' and actor_user_id is not null and automation_decision_id is null)");
  });

  it("catálogo fechado: concluído, em análise, em execução, encerrado e conclusão de etapa não são automáticos", () => {
    const rule = sql.slice(sql.indexOf("create function private.status_track_automation_rule"), sql.indexOf("revoke all on function private.status_track_automation_rule"));
    for (const target of ["concluido", "em_analise", "em_execucao", "encerrado", "suspenso", "aguardando_terceiros", "novo"]) {
      expect(rule, target).not.toMatch(new RegExp(`p_to = '${target}'`));
    }
    expect(rule).toContain("p_to = 'documentos_recebidos' and p_from = 'aguardando_documentos'");
    expect(rule).toMatch(/documentos_recebidos[\s\S]*?array\['client_file'\]/);
    expect(applier).toContain("'step_completion_manual_only'");
    expect(applier).toContain("'commercial_manual_only'");
  });

  it("a evidência é julgada pelo veredito da #358 contra a decisão humana da trilha", () => {
    expect(applier).toContain("private.message_origin_time_evidence_verdict(m.id, v_row.manual_decided_at)");
    expect(applier).toContain("'evidence_superseded'");
  });

  it("a decisão não guarda texto: só códigos, ids e horários", () => {
    const table = sql.slice(sql.indexOf("create table public.status_track_automation_decisions"), sql.indexOf("create index status_track_automation_decisions_track_idx"));
    expect(table).not.toMatch(/body_text|\bnote\b|\bquote\b|\bsummary\b/);
    expect(table).toContain("extractor_ref text check (extractor_ref ~ '^[A-Za-z0-9._:-]{1,120}$')");
  });
});

describe("5. autoria no histórico", () => {
  it("aplicação automática tem rótulo próprio, nunca 'alguém da equipe'", () => {
    expect(historyActorLabel("automation", null)).toBe("Aplicação automática");
    expect(historyActorLabel("automation", "Ana")).toBe("Aplicação automática");
    expect(historyActorLabel("user", "Ana")).toBe("Ana");
    expect(historyActorLabel("user", null)).toBe("Alguém da equipe");
  });
  it("só 'automation' vira automação; qualquer outro valor é usuário", () => {
    expect(toHistoryActorKind("automation")).toBe("automation");
    expect(toHistoryActorKind("user")).toBe("user");
    expect(toHistoryActorKind(undefined)).toBe("user");
  });
});
