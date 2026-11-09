/**
 * @vitest-environment node
 *
 * C1 — página de Automações: owner/admin gerenciam; manager só consulta (sem
 * nenhum botão de ação); os demais recebem "não encontrado" sem tocar em
 * consulta alguma; o workspace é o da sessão; estados vazios; ativação só
 * oferecida com simulação atual; histórico mostra resultado, tentativa e
 * motivo em texto claro.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

class NotFoundSignal extends Error {
  constructor() {
    super("NEXT_NOT_FOUND");
  }
}

const state = vi.hoisted(() => ({
  role: "owner" as string,
  workspaceId: "10000000-0000-0000-0000-000000000001",
}));
const { rulesMock, executionsMock, stagesMock, teamMock } = vi.hoisted(() => ({
  rulesMock: vi.fn(),
  executionsMock: vi.fn(),
  stagesMock: vi.fn(),
  teamMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundSignal();
  },
}));
vi.mock("@/components/app-shell/topbar", () => ({
  Topbar: ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <header data-testid="topbar">
      {title} | {subtitle}
    </header>
  ),
}));
vi.mock("@/modules/shell/queries", () => ({
  getShellContext: async () => ({
    user: { id: "u-1", fullName: "Ana", initials: "A", role: state.role },
    activeWorkspace: { id: state.workspaceId, name: "Escritório Um" },
  }),
}));
vi.mock("@/server/authz/permissions", async () => {
  const roles: { roleHasPermission: (role: string, permission: string) => boolean } = await vi.importActual("@/lib/roles");
  return {
    requireMembership: async () => ({
      role: state.role,
      userId: "20000000-0000-0000-0000-000000000001",
      workspaceId: state.workspaceId,
      membershipId: "m-1",
    }),
    roleHasPermission: roles.roleHasPermission,
  };
});
vi.mock("@/modules/automations/queries", () => ({
  listAutomationRules: rulesMock,
  listAutomationExecutions: executionsMock,
  listAutomationStageOptions: stagesMock,
}));
vi.mock("@/modules/team/queries", () => ({ listTeamMembers: teamMock }));
// Os componentes de cliente importam as Server Actions; aqui só se renderiza.
vi.mock("@/modules/automations/actions", () => ({
  saveAutomationRuleAction: vi.fn(),
  simulateAutomationRuleAction: vi.fn(),
  setAutomationRuleStatusAction: vi.fn(),
  processAutomationsAction: vi.fn(),
}));

import AutomacoesPage from "@/app/(app)/automacoes/page";

const ANA = "20000000-0000-0000-0000-000000000001";
const BRUNO = "20000000-0000-0000-0000-000000000002";
const ST1 = "60000000-0000-0000-0000-000000000001";

const rule = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Regra ${id.slice(-1)}`,
  status: "draft",
  trigger: "lead_created",
  condPriority: "alta",
  condLegalArea: null,
  condToStageId: null,
  condFromStageId: null,
  actionTitle: "Retornar o contato",
  actionDueDays: 2,
  actionPriority: "alta",
  assigneeMode: "lead_owner",
  assigneeUserId: null,
  version: 1,
  simulationCurrent: false,
  simulatedAt: null,
  simulatedCount: null,
  activatedAt: null,
  createdAt: "2026-11-10T10:00:00+00:00",
  updatedAt: "2026-11-10T10:00:00+00:00",
  ...over,
});
const exec = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  ruleId: "70000000-0000-0000-0000-000000000001",
  ruleName: "Regra 1",
  trigger: "lead_created",
  state: "succeeded",
  attemptCount: 1,
  lastAttemptAt: "2026-11-10T12:00:00+00:00",
  nextAttemptAt: null,
  errorCode: null,
  activityId: null,
  createdAt: "2026-11-10T11:59:00+00:00",
  finishedAt: "2026-11-10T12:00:00+00:00",
  ...over,
});
const R = (n: number) => `70000000-0000-0000-0000-00000000000${n}`;

const render = async () => renderToStaticMarkup(await AutomacoesPage());
/** O botão com este texto: o próprio <button>. */
const button = (html: string, label: string) => new RegExp(`<button[^>]*>${label}</button>`).exec(html)?.[0] ?? null;
/** O ATRIBUTO disabled (a classe do botão também tem "disabled:" do Tailwind). */
const isDisabled = (markup: string | null) => /\sdisabled(=""|\s|>)/.test(markup ?? "");

beforeEach(() => {
  vi.clearAllMocks();
  state.role = "owner";
  state.workspaceId = "10000000-0000-0000-0000-000000000001";
  rulesMock.mockResolvedValue([rule(R(1))]);
  executionsMock.mockResolvedValue([exec("e1")]);
  stagesMock.mockResolvedValue([{ id: ST1, label: "Qualificar", terminal: false }]);
  teamMock.mockResolvedValue([
    { membershipId: "m1", userId: ANA, fullName: "Ana Owner", email: "ana@x.com", role: "owner", isCurrentUser: true },
    { membershipId: "m2", userId: BRUNO, fullName: null, email: "bruno@x.com", role: "admin", isCurrentUser: false },
  ]);
});

describe("acesso", () => {
  it.each(["lawyer", "sales", "viewer"])("%s recebe 'não encontrado' e nenhuma consulta roda", async (role) => {
    state.role = role;
    await expect(render()).rejects.toBeInstanceOf(NotFoundSignal);
    for (const mock of [rulesMock, executionsMock, stagesMock, teamMock]) expect(mock).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin", "manager"])("%s vê a tela", async (role) => {
    state.role = role;
    const html = await render();
    expect(html).toContain("Automações");
    expect(html).toContain("Regra 1");
    expect(html).toContain("Histórico de execuções");
  });

  it("o workspace é o da SESSÃO", async () => {
    await render();
    expect(rulesMock).toHaveBeenCalledWith(state.workspaceId);
    expect(executionsMock).toHaveBeenCalledWith(state.workspaceId);
    expect(stagesMock).toHaveBeenCalledWith(state.workspaceId);
  });

  it("o banco recusou (papel mudou desde a abertura): mesma resposta de quem nunca teve acesso", async () => {
    rulesMock.mockResolvedValue(null);
    await expect(render()).rejects.toBeInstanceOf(NotFoundSignal);
    rulesMock.mockResolvedValue([]);
    executionsMock.mockResolvedValue(null);
    await expect(render()).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it("falha de carga sobe para o error.tsx (nunca vira lista vazia)", async () => {
    rulesMock.mockRejectedValue(new Error("Falha ao carregar"));
    await expect(render()).rejects.toThrow("Falha ao carregar");
  });
});

describe("gerente só consulta", () => {
  it("vê regras e histórico, sem nenhum botão de ação", async () => {
    state.role = "manager";
    rulesMock.mockResolvedValue([rule(R(1), { status: "active", simulationCurrent: true, simulatedAt: "2026-11-10T10:00:00+00:00", simulatedCount: 3 })]);
    const html = await render();
    for (const label of ["Nova regra", "Processar agora", "Editar", "Simular", "Ativar", "Pausar", "Reativar", "Arquivar"]) {
      expect(button(html, label), label).toBeNull();
    }
    expect(html).toContain("Só proprietário e administrador criam ou alteram regras");
    expect(html).toContain("Quando um lead for criado com prioridade alta");
  });
});

describe("quem gerencia", () => {
  it.each(["owner", "admin"])("%s vê os controles", async (role) => {
    state.role = role;
    const html = await render();
    expect(button(html, "Nova regra")).not.toBeNull();
    expect(button(html, "Processar agora")).not.toBeNull();
    expect(button(html, "Editar")).not.toBeNull();
    expect(button(html, "Simular")).not.toBeNull();
    expect(html).not.toContain("Só proprietário e administrador criam");
  });

  it("rascunho sem simulação atual: ativar fica DESABILITADO e a tela explica", async () => {
    const html = await render();
    expect(isDisabled(button(html, "Ativar"))).toBe(true);
    expect(html).toContain("Rascunho");
    expect(html).toContain("Ainda não simulada");
    expect(html).toContain("Simule a versão atual para poder ativar");
  });

  it("com simulação da versão atual, ativar fica disponível", async () => {
    rulesMock.mockResolvedValue([rule(R(1), { simulationCurrent: true, simulatedAt: "2026-11-10T10:00:00+00:00", simulatedCount: 5 })]);
    const html = await render();
    expect(button(html, "Ativar")).not.toBeNull();
    expect(isDisabled(button(html, "Ativar"))).toBe(false);
    expect(html).toContain("5 registro(s) compatíveis nos últimos 30 dias");
  });

  it("simulação desatualizada (a regra mudou depois): avisa e bloqueia a ativação", async () => {
    rulesMock.mockResolvedValue([rule(R(1), { version: 3, simulatedAt: "2026-11-10T10:00:00+00:00", simulatedCount: 5, simulationCurrent: false })]);
    const html = await render();
    expect(html).toContain("A simulação está desatualizada");
    expect(isDisabled(button(html, "Ativar"))).toBe(true);
  });

  it("cada estado mostra o controle certo", async () => {
    rulesMock.mockResolvedValue([
      rule(R(1), { name: "Ativa", status: "active", simulationCurrent: true, simulatedAt: "2026-11-10T10:00:00+00:00", activatedAt: "2026-11-10T10:05:00+00:00" }),
      rule(R(2), { name: "Pausada", status: "paused", simulationCurrent: true, simulatedAt: "2026-11-10T10:00:00+00:00" }),
      rule(R(3), { name: "Arquivada", status: "archived" }),
    ]);
    const html = await render();
    expect(html).toContain("Ativa</span>");
    expect(html).toContain("Pausada</span>");
    expect(html).toContain("Arquivada</span>");
    expect(button(html, "Pausar")).not.toBeNull();
    expect(button(html, "Reativar")).not.toBeNull();
    expect(html).toContain("Regra arquivada: não executa mais e não pode ser alterada.");
    // A arquivada não tem controle nenhum: só 2 botões "Editar" (ativa e pausada).
    expect((html.match(/<button[^>]*>Editar<\/button>/g) ?? []).length).toBe(2);
  });

  it("gatilho de etapa mostra o nome da etapa; etapa removida é dita como removida", async () => {
    rulesMock.mockResolvedValue([
      rule(R(1), { name: "Por etapa", trigger: "opportunity_stage_changed", condPriority: null, condToStageId: ST1 }),
      rule(R(2), { name: "Etapa sumiu", trigger: "opportunity_stage_changed", condPriority: null, condToStageId: "60000000-0000-0000-0000-0000000000ff" }),
    ]);
    const html = await render();
    expect(html).toContain("Quando uma oportunidade entrar na etapa «Qualificar»");
    expect(html).toContain("entrar em uma etapa removida");
  });

  it("responsável: pessoa da equipe pelo nome (ou e-mail), nunca o id", async () => {
    rulesMock.mockResolvedValue([rule(R(1), { assigneeMode: "user", assigneeUserId: BRUNO })]);
    const html = await render();
    expect(html).toContain("responsável: bruno@x.com");
    expect(html).not.toContain(BRUNO);
  });
});

describe("estados vazios", () => {
  it("sem regras e sem histórico", async () => {
    rulesMock.mockResolvedValue([]);
    executionsMock.mockResolvedValue([]);
    const html = await render();
    expect(html).toContain("Nenhuma regra ainda");
    expect(html).toContain("Crie a primeira regra, simule o resultado e ative");
    expect(html).toContain("Nenhuma execução ainda");
  });

  it("para o gerente, o vazio não convida a criar", async () => {
    state.role = "manager";
    rulesMock.mockResolvedValue([]);
    const html = await render();
    expect(html).toContain("Quando proprietário ou administrador criarem regras");
    expect(html).not.toContain("Crie a primeira regra");
  });
});

describe("histórico", () => {
  it("resultado, tentativa e motivo em texto claro", async () => {
    executionsMock.mockResolvedValue([
      exec("e1"),
      exec("e2", { state: "pending", attemptCount: 2, errorCode: "assignee_not_member", nextAttemptAt: "2026-11-10T12:10:00+00:00", finishedAt: null }),
      exec("e3", { state: "dead_letter", attemptCount: 4, errorCode: "assignee_no_access" }),
      exec("e4", { state: "cancelled", attemptCount: 0, errorCode: "rule_inactive" }),
      exec("e5", { state: "pending", attemptCount: 0, finishedAt: null, lastAttemptAt: null, nextAttemptAt: "2026-11-10T12:00:00+00:00" }),
    ]);
    const html = await render();
    const table = /<table[\s\S]*?<\/table>/.exec(html.slice(html.indexOf("Histórico de execuções")))?.[0] ?? "";
    expect(table).toContain("Concluída");
    expect(table).toContain("Nova tentativa agendada para");
    expect(table).toContain("2 de 4");
    expect(table).toContain("Falhou (sem novas tentativas)");
    expect(table).toContain("4 de 4");
    expect(table).toContain("O responsável não é mais um membro ativo do workspace.");
    expect(table).toContain("O responsável não tem acesso a este lead.");
    expect(table).toContain("Cancelada");
    expect(table).toContain("A regra foi pausada ou arquivada antes da execução.");
    expect(table).toContain("Aguardando");
  });

  it("não mostra identificadores nem texto fora dos códigos", async () => {
    executionsMock.mockResolvedValue([exec("e1", { errorCode: null, activityId: "a1000000-0000-0000-0000-000000000001" })]);
    const html = await render();
    expect(html).not.toContain("a1000000-0000-0000-0000-000000000001");
    expect(html).not.toMatch(/sk_live|SEGREDO|@exemplo/);
  });
});
