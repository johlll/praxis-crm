/**
 * @vitest-environment node
 *
 * Conversas + IA — painel do caso (PR A da correção de direção da interface).
 * docs/decisoes/conversas-painel-caso.md
 *
 * Regras puras de exibição (selo, identificação com desempate real, foco × vínculo, etapas sem marca de
 * conclusão), estado da URL (aba e edição), leitura das chaves novas e o contrato da migration.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({ rpc: rpcMock }),
}));

import {
  CASE_TABS,
  caseBadge,
  caseCountLabel,
  caseIdentity,
  caseOpenedLine,
  commercialSteps,
  focusNote,
  isCaseTab,
} from "@/modules/conversations/case-display";
import { inboxHref, parseInboxParams } from "@/modules/conversations/inbox";
import { caseHistoryExtras } from "@/modules/conversations/context-format";
import { mapStageMoves, memberName } from "@/modules/conversations/context";
import { listConversationCaseOptions, type ConversationCaseOption } from "@/modules/status-tracks/queries";
import { listConversationInbox } from "@/modules/conversations/queries";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8").split("\r").join("");
const CONV = "c0000000-0000-4000-8000-000000000001";
const OPP_A = "0a000000-0000-4000-8000-00000000000a";
const OPP_B = "0b000000-0000-4000-8000-00000000000b";
const OPP_C = "0c000000-0000-4000-8000-00000000000c";

function opt(over: Partial<ConversationCaseOption> = {}): ConversationCaseOption {
  return {
    opportunityId: OPP_A,
    leadId: "1ead0000-0000-4000-8000-000000000001",
    legalArea: "Usucapião",
    leadStatus: "ativo",
    status: "open",
    stageId: "5a000000-0000-4000-8000-000000000001",
    stageName: "Fazer primeiro contato",
    isLinked: false,
    caseProgressStatus: null,
    createdAt: "2026-11-16T12:05:00.000Z",
    ...over,
  };
}

beforeEach(() => rpcMock.mockReset());

describe("selo do caso: natureza sempre escrita, nunca a situação do atendimento", () => {
  it("oportunidade aberta → Comercial + etapa do Kanban", () => {
    expect(caseBadge(opt({ stageName: "Enviar proposta" }))).toMatchObject({ kind: "commercial", prefix: "Comercial", label: "Enviar proposta", full: "Comercial: Enviar proposta" });
  });
  it("oportunidade ganha → Serviço + andamento registrado; sem registro é 'Andamento não informado'", () => {
    expect(caseBadge(opt({ status: "won", caseProgressStatus: "em_analise" }))).toMatchObject({ kind: "service", label: "Em análise", progress: "em_analise" });
    expect(caseBadge(opt({ status: "won", caseProgressStatus: "nao_informado" }))).toMatchObject({ kind: "service", label: "Andamento não informado" });
    expect(caseBadge(opt({ status: "won", caseProgressStatus: null }))).toMatchObject({ kind: "service", progress: "nao_informado" });
  });
  it("oportunidade perdida → 'Perdida', sem etapa nem andamento", () => {
    expect(caseBadge(opt({ status: "lost", stageName: "Negociar honorários" }))).toMatchObject({ kind: "lost", label: "Perdida", full: "Oportunidade perdida" });
  });
});

describe("identificação do caso: só dados gravados, desempate real entre casos parecidos", () => {
  it("assunto = área do lead; sem área, texto honesto (nenhum código inventado)", () => {
    expect(caseIdentity(opt()).title).toBe("Usucapião");
    expect(caseIdentity(opt({ legalArea: null })).title).toBe("Oportunidade sem área");
    expect(caseIdentity(opt({ legalArea: "  " })).title).toBe("Oportunidade sem área");
    expect(caseIdentity(opt()).title).not.toMatch(/#|IM-|processo/i);
  });
  it("sem gêmeos: só a data de abertura", () => {
    const a = opt();
    const other = opt({ opportunityId: OPP_B, legalArea: "Inventário" });
    expect(caseIdentity(a, [a, other])).toEqual({ title: "Usucapião", opened: "Aberta em 16/11/2026", extra: null });
  });
  it("mesma área e etapa em outra data: a data já distingue", () => {
    const a = opt();
    const b = opt({ opportunityId: OPP_B, createdAt: "2026-10-01T12:00:00.000Z" });
    expect(caseIdentity(a, [a, b]).extra).toBeNull();
  });
  it("mesma área, etapa e data: entra a hora de abertura", () => {
    const a = opt({ createdAt: "2026-11-16T12:05:00.000Z" });
    const b = opt({ opportunityId: OPP_B, createdAt: "2026-11-16T17:40:00.000Z" });
    expect(caseIdentity(a, [a, b]).extra).toBe("às 09:05");
    expect(caseOpenedLine(caseIdentity(a, [a, b]))).toBe("Aberta em 16/11/2026 às 09:05");
  });
  it("até o minuto igual: entra o início do identificador (real)", () => {
    const b = opt({ opportunityId: OPP_B, createdAt: "2026-11-16T17:40:00.000Z" });
    const c = opt({ opportunityId: OPP_C, createdAt: "2026-11-16T17:40:20.000Z" });
    expect(caseIdentity(b, [b, c]).extra).toBe("ref. 0B000000");
    expect(caseIdentity(c, [b, c]).extra).toBe("ref. 0C000000");
    expect(caseOpenedLine(caseIdentity(c, [b, c]))).toBe("Aberta em 16/11/2026 · ref. 0C000000");
  });
  it("natureza diferente não é gêmeo (ganha × aberta)", () => {
    const a = opt();
    const b = opt({ opportunityId: OPP_B, status: "won" });
    expect(caseIdentity(a, [a, b]).extra).toBeNull();
  });
  it("contagem: '1 caso', '3 casos'", () => {
    expect(caseCountLabel(1)).toBe("1 caso");
    expect(caseCountLabel(3)).toBe("3 casos");
  });
});

describe("foco (tela) × vínculo (gravado): a diferença sempre aparece", () => {
  it("foco = vínculo → 'Caso vinculado a esta conversa.'", () => {
    expect(focusNote("linked", OPP_A, OPP_A)).toEqual({ tone: "linked", text: "Caso vinculado a esta conversa.", linkedId: null });
    expect(focusNote("url", OPP_A, OPP_A).tone).toBe("linked");
  });
  it("escolhido na URL, com outro vínculo → diz e aponta o vinculado", () => {
    expect(focusNote("url", OPP_B, OPP_A)).toEqual({ tone: "differs", text: "Escolhido nesta tela. A conversa está vinculada a outro caso.", linkedId: OPP_A });
  });
  it("escolhido na URL, sem vínculo → diz que não há vínculo", () => {
    expect(focusNote("url", OPP_B, null)).toMatchObject({ tone: "differs", linkedId: null, text: "Escolhido nesta tela. A conversa não tem caso vinculado." });
  });
  it("padrão por lead ou por contato único → nunca se apresenta como vínculo", () => {
    expect(focusNote("lead", OPP_A, null)).toMatchObject({ tone: "differs", text: expect.stringContaining("Único caso do lead") });
    expect(focusNote("only", OPP_A, null)).toMatchObject({ tone: "differs", text: expect.stringContaining("Único caso deste contato") });
  });
});

describe("andamento comercial: posição no funil, sem afirmar conclusão", () => {
  const stages = [
    { id: "s3", name: "Agendar consulta", position: 3 },
    { id: "s1", name: "Fazer primeiro contato", position: 1 },
    { id: "won", name: "Ganho", position: 8, isWon: true },
    { id: "s2", name: "Qualificar", position: 2 },
    { id: "lost", name: "Perdido", position: 9, isLost: true },
  ];
  it("ordem do pipeline, sem etapas terminais; anterior/atual/seguinte", () => {
    expect(commercialSteps(stages, "s2")).toEqual([
      { id: "s1", name: "Fazer primeiro contato", state: "previous" },
      { id: "s2", name: "Qualificar", state: "current" },
      { id: "s3", name: "Agendar consulta", state: "next" },
    ]);
  });
  it("estados possíveis não incluem 'concluída'", () => {
    const states = new Set((commercialSteps(stages, "s3") ?? []).map((s) => s.state));
    expect([...states].sort()).toEqual(["current", "previous"]);
    expect(JSON.stringify(commercialSteps(stages, "s3"))).not.toMatch(/conclu|done|complete/i);
  });
  it("etapa atual fora das etapas abertas → sem barra (nada inferido)", () => {
    expect(commercialSteps(stages, "won")).toBeNull();
    expect(commercialSteps(stages, "inexistente")).toBeNull();
  });
});

describe("abas e edição na URL: Voltar/Avançar e links funcionam", () => {
  it("aba e edição são lidas e sanitizadas", () => {
    expect(parseInboxParams({}).aba).toBe("resumo");
    expect(parseInboxParams({ aba: "tarefas" }).aba).toBe("tarefas");
    expect(parseInboxParams({ aba: "historico" }).aba).toBe("historico");
    expect(parseInboxParams({ aba: "documentos" }).aba).toBe("resumo"); // não existe nesta entrega
    expect(parseInboxParams({ aba: "<script>" }).aba).toBe("resumo");
    expect(parseInboxParams({ editar: "1" }).editar).toBe(true);
    expect(parseInboxParams({ editar: "true" }).editar).toBe(false);
  });
  it("Documentos não é aba nesta entrega", () => {
    expect([...CASE_TABS]).toEqual(["resumo", "tarefas", "historico"]);
    expect(isCaseTab("documentos")).toBe(false);
  });
  it("o estado do painel acompanha a conversa aberta e não vai para outra conversa", () => {
    const params = parseInboxParams({ q: "maria", situacao: "novo", caso: OPP_A, aba: "tarefas", editar: "1" });
    expect(inboxHref(CONV, params, { keepCase: true })).toBe(`/conversas/${CONV}?q=maria&situacao=novo&caso=${OPP_A}&aba=tarefas&editar=1`);
    // abrir outra conversa pela lista: busca e filtro ficam; caso, aba e edição não
    expect(inboxHref("c0000000-0000-4000-8000-000000000002", params)).toBe("/conversas/c0000000-0000-4000-8000-000000000002?q=maria&situacao=novo");
    // Resumo é o padrão e não suja a URL
    expect(inboxHref(CONV, { ...params, aba: "resumo", editar: false }, { keepCase: true })).toBe(`/conversas/${CONV}?q=maria&situacao=novo&caso=${OPP_A}`);
  });
});

describe("histórico do caso: fontes canônicas, cada evento uma vez", () => {
  it("movimentações comerciais com nomes; etapa removida e autor desconhecido não quebram", () => {
    const moves = mapStageMoves(
      [
        { fromStageId: "s1", toStageId: "s2", actorUserId: "u1", occurredAt: "2026-11-17T10:00:00Z", secondsInPreviousStage: 10 },
        { fromStageId: null, toStageId: "gone", actorUserId: "u9", occurredAt: "2026-11-16T10:00:00Z", secondsInPreviousStage: null },
      ],
      [{ id: "s1", name: "Contato" }, { id: "s2", name: "Proposta" }],
      [{ membershipId: "m", userId: "u1", fullName: "Paula", email: "p@x", role: "owner", isCurrentUser: true }],
    );
    expect(moves[0]).toMatchObject({ fromStageName: "Contato", toStageName: "Proposta", actorName: "Paula" });
    expect(moves[1]).toMatchObject({ fromStageName: null, toStageName: "Etapa removida", actorName: null });
    expect(new Set(moves.map((m) => m.id)).size).toBe(2);
  });
  it("nome do integrante: nome, senão e-mail, senão nada", () => {
    const m = [{ membershipId: "m", userId: "u1", fullName: null, email: "p@x", role: "owner" as const, isCurrentUser: true }];
    expect(memberName(m, "u1")).toBe("p@x");
    expect(memberName(m, "u2")).toBeNull();
    expect(memberName(m, null)).toBeNull();
  });
  it("marcos: abertura sempre, ganho só quando gravado, perda nunca (não há data gravada)", () => {
    const base = { opportunityId: OPP_A, createdAt: "2026-11-01T10:00:00Z", stageMoves: [] };
    expect(caseHistoryExtras({ ...base, wonAt: null }).map((e) => e.title)).toEqual(["Oportunidade aberta"]);
    expect(caseHistoryExtras({ ...base, wonAt: "2026-11-02T10:00:00Z" }).map((e) => e.title)).toEqual(["Oportunidade aberta", "Oportunidade ganha"]);
    const withMoves = caseHistoryExtras({
      ...base,
      wonAt: null,
      stageMoves: [{ id: "x", occurredAt: "2026-11-03T10:00:00Z", fromStageName: "A", toStageName: "B", actorName: null }],
    });
    expect(withMoves.filter((e) => e.title === "Etapa comercial alterada")).toHaveLength(1);
    expect(withMoves[0]).toMatchObject({ tag: "Etapa comercial", detail: "De “A” para “B”", actorLabel: "Alguém da equipe" });
    expect(withMoves.some((e) => /perdid/i.test(e.title))).toBe(false);
  });
});

describe("leitura: lista e painel usam o caso padrão do banco", () => {
  const item = { opportunity_id: OPP_A, lead_id: "1ead0000-0000-4000-8000-000000000001", legal_area: "Usucapião", lead_status: "ativo", status: "won", stage_id: "s", stage_name: "Ganho", is_linked: true, case_progress_status: "em_analise", created_at: "2026-11-01T10:00:00Z" };

  it("painel: o padrão só vale se for uma das opções da mesma leitura", async () => {
    rpcMock.mockResolvedValueOnce({ data: { conversation_id: CONV, contact_resolved: true, linked_opportunity_id: OPP_A, case_count: 1, default_opportunity_id: OPP_A, default_source: "linked", items: [item] }, error: null });
    expect(await listConversationCaseOptions(CONV)).toMatchObject({ defaultOpportunityId: OPP_A, defaultSource: "linked" });
    rpcMock.mockResolvedValueOnce({ data: { conversation_id: CONV, contact_resolved: true, linked_opportunity_id: null, case_count: 1, default_opportunity_id: OPP_B, default_source: "only", items: [item] }, error: null });
    expect(await listConversationCaseOptions(CONV)).toMatchObject({ defaultOpportunityId: null, defaultSource: null });
    rpcMock.mockResolvedValueOnce({ data: { conversation_id: CONV, contact_resolved: true, linked_opportunity_id: null, case_count: 1, default_opportunity_id: OPP_A, default_source: "palpite", items: [item] }, error: null });
    expect(await listConversationCaseOptions(CONV)).toMatchObject({ defaultOpportunityId: OPP_A, defaultSource: null });
  });

  it("lista: caso, contagem e origem por item; ausência vira 0/nulo (nunca palpite)", async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{
        items: [
          { id: CONV, wa_id: "+55", attendance_status: "novo", needs_link_review: false, case: item, case_count: 1, case_source: "linked" },
          { id: "c2", wa_id: null, attendance_status: "nao_informado", needs_link_review: false, case: null, case_count: 3, case_source: null },
          { id: "c3", wa_id: null, attendance_status: "nao_informado", needs_link_review: false },
        ],
        total_count: 3,
        status_counts: {},
      }],
      error: null,
    });
    const page = await listConversationInbox("w");
    expect(page.items[0]).toMatchObject({ caseCount: 1, caseSource: "linked", caseItem: { opportunityId: OPP_A, caseProgressStatus: "em_analise" } });
    expect(page.items[1]).toMatchObject({ caseCount: 3, caseSource: null, caseItem: null });
    expect(page.items[2]).toMatchObject({ caseCount: 0, caseSource: null, caseItem: null });
  });
});

describe("contrato da migration e promessas que o painel não faz", () => {
  const sql = read("supabase/migrations/20261120120000_conversas_painel_caso.sql");
  const code = sql.replace(/--[^\n]*/g, "");

  it("aditiva e só de leitura: nenhuma tabela, coluna, gatilho ou escrita", () => {
    expect(code).not.toMatch(/\b(create|alter|drop)\s+table\b/i);
    expect(code).not.toMatch(/\bcreate\s+trigger\b/i);
    expect(code).not.toMatch(/\b(insert\s+into|update\s+public\.|delete\s+from)\b/i);
    expect(code).not.toMatch(/\bvolatile\b/i);
  });
  it("uma função privada nova, fechada a todos os papéis de API", () => {
    expect(code).toMatch(/create function private\.conversation_case_resolution\(/);
    expect(code).toMatch(/revoke all on function private\.conversation_case_resolution\(uuid, public\.membership_role, uuid\)\s+from public, anon, authenticated, service_role/);
  });
  it("só recria as duas leituras desta etapa, com a mesma assinatura; list_conversations intocada", () => {
    expect(code.match(/create or replace function public\.\w+/g)).toEqual([
      "create or replace function public.list_conversation_case_options",
      "create or replace function public.list_conversation_inbox",
    ]);
    expect(code).not.toMatch(/list_conversations\(/);
    expect(code).toMatch(/returns table \(items jsonb, total_count bigint, status_counts jsonb\)/);
  });
  it("lista e painel chamam a MESMA regra", () => {
    expect(code.match(/private\.conversation_case_resolution\(/g)!.length).toBeGreaterThanOrEqual(3); // definição + 2 usos
    expect(code).toMatch(/v_resolution := private\.conversation_case_resolution\(v_conv\.id, v_target\.role, v_actor\)/);
    expect(code).toMatch(/cross join lateral \(select private\.conversation_case_resolution\(p\.id, v_role, v_actor\) as r\) cr/);
  });
  it("o painel não inventa código de caso, tipo de serviço, processo, protocolo, sentença, documentos nem observações", () => {
    const panel = read("src/components/conversations/conversation-context-panel.tsx");
    const visible = panel.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(visible).not.toMatch(/Protocolo|Sentença|Processo|Documentos|Observações|Imóvel|#IM|Tipo de serviço/);
    expect(visible).not.toMatch(/Vit[óo]ria/);
  });
  it("na consulta não há formulário: editores só dentro da edição", () => {
    const panel = read("src/components/conversations/conversation-context-panel.tsx");
    const edit = panel.slice(panel.indexOf("function CaseEdit("));
    const before = panel.slice(0, panel.indexOf("function CaseEdit("));
    expect(before).not.toMatch(/<TrackStatusEditor|<AutomationControl/);
    expect(edit).toMatch(/<TrackStatusEditor/);
    expect(edit).toMatch(/<AutomationControl/);
  });
  it("a etapa comercial continua mudando só pelo Pipeline (sem editor no painel)", () => {
    const panel = read("src/components/conversations/conversation-context-panel.tsx");
    expect(panel).not.toMatch(/moveOpportunityStageAction|move_opportunity_stage/);
  });
});
