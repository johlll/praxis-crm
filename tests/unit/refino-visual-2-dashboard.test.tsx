import { act, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Refinamento visual 2 — Visão geral com gráficos. Os números continuam
 * vindo só de public.get_dashboard / get_dashboard_attribution; aqui se
 * prova que a apresentação nova não inventa, não muda denominador e não
 * mostra dinheiro a quem não recebe dinheiro.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const presentation = await import("@/modules/dashboard/presentation");
const { mapDashboard } = await import("@/modules/dashboard/queries");
const { SeriesCard } = await import("@/components/dashboard/series-card");
const { AttributionCard } = await import("@/components/dashboard/attribution-card");
const { PeriodKpis } = await import("@/components/dashboard/metric-cards");
const { FunnelCard } = await import("@/components/dashboard/funnel-card");
const { ChartFrame } = await import("@/components/charts/chart-frame");
import type { DashboardAttribution } from "@/modules/attribution/queries";
import type { Route } from "next";

const plain = (s: string | null | undefined) => (s ?? "").replace(/ /g, " ");

function raw(role: "owner" | "sales", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const money = role === "owner";
  return {
    role,
    is_demo: false,
    generated_at: "2026-11-16T12:00:00Z",
    stalled_days: 5,
    period: {
      days: 30,
      current_start: "2026-10-18T03:00:00+00:00",
      current_end: "2026-11-17T03:00:00+00:00",
      previous_start: "2026-09-18T03:00:00+00:00",
      previous_end: "2026-10-18T03:00:00+00:00",
      today: "2026-11-16",
    },
    legal_areas: [],
    pipelines: [{ id: "p1", name: "Comercial", is_default: true }],
    period_metrics: {
      leads_received: { current: 30, previous: 10 },
      consultations_done: { current: 15, previous: 0 },
      proposals_sent: { current: 15, previous: 2 },
      opportunities_won: { current: 4, previous: 3 },
      days_to_win: { current: 25.3, previous: 7 },
      ...(money ? { won_value_cents: { current: 14750000, previous: 7500000 } } : {}),
    },
    cohort: { leads: 30, leads_with_won: 3 },
    positions: {
      open_opportunities: 43,
      stalled_opportunities: 8,
      unassigned_open_opportunities: 10,
      open_without_next_action: 14,
      overdue_activities: 11,
      opportunities_with_overdue: 11,
      attention_opportunities: 25,
      today_activities: 13,
      today_activities_pending: 10,
      ...(money ? { open_value_cents: 109350000, open_without_value: 6, attention_value_cents: 66650000 } : {}),
    },
    attention: { total: 0, items: [] },
    agenda_today: { total: 0, items: [] },
    series: {
      bucket_days: 5,
      won: [
        { start_date: "2026-10-18", last_date: "2026-10-22", count: 0, ...(money ? { value_cents: 0 } : {}) },
        { start_date: "2026-10-23", last_date: "2026-10-27", count: 1, ...(money ? { value_cents: 2000000 } : {}) },
        { start_date: "2026-11-12", last_date: "2026-11-16", count: 2, ...(money ? { value_cents: 8750000 } : {}) },
      ],
      ...(money
        ? {
            forecast: {
              buckets: [
                { start_date: "2026-11-16", last_date: "2026-11-20", count: 3, value_cents: 4500000 },
                { start_date: "2026-11-21", last_date: "2026-11-25", count: 0, value_cents: 0 },
              ],
              past_due: 2,
              without_date: 5,
              without_value: 1,
            },
          }
        : {}),
    },
    team: [],
    funnel: {
      pipeline_id: "p1",
      pipeline_name: "Comercial",
      cohort_size: 29,
      cohort_won: 3,
      cohort_lost: 5,
      cohort_open: 21,
      stages: [
        { stage_id: "s0", name: "Fazer primeiro contato", position: 0, open_now: 4, visited: 29, advanced: 26, cohort_open_here: 3, cohort_lost_here: 0, cohort_won_here: 0 },
        { stage_id: "s1", name: "Qualificar oportunidade", position: 1, open_now: 6, visited: 26, advanced: 24, cohort_open_here: 2, cohort_lost_here: 0, cohort_won_here: 0 },
      ],
    },
    insight_data: { stalled_top_stage: null, cohort_lost_top_reason: null, cohort_lost_total: 0 },
    ...overrides,
  };
}

const attribution = (sources: DashboardAttribution["sources"], extra: Partial<DashboardAttribution> = {}): DashboardAttribution => ({
  model: "first_touch",
  periodDays: 30,
  source: null,
  unit: "opportunity",
  createdInPeriod: sources.reduce((s, r) => s + r.created, 0),
  wonInPeriod: sources.reduce((s, r) => s + r.won, 0),
  unattributedCreated: 0,
  sources,
  ...extra,
});

const hrefs = (sources: DashboardAttribution["sources"]) =>
  Object.fromEntries(sources.map((s) => [s.source ?? "__sem_origem__", `/visao-geral?origem=${encodeURIComponent(s.source ?? "__sem_origem__")}` as Route]));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("série: cada ponto é exatamente uma faixa da RPC", () => {
  it("mantém ordem, faixa e contagem; valor só quando o servidor mandou", () => {
    const owner = mapDashboard(raw("owner"));
    const points = presentation.buildSeriesPoints(owner.series.won);
    expect(points.map((p) => [p.tick, p.range, p.count, p.valueCents])).toEqual([
      ["18/10", "18/10–22/10", 0, 0],
      ["23/10", "23/10–27/10", 1, 2000000],
      ["12/11", "12/11–16/11", 2, 8750000],
    ]);
    const sales = presentation.buildSeriesPoints(mapDashboard(raw("sales")).series.won);
    expect(sales.every((p) => !("valueCents" in p))).toBe(true);
  });

  it("série toda zerada é vazia; uma faixa com registro já não é", () => {
    expect(presentation.seriesIsEmpty(presentation.buildSeriesPoints([{ startDate: "2026-11-01", lastDate: "2026-11-05", count: 0, valueCents: 0 }]))).toBe(true);
    expect(presentation.seriesIsEmpty(presentation.buildSeriesPoints([{ startDate: "2026-11-01", lastDate: "2026-11-05", count: 1 }]))).toBe(false);
    expect(presentation.seriesIsEmpty([])).toBe(true);
  });
});

describe("origem: denominador, ordem e cores", () => {
  const sources = [
    { source: null, created: 3, won: 2 },
    { source: "google", created: 6, won: 1 },
    { source: "indicação", created: 6, won: 1 },
    { source: "site do escritório", created: 10, won: 0 },
    { source: "instagram", created: 4, won: 0 },
  ];

  it("o denominador é a soma das criadas, e as fatias somam 100%", () => {
    const b = presentation.buildOriginBreakdown(sources);
    expect(b.totalCreated).toBe(29);
    expect(b.segments.reduce((s, x) => s + x.created, 0)).toBe(29);
    expect(b.segments.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 10);
    // "Ganhas" é outra população (ganhas no período): nunca entra na rosca.
    expect(b.segments.some((s) => "won" in s)).toBe(false);
  });

  it("maior primeiro, na ordem fixa da paleta; 'Não informada' por último, no neutro", () => {
    const b = presentation.buildOriginBreakdown(sources);
    expect(b.segments.map((s) => [s.label, s.color])).toEqual([
      ["site do escritório", "chart1"],
      ["google", "chart2"],
      ["indicação", "chart3"],
      ["instagram", "chart4"],
      ["Não informada", "neutral"],
    ]);
    expect(b.showDonut).toBe(true);
  });

  it("mais de seis origens: as cinco maiores mantêm cor e o resto vira 'Outras origens', cada uma ainda na tabela", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ source: `origem ${i + 1}`, created: 20 - i, won: 0 }));
    const b = presentation.buildOriginBreakdown(many);
    expect(b.segments).toHaveLength(6);
    expect(b.segments.at(-1)).toMatchObject({ label: "Outras origens", color: "chart6", created: 15 + 14 + 13 });
    expect(b.rows).toHaveLength(8);
    expect(b.rows.filter((r) => r.segmentKey === "especial:outras").map((r) => r.label)).toEqual(["origem 6", "origem 7", "origem 8"]);
  });

  it("linha sem criadas no período fica só na tabela (sem fatia, sem cor)", () => {
    const b = presentation.buildOriginBreakdown([...sources, { source: "evento", created: 0, won: 2 }]);
    const row = b.rows.at(-1)!;
    expect(row).toMatchObject({ label: "evento", created: 0, won: 2, segmentKey: null, color: null });
    expect(b.segments.map((s) => s.label)).not.toContain("evento");
  });

  it("uma origem só ou nenhuma criada: sem rosca", () => {
    expect(presentation.buildOriginBreakdown([{ source: null, created: 29, won: 4 }]).showDonut).toBe(false);
    const none = presentation.buildOriginBreakdown([{ source: "google", created: 0, won: 1 }]);
    expect(none.showDonut).toBe(false);
    expect(none.totalCreated).toBe(0);
    expect(none.rows[0]!.share).toBeNull();
  });

  // A identidade de cada fatia (usada em seleção e destaque) não pode colidir
  // com nenhum nome de origem que o escritório tenha digitado.
  it("origem real chamada 'sem' e origem nula têm fatias com identidades diferentes, cada linha na sua", () => {
    const b = presentation.buildOriginBreakdown([
      { source: "sem", created: 7, won: 2 },
      { source: null, created: 3, won: 1 },
      { source: "google", created: 10, won: 0 },
    ]);
    const real = b.rows.find((r) => r.source === "sem")!;
    const none = b.rows.find((r) => r.source === null)!;
    expect(real.segmentKey).not.toBe(none.segmentKey);
    expect(new Set(b.segments.map((s) => s.key)).size).toBe(b.segments.length);
    const segmentOf = (key: string | null) => b.segments.find((s) => s.key === key)!;
    expect(segmentOf(real.segmentKey)).toMatchObject({ label: "sem", created: 7, color: "chart2" });
    expect(segmentOf(none.segmentKey)).toMatchObject({ label: "Não informada", created: 3, color: "neutral" });
    // Totais e percentuais seguem os mesmos.
    expect(b.totalCreated).toBe(20);
    expect(b.segments.reduce((s, x) => s + x.created, 0)).toBe(20);
    expect([real.share, none.share]).toEqual([0.35, 0.15]);
  });

  it("mais de seis origens com 'outras' entre as cinco maiores: a origem real é distinta do agrupamento", () => {
    const sources = [
      { source: "outras", created: 19, won: 3 },
      { source: "origem 2", created: 18, won: 0 },
      { source: "origem 3", created: 17, won: 0 },
      { source: "origem 4", created: 16, won: 0 },
      { source: "origem 5", created: 15, won: 0 },
      { source: "origem 6", created: 14, won: 0 },
      { source: "origem 7", created: 13, won: 0 },
      { source: null, created: 2, won: 0 },
    ];
    const b = presentation.buildOriginBreakdown(sources);
    const real = b.rows.find((r) => r.source === "outras")!;
    const grouped = b.rows.filter((r) => ["origem 6", "origem 7"].includes(r.label));
    expect(real.color).toBe("chart1");
    expect(new Set(b.segments.map((s) => s.key)).size).toBe(b.segments.length);
    // As menores continuam compartilhando a identidade do agrupamento — e só elas.
    expect(grouped.map((r) => r.segmentKey)).toEqual([grouped[0]!.segmentKey, grouped[0]!.segmentKey]);
    expect(grouped[0]!.segmentKey).not.toBe(real.segmentKey);
    expect(b.rows.filter((r) => r.segmentKey === real.segmentKey).map((r) => r.label)).toEqual(["outras"]);
    expect(b.segments.find((s) => s.key === grouped[0]!.segmentKey)).toMatchObject({ label: "Outras origens", color: "chart6", created: 27 });
    expect(b.segments.find((s) => s.key === real.segmentKey)).toMatchObject({ label: "outras", created: 19, color: "chart1" });
    expect(b.totalCreated).toBe(114);
    expect(b.segments.reduce((s, x) => s + x.created, 0)).toBe(114);
    expect(b.segments.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 10);
  });

  it("o prefixo das identidades separa origem real de categoria especial, qualquer que seja o texto digitado", () => {
    const b = presentation.buildOriginBreakdown([
      { source: "especial:nao-informada", created: 4, won: 0 },
      { source: "especial:outras", created: 3, won: 0 },
      { source: "real:google", created: 2, won: 0 },
      { source: null, created: 1, won: 0 },
    ]);
    expect(new Set(b.segments.map((s) => s.key)).size).toBe(4);
    expect(b.rows.map((r) => r.segmentKey)).toEqual(b.segments.map((s) => s.key));
  });
});

describe("cartão de origem", () => {
  const sources = [
    { source: null, created: 3, won: 2 },
    { source: "google", created: 6, won: 1 },
    { source: "site do escritório", created: 10, won: 0 },
  ];

  it("tabela-legenda: um link por origem, com criadas, % e ganhas; total no centro", () => {
    render(
      <AttributionCard attribution={attribution(sources, { unattributedCreated: 3 })} modelHrefs={{}} sourceHrefs={hrefs(sources)} clearSourceHref={"/visao-geral" as Route} />,
    );
    const region = screen.getByRole("region", { name: "Origem das oportunidades" });
    const rows = within(region).getAllByRole("row").slice(1);
    expect(rows.map((r) => plain(r.textContent))).toEqual(["site do escritório1052,6%0", "google631,6%1", "Não informada315,8%2"]);
    expect(within(region).getAllByRole("link", { name: "google" })).toHaveLength(1);
    expect(within(region).getByRole("link", { name: "Não informada" })).toHaveAttribute("href", "/visao-geral?origem=__sem_origem__");
    expect(within(region).getByText("19")).toBeInTheDocument();
    expect(within(region).getByText("3 de 19 criadas no período sem interação elegível (\"Não atribuído\").")).toBeInTheDocument();
  });

  it("origem filtrada continua marcada (aria-current)", () => {
    render(
      <AttributionCard
        attribution={attribution(sources, { source: "google" })}
        modelHrefs={{}}
        sourceHrefs={hrefs(sources)}
        clearSourceHref={"/visao-geral" as Route}
      />,
    );
    expect(screen.getByRole("link", { name: "google" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("link", { name: "Limpar origem" })).toBeInTheDocument();
  });

  it("uma origem só: diz em texto, sem rosca de uma fatia", () => {
    const one = [{ source: null, created: 29, won: 4 }];
    render(<AttributionCard attribution={attribution(one)} modelHrefs={{}} sourceHrefs={hrefs(one)} clearSourceHref={"/visao-geral" as Route} />);
    expect(screen.getByText("Todas as 29 oportunidades criadas no período estão em uma única origem.")).toBeInTheDocument();
    expect(screen.queryByText("criadas")).toBeNull();
  });
});

describe("cartão da série", () => {
  it("dono: tabela equivalente com faixa, valor acordado e quantidade", () => {
    render(<SeriesCard dashboard={mapDashboard(raw("owner"))} />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((r) => plain(r.textContent))).toEqual(["18/10–22/10R$ 00", "23/10–27/10R$ 20.0001", "12/11–16/11R$ 87.5002"]);
    expect(screen.getByText("Ver dados em tabela")).toBeInTheDocument();
  });

  it("dono: 'Previsto' troca para a previsão e mostra o que ficou fora do gráfico", () => {
    render(<SeriesCard dashboard={mapDashboard(raw("owner"))} />);
    act(() => screen.getByRole("button", { name: "Previsto" }).click());
    expect(screen.getByText(/Próximos 30 dias, a cada 5 dias/)).toBeInTheDocument();
    expect(plain(screen.getAllByRole("row")[1]!.textContent)).toBe("16/11–20/11R$ 45.0003");
    expect(screen.getByText(/2 com data prevista já vencida · 5 sem data prevista/)).toBeInTheDocument();
  });

  it("sales: só quantidade — nenhum R$, nenhuma coluna de valor, sem 'Previsto'", () => {
    const { container } = render(<SeriesCard dashboard={mapDashboard(raw("sales"))} />);
    expect(container.textContent).not.toContain("R$");
    expect(screen.queryByText("Valor acordado")).toBeNull();
    expect(screen.queryByRole("group", { name: "Série exibida" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Oportunidades ganhas" })).toBeInTheDocument();
    expect(screen.getAllByRole("row").slice(1).map((r) => plain(r.textContent))).toEqual(["18/10–22/100", "23/10–27/101", "12/11–16/112"]);
  });

  it("sem nenhum ganho na série: diz em texto, sem gráfico nem tabela zerada", () => {
    const empty = mapDashboard(raw("owner", { series: { bucket_days: 5, won: [{ start_date: "2026-11-12", last_date: "2026-11-16", count: 0, value_cents: 0 }] } }));
    render(<SeriesCard dashboard={empty} />);
    expect(screen.getByText("Nenhuma oportunidade ganha nos últimos 30 dias.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("área do gráfico", () => {
  it("sem ResizeObserver (servidor, jsdom): só a reserva de altura, nada desenhado", () => {
    const draw = vi.fn(() => <span>gráfico</span>);
    const { container } = render(<ChartFrame height={200}>{draw}</ChartFrame>);
    expect(draw).not.toHaveBeenCalled();
    expect((container.firstChild as HTMLElement).style.height).toBe("200px");
  });

  it("com ResizeObserver: desenha com a largura e a altura medidas", () => {
    class FakeObserver {
      constructor(private readonly callback: () => void) {}
      observe() {
        this.callback();
      }
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeObserver);
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 412.6, height: 220.2 } as DOMRect);
    render(<ChartFrame fill minHeight={220}>{({ width, height }) => <span>{`${width}×${height}`}</span>}</ChartFrame>);
    expect(screen.getByText("412×220")).toBeInTheDocument();
    spy.mockRestore();
  });
});

describe("cartões de indicador", () => {
  it("o helper do e2e lê o valor certo: o 2º <p> do cartão que tem o rótulo e 'período anterior'", () => {
    const { container } = render(<PeriodKpis dashboard={mapDashboard(raw("owner"))} />);
    const valueOf = (label: string) => {
      const cards = [...container.querySelectorAll("div")].filter(
        (div) => [...div.querySelectorAll("p")].some((p) => p.textContent === label) && (div.textContent ?? "").includes("período anterior"),
      );
      return plain(cards.at(-1)!.querySelectorAll("p")[1]!.textContent);
    };
    expect(valueOf("Leads recebidos")).toBe("30");
    expect(valueOf("Oportunidades ganhas")).toBe("4");
    expect(valueOf("Honorários das ganhas")).toBe("R$ 147.500");
  });

  it("comparação só onde o contrato fornece; base zero continua '—'", () => {
    render(<PeriodKpis dashboard={mapDashboard(raw("owner"))} />);
    expect(screen.getByText("Leads recebidos").closest("div")!.textContent).toContain("+200% vs período anterior");
    expect(within(screen.getByText("Consultas realizadas").closest("div")!).getByText("— sem base no período anterior")).toBeInTheDocument();
    expect(screen.getByText("Pela data de entrada do lead")).toBeInTheDocument();
  });
});

describe("funil", () => {
  it("resumo da coorte: ganhas + perdas + em andamento = criadas, com os mesmos números de antes", () => {
    render(<FunnelCard dashboard={mapDashboard(raw("owner"))} pipelineHrefs={{}} />);
    const summary = Object.fromEntries(
      screen.getAllByRole("term").map((dt) => [dt.textContent, plain(dt.nextElementSibling?.textContent)]),
    );
    expect(summary).toEqual({ "Criadas no período": "29", Ganhas: "3 (10,3%)", "Perdas registradas": "5", "Em andamento": "21" });
    // As etapas continuam sendo os únicos itens de lista.
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });
});
