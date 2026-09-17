import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A10 — Visão geral: regras de apresentação, leitura da RPC e o que cada
 * papel enxerga na tela. Os números em si são testados no banco
 * (supabase/tests/database/16_a10_dashboard.test.sql).
 */

type Result = { data: unknown; error: { message: string } | null };

const state = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpc: (() => ({ data: null, error: null })) as (fn: string, args: Record<string, unknown>) => Result,
}));

vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.calls.push({ fn, args });
      return state.rpc(fn, args);
    },
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/modules/activities/actions", () => ({ completeActivityAction: vi.fn() }));

const { DataLoadError } = await import("@/server/data/load-error");
const { getDashboard, mapDashboard } = await import("@/modules/dashboard/queries");
const { parseDashboardFilters, dashboardHref } = await import("@/modules/dashboard/schema");
const presentation = await import("@/modules/dashboard/presentation");
const { PeriodKpis, SecondaryStrip, AttentionBanner } = await import("@/components/dashboard/metric-cards");
const { SeriesCard } = await import("@/components/dashboard/series-card");
const { AttentionList } = await import("@/components/dashboard/attention-list");
const { FunnelCard } = await import("@/components/dashboard/funnel-card");

const WS = "10000000-0000-0000-0000-000000000010";
/** Intl usa espaço não separável depois de "R$". */
const plain = (s: string | null | undefined) => (s ?? "").replace(/ /g, " ");
const PIPE = "50000000-0000-0000-0000-000000000010";

function rawDashboard(role: "owner" | "sales" | "viewer"): Record<string, unknown> {
  const money = role === "owner";
  const item: Record<string, unknown> = {
    id: "c1000000-0000-0000-0000-000000000002",
    lead_id: "b1000000-0000-0000-0000-000000000002",
    contact_name: "Contato Único",
    legal_area: "Família",
    stage_name: "Verificar aderência e conflito",
    assigned_to_name: "Otávio",
    stage_entered_at: "2026-09-01T12:00:00Z",
    is_stalled: true,
    is_unassigned: false,
    overdue_activities_count: 1,
    next_action: null,
  };
  if (money) Object.assign(item, { value_cents: 1234500, fee_model: "fixed", probability: 30, forecast_date: null });
  if (role === "sales") item.value_band = "R$ 10.000–25.000";

  return {
    role,
    is_demo: true,
    generated_at: "2026-09-16T15:00:00Z",
    stalled_days: 5,
    period: {
      days: 30,
      current_start: "2026-08-18T03:00:00+00:00",
      current_end: "2026-09-17T03:00:00+00:00",
      previous_start: "2026-07-19T03:00:00+00:00",
      previous_end: "2026-08-18T03:00:00+00:00",
      today: "2026-09-16",
    },
    legal_areas: ["Família"],
    pipelines: [{ id: PIPE, name: "Comercial", is_default: true }],
    period_metrics: {
      leads_received: { current: 12, previous: 8 },
      consultations_done: { current: 3, previous: 0 },
      proposals_sent: { current: 2, previous: 4 },
      opportunities_won: { current: 1, previous: 1 },
      days_to_win: { current: 97, previous: null },
      ...(money ? { won_value_cents: { current: 1234500, previous: 0 } } : {}),
    },
    cohort: { leads: 12, leads_with_won: 3 },
    positions: {
      open_opportunities: 1,
      stalled_opportunities: 1,
      unassigned_open_opportunities: 0,
      open_without_next_action: 1,
      overdue_activities: 1,
      opportunities_with_overdue: 1,
      attention_opportunities: 1,
      today_activities: 0,
      today_activities_pending: 0,
      ...(money ? { open_value_cents: 1234500, open_without_value: 0, attention_value_cents: 1234500 } : {}),
    },
    attention: { total: 1, items: [item] },
    agenda_today: { total: 0, items: [] },
    series: {
      bucket_days: 5,
      won: [{ start_date: "2026-09-12", last_date: "2026-09-16", count: 1, ...(money ? { value_cents: 1234500 } : {}) }],
      ...(money
        ? {
            forecast: {
              buckets: [{ start_date: "2026-09-16", last_date: "2026-09-20", count: 0, value_cents: 0 }],
              past_due: 0,
              without_date: 1,
              without_value: 0,
            },
          }
        : {}),
    },
    team: [],
    funnel: {
      pipeline_id: PIPE,
      pipeline_name: "Comercial",
      cohort_size: 2,
      cohort_won: 0,
      cohort_lost: 1,
      cohort_open: 1,
      stages: [
        { stage_id: "s0", name: "Fazer primeiro contato", position: 0, open_now: 0, visited: 2, advanced: 2, cohort_open_here: 0, cohort_lost_here: 0, cohort_won_here: 0, ...(money ? { value_sum_cents: 0 } : {}) },
        { stage_id: "s1", name: "Qualificar oportunidade", position: 1, open_now: 0, visited: 2, advanced: 1, cohort_open_here: 0, cohort_lost_here: 1, cohort_won_here: 0, ...(money ? { value_sum_cents: 0 } : {}) },
        { stage_id: "s2", name: "Verificar aderência e conflito", position: 2, open_now: 1, visited: 1, advanced: 0, cohort_open_here: 1, cohort_lost_here: 0, cohort_won_here: 0, ...(money ? { value_sum_cents: 1234500 } : {}) },
      ],
    },
    insight_data: { stalled_top_stage: null, cohort_lost_top_reason: null, cohort_lost_total: 1 },
  };
}

beforeEach(() => {
  state.calls = [];
  state.rpc = () => ({ data: null, error: null });
});

describe("variação contra o período anterior", () => {
  it("base anterior zero não vira percentual: mostra —", () => {
    expect(presentation.computeDelta(5, 0)).toEqual({ kind: "none" });
    expect(presentation.formatDelta(presentation.computeDelta(0, 0))).toBe("—");
  });

  it("calcula alta, queda e estabilidade", () => {
    expect(presentation.formatDelta(presentation.computeDelta(12, 8))).toBe("+50%");
    expect(presentation.formatDelta(presentation.computeDelta(2, 4))).toBe("−50%");
    expect(presentation.formatDelta(presentation.computeDelta(3, 3))).toBe("0%");
  });
});

describe("formatação", () => {
  it("dinheiro em reais, com centavos só quando existem", () => {
    expect(plain(presentation.formatBRL(18450000))).toBe("R$ 184.500");
    expect(plain(presentation.formatBRL(1050))).toBe("R$ 10,50");
  });

  it("faixa de datas da série e dias até o ganho", () => {
    expect(presentation.bucketLabel("2026-09-01", "2026-09-05")).toBe("01/09–05/09");
    expect(presentation.bucketLabel("2026-09-16", "2026-09-16")).toBe("16/09");
    expect(presentation.formatDays(null)).toBe("—");
    expect(presentation.formatDays(25.6)).toBe("25,6 dias");
  });

  it("percentual sem denominador não é calculado", () => {
    expect(presentation.formatPercent(1, 0)).toBeNull();
    expect(presentation.formatPercent(3, 12)).toBe("25%");
  });
});

describe("filtros da URL", () => {
  it("valores inválidos caem no padrão, sem erro", () => {
    expect(parseDashboardFilters({ periodo: "15", responsavel: "x' or 1=1", pipeline: "abc", op: "1" })).toEqual({
      periodDays: 30,
      assignedTo: null,
      onlyUnassigned: false,
      legalArea: null,
      pipelineId: null,
      selectedOpportunityId: null,
    });
  });

  it("aceita período, responsável, 'sem responsável', área e pipeline válidos", () => {
    const f = parseDashboardFilters({ periodo: "90", responsavel: "sem", area: " Família ", pipeline: PIPE });
    expect(f).toMatchObject({ periodDays: 90, assignedTo: null, onlyUnassigned: true, legalArea: "Família", pipelineId: PIPE });
    expect(dashboardHref(f, { selectedOpportunityId: WS })).toBe(
      `/visao-geral?periodo=90&responsavel=sem&area=Fam%C3%ADlia&pipeline=${PIPE}&op=${WS}`,
    );
    expect(dashboardHref(parseDashboardFilters({}))).toBe("/visao-geral");
  });
});

describe("getDashboard", () => {
  const filters = parseDashboardFilters({ periodo: "7", responsavel: WS, area: "Família", pipeline: PIPE });

  it("falha da consulta lança erro tratável — nunca devolve zeros", async () => {
    state.rpc = () => ({ data: null, error: { message: "canceling statement due to statement timeout" } });
    await expect(getDashboard(WS, filters)).rejects.toBeInstanceOf(DataLoadError);
  });

  it("resposta vazia também é falha, não painel zerado", async () => {
    state.rpc = () => ({ data: null, error: null });
    await expect(getDashboard(WS, filters)).rejects.toBeInstanceOf(DataLoadError);
  });

  it("envia os filtros à RPC e volta ao pipeline padrão se o da URL não existe mais", async () => {
    state.rpc = (_fn, args) =>
      args.p_pipeline_id ? { data: null, error: { message: "pipeline_not_found" } } : { data: rawDashboard("owner"), error: null };
    const d = await getDashboard(WS, filters);
    expect(d.metrics.leadsReceived.current).toBe(12);
    expect(state.calls[0]).toEqual({
      fn: "get_dashboard",
      args: {
        p_workspace_id: WS,
        p_period_days: 7,
        p_assigned_to: WS,
        p_only_unassigned: false,
        p_legal_area: "Família",
        p_pipeline_id: PIPE,
      },
    });
    expect(state.calls[1]!.args).not.toHaveProperty("p_pipeline_id");
  });

  it("não inventa campos financeiros ausentes do payload (sales/viewer)", () => {
    for (const role of ["sales", "viewer"] as const) {
      const d = mapDashboard(rawDashboard(role));
      const serialized = JSON.stringify(d);
      expect(serialized).not.toMatch(/cents|forecast/i);
      expect(d.metrics.wonValueCents).toBeUndefined();
      expect(d.positions.openValueCents).toBeUndefined();
    }
    expect(mapDashboard(rawDashboard("sales")).attention.items[0]!.valueBand).toBe("R$ 10.000–25.000");
    expect(JSON.stringify(mapDashboard(rawDashboard("viewer")))).not.toContain("valueBand");
  });
});

describe("tela por papel", () => {
  function renderBlocks(role: "owner" | "sales" | "viewer") {
    const d = mapDashboard(rawDashboard(role));
    return render(
      <div>
        <PeriodKpis dashboard={d} />
        <SecondaryStrip dashboard={d} />
        <AttentionBanner dashboard={d} />
        <SeriesCard dashboard={d} />
        <FunnelCard dashboard={d} pipelineHrefs={{}} />
        <AttentionList dashboard={d} hrefFor={{}} selectedId={null} />
      </div>,
    );
  }

  it("owner vê honorários, valor em negociação e a série em reais", () => {
    const { container } = renderBlocks("owner");
    expect(screen.getByText("Honorários das ganhas")).toBeInTheDocument();
    expect(screen.getByText("Valor em negociação")).toBeInTheDocument();
    expect(plain(container.textContent)).toContain("R$ 12.345");
    expect(screen.getByRole("group", { name: "Série exibida" })).toBeInTheDocument();
  });

  it("sales vê contagens e só a faixa da oportunidade individual", () => {
    const { container } = renderBlocks("sales");
    const text = plain(container.textContent);
    expect(screen.queryByText("Honorários das ganhas")).toBeNull();
    expect(screen.queryByText("Valor em negociação")).toBeNull();
    expect(screen.queryByRole("group", { name: "Série exibida" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Oportunidades ganhas" })).toBeInTheDocument();
    // Única menção a reais é a faixa da oportunidade da lista.
    expect(text.match(/R\$/g)).toHaveLength(1);
    expect(text).toContain("R$ 10.000–25.000");
    expect(screen.getByText("1 oportunidade precisa de atenção")).toBeInTheDocument();
  });

  it("viewer não vê valor nem faixa", () => {
    const { container } = renderBlocks("viewer");
    expect(container.textContent).not.toContain("R$");
  });

  it("período sem base mostra — e indicadores de posição não têm comparação", () => {
    renderBlocks("owner");
    const consultas = screen.getByText("Consultas realizadas").closest("div")!;
    expect(within(consultas).getByText("— sem base no período anterior")).toBeInTheDocument();
    expect(screen.getByText("Leads recebidos").closest("div")!.textContent).toContain("+50% vs período anterior");
    const abertas = screen.getByText("Oportunidades abertas").closest("div")!;
    expect(abertas.textContent).not.toMatch(/anterior/);
  });
});

describe("insights só com dados suficientes", () => {
  it("abaixo do mínimo, nada é dito", () => {
    const d = mapDashboard(rawDashboard("owner"));
    expect(presentation.buildInsights(d)).toEqual([]);
  });

  it("acima do mínimo, cada insight traz a base", () => {
    const raw = rawDashboard("owner");
    raw.positions = { ...(raw.positions as object), open_opportunities: 10, open_without_next_action: 4, stalled_opportunities: 5 };
    raw.insight_data = {
      stalled_top_stage: { stage_name: "Agendar consulta", count: 3 },
      cohort_lost_top_reason: { label: "Sem retorno do cliente", count: 2 },
      cohort_lost_total: 4,
    };
    const insights = presentation.buildInsights(mapDashboard(raw));
    expect(insights.map((i) => i.id)).toEqual(["sem-proxima-acao", "etapa-parada", "motivo-perda"]);
    expect(insights[0]!.text).toBe("4 de 10 oportunidades abertas estão sem próxima atividade agendada.");
    expect(insights.every((i) => i.basis.length > 0)).toBe(true);
  });
});
