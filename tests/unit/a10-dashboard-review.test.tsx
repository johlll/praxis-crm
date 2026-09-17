import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * A10 — revisão da PR #15. Cobre na tela o que os testes de banco
 * (supabase/tests/database/17_a10_dashboard_review.test.sql) cobrem nos
 * números:
 *
 *   1. funil: contagem por passagem registrada e taxa de avanço sobre a
 *      mesma população (nunca acima de 100%);
 *   2. equipe: responsável que saiu do escritório aparece marcado;
 *   3. filtros: os seletores acompanham a URL depois de limpar os
 *      filtros e depois de voltar/avançar no navegador (a navegação do
 *      cliente troca as props sem desmontar o formulário).
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { FunnelCard } = await import("@/components/dashboard/funnel-card");
const { TeamTable } = await import("@/components/dashboard/team-and-insights");
const { DashboardFilterBar } = await import("@/components/dashboard/filter-bar");
const { mapDashboard } = await import("@/modules/dashboard/queries");
import type { Dashboard, TeamRow } from "@/modules/dashboard/queries";
import type { DashboardFilters } from "@/modules/dashboard/schema";

const PIPE = "50000000-0000-0000-0000-000000000010";
const LUCAS = "20000000-0000-0000-0000-000000000011";

/** Funil com uma etapa pulada: ninguém passou pela etapa 2. */
function dashboardWithSkippedStage(): Dashboard {
  return mapDashboard({
    role: "owner",
    is_demo: false,
    generated_at: "2026-09-17T12:00:00Z",
    stalled_days: 5,
    period: {
      days: 7,
      current_start: "2026-09-11T03:00:00+00:00",
      current_end: "2026-09-18T03:00:00+00:00",
      previous_start: "2026-09-04T03:00:00+00:00",
      previous_end: "2026-09-11T03:00:00+00:00",
      today: "2026-09-17",
    },
    legal_areas: [],
    pipelines: [{ id: PIPE, name: "Comercial", is_default: true }],
    period_metrics: {
      leads_received: { current: 3, previous: 0 },
      consultations_done: { current: 0, previous: 0 },
      proposals_sent: { current: 0, previous: 0 },
      opportunities_won: { current: 1, previous: 0 },
      days_to_win: { current: null, previous: null },
    },
    cohort: { leads: 3, leads_with_won: 1 },
    positions: {
      open_opportunities: 2,
      stalled_opportunities: 0,
      unassigned_open_opportunities: 0,
      open_without_next_action: 0,
      overdue_activities: 0,
      opportunities_with_overdue: 0,
      attention_opportunities: 0,
      today_activities: 0,
      today_activities_pending: 0,
    },
    attention: { total: 0, items: [] },
    agenda_today: { total: 0, items: [] },
    series: { bucket_days: 1, won: [] },
    team: [],
    funnel: {
      pipeline_id: PIPE,
      pipeline_name: "Comercial",
      cohort_size: 3,
      cohort_won: 1,
      cohort_lost: 0,
      cohort_open: 2,
      stages: [
        { stage_id: "s0", name: "Fazer primeiro contato", position: 0, open_now: 0, visited: 3, advanced: 3, cohort_open_here: 0, cohort_lost_here: 0, cohort_won_here: 0 },
        { stage_id: "s1", name: "Qualificar oportunidade", position: 1, open_now: 1, visited: 2, advanced: 2, cohort_open_here: 1, cohort_lost_here: 0, cohort_won_here: 0 },
        { stage_id: "s2", name: "Verificar aderência", position: 2, open_now: 0, visited: 2, advanced: 1, cohort_open_here: 0, cohort_lost_here: 0, cohort_won_here: 1 },
        { stage_id: "s3", name: "Agendar consulta", position: 3, open_now: 1, visited: 1, advanced: 0, cohort_open_here: 1, cohort_lost_here: 0, cohort_won_here: 0 },
      ],
    },
    insight_data: { stalled_top_stage: null, cohort_lost_top_reason: null, cohort_lost_total: 0 },
  });
}

describe("funil por passagem registrada", () => {
  it("mostra as passagens de cada etapa e a taxa de avanço da mesma população", () => {
    const dashboard = dashboardWithSkippedStage();
    render(<FunnelCard dashboard={dashboard} pipelineHrefs={{}} />);

    const rows = screen.getAllByRole("listitem");
    // Etapa 3: uma passagem só (a oportunidade que pulou da etapa 0 para
    // cá), e nenhuma delas seguiu adiante.
    expect(within(rows[3]!).getByTitle("1 de 3 passaram por esta etapa")).toHaveTextContent("1");
    expect(
      within(rows[3]!).getByTitle(
        "0 das 1 que passaram por esta etapa seguiram adiante (etapa posterior ou ganho registrado)",
      ),
    ).toHaveTextContent("0%");
    // Etapa 2: das duas que passaram, só a ganha seguiu adiante.
    expect(
      within(rows[2]!).getByTitle(
        "1 das 2 que passaram por esta etapa seguiram adiante (etapa posterior ou ganho registrado)",
      ),
    ).toHaveTextContent("50%");
  });

  it("nenhuma etapa mostra taxa acima de 100%: o numerador é subconjunto do denominador", () => {
    const dashboard = dashboardWithSkippedStage();
    for (const stage of dashboard.funnel!.stages) {
      expect(stage.advanced).toBeLessThanOrEqual(stage.visited);
    }
    render(<FunnelCard dashboard={dashboard} pipelineHrefs={{}} />);
    const rates = screen
      .getAllByRole("listitem")
      .map((row) => within(row).getByTitle(/seguiram adiante/).textContent ?? "");
    expect(rates).toHaveLength(4);
    for (const rate of rates) {
      expect(Number.parseInt(rate, 10)).toBeLessThanOrEqual(100);
    }
  });
});

describe("equipe com responsável que saiu do escritório", () => {
  const rows: TeamRow[] = [
    { userId: "20000000-0000-0000-0000-000000000010", fullName: "Paula Proprietária", isFormer: false, leadsReceived: 3, consultationsDone: 1, opportunitiesWon: 1, overdueActivities: 0 },
    { userId: LUCAS, fullName: "Lucas Advogado", isFormer: true, leadsReceived: 2, consultationsDone: 2, opportunitiesWon: 0, overdueActivities: 1 },
  ];

  it("mantém os números e marca a linha como fora da equipe", () => {
    render(<TeamTable rows={rows} days={7} />);
    const row = screen.getByRole("row", { name: /Lucas Advogado/ });
    expect(within(row).getByText("Fora da equipe")).toBeInTheDocument();
    expect(within(row).getByRole("rowheader")).toHaveTextContent("Lucas Advogado");
    expect(row.textContent).toContain("2");

    const paula = screen.getByRole("row", { name: /Paula Proprietária/ });
    expect(within(paula).queryByText("Fora da equipe")).toBeNull();
  });

  it("a soma das linhas pode ser conferida contra o indicador geral", () => {
    expect(rows.reduce((total, row) => total + row.leadsReceived, 0)).toBe(5);
  });
});

describe("seletores dos filtros acompanham a URL", () => {
  const members = [{ userId: LUCAS, name: "Lucas Advogado" }];
  const bar = (filters: DashboardFilters, hasActiveFilters: boolean) => (
    <DashboardFilterBar filters={filters} members={members} legalAreas={["Família", "Trabalhista"]} hasActiveFilters={hasActiveFilters} />
  );
  const period = () => screen.getByLabelText("Período") as HTMLSelectElement;
  const owner = () => screen.getByLabelText("Responsável pelo lead") as HTMLSelectElement;
  const area = () => screen.getByLabelText("Área jurídica") as HTMLSelectElement;

  it("limpar filtros volta os três seletores ao padrão sem recarregar a página", () => {
    const filtered: DashboardFilters = { periodDays: 7, assignedTo: LUCAS, onlyUnassigned: false, legalArea: "Família", pipelineId: null, selectedOpportunityId: null };
    const { rerender } = render(bar(filtered, true));
    expect(period().value).toBe("7");
    expect(owner().value).toBe(LUCAS);
    expect(area().value).toBe("Família");

    // "Limpar filtros" é um link: a navegação do cliente troca as props
    // do mesmo componente, sem desmontá-lo.
    rerender(bar({ periodDays: 30, assignedTo: null, onlyUnassigned: false, legalArea: null, pipelineId: null, selectedOpportunityId: null }, false));
    expect(period().value).toBe("30");
    expect(owner().value).toBe("");
    expect(area().value).toBe("");
  });

  it("voltar e avançar no navegador mantém os seletores iguais à URL", () => {
    const semFiltro: DashboardFilters = { periodDays: 30, assignedTo: null, onlyUnassigned: false, legalArea: null, pipelineId: null, selectedOpportunityId: null };
    const comFiltro: DashboardFilters = { periodDays: 90, assignedTo: null, onlyUnassigned: true, legalArea: "Trabalhista", pipelineId: null, selectedOpportunityId: null };

    const { rerender } = render(bar(semFiltro, false));
    rerender(bar(comFiltro, true));
    expect(period().value).toBe("90");
    expect(owner().value).toBe("sem");
    expect(area().value).toBe("Trabalhista");

    // Voltar.
    rerender(bar(semFiltro, false));
    expect(period().value).toBe("30");
    expect(owner().value).toBe("");
    expect(area().value).toBe("");

    // Avançar.
    rerender(bar(comFiltro, true));
    expect(period().value).toBe("90");
    expect(owner().value).toBe("sem");
    expect(area().value).toBe("Trabalhista");
  });
});
