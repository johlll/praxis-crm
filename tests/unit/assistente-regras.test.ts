/**
 * Assistente — regras sem servidor: a interpretação SIMULADA, a lista de operações, o rascunho e o
 * diagnóstico (com e sem pendências, e com consultas que falham).
 */
import { describe, expect, it } from "vitest";

import { simulatedInterpreter } from "@/modules/assistant/interpreter";
import { ASSISTANT_OPERATIONS, isAssistantOperation, mergeDraft, missingFields } from "@/modules/assistant/operations";
import { buildDiagnosis, shortWhen, type DiagnosisSources } from "@/modules/assistant/diagnosis";
import { mapMatches, questionFor, validateRegistration } from "@/modules/assistant/registration";
import type { ActivityListItem } from "@/modules/activities/queries";
import type { AttentionItem } from "@/modules/dashboard/queries";

const WS = "10000000-0000-0000-0000-000000000001";
const interpret = (text: string, pending: Parameters<typeof simulatedInterpreter.interpret>[1]["pending"] = null, legalAreas: string[] = []) =>
  simulatedInterpreter.interpret(text, { pending, legalAreas });

describe("interpretação simulada", () => {
  it("se identifica como simulação", () => {
    expect(simulatedInterpreter.simulated).toBe(true);
    expect(simulatedInterpreter.id).toBe("simulado-v1");
  });

  it.each(["O que precisa da minha atenção hoje?", "quais são as pendências?", "o que tenho pra hoje", "tem algo atrasado?"])(
    "“%s” propõe o diagnóstico",
    (text) => {
      expect(interpret(text)).toEqual({ operation: "diagnose_attention", params: {} });
    },
  );

  it("pedido completo: nome, assunto e área sugerida", () => {
    expect(interpret("Cadastre Ana Ribeiro para um caso de regularização de imóvel")).toEqual({
      operation: "propose_client_registration",
      fresh: true,
      params: { name: "Ana Ribeiro", summary: "Regularização de imóvel", legalArea: "Imobiliário" },
    });
  });

  it("prefere a grafia de uma área que o escritório já usa", () => {
    const proposal = interpret("cadastre João da Silva sobre divórcio consensual", null, ["família", "Trabalhista"]);
    expect(proposal).toMatchObject({ params: { name: "João da Silva", summary: "Divórcio consensual", legalArea: "família" } });
  });

  it("pega telefone e e-mail do pedido", () => {
    expect(interpret("Cadastre Bia Souza, telefone (11) 98888-7777, bia@exemplo.com, caso de rescisão")).toMatchObject({
      params: { name: "Bia Souza", phone: "(11) 98888-7777", email: "bia@exemplo.com", legalArea: "Trabalhista" },
    });
  });

  it("“Cadastre um cliente” não inventa nome nem área", () => {
    expect(interpret("Cadastre um cliente")).toEqual({ operation: "propose_client_registration", fresh: true, params: {} });
  });

  it("pedido sem assunto: só o nome", () => {
    expect(interpret("Cadastre Ana Ribeiro")).toMatchObject({ params: { name: "Ana Ribeiro" } });
  });

  it("com rascunho aberto, a resposta preenche só o que falta", () => {
    expect(interpret("Ana Ribeiro, regularização de imóvel", {})).toEqual({
      operation: "propose_client_registration",
      params: { name: "Ana Ribeiro", summary: "Regularização de imóvel", legalArea: "Imobiliário" },
    });
    expect(interpret("Família", { name: "Ana Ribeiro" })).toEqual({ operation: "propose_client_registration", params: { legalArea: "Família" } });
    expect(interpret("Agrário", { name: "Ana Ribeiro" })).toMatchObject({ params: { legalArea: "Agrário" } });
    expect(interpret("Ana Ribeiro", { legalArea: "Família" })).toMatchObject({ params: { name: "Ana Ribeiro" } });
  });

  it("cancelar só vale com rascunho aberto", () => {
    expect(interpret("cancelar", { name: "Ana" })).toEqual({ operation: "cancel_registration", params: {} });
    expect(interpret("cancelar")).toEqual({ operation: null, reason: "unknown" });
  });

  it("o que não reconhece não vira operação", () => {
    expect(interpret("qual a previsão do tempo?")).toEqual({ operation: null, reason: "unknown" });
  });
});

describe("lista de operações", () => {
  it("é explícita e não aceita outras", () => {
    expect(Object.keys(ASSISTANT_OPERATIONS).sort()).toEqual(["cancel_registration", "diagnose_attention", "propose_client_registration"]);
    expect(isAssistantOperation("delete_lead")).toBe(false);
    expect(isAssistantOperation("toString")).toBe(false);
  });

  it("cadastro exige as permissões do cadastro oficial de contato e de lead", () => {
    expect(ASSISTANT_OPERATIONS.propose_client_registration.permissions).toEqual(["contact.edit", "lead.edit"]);
  });

  it("parâmetros desconhecidos (como o escritório) são descartados", () => {
    const parsed = ASSISTANT_OPERATIONS.propose_client_registration.params.parse({ name: " Ana ", workspaceId: "outro" });
    expect(parsed).toEqual({ name: "Ana" });
    expect(ASSISTANT_OPERATIONS.diagnose_attention.params.safeParse({ workspaceId: "outro" }).success).toBe(false);
  });
});

describe("rascunho", () => {
  it("diz o que falta e pergunta só isso", () => {
    expect(missingFields({})).toEqual(["name", "legalArea"]);
    expect(missingFields({ name: "Ana" })).toEqual(["legalArea"]);
    expect(questionFor(["legalArea"], { name: "Ana Ribeiro", summary: "Inventário" })).toContain("área jurídica do caso de Ana Ribeiro");
    expect(questionFor(["name"], {})).toBe("Qual é o nome da pessoa?");
    expect(questionFor(["name", "legalArea"], {})).toContain("nome da pessoa e do assunto");
  });

  it("completar não apaga o que já estava preenchido", () => {
    expect(mergeDraft({ name: "Ana", summary: "Imóvel" }, { legalArea: "Cível", name: "" })).toEqual({ name: "Ana", summary: "Imóvel", legalArea: "Cível" });
    expect(mergeDraft(null, { name: "Bia" })).toEqual({ name: "Bia" });
  });

  it("valida com os mesmos esquemas do cadastro de contato e de lead", () => {
    expect(validateRegistration(WS, { name: "Ana", legalArea: "Cível", phone: "11 98888-7777", email: "ANA@Exemplo.com" })).toMatchObject({
      ok: true,
      value: { name: "Ana", legalArea: "Cível", summary: null, phones: [{ value_normalized: "+5511988887777" }], emails: [{ value_normalized: "ana@exemplo.com" }] },
    });
    expect(validateRegistration(WS, { name: "Ana", legalArea: "Cível", phone: "123" })).toEqual({ ok: false, message: "Telefone inválido." });
    expect(validateRegistration(WS, { name: "", legalArea: "Cível" })).toEqual({ ok: false, message: "Informe um nome." });
    expect(validateRegistration(WS, { name: "Ana", legalArea: " " })).toEqual({ ok: false, message: "Informe a área jurídica." });
  });

  it("os motivos da duplicidade vêm por extenso", () => {
    expect(mapMatches([{ contact_id: "c1", name: "Ana", signals: ["phone", "same_name"], lead_count: 2 }, { lixo: true }])).toEqual([
      { contactId: "c1", name: "Ana", reasons: ["mesmo telefone", "nome igual"], leadCount: 2, href: "/contatos/c1" },
    ]);
    expect(mapMatches(null)).toEqual([]);
  });
});

const activity = (over: Partial<ActivityListItem>): ActivityListItem => ({
  id: "a1",
  leadId: "l1",
  opportunityId: null,
  contactName: "Carla Dias",
  legalArea: "Família",
  type: "call",
  title: "Retornar ligação",
  notes: null,
  assignedTo: null,
  assignedToName: "Lucas",
  priority: "media",
  dueAt: "2026-11-25T13:00:00Z",
  hasTime: true,
  status: "pending",
  completedAt: null,
  source: "manual",
  lockVersion: 1,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  isOverdue: true,
  ...over,
});

const attention = (over: Partial<AttentionItem>): AttentionItem => ({
  id: "o1",
  leadId: "l9",
  contactName: "Diego Lima",
  legalArea: "Cível",
  stageName: "Qualificar",
  assignedToName: null,
  stageEnteredAt: "2026-11-10T12:00:00Z",
  isStalled: true,
  isUnassigned: true,
  overdueActivitiesCount: 0,
  nextAction: null,
  ...over,
});

const sources = (over: Partial<DiagnosisSources> = {}): DiagnosisSources => ({
  overdue: async () => ({ items: [activity({})], total: 3 }),
  today: async () => ({ items: [activity({ id: "a2", dueAt: "2026-11-26T17:30:00Z", isOverdue: false, title: "Consulta inicial", type: "meeting" })], total: 1 }),
  attention: async () => ({ attention: { total: 2, items: [attention({})] }, generatedAt: "2026-11-26T15:00:00Z", stalledDays: 5 }),
  now: () => new Date("2026-11-26T15:00:00Z"),
  ...over,
});

describe("diagnóstico", () => {
  it("com pendências: prioridades, motivo de cada uma e o registro de origem", async () => {
    const block = await buildDiagnosis(sources());
    if (block.type !== "diagnosis") throw new Error("tipo");
    expect(block.summary).toBe("Encontrei 3 atividades atrasadas, 1 atividade na agenda de hoje e 2 oportunidades que exigem atenção.");
    const [overdue, today, opp] = block.sections;
    expect(overdue).toMatchObject({ status: "ok", total: 3, moreHref: "/atividades?filter=overdue" });
    expect(overdue!.items[0]).toEqual({
      id: "a1",
      title: "Carla Dias · Retornar ligação",
      reason: "Ligação atrasada desde 25/11 às 10:00 · Lucas",
      href: "/leads/l1",
      tone: "danger",
    });
    // Fuso do escritório: 17h30 UTC são 14h30 em São Paulo.
    expect(today!.items[0]!.reason).toBe("Reunião hoje às 14:30 · Lucas");
    expect(opp!.items[0]).toMatchObject({
      title: "Diego Lima · Cível",
      reason: 'Parada há 16 dias em "Qualificar" (limite: 5) · sem responsável',
      href: "/oportunidades/o1",
    });
  });

  it("sem pendências: diz isso com base no resultado das três consultas", async () => {
    const block = await buildDiagnosis(
      sources({
        overdue: async () => ({ items: [], total: 0 }),
        today: async () => ({ items: [], total: 0 }),
        attention: async () => ({ attention: { total: 0, items: [] }, generatedAt: "2026-11-26T15:00:00Z", stalledDays: 5 }),
      }),
    );
    if (block.type !== "diagnosis") throw new Error("tipo");
    expect(block.summary).toMatch(/^Nada precisa da sua atenção agora/);
    expect(block.sections.every((s) => s.status === "ok" && s.items.length === 0)).toBe(true);
  });

  it("uma consulta que falha fica indisponível e nunca vira zero", async () => {
    const block = await buildDiagnosis(
      sources({
        overdue: async () => ({ items: [], total: 0 }),
        today: async () => {
          throw new Error("rede");
        },
        attention: async () => ({ attention: { total: 0, items: [] }, generatedAt: "2026-11-26T15:00:00Z", stalledDays: 5 }),
      }),
    );
    if (block.type !== "diagnosis") throw new Error("tipo");
    expect(block.sections[1]).toMatchObject({ status: "unavailable", total: 0, items: [] });
    expect(block.summary).toBe(
      "Nas consultas que responderam, não há pendências. Não consegui consultar: agenda de hoje. Tente de novo em instantes.",
    );
    expect(block.summary).not.toMatch(/Nada precisa/);
  });

  it("todas falhando: não afirma nada", async () => {
    const fail = async () => {
      throw new Error("x");
    };
    const block = await buildDiagnosis(sources({ overdue: fail, today: fail, attention: fail }));
    if (block.type !== "diagnosis") throw new Error("tipo");
    expect(block.summary).toBe("Não consegui consultar nenhuma das informações agora. Tente de novo em instantes.");
    expect(block.generatedAt).toBe("2026-11-26T15:00:00.000Z");
  });

  it("datas curtas no fuso do escritório; o ano só aparece quando não é o atual", () => {
    const now = new Date("2026-11-26T15:00:00Z");
    expect(shortWhen("2026-11-25T02:30:00Z", true, now)).toBe("24/11 às 23:30");
    expect(shortWhen("2026-11-25T03:00:00Z", false, now)).toBe("25/11");
    expect(shortWhen("2025-12-30T13:00:00Z", true, now)).toBe("30/12/2025 às 10:00");
  });

  it("duas consultas indisponíveis são listadas com “e”", async () => {
    const fail = async () => {
      throw new Error("x");
    };
    const block = await buildDiagnosis(sources({ overdue: fail, today: fail }));
    if (block.type !== "diagnosis") throw new Error("tipo");
    expect(block.summary).toBe(
      "Encontrei 2 oportunidades que exigem atenção. Não consegui consultar: atividades atrasadas e agenda de hoje. Tente de novo em instantes.",
    );
  });

  it("mostra no máximo cinco por lista, com o total real", async () => {
    const many = Array.from({ length: 8 }, (_, i) => activity({ id: `x${i}` }));
    const block = await buildDiagnosis(sources({ overdue: async () => ({ items: many, total: 42 }) }));
    if (block.type !== "diagnosis") throw new Error("tipo");
    expect(block.sections[0]).toMatchObject({ total: 42 });
    expect(block.sections[0]!.items).toHaveLength(5);
  });
});
