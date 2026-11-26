import { fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tráfego Pago (docs/decisoes/trafego-pago.md): filtros e datas, cálculos, consistência entre cartões, gráfico,
 * distribuição e tabela, ordenação, exportação, estados (sem conexão, sem resultados, carregando, falha) e o
 * isolamento da demonstração.
 */

const push = vi.hoisted(() => vi.fn());
const db = vi.hoisted(() => ({
  result: { data: { is_demo: false } as { is_demo: boolean } | null, error: null as { message: string } | null },
  calls: [] as string[],
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: (column: string, value: string) => ({
          single: async () => {
            db.calls.push(`${table}.${columns}.${column}=${value}`);
            return db.result;
          },
        }),
      }),
    }),
  }),
}));
vi.mock("@/server/authz/permissions", () => ({ requireWorkspace: async () => "10000000-0000-0000-0000-000000000001" }));
vi.mock("@/modules/shell/queries", () => ({
  getShellContext: async () => ({ user: { id: "u", fullName: "Ana", initials: "A", role: "owner" } }),
}));
vi.mock("@/components/app-shell/topbar", () => ({ Topbar: ({ title }: { title: string }) => <h1>{title}</h1> }));

const { DataLoadError } = await import("@/server/data/load-error");
const schema = await import("@/modules/traffic/schema");
const { buildTrafficReport, buildBuckets, compare, costPerLeadCents, wholePercents, sortRows, SORT_KEYS } = await import(
  "@/modules/traffic/report"
);
const { buildDemoDataset, DEMO_COVERAGE_DAYS } = await import("@/modules/traffic/demo-data");
const { campaignsToCsv, neutralizeFormula, CSV_HEADER, DEMO_ORIGIN } = await import("@/modules/traffic/csv");
const { getTrafficWorkspaceMode } = await import("@/modules/traffic/queries");
const { TrafficView } = await import("@/components/traffic/traffic-view");
const { CampaignsTable } = await import("@/components/traffic/campaigns-table");
const { default: TrafficPage } = await import("@/app/(app)/trafego-pago/page");
const { default: TrafficLoading } = await import("@/app/(app)/trafego-pago/loading");
const { default: TrafficError } = await import("@/app/(app)/trafego-pago/error");

const TODAY = "2026-11-25";
/** Intl usa espaço não separável depois de "R$". */
const plain = (s: string | null | undefined) => (s ?? "").replace(/ /g, " ");
const filters = (params: Record<string, string | string[]> = {}) => schema.parseTrafficFilters(params);
const demo = buildDemoDataset(TODAY);

function report(params: Record<string, string | string[]> = {}, today = TODAY, dataset = demo) {
  const f = filters(params);
  const period = schema.resolvePeriod(f, today);
  if (!period.ok) throw new Error(period.error);
  return { f, period, report: buildTrafficReport(dataset, f.platforms, period.current, period.previous) };
}

beforeEach(() => {
  push.mockReset();
  db.calls.length = 0;
  db.result = { data: { is_demo: false }, error: null };
});

describe("filtros e datas", () => {
  it("padrão: as duas plataformas e os últimos 30 dias, terminando hoje, contra os 30 anteriores", () => {
    const { f, period } = report();
    expect(f.platforms).toEqual(["meta", "google"]);
    expect(period.current).toEqual({ from: "2026-10-27", to: "2026-11-25", days: 30 });
    expect(period.previous).toEqual({ from: "2026-09-27", to: "2026-10-26", days: 30 });
  });

  it("valores desconhecidos de plataforma e atalho caem no padrão", () => {
    expect(filters({ plataforma: "tiktok", periodo: "999" })).toMatchObject({ platforms: ["meta", "google"], preset: "30" });
    expect(filters({ plataforma: ["google", "x"] }).platforms).toEqual(["google"]);
    expect(filters({ plataforma: ["google", "meta", "meta"] }).platforms).toEqual(["meta", "google"]);
  });

  it.each([
    ["7", "2026-11-19", "2026-11-25", 7],
    ["90", "2026-08-28", "2026-11-25", 90],
    ["mes", "2026-11-01", "2026-11-25", 25],
    ["mes-anterior", "2026-10-01", "2026-10-31", 31],
  ])("atalho %s", (periodo, from, to, days) => {
    const { period } = report({ periodo });
    expect(period.current).toEqual({ from, to, days });
    // O anterior tem a MESMA duração e termina na véspera do atual.
    expect(period.previous.days).toBe(days);
    expect(period.previous.to).toBe(schema.addDays(from, -1));
  });

  it("mês passado em janeiro e fevereiro bissexto", () => {
    expect(report({ periodo: "mes-anterior" }, "2027-01-10", buildDemoDataset("2027-01-10")).period.current).toMatchObject({
      from: "2026-12-01",
      to: "2026-12-31",
    });
    expect(report({ periodo: "mes-anterior" }, "2028-03-05", buildDemoDataset("2028-03-05")).period.current).toMatchObject({
      from: "2028-02-01",
      to: "2028-02-29",
      days: 29,
    });
  });

  it.each([
    ["", "2026-11-10", "missing_from"],
    ["2026-11-01", "", "missing_to"],
    ["2026-02-30", "2026-11-10", "invalid_from"],
    ["01/11/2026", "2026-11-10", "invalid_from"],
    ["2026-11-01", "2026-13-01", "invalid_to"],
    ["2026-11-10", "2026-11-09", "inverted"],
    ["2026-11-01", "2026-11-26", "future"],
    ["1999-12-31", "2000-06-01", "too_old"],
    ["2025-11-23", "2026-11-25", "too_long"],
  ])("recusa início %s e fim %s (%s)", (de, ate, error) => {
    const f = filters({ periodo: "personalizado", de, ate });
    expect(schema.resolvePeriod(f, TODAY)).toEqual({ ok: false, error });
    expect(schema.PERIOD_ERROR_MESSAGE[error as keyof typeof schema.PERIOD_ERROR_MESSAGE].length).toBeGreaterThan(10);
  });

  it("aceita um único dia, hoje, e o limite de 366 dias", () => {
    expect(report({ periodo: "personalizado", de: TODAY, ate: TODAY }).period.current.days).toBe(1);
    expect(schema.validateCustomRange("2025-11-25", TODAY, TODAY)).toBeNull();
  });

  it("endereço: só o que difere do padrão, e volta igual", () => {
    expect(schema.trafficHref(filters())).toBe("/trafego-pago");
    const custom = filters({ plataforma: "meta", periodo: "personalizado", de: "2026-11-01", ate: "2026-11-10" });
    const href = schema.trafficHref(custom);
    expect(href).toBe("/trafego-pago?plataforma=meta&periodo=personalizado&de=2026-11-01&ate=2026-11-10");
    expect(filters(Object.fromEntries(new URL(href, "http://x").searchParams))).toEqual(custom);
  });
});

describe("cálculos", () => {
  it("últimos 30 dias da demonstração: totais, CPL e comparação", () => {
    const { report: r } = report();
    expect(r.totals).toEqual({ investmentCents: 789_000, conversations: 318, qualifiedLeads: 127, contracts: 21, cplCents: 6213 });
    expect(r.comparison.investmentCents).toMatchObject({ kind: "change", percent: 12.4 });
    expect(r.comparison.conversations).toMatchObject({ kind: "change", percent: 18.7 });
    expect(r.comparison.qualifiedLeads).toMatchObject({ kind: "change", percent: 24.5 });
    expect(r.comparison.contracts).toMatchObject({ kind: "change", percent: 40 });
    expect(sortRows(r.rows, { key: "investmentCents", direction: "desc" }).map((x) => x.cplCents)).toEqual([
      6049, 6000, 6376, 5444, 9060,
    ]);
    expect(r.distribution).toEqual([
      { platform: "meta", selected: true, investmentCents: 426_520, percent: 54 },
      { platform: "google", selected: true, investmentCents: 362_480, percent: 46 },
    ]);
  });

  it("os totais não mudam quando o dia muda (conjunto relativo a hoje)", () => {
    for (const today of ["2026-12-31", "2027-03-01"]) {
      expect(report({}, today, buildDemoDataset(today)).report.totals.qualifiedLeads).toBe(127);
    }
    expect(buildDemoDataset(TODAY)).toEqual(demo);
  });

  it("cartões, gráfico, distribuição e tabela batem em qualquer período e plataforma", () => {
    const periods: Record<string, string>[] = [
      { periodo: "7" },
      { periodo: "30" },
      { periodo: "90" },
      { periodo: "mes" },
      { periodo: "mes-anterior" },
      { periodo: "personalizado", de: "2026-11-24", ate: "2026-11-24" },
      { periodo: "personalizado", de: "2026-09-03", ate: "2026-10-17" },
      { periodo: "personalizado", de: "2025-11-25", ate: "2026-11-25" },
    ];
    for (const params of periods) {
      for (const plataforma of [["meta"], ["google"], ["meta", "google"]]) {
        const { report: r, period } = report({ ...params, plataforma });
        const rows = (key: "investmentCents" | "conversations" | "qualifiedLeads" | "contracts") =>
          r.rows.reduce((s, x) => s + x[key], 0);
        for (const key of ["investmentCents", "conversations", "qualifiedLeads", "contracts"] as const) {
          expect(rows(key)).toBe(r.totals[key]);
        }
        expect(r.series.reduce((s, b) => s + b.qualifiedLeads, 0)).toBe(r.totals.qualifiedLeads);
        expect(r.series.reduce((s, b) => s + b.contracts, 0)).toBe(r.totals.contracts);
        expect(r.series.reduce((s, b) => s + b.days, 0)).toBe(period.current.days);
        expect(r.distribution.reduce((s, d) => s + d.investmentCents, 0)).toBe(r.totals.investmentCents);
        if (r.totals.investmentCents > 0) expect(r.distribution.reduce((s, d) => s + (d.percent ?? 0), 0)).toBe(100);
        expect(r.rows.every((x) => plataforma.includes(x.platform))).toBe(true);
      }
    }
  });

  it("CPL nunca divide por zero", () => {
    expect(costPerLeadCents(5000, 0)).toBeNull();
    expect(costPerLeadCents(0, 0)).toBeNull();
    expect(costPerLeadCents(1000, 3)).toBe(333);
  });

  it("sem base: período anterior zero ou sem dados completos não vira percentual", () => {
    expect(compare(10, 0, true)).toEqual({ kind: "no_base", reason: "previous_zero" });
    expect(compare(10, 5, false)).toEqual({ kind: "no_base", reason: "no_coverage" });
    // 90 dias: o anterior ainda cabe nos 180 dias de dados.
    expect(report({ periodo: "90" }).report.comparison.contracts.kind).toBe("change");
    // 91 dias: o anterior começaria antes dos dados.
    const r = report({ periodo: "personalizado", de: schema.addDays(TODAY, -90), ate: TODAY }).report;
    expect(Object.values(r.comparison).every((c) => c.kind === "no_base")).toBe(true);
  });

  it("antes do começo dos dados é ausência, não zero", () => {
    const before = report({ periodo: "personalizado", de: "2026-01-01", ate: "2026-01-31" }).report;
    expect(before.rows).toEqual([]);
    expect(before.coverageNotice).toEqual({ dataStartsAt: schema.addDays(TODAY, -(DEMO_COVERAGE_DAYS - 1)) });
    expect(report().report.coverageNotice).toBeNull();
  });

  it("campanha sem veiculação no período não vira linha de zeros", () => {
    // A encerrada parou há 8 dias; a pausada, há 3.
    expect(report({ periodo: "7" }).report.rows.map((r) => r.id)).toEqual(["demo-1", "demo-2", "demo-3", "demo-4"]);
    expect(report({ periodo: "personalizado", de: TODAY, ate: TODAY }).report.rows.map((r) => r.id)).toEqual([
      "demo-1",
      "demo-2",
      "demo-3",
    ]);
  });

  it("percentuais inteiros somam 100; sem gasto, sem percentual", () => {
    expect(wholePercents([1, 1, 1])).toEqual([34, 33, 33]);
    expect(wholePercents([0, 0])).toEqual([null, null]);
    expect(wholePercents([10, 0])).toEqual([100, 0]);
  });

  it("faixas alinhadas ao fim: a parcial, se houver, é a primeira", () => {
    expect(buildBuckets(schema.rangeOf("2026-11-19", "2026-11-25"))).toHaveLength(7);
    const month = buildBuckets(schema.rangeOf("2026-11-01", "2026-11-25"));
    expect(month[0]).toEqual({ from: "2026-11-01", to: "2026-11-01", days: 1, partial: true });
    expect(month.at(-1)).toEqual({ from: "2026-11-23", to: "2026-11-25", days: 3, partial: false });
    expect(buildBuckets(schema.rangeOf("2025-11-25", "2026-11-25")).length).toBeLessThanOrEqual(11);
  });
});

describe("ordenação", () => {
  const rows = report().report.rows;
  const noLead = { ...rows[0]!, id: "z", name: "Sem lead", qualifiedLeads: 0, cplCents: null, legalArea: null };

  it.each(SORT_KEYS)("%s nas duas direções, sem perder linha nem alterar a lista original", (key) => {
    const original = rows.map((r) => r.id);
    const asc = sortRows(rows, { key, direction: "asc" });
    const desc = sortRows(rows, { key, direction: "desc" });
    expect([...asc].map((r) => r.id).sort()).toEqual([...original].sort());
    expect(desc).toHaveLength(rows.length);
    expect(rows.map((r) => r.id)).toEqual(original);
  });

  it("texto em ordem alfabética do português e número por valor", () => {
    expect(sortRows(rows, { key: "name", direction: "asc" })[0]!.name).toBe("Direito Imobiliário – Avaliação de Caso");
    expect(sortRows(rows, { key: "conversations", direction: "asc" }).map((r) => r.conversations)).toEqual([30, 44, 62, 78, 104]);
  });

  it("CPL ou área ausente fica no fim nas duas direções", () => {
    for (const direction of ["asc", "desc"] as const) {
      expect(sortRows([noLead, ...rows], { key: "cplCents", direction }).at(-1)!.id).toBe("z");
      expect(sortRows([noLead, ...rows], { key: "legalArea", direction }).at(-1)!.id).toBe("z");
    }
  });
});

describe("exportação CSV", () => {
  const { report: r, period } = report();

  it.each([
    "=1+1",
    "+SUM(A1)",
    "-2+3",
    "@cmd",
    "  =HYPERLINK(\"x\")",
    "\t=1",
    "\r=1",
    "\n=1",
    " =1",
    "﻿=1",
    "\u0000=1",
    "＝1",
    "＋1",
    "－1",
    "＠1",
  ])("neutraliza %j", (text) => {
    expect(neutralizeFormula(text)).toBe(`'${text}`);
  });

  it("texto comum não muda", () => {
    for (const text of ["Usucapião – Captação de Leads", "Campanha = teste", "A+B", ""]) expect(neutralizeFormula(text)).toBe(text);
  });

  it("nome e área hostis saem neutralizados, entre aspas e sem quebrar colunas", () => {
    const hostile = { ...r.rows[0]!, name: '=cmd|"/c calc";A1', legalArea: "@x", cplCents: null };
    const csv = campaignsToCsv([hostile], period.current, DEMO_ORIGIN);
    const line = csv.split("\r\n")[1]!;
    expect(line).toContain('"\'=cmd|""/c calc"";A1"');
    expect(line).toContain('"\'@x"');
    expect(line).toContain('"sem leads qualificados"');
  });

  it("BOM, cabeçalho, uma linha por campanha na ordem recebida, sem linha de total, números em formato de planilha", () => {
    const sorted = sortRows(r.rows, { key: "name", direction: "asc" });
    const csv = campaignsToCsv(sorted, period.current, DEMO_ORIGIN);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).trimEnd().split("\r\n");
    expect(lines).toHaveLength(1 + sorted.length);
    expect(lines[0]).toBe(CSV_HEADER.map((h) => `"${h}"`).join(";"));
    expect(lines[1]).toContain(sorted[0]!.name);
    expect(lines.slice(1).every((l) => l.startsWith(`"${DEMO_ORIGIN}";"27/10/2026";"25/11/2026";`))).toBe(true);
    const usucapiao = lines.find((l) => l.includes("Captação de Leads"))!;
    expect(usucapiao).toContain('"2480,00";"104";"41";"7";"60,49";"Ativa"');
  });
});

describe("tela com dados de demonstração", () => {
  const view = (params: Record<string, string | string[]> = {}) =>
    render(<TrafficView dataset={demo} filters={filters(params)} today={TODAY} />);
  const kpi = (key: string) => plain(screen.getByTestId(`traffic-kpi-${key}`).textContent);
  const total = (key: string) => plain(screen.getByTestId(`traffic-total-${key}`).textContent);

  it("identifica a demonstração e mostra os MESMOS números nos cartões, na tabela e na distribuição", () => {
    view();
    expect(screen.getByRole("note")).toHaveTextContent("Dados demonstrativos");
    expect(kpi("investmentCents")).toBe("R$ 7.890,00");
    expect(kpi("conversations")).toBe("318");
    expect(kpi("qualifiedLeads")).toBe("127");
    expect(kpi("contracts")).toBe("21");
    for (const key of ["investmentCents", "conversations", "qualifiedLeads", "contracts"]) expect(total(key)).toBe(kpi(key));
    expect(plain(screen.getByTestId("traffic-share-total").textContent)).toBe("R$ 7.890,00");
    expect(total("cplCents")).toBe("R$ 62,13");
    expect(screen.getByTestId("traffic-period")).toHaveTextContent("27/10/2026 a 25/11/2026");
    expect(screen.getByText(/não são as conversas do CRM/)).toBeInTheDocument();
    expect(screen.getByText(/CPL \(custo por lead qualificado\) = investimento ÷ leads qualificados/)).toBeInTheDocument();
  });

  it("o filtro de plataforma muda cartões, tabela e distribuição juntos", () => {
    view({ plataforma: "meta" });
    expect(kpi("investmentCents")).toBe("R$ 4.265,20");
    expect(total("investmentCents")).toBe("R$ 4.265,20");
    expect(kpi("qualifiedLeads")).toBe("69");
    expect(total("qualifiedLeads")).toBe("69");
    expect(screen.getByTestId("traffic-share-google")).toHaveTextContent("fora do filtro");
    expect(plain(screen.getByTestId("traffic-share-meta").textContent)).toContain("100%");
    expect(screen.queryByText("Inventário – Consultoria Inicial")).not.toBeInTheDocument();
  });

  it("sem resultados é um estado próprio, sem cartões nem percentuais", () => {
    view({ periodo: "personalizado", de: "2026-01-01", ate: "2026-01-31" });
    expect(screen.getByRole("heading", { name: "Sem resultados no período" })).toBeInTheDocument();
    expect(screen.queryByTestId("traffic-kpi-investmentCents")).not.toBeInTheDocument();
    expect(screen.queryByText("Nenhuma conta conectada")).not.toBeInTheDocument();
    expect(screen.getByText(/Os dados de demonstração começam em/)).toBeInTheDocument();
  });

  it("datas recusadas na URL: mensagem clara, campos marcados e nenhum número", () => {
    view({ periodo: "personalizado", de: "2026-11-20", ate: "2026-11-01" });
    expect(screen.getByRole("alert")).toHaveTextContent("A data de início precisa ser igual ou anterior à data de fim.");
    expect(screen.getByText("Período inválido")).toBeInTheDocument();
    expect(screen.getByLabelText("Início")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Fim")).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByTestId("traffic-kpi-investmentCents")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("R$");
  });

  it("desmarcar uma plataforma navega; a última não pode ser desmarcada", () => {
    view();
    fireEvent.click(screen.getByRole("checkbox", { name: "Google" }));
    expect(push).toHaveBeenLastCalledWith("/trafego-pago?plataforma=meta", { scroll: false });
    push.mockReset();
    fireEvent.click(screen.getByRole("checkbox", { name: "Meta" }));
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "Meta" })).toBeChecked();
    expect(screen.getByRole("alert")).toHaveTextContent("Mantenha ao menos uma plataforma selecionada.");
  });

  it("atalho de período aplica na hora; o personalizado espera datas válidas", () => {
    view();
    fireEvent.change(screen.getByRole("combobox", { name: "Período" }), { target: { value: "7" } });
    expect(push).toHaveBeenLastCalledWith("/trafego-pago?periodo=7", { scroll: false });

    push.mockReset();
    fireEvent.change(screen.getByRole("combobox", { name: "Período" }), { target: { value: "personalizado" } });
    expect(push).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Início"), { target: { value: "2026-11-10" } });
    fireEvent.change(screen.getByLabelText("Fim"), { target: { value: "2026-11-05" } });
    fireEvent.click(screen.getByRole("button", { name: "Aplicar período" }));
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("anterior à data de fim");

    fireEvent.change(screen.getByLabelText("Fim"), { target: { value: "2026-11-20" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Aplicar período" }));
    expect(push).toHaveBeenLastCalledWith("/trafego-pago?periodo=personalizado&de=2026-11-10&ate=2026-11-20", { scroll: false });
  });

  it("os controles acompanham a URL nova (voltar/avançar) sem serem recriados", () => {
    const { rerender } = view();
    const meta = screen.getByRole("checkbox", { name: "Meta" });
    rerender(<TrafficView dataset={demo} filters={filters({ plataforma: "google", periodo: "90" })} today={TODAY} />);
    expect(screen.getByRole("checkbox", { name: "Meta" })).toBe(meta);
    expect(meta).not.toBeChecked();
    expect(screen.getByRole("combobox", { name: "Período" })).toHaveValue("90");
  });

  it("um envio antes de a página ficar interativa cai num GET com os mesmos parâmetros", () => {
    const html = renderToStaticMarkup(<TrafficView dataset={demo} filters={filters()} today={TODAY} />);
    expect(html).toContain('action="/trafego-pago"');
    expect(html).toContain('method="get"');
    for (const name of ["plataforma", "periodo"]) expect(html).toContain(`name="${name}"`);
  });

  it("a conexão só explica: nenhum campo, nenhum sucesso", () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: "Conectar contas" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Conexão ainda não disponível");
    expect(dialog).toHaveTextContent("somente para leitura");
    expect(dialog).toHaveTextContent("não criará, pausará nem alterará campanhas ou orçamento");
    expect(dialog.querySelectorAll("input, textarea, select, form, a")).toHaveLength(0);
    expect(dialog.textContent).not.toMatch(/conectad[oa] com sucesso/i);
  });
});

describe("tabela de campanhas", () => {
  const { report: r, period } = report();
  const table = () =>
    render(<CampaignsTable rows={r.rows} totals={r.totals} period={period.current} platforms={["meta", "google"]} />);
  const names = () =>
    within(screen.getByRole("table"))
      .getAllByRole("rowheader")
      .map((h) => h.querySelector("span")?.textContent ?? h.textContent)
      .filter((t) => !t!.startsWith("Total"));

  it("começa por investimento e ordena pelo cabeçalho, com aria-sort", () => {
    table();
    expect(names()[0]).toBe("Usucapião – Captação de Leads");
    const head = within(screen.getByRole("table")).getByRole("button", { name: "Conversas" });
    fireEvent.click(head);
    expect(head.closest("th")).toHaveAttribute("aria-sort", "descending");
    fireEvent.click(head);
    expect(head.closest("th")).toHaveAttribute("aria-sort", "ascending");
    expect(names()[0]).toBe("Usucapião Extrajudicial – Oportunidades");
    expect(screen.getAllByRole("columnheader").filter((h) => h.hasAttribute("aria-sort"))).toHaveLength(1);
  });

  it("o seletor de ordenação (larguras menores) alcança colunas sem cabeçalho próprio", () => {
    table();
    fireEvent.change(screen.getByRole("combobox", { name: "Ordenar por" }), { target: { value: "platform" } });
    expect(names()[0]).toBe("Inventário – Consultoria Inicial");
    fireEvent.click(screen.getByRole("button", { name: "Crescente" }));
    expect(names()[0]).toBe("Direito Imobiliário – Avaliação de Caso");
  });

  it("exporta o conjunto filtrado na ordem da tela", async () => {
    const blobs: Blob[] = [];
    const downloads: string[] = [];
    const create = vi.fn((b: Blob) => (blobs.push(b), "blob:x"));
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    table();
    fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: "Campanha" }));
    fireEvent.click(screen.getByRole("button", { name: "Exportar CSV" }));
    click.mockRestore();

    expect(downloads).toEqual(["trafego-pago-demonstracao_meta-google_2026-10-27_a_2026-11-25.csv"]);
    const text = await blobs[0]!.text();
    expect(text.replace(/^﻿/, "")).toBe(
      campaignsToCsv(sortRows(r.rows, { key: "name", direction: "asc" }), period.current, DEMO_ORIGIN).slice(1),
    );
    expect(screen.getByText("Relatório gerado com 5 campanhas.")).toBeInTheDocument();
  });
});

describe("estados e isolamento", () => {
  it("escritório real: 'Nenhuma conta conectada', sem filtro, número ou campanha", () => {
    const { container } = render(<TrafficView dataset={null} filters={filters()} today={TODAY} />);
    expect(screen.getByRole("heading", { name: "Nenhuma conta conectada" })).toBeInTheDocument();
    expect(container.textContent).not.toContain("R$");
    expect(container.textContent).not.toMatch(/Usucapião|Inventário|demonstr|Sem resultados/i);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Conectar Meta Ads" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Conexão ainda não disponível");
  });

  it("a demonstração vem só de workspaces.is_demo do escritório ativo", async () => {
    await expect(getTrafficWorkspaceMode("w1")).resolves.toBe("disconnected");
    db.result = { data: { is_demo: true }, error: null };
    await expect(getTrafficWorkspaceMode("w2")).resolves.toBe("demo");
    expect(db.calls).toEqual(["workspaces.is_demo.id=w1", "workspaces.is_demo.id=w2"]);
  });

  it("falha na leitura é falha: nunca vira demonstração nem 'sem conexão'", async () => {
    db.result = { data: null, error: { message: "boom" } };
    await expect(getTrafficWorkspaceMode("w")).rejects.toBeInstanceOf(DataLoadError);
    db.result = { data: null, error: null };
    await expect(getTrafficWorkspaceMode("w")).rejects.toBeInstanceOf(DataLoadError);
    await expect(TrafficPage({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(DataLoadError);
  });

  it("a página de um escritório real não carrega nenhum dado de demonstração, mesmo com filtros na URL", async () => {
    const page = await TrafficPage({ searchParams: Promise.resolve({ periodo: "90", plataforma: "meta" }) });
    const html = renderToStaticMarkup(page);
    expect(html).toContain("Nenhuma conta conectada");
    expect(html).not.toMatch(/R\$|Usucapião|Inventário|demonstrativ/i);
    expect(JSON.stringify(page)).not.toMatch(/demo-1|Captação de Leads/);
  });

  it("a página do escritório demonstrativo mostra os dados identificados", async () => {
    db.result = { data: { is_demo: true }, error: null };
    const html = renderToStaticMarkup(await TrafficPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Dados demonstrativos");
    expect(plain(html)).toContain("R$ 7.890,00");
  });

  it("carregando não mostra número nenhum, não leva componente interativo e explica a falta de JavaScript", () => {
    const { container } = render(<TrafficLoading />);
    expect(screen.getByRole("status")).toHaveTextContent("Carregando o Tráfego Pago");
    expect(container.textContent).not.toMatch(/R\$|\d/);
    expect(container.querySelectorAll("input, button, select")).toHaveLength(0);
    expect(renderToStaticMarkup(<TrafficLoading />)).toMatch(/<noscript>.*precisa de JavaScript.*<\/noscript>/);
    // A busca global dentro da reserva gera um <script> sem nonce no carregamento direto (bloqueado pela CSP).
    const source = readFileSync(resolve(__dirname, "..", "..", "src/app/(app)/trafego-pago/loading.tsx"), "utf8");
    expect(source).not.toMatch(/^import /m);
  });

  it("falha tem tela própria com 'Tentar novamente'", () => {
    const retry = vi.fn();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<TrafficError error={new Error("segredo interno")} retry={retry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível carregar o Tráfego Pago");
    expect(document.body.textContent).not.toContain("segredo interno");
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(retry).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it("nada na frente de tráfego fala com serviço externo, grava no banco ou lê credencial", () => {
    const root = resolve(__dirname, "..", "..", "src");
    const files = [
      "modules/traffic/schema.ts",
      "modules/traffic/report.ts",
      "modules/traffic/demo-data.ts",
      "modules/traffic/csv.ts",
      "modules/traffic/format.ts",
      "modules/traffic/queries.ts",
      "components/traffic/traffic-view.tsx",
      "components/traffic/traffic-filters.tsx",
      "components/traffic/campaigns-table.tsx",
      "components/traffic/connection.tsx",
      "app/(app)/trafego-pago/page.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(resolve(root, file), "utf8");
      expect(source, file).not.toMatch(/fetch\(|\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(|process\.env|googleapis|graph\.facebook/);
      // O conjunto fictício só é importado pela página, no servidor.
      if (file !== "app/(app)/trafego-pago/page.tsx") expect(source, file).not.toMatch(/from "[^"]*demo-data"/);
    }
  });
});
