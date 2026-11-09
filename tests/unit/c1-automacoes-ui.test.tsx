/**
 * C1 — interação: o cartão da regra (simular, ativar só com simulação atual,
 * pausar, arquivar em dois passos) e o formulário (campos por gatilho, estado
 * limpo a cada abertura, erro sanitizado, nada de campo livre).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { simulateMock, statusMock, saveMock, processMock } = vi.hoisted(() => ({
  simulateMock: vi.fn(),
  statusMock: vi.fn(),
  saveMock: vi.fn(),
  processMock: vi.fn(),
}));

vi.mock("@/modules/automations/actions", () => ({
  simulateAutomationRuleAction: simulateMock,
  setAutomationRuleStatusAction: statusMock,
  saveAutomationRuleAction: saveMock,
  processAutomationsAction: processMock,
}));

import { ProcessNowButton } from "@/components/automations/process-now-button";
import { AutomationRuleCard } from "@/components/automations/rule-card";
import { AutomationRuleFormDialog } from "@/components/automations/rule-form-dialog";
import type { AutomationRule, AutomationStageOption } from "@/modules/automations/queries";

const RULE_ID = "70000000-0000-0000-0000-000000000001";
const ST1 = "60000000-0000-0000-0000-000000000001";
const ST_WON = "60000000-0000-0000-0000-000000000009";
const BRUNO = "20000000-0000-0000-0000-000000000002";

const STAGES: AutomationStageOption[] = [
  { id: ST1, label: "Qualificar", terminal: false },
  { id: ST_WON, label: "Ganho", terminal: true },
];
const MEMBERS = [
  { userId: "20000000-0000-0000-0000-000000000001", name: "Ana Owner" },
  { userId: BRUNO, name: "Bruno Admin" },
];

const baseRule: AutomationRule = {
  id: RULE_ID,
  name: "Retorno",
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
};

const SIM = {
  version: 1,
  window_days: 30,
  match_count: 7,
  sample: [
    { date: "2026-11-09", priority: "alta", legal_area: "Trabalhista", due_date: "2026-11-11", assignee: "ok" },
    { date: "2026-11-08", priority: "media", legal_area: null, due_date: "2026-11-10", assignee: "invalid" },
  ],
  sample_invalid: 1,
};

function card(rule: Partial<AutomationRule> = {}, canManage = true) {
  return (
    <ul>
      <AutomationRuleCard
        rule={{ ...baseRule, ...rule }}
        triggerText="Quando um lead for criado com prioridade alta"
        actionText="Criar a atividade «Retornar o contato»"
        canManage={canManage}
        stages={STAGES}
        members={MEMBERS}
      />
    </ul>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  simulateMock.mockResolvedValue({ ok: true, simulation: SIM });
  statusMock.mockResolvedValue({ ok: true });
  saveMock.mockResolvedValue({ ok: true, ruleId: RULE_ID });
  processMock.mockResolvedValue({ ok: true, events: 2, executions: 1 });
});
afterEach(cleanup);

describe("cartão da regra", () => {
  it("simular mostra contagem e prévia sem identificação, e avisa do responsável inválido", async () => {
    render(card());
    fireEvent.click(screen.getByRole("button", { name: "Simular" }));
    await waitFor(() => expect(screen.getByText(/7 registro\(s\) compatíveis nos últimos 30 dias/)).toBeInTheDocument());
    expect(simulateMock).toHaveBeenCalledWith(RULE_ID);
    expect(screen.getByText(/Nada foi criado nem alterado/)).toBeInTheDocument();
    expect(screen.getByText(/não mostra nomes nem dados de contato/)).toBeInTheDocument();
    expect(screen.getByText("Trabalhista")).toBeInTheDocument();
    expect(screen.getByText("Válido")).toBeInTheDocument();
    expect(screen.getByText("Inválido: a execução falharia")).toBeInTheDocument();
    expect(screen.getByText(/Em 1 exemplo\(s\) o responsável seria inválido/)).toBeInTheDocument();
  });

  it("simulação recusada mostra o erro sanitizado e nada de prévia", async () => {
    simulateMock.mockResolvedValue({ ok: false, error: "Regra não encontrada." });
    render(card());
    fireEvent.click(screen.getByRole("button", { name: "Simular" }));
    await waitFor(() => expect(screen.getByText("Regra não encontrada.")).toBeInTheDocument());
    expect(screen.queryByText(/compatíveis nos últimos/)).not.toBeInTheDocument();
  });

  it("ativar fica desabilitado sem simulação da versão atual e habilitado com ela", () => {
    const { rerender } = render(card());
    expect(screen.getByRole("button", { name: "Ativar" })).toBeDisabled();
    expect(screen.getByText("Simule a versão atual para poder ativar.")).toBeInTheDocument();

    rerender(card({ simulationCurrent: true, simulatedAt: "2026-11-10T10:00:00+00:00", simulatedCount: 7 }));
    expect(screen.getByRole("button", { name: "Ativar" })).toBeEnabled();
    expect(screen.queryByText("Simule a versão atual para poder ativar.")).not.toBeInTheDocument();
  });

  it("ativar chama a ação; uma recusa do banco aparece e não some em silêncio", async () => {
    statusMock.mockResolvedValue({ ok: false, error: "Simule a regra (versão atual) antes de ativá-la." });
    render(card({ simulationCurrent: true, simulatedAt: "2026-11-10T10:00:00+00:00", simulatedCount: 7 }));
    fireEvent.click(screen.getByRole("button", { name: "Ativar" }));
    await waitFor(() => expect(statusMock).toHaveBeenCalledWith(RULE_ID, "active"));
    await waitFor(() => expect(screen.getByText("Simule a regra (versão atual) antes de ativá-la.")).toBeInTheDocument());
  });

  it("regra ativa oferece pausar (e não ativar); pausada oferece reativar", async () => {
    const { rerender } = render(card({ status: "active", simulationCurrent: true, simulatedAt: "2026-11-10T10:00:00+00:00" }));
    expect(screen.queryByRole("button", { name: "Ativar" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pausar" }));
    await waitFor(() => expect(statusMock).toHaveBeenCalledWith(RULE_ID, "paused"));

    rerender(card({ status: "paused", simulationCurrent: false, simulatedAt: "2026-11-10T10:00:00+00:00" }));
    expect(screen.getByRole("button", { name: "Reativar" })).toBeDisabled();
  });

  it("arquivar exige uma segunda confirmação (é terminal) e pode ser cancelado", async () => {
    render(card());
    fireEvent.click(screen.getByRole("button", { name: "Arquivar" }));
    expect(statusMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.getByRole("button", { name: "Arquivar" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Arquivar" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar arquivamento" }));
    await waitFor(() => expect(statusMock).toHaveBeenCalledWith(RULE_ID, "archived"));
  });

  it("regra arquivada e quem só consulta não têm nenhum botão", () => {
    const { rerender } = render(card({ status: "archived" }));
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText(/Regra arquivada/)).toBeInTheDocument();

    rerender(card({}, false));
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("formulário da regra", () => {
  function open(rule?: AutomationRule) {
    render(
      <AutomationRuleFormDialog
        {...(rule ? { rule } : {})}
        stages={STAGES}
        members={MEMBERS}
        trigger={<button type="button">Abrir formulário</button>}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Abrir formulário" }));
    return screen.getByRole("dialog");
  }
  const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement & HTMLSelectElement;

  it("lead criado mostra prioridade e área; etapa mostra destino e origem (e some o resto)", () => {
    open();
    expect(field("Prioridade do lead (opcional)")).toBeInTheDocument();
    expect(field("Área jurídica (opcional)")).toBeInTheDocument();
    expect(screen.queryByLabelText("Etapa de destino")).not.toBeInTheDocument();

    fireEvent.change(field("Gatilho"), { target: { value: "opportunity_stage_changed" } });
    expect(field("Etapa de destino")).toBeInTheDocument();
    expect(field("Vinda de (opcional)")).toBeInTheDocument();
    expect(screen.queryByLabelText("Prioridade do lead (opcional)")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Área jurídica (opcional)")).not.toBeInTheDocument();
  });

  it("etapa de ganho/perda não é oferecida como destino", () => {
    open();
    fireEvent.change(field("Gatilho"), { target: { value: "opportunity_stage_changed" } });
    const destino = within(field("Etapa de destino")).getAllByRole("option").map((o) => o.textContent);
    expect(destino).toEqual(["Escolha a etapa", "Qualificar"]);
    const origem = within(field("Vinda de (opcional)")).getAllByRole("option").map((o) => o.textContent);
    expect(origem).toContain("Ganho");
  });

  it("a pessoa específica só aparece quando o modo é 'Pessoa específica'", () => {
    open();
    expect(screen.queryByLabelText("Pessoa")).not.toBeInTheDocument();
    fireEvent.change(field("Responsável"), { target: { value: "user" } });
    expect(within(field("Pessoa")).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Escolha uma pessoa",
      "Ana Owner",
      "Bruno Admin",
    ]);
  });

  it("criar envia só os campos do gatilho escolhido e fecha ao salvar", async () => {
    open();
    fireEvent.change(field("Nome da regra"), { target: { value: "Preparar" } });
    fireEvent.change(field("Gatilho"), { target: { value: "opportunity_stage_changed" } });
    fireEvent.change(field("Etapa de destino"), { target: { value: ST1 } });
    fireEvent.change(field("Título"), { target: { value: "Preparar a qualificação" } });
    fireEvent.change(field("Prazo (dias)"), { target: { value: "0" } });
    fireEvent.change(field("Responsável"), { target: { value: "user" } });
    fireEvent.change(field("Pessoa"), { target: { value: BRUNO } });
    fireEvent.click(screen.getByRole("button", { name: "Criar como rascunho" }));

    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    const data = saveMock.mock.calls[0]?.[0] as FormData;
    expect(Object.fromEntries(data.entries())).toEqual({
      name: "Preparar",
      trigger: "opportunity_stage_changed",
      condToStageId: ST1,
      condFromStageId: "",
      actionTitle: "Preparar a qualificação",
      actionDueDays: "0",
      actionPriority: "media",
      assigneeMode: "user",
      assigneeUserId: BRUNO,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("recusa do servidor aparece no formulário, que continua aberto", async () => {
    saveMock.mockResolvedValue({ ok: false, error: "Informe o nome da regra." });
    open();
    fireEvent.click(screen.getByRole("button", { name: "Criar como rascunho" }));
    await waitFor(() => expect(screen.getByText("Informe o nome da regra.")).toBeInTheDocument());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("editar traz os valores da regra, avisa da simulação e envia o id", async () => {
    open({ ...baseRule, status: "active", name: "Retorno atual", simulationCurrent: true });
    expect(field("Nome da regra").value).toBe("Retorno atual");
    expect(field("Prioridade do lead (opcional)").value).toBe("alta");
    expect(screen.getByText(/invalida a simulação e pausa a regra/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    const data = saveMock.mock.calls[0]?.[0] as FormData;
    expect(data.get("ruleId")).toBe(RULE_ID);
    expect(data.get("name")).toBe("Retorno atual");
  });

  it("cada abertura começa limpa (um valor digitado e cancelado não volta)", () => {
    open();
    fireEvent.change(field("Nome da regra"), { target: { value: "rascunho abandonado" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    fireEvent.click(screen.getByRole("button", { name: "Abrir formulário" }));
    expect(field("Nome da regra").value).toBe("");
  });

  it("não existe campo livre de expressão, SQL ou código", () => {
    open();
    const labels = screen.getAllByRole("textbox").map((el) => el.getAttribute("id"));
    expect(labels.sort()).toEqual(["automation-cond-area", "automation-days", "automation-name", "automation-title"]);
    expect(screen.queryByRole("textbox", { name: /sql|expressão|código|script/i })).not.toBeInTheDocument();
  });
});

describe("processar agora", () => {
  it("mostra só contagens", async () => {
    render(<ProcessNowButton />);
    fireEvent.click(screen.getByRole("button", { name: "Processar agora" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2 evento(s) lido(s) e 1 execução(ões) tentada(s)."));
  });

  it("sem pendências e em caso de erro", async () => {
    processMock.mockResolvedValueOnce({ ok: true, events: 0, executions: 0 });
    render(<ProcessNowButton />);
    fireEvent.click(screen.getByRole("button", { name: "Processar agora" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Nada pendente agora."));

    processMock.mockResolvedValueOnce({ ok: false, error: "Você não tem permissão para fazer isso." });
    fireEvent.click(screen.getByRole("button", { name: "Processar agora" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Você não tem permissão para fazer isso."));
  });
});
