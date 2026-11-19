/**
 * @vitest-environment node
 *
 * Painel do caso, etapa B — número interno, tipos de serviço e roteiro com marcos concluídos.
 * docs/decisoes/conversas-painel-servico.md
 *
 * Regras puras (número, estado das etapas só pelo registro, próxima etapa, textos do histórico, selo coerente),
 * modelos sugeridos (válidos, sem protocolo nem sentença nos extrajudiciais), leitura, ações (parâmetros,
 * conflito, permissão), a mesma faixa de permissões no banco e o contrato da migration.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({ rpc: rpcMock }),
}));
const guard = vi.hoisted(() => ({ requirePermissionSafe: vi.fn() }));
vi.mock("@/server/authz/safe", () => guard);
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  SERVICE_TYPE_SUGGESTIONS,
  formatCaseNumber,
  mapCaseService,
  mapCaseServiceEvent,
  mapServiceType,
  nextPendingAfter,
  serviceEventText,
  serviceProgressCounts,
  serviceStepItems,
  serviceTypeFormSchema,
  type CaseServicePlan,
  type CaseServiceEvent,
} from "@/modules/case-service/schema";
import { caseBadge, caseChipLabel, caseIdentity } from "@/modules/conversations/case-display";
import { caseHistoryExtras, compareStampDesc, stampMicros } from "@/modules/conversations/context-format";
import { roleHasPermission, ROLES, type Role } from "@/lib/roles";
import { toUserMessage } from "@/lib/errors";
import {
  applyCaseServicePlanAction,
  assignCaseNumberAction,
  completeCaseServiceStepAction,
  loadCaseServiceHistoryAction,
  reopenCaseServiceStepAction,
  saveServiceTypeAction,
  setCaseServiceCurrentStepAction,
} from "@/modules/case-service/actions";
import { getCaseService, listCaseServiceHistory } from "@/modules/case-service/queries";
import type { ConversationCaseOption } from "@/modules/status-tracks/queries";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8").split("\r").join("");
const MIGRATION = "supabase/migrations/20261121120000_conversas_painel_servico.sql";
const OPP = "0a000000-0000-4000-8000-00000000000a";
const S1 = "51000000-0000-4000-8000-000000000001";
const S2 = "51000000-0000-4000-8000-000000000002";
const S3 = "51000000-0000-4000-8000-000000000003";
const S4 = "51000000-0000-4000-8000-000000000004";
const TYPE = "7e000000-0000-4000-8000-000000000001";

function plan(over: Partial<CaseServicePlan> = {}): CaseServicePlan {
  return {
    id: "91000000-0000-4000-8000-000000000001",
    serviceTypeId: TYPE,
    serviceTypeName: "Procedimento extrajudicial",
    serviceTypeVersion: 1,
    templateName: "Procedimento extrajudicial",
    templateVersion: 1,
    templateArchived: false,
    appliedAt: "2026-11-19T12:00:00.000Z",
    appliedByName: "Ana",
    currentStepId: S3,
    hasRecords: true,
    steps: [
      { id: S1, position: 1, name: "Documentos", completedAt: "2026-11-19T13:00:00.000Z", completedByName: "Ana" },
      { id: S2, position: 2, name: "Análise", completedAt: null, completedByName: null },
      { id: S3, position: 3, name: "Elaboração", completedAt: null, completedByName: null },
      { id: S4, position: 4, name: "Registro", completedAt: null, completedByName: null },
    ],
    ...over,
  };
}

function opt(over: Partial<ConversationCaseOption> = {}): ConversationCaseOption {
  return {
    opportunityId: OPP,
    leadId: "1ead0000-0000-4000-8000-000000000001",
    legalArea: "Imobiliário",
    leadStatus: "ativo",
    status: "won",
    stageId: "5a000000-0000-4000-8000-000000000001",
    stageName: "Ganho",
    isLinked: true,
    caseProgressStatus: "em_analise",
    createdAt: "2026-11-16T12:05:00.000Z",
    caseNumber: null,
    serviceTypeName: null,
    serviceStepName: null,
    serviceStepPosition: null,
    serviceStepsTotal: null,
    serviceStepsCompleted: null,
    ...over,
  };
}

beforeEach(() => {
  rpcMock.mockReset();
  guard.requirePermissionSafe.mockReset();
  guard.requirePermissionSafe.mockResolvedValue({ ctx: { workspaceId: "10000000-0000-0000-0000-000000000001", role: "owner" } });
});

describe("número interno", () => {
  it("formato próprio do escritório, com zeros à esquerda e sem limite de dígitos", () => {
    expect(formatCaseNumber(1)).toBe("#0001");
    expect(formatCaseNumber(42)).toBe("#0042");
    expect(formatCaseNumber(12345)).toBe("#12345");
  });
  it("título 'Caso #0042' só com número gravado; sem número o assunto continua sendo o título", () => {
    expect(caseIdentity(opt({ caseNumber: 42 })).title).toBe("Caso #0042");
    expect(caseIdentity(opt({ caseNumber: 42 })).subject).toBe("Imobiliário");
    expect(caseIdentity(opt()).title).toBe("Imobiliário");
    expect(caseIdentity(opt()).number).toBeNull();
  });
  it("etiqueta da lista e do cabeçalho da conversa: número + área, ou só a área", () => {
    expect(caseChipLabel(opt({ caseNumber: 7 }))).toBe("#0007 · Imobiliário");
    expect(caseChipLabel(opt())).toBe("Imobiliário");
    expect(caseChipLabel(opt({ legalArea: null }))).toBe("Oportunidade sem área");
  });
  it("com número, o desempate artificial entre casos parecidos não é necessário", () => {
    const a = opt({ caseNumber: 1 });
    const b = opt({ opportunityId: "0b000000-0000-4000-8000-00000000000b", caseNumber: 2 });
    expect(caseIdentity(a, [a, b]).extra).toBeNull();
  });
});

describe("roteiro: estado de cada etapa só pelo registro", () => {
  it("concluída = conclusão gravada; atual = escolhida; o resto pendente (a 2, antes da atual, NÃO vira concluída)", () => {
    expect(serviceStepItems(plan()).map((s) => `${s.position}:${s.state}`)).toEqual(["1:completed", "2:pending", "3:current", "4:pending"]);
  });
  it("sem etapa atual, nada é 'atual' e nada é deduzido", () => {
    expect(serviceStepItems(plan({ currentStepId: null })).map((s) => s.state)).toEqual(["completed", "pending", "pending", "pending"]);
  });
  it("a ordem é a da posição gravada, não a da lista recebida", () => {
    const p = plan();
    expect(serviceStepItems({ ...p, steps: [...p.steps].reverse() }).map((s) => s.position)).toEqual([1, 2, 3, 4]);
  });
  it("próxima pendente depois da atual pula as concluídas (sugestão; quem decide é a pessoa)", () => {
    const p = plan({ steps: plan().steps.map((s) => (s.id === S4 ? s : s)) });
    expect(nextPendingAfter(p, S3)?.id).toBe(S4);
    const allDoneAfter = plan({ steps: plan().steps.map((s) => (s.id === S4 ? { ...s, completedAt: "2026-11-19T14:00:00.000Z" } : s)) });
    expect(nextPendingAfter(allDoneAfter, S3)).toBeNull();
    expect(nextPendingAfter(plan(), "nao-existe")).toBeNull();
  });
  it("contagens: concluídas, total e etapa atual", () => {
    expect(serviceProgressCounts(plan())).toMatchObject({ total: 4, completed: 1, current: { id: S3 } });
  });
});

describe("selo coerente: o andamento é o mesmo na lista, no cabeçalho e no painel", () => {
  it("a etapa atual entra só na frase completa (dica/leitor de tela), sem trocar o rótulo do andamento", () => {
    const b = caseBadge(opt({ serviceStepName: "Análise", serviceStepPosition: 2, serviceStepsTotal: 4 }));
    expect(b.label).toBe("Em análise");
    expect(b.full).toBe("Serviço: Em análise · etapa atual: Análise (2 de 4)");
    expect(caseBadge(opt()).full).toBe("Serviço: Em análise");
  });
});

describe("histórico", () => {
  const base: CaseServiceEvent = {
    id: "e1",
    op: "plan_applied",
    planName: "Consultoria",
    previousPlanName: null,
    stepName: null,
    stepPosition: null,
    currentBeforeName: null,
    currentAfterName: null,
    progressFrom: null,
    progressTo: null,
    toVersion: 1,
    actorName: "Ana",
    occurredAt: "2026-11-19T12:00:00.000Z",
  };
  it("cada operação com o alvo nomeado", () => {
    expect(serviceEventText({ ...base, currentAfterName: "Recebimento" })).toBe("Roteiro aplicado: Consultoria (etapa atual: Recebimento)");
    expect(serviceEventText({ ...base, op: "plan_replaced", previousPlanName: "A" })).toContain("A → Consultoria");
    expect(serviceEventText({ ...base, op: "plan_removed" })).toContain("as conclusões ficam no histórico");
    expect(serviceEventText({ ...base, op: "step_completed", stepName: "Análise", currentBeforeName: "Análise", currentAfterName: "Parecer" })).toBe(
      "Etapa concluída: “Análise” · etapa atual: Parecer",
    );
    expect(serviceEventText({ ...base, op: "step_reopened", stepName: "Análise" })).toBe("Etapa reaberta: “Análise”");
    expect(serviceEventText({ ...base, op: "current_step_set", currentAfterName: "B", currentBeforeName: "A" })).toBe("Etapa atual: B (antes: A)");
    expect(serviceEventText({ ...base, op: "current_step_cleared", currentBeforeName: "A" })).toBe("Sem etapa atual (antes: A)");
  });
  it("o número interno e o roteiro entram no Histórico com a origem; a mudança de andamento junto aparece no detalhe", () => {
    const extras = caseHistoryExtras({
      opportunityId: OPP,
      createdAt: "2026-11-01T12:00:00.000Z",
      wonAt: "2026-11-02T12:00:00.000Z",
      stageMoves: [],
      caseNumber: { number: 3, assignedVia: "manual", assignedAt: "2026-11-19T10:00:00.000Z", assignedByName: "Ana" },
      serviceEvents: [{ ...base, op: "step_reopened", stepName: "Análise", progressFrom: "concluido", progressTo: "em_execucao" }],
    });
    expect(extras.find((e) => e.tag === "Identificação")).toMatchObject({ title: "Número interno #0003 atribuído", detail: "Por atribuição manual." });
    expect(extras.find((e) => e.tag === "Roteiro do serviço")).toMatchObject({ detail: "Andamento: Concluído → Em execução", actorLabel: "Ana" });
  });
});

describe("histórico do roteiro paginado no servidor", () => {
  it("a tela ordena como o banco: microssegundos contam, empate exato pelo id decrescente", () => {
    expect(stampMicros("2026-11-18T12:00:00.123457+00:00") - stampMicros("2026-11-18T12:00:00.123456+00:00")).toBe(1);
    expect(stampMicros("2026-11-18T12:00:00.123Z")).toBe(stampMicros("2026-11-18T12:00:00.123000+00:00"));
    expect(stampMicros("2026-11-18T12:00:00Z")).toBe(Date.parse("2026-11-18T12:00:00Z") * 1000);
    const rows = [
      { id: "a", occurredAt: "2026-11-18T12:00:00.123456+00:00" },
      { id: "c", occurredAt: "2026-11-18T12:00:00.123456+00:00" },
      { id: "b", occurredAt: "2026-11-18T12:00:00.123457+00:00" },
      { id: "d", occurredAt: "2026-11-18T11:59:59.999999+00:00" },
    ];
    expect([...rows].sort(compareStampDesc).map((r) => r.id)).toEqual(["b", "c", "a", "d"]);
  });
  // Horário com microssegundos, como o Postgres devolve: o cursor volta ao banco exatamente como veio
  // (passar por Date cortaria para milissegundos e pularia ou repetiria eventos de horário igual).
  const AT = "2026-11-18T12:00:00.123456+00:00";
  const ev = (id: string, at = AT) => ({ id, op: "current_step_set", to_version: 2, occurred_at: at });
  it("primeira página: sem cursor; o cursor da próxima é o último evento, sem conversão", async () => {
    rpcMock.mockResolvedValueOnce({ data: [{ items: [ev("e3"), ev("e2")], has_more: true }], error: null });
    const page = await listCaseServiceHistory(OPP);
    expect(rpcMock).toHaveBeenCalledWith("list_case_service_history", { p_opportunity_id: OPP, p_limit: 50 });
    expect(page).toMatchObject({ hasMore: true, next: { before: AT, beforeId: "e2" } });
    expect(page!.items.map((e) => e.id)).toEqual(["e3", "e2"]);
  });
  it("página seguinte: leva o cursor (horário e id) ao banco; última página não tem cursor", async () => {
    rpcMock.mockResolvedValueOnce({ data: [{ items: [ev("e1")], has_more: false }], error: null });
    const page = await listCaseServiceHistory(OPP, { cursor: { before: AT, beforeId: "e2" } });
    expect(rpcMock).toHaveBeenCalledWith("list_case_service_history", { p_opportunity_id: OPP, p_before: AT, p_before_id: "e2", p_limit: 50 });
    expect(page).toMatchObject({ hasMore: false, next: null });
  });
  it("carregar mais: valida o pedido, devolve a página ou um erro legível; fora do alcance não vira lista vazia", async () => {
    expect(await loadCaseServiceHistoryAction({ opportunityId: "x", before: AT, beforeId: S1 })).toMatchObject({ ok: false });
    expect(await loadCaseServiceHistoryAction({ opportunityId: OPP, before: "ontem", beforeId: S1 })).toMatchObject({ ok: false });
    expect(rpcMock).not.toHaveBeenCalled();

    rpcMock.mockResolvedValueOnce({ data: [{ items: [ev(S2)], has_more: false }], error: null });
    const ok = await loadCaseServiceHistoryAction({ opportunityId: OPP, before: AT, beforeId: S1 });
    expect(rpcMock).toHaveBeenLastCalledWith("list_case_service_history", { p_opportunity_id: OPP, p_before: AT, p_before_id: S1, p_limit: 50 });
    expect(ok).toMatchObject({ ok: true, page: { hasMore: false, next: null, items: [{ id: S2 }] } });

    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "opportunity_not_found" } });
    expect(await loadCaseServiceHistoryAction({ opportunityId: OPP, before: AT, beforeId: S1 })).toEqual({ ok: false, error: "Não foi possível carregar o histórico." });
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    expect(await loadCaseServiceHistoryAction({ opportunityId: OPP, before: AT, beforeId: S1 })).toEqual({
      ok: false, error: "Não foi possível carregar o histórico. Tente de novo.",
    });
  });
});

describe("modelos sugeridos", () => {
  it("todos válidos pelo mesmo formulário do catálogo, com código próprio", () => {
    for (const s of SERVICE_TYPE_SUGGESTIONS) {
      expect(serviceTypeFormSchema.safeParse({ name: s.name, steps: [...s.steps], suggestionCode: s.code }).success).toBe(true);
      expect(s.code).toMatch(/^[a-z0-9_]{1,40}$/);
    }
    expect(new Set(SERVICE_TYPE_SUGGESTIONS.map((s) => s.code)).size).toBe(SERVICE_TYPE_SUGGESTIONS.length);
  });
  it("extrajudicial e consultivo não impõem protocolo de ação nem sentença", () => {
    for (const code of ["procedimento_extrajudicial", "consultoria_parecer", "contrato_documento"]) {
      const s = SERVICE_TYPE_SUGGESTIONS.find((x) => x.code === code)!;
      expect(s.steps.join(" ")).not.toMatch(/senten[çc]a|peti[çc][ãa]o|protocol/i);
    }
  });
  it("nenhum modelo é aplicado sozinho: nada no código chama a criação ou a aplicação fora das ações explícitas", () => {
    const files = ["src/modules/conversations/context.ts", "src/modules/case-service/queries.ts", "src/app/(app)/configuracoes/tipos-de-servico/page.tsx"];
    for (const f of files) expect(read(f)).not.toMatch(/create_service_type|apply_case_service_plan/);
  });
  it("o formulário recusa etapas repetidas, vazias ou acima do limite", () => {
    expect(serviceTypeFormSchema.safeParse({ name: "X", steps: ["A", "a"] }).success).toBe(false);
    expect(serviceTypeFormSchema.safeParse({ name: "X", steps: ["  "] }).success).toBe(false);
    expect(serviceTypeFormSchema.safeParse({ name: "X", steps: Array.from({ length: 31 }, (_, i) => `E${i}`) }).success).toBe(false);
    expect(serviceTypeFormSchema.safeParse({ name: "  ", steps: ["A"] }).success).toBe(false);
  });
});

describe("leitura", () => {
  it("caso antigo: sem número, sem roteiro, andamento como gravado", async () => {
    rpcMock.mockResolvedValueOnce({
      data: { opportunity_id: OPP, opportunity_status: "won", applicable: true, case_number: null, version: 2, status: "aguardando_documentos", automation_paused: false, manual_decided_at: null, plan: null, previous_plans: 0 },
      error: null,
    });
    const s = await getCaseService(OPP);
    expect(rpcMock).toHaveBeenCalledWith("get_case_service", { p_opportunity_id: OPP });
    expect(s).toMatchObject({ caseNumber: null, plan: null, status: "aguardando_documentos", version: 2 });
  });
  it("fora do alcance é ausência (null), falha de verdade sobe", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "opportunity_not_found" } });
    expect(await getCaseService(OPP)).toBeNull();
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await expect(getCaseService(OPP)).rejects.toThrow();
  });
  it("mapeadores do roteiro, do catálogo e do histórico", () => {
    const s = mapCaseService({
      opportunity_id: OPP, opportunity_status: "won", applicable: true, version: 5, status: "em_execucao",
      case_number: { number: 9, assigned_via: "win", assigned_at: "2026-11-19T10:00:00Z", assigned_by_name: null },
      plan: { id: "p", service_type_id: TYPE, service_type_name: "T", service_type_version: 1, template_name: "T", template_version: 2, template_archived: false,
        applied_at: "x", applied_by_name: "Ana", current_step_id: S2, has_records: true,
        steps: [{ id: S2, position: 1, name: "A", completed_at: null, completed_by_name: null }] },
      previous_plans: 1,
    });
    expect(s.caseNumber).toEqual({ number: 9, assignedVia: "win", assignedAt: "2026-11-19T10:00:00Z", assignedByName: null });
    expect(s.plan).toMatchObject({ templateVersion: 2, serviceTypeVersion: 1, currentStepId: S2, hasRecords: true });
    expect(mapServiceType({ id: TYPE, name: "T", version: 3, archived: false, steps: [{ position: 1, name: "A" }], active_cases: 2 })).toMatchObject({ activeCases: 2, steps: [{ position: 1, name: "A" }] });
    expect(mapCaseServiceEvent({ id: "e", op: "step_completed", step_name: "A", to_version: 4, occurred_at: "x" })).toMatchObject({ op: "step_completed", stepName: "A", toVersion: 4 });
  });
});

describe("ações", () => {
  it("aplicar leva versão, etapa inicial explícita e chave; trocar leva a confirmação dos registros", async () => {
    rpcMock.mockResolvedValue({ data: { replayed: false, version: 3 }, error: null });
    const key = "a0000000-0000-4000-8000-000000000001";
    await applyCaseServicePlanAction({ opportunityId: OPP, serviceTypeId: TYPE, expectedVersion: 2, currentStepPosition: 1, idempotencyKey: key }, "apply");
    expect(rpcMock).toHaveBeenLastCalledWith("apply_case_service_plan", {
      p_opportunity_id: OPP, p_service_type_id: TYPE, p_expected_version: 2, p_current_step_position: 1, p_idempotency_key: key,
    });
    await applyCaseServicePlanAction({ opportunityId: OPP, serviceTypeId: TYPE, expectedVersion: 3, acknowledgeRecords: true }, "replace");
    expect(rpcMock).toHaveBeenLastCalledWith("replace_case_service_plan", {
      p_opportunity_id: OPP, p_service_type_id: TYPE, p_expected_version: 3, p_acknowledge_records: true,
    });
  });
  it("concluir e avançar: a próxima etapa atual vai explícita; reabrir em caso concluído leva o novo andamento", async () => {
    rpcMock.mockResolvedValue({ data: { replayed: false, version: 4 }, error: null });
    await completeCaseServiceStepAction({ opportunityId: OPP, stepId: S3, expectedVersion: 3, nextCurrentStepId: S4 });
    expect(rpcMock).toHaveBeenLastCalledWith("complete_case_service_step", { p_opportunity_id: OPP, p_step_id: S3, p_expected_version: 3, p_next_current_step_id: S4 });
    await reopenCaseServiceStepAction({ opportunityId: OPP, stepId: S1, expectedVersion: 4, makeCurrent: true, progressStatus: "em_execucao" });
    expect(rpcMock).toHaveBeenLastCalledWith("reopen_case_service_step", {
      p_opportunity_id: OPP, p_step_id: S1, p_expected_version: 4, p_make_current: true, p_progress_status: "em_execucao",
    });
    const bad = await reopenCaseServiceStepAction({ opportunityId: OPP, stepId: S1, expectedVersion: 4, progressStatus: "concluido" });
    expect(bad.ok).toBe(false);
  });
  it("conflito de versão é sinalizado (a tela pede para atualizar, nunca repete à força)", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "track_conflict" } });
    const r = await setCaseServiceCurrentStepAction({ opportunityId: OPP, stepId: S2, expectedVersion: 1 });
    expect(r).toMatchObject({ ok: false, conflict: true });
  });
  it("repetição pela chave volta como 'nada mudou'", async () => {
    rpcMock.mockResolvedValue({ data: { replayed: true, version: 4 }, error: null });
    const r = await completeCaseServiceStepAction({ opportunityId: OPP, stepId: S3, expectedVersion: 3 });
    expect(r).toEqual({ ok: true, result: { replayed: true, version: 4 } });
  });
  it("sem permissão não chega ao banco; cada ação usa a sua permissão", async () => {
    guard.requirePermissionSafe.mockResolvedValue({ error: "Você não tem permissão para fazer isso." });
    expect((await assignCaseNumberAction({ opportunityId: OPP })).ok).toBe(false);
    expect((await completeCaseServiceStepAction({ opportunityId: OPP, stepId: S3, expectedVersion: 1 })).ok).toBe(false);
    expect((await saveServiceTypeAction({ name: "X", steps: ["A"] })).ok).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
    expect(guard.requirePermissionSafe.mock.calls.map((c) => c[0])).toEqual(["case.number_assign", "case.progress_edit", "service_catalog.manage"]);
  });
  it("criar tipo usa o escritório da SESSÃO, nunca um id vindo do formulário", async () => {
    rpcMock.mockResolvedValue({ data: { id: TYPE, version: 1 }, error: null });
    await saveServiceTypeAction({ name: "Consultoria", steps: ["A", "B"], suggestionCode: "consultoria_parecer" });
    expect(rpcMock).toHaveBeenLastCalledWith("create_service_type", {
      p_workspace_id: "10000000-0000-0000-0000-000000000001", p_name: "Consultoria", p_steps: ["A", "B"], p_suggestion_code: "consultoria_parecer",
    });
  });
  it("cada código novo do banco tem mensagem própria em português", () => {
    for (const code of ["service_steps_pending", "service_reopen_status_required", "service_plan_has_records", "case_concluded", "service_step_completed",
      "service_type_name_taken", "service_type_conflict", "service_plan_exists", "case_number_immutable", "service_state_invalid"]) {
      expect(toUserMessage({ message: code })).not.toBe("Não foi possível concluir a operação. Tente novamente.");
    }
  });
});

describe("permissões: a mesma faixa no código e no banco", () => {
  const sql = read(MIGRATION);
  const roles = (permission: Parameters<typeof roleHasPermission>[1]) => ROLES.filter((r: Role) => roleHasPermission(r, permission));
  it("catálogo: owner, admin, manager", () => {
    expect(roles("service_catalog.manage")).toEqual(["owner", "admin", "manager"]);
    expect(sql).toMatch(/create function public\.create_service_type[\s\S]*?array\['owner', 'admin', 'manager'\]/);
  });
  it("número interno: quem edita a oportunidade", () => {
    expect(roles("case.number_assign")).toEqual(roles("opportunity.edit"));
    expect(sql).toMatch(/assign_opportunity_case_number[\s\S]*?not in \('owner', 'admin', 'manager', 'lawyer', 'sales'\)/);
  });
  it("roteiro: a mesma faixa do andamento (case.progress_edit)", () => {
    expect(roles("case.progress_edit")).toEqual(["owner", "admin", "manager", "lawyer"]);
    expect(sql).toMatch(/create function private\.case_service_begin[\s\S]*?not in \('owner', 'admin', 'manager', 'lawyer'\)/);
  });
});

describe("contrato da migration", () => {
  const sql = read(MIGRATION);
  const migrations = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
  it("é a última, posterior à publicada (20261120120000), e não carrega a da #358", () => {
    expect(migrations.at(-1)).toBe("20261121120000_conversas_painel_servico.sql");
    expect(migrations).not.toContain("20261119120000_conversas_horario_origem.sql");
    expect(sql).not.toMatch(/origin_time/);
  });
  it("não numera casos antigos nem aplica roteiro: nenhuma escrita fora das funções", () => {
    const outside = sql.replace(/\$body\$[\s\S]*?\$body\$/g, "");
    expect(outside).not.toMatch(/insert into public\.(opportunity_case_numbers|case_service_plans|case_service_events|service_types)/);
    expect(outside).not.toMatch(/update public\.(opportunities|status_tracks|conversations)/);
  });
  it("tabelas novas deny-all; funções privadas fechadas a todos os papéis de API", () => {
    for (const t of ["case_number_counters", "opportunity_case_numbers", "service_types", "service_type_steps", "case_service_plans", "case_service_plan_steps", "case_service_events"]) {
      expect(sql).toContain(`alter table public.${t} force row level security;`);
      expect(sql).toContain(`revoke all on table public.${t} from public, anon, authenticated;`);
    }
    const privates = [...sql.matchAll(/create function (private\.[a-z_]+)\(/g)].map((m) => m[1]!);
    for (const fn of privates) expect(sql).toMatch(new RegExp(`revoke all on function ${fn.replace(".", "\\.")}\\([^)]*\\)\\s*from public, anon, authenticated, service_role`));
  });
  it("a exportação mantém as seções anteriores byte a byte (cópia da versão da fundação) e só acrescenta três", () => {
    const found = read("supabase/migrations/20261117130000_conversas_ia_fundacao.sql");
    const prev = found.slice(found.indexOf("create or replace function private.privacy_export_payload("));
    const cur = sql.slice(sql.indexOf("create or replace function private.privacy_export_payload("));
    const prefix = prev.slice(0, prev.lastIndexOf("    ), '[]'::jsonb)\n  );"));
    expect(cur.startsWith(prefix)).toBe(true);
    expect(cur).toMatch(/'case_numbers'[\s\S]*'case_service_plans'[\s\S]*'case_service_history'/);
    // Sem usuário interno nem chave de idempotência nas seções novas.
    const added = cur.slice(prefix.length);
    expect(added).not.toMatch(/actor_user_id|assigned_by|applied_by|completed_by|ended_by|idempotency_key/);
  });
  it("concluir o serviço continua na correção do andamento, agora com a regra das etapas pendentes", () => {
    expect(sql).toMatch(/create or replace function public\.set_opportunity_case_progress[\s\S]*service_steps_pending/);
  });
  it("nenhuma escrita do roteiro toca a situação do atendimento nem a etapa comercial", () => {
    const writers = sql.slice(sql.indexOf("-- 8) Escritas do roteiro"), sql.indexOf("-- 9) Correção do andamento"));
    expect(writers).not.toMatch(/attendance_status|stage_transitions|stage_id/);
  });
});
