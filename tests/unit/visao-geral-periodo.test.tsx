import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DashboardFilters } from "@/modules/dashboard/schema";

/**
 * Visão geral — período personalizado: regras de seleção e de datas, endereço, consultas e o calendário
 * (cliques, teclado, descarte e foco). Os números por data são testados no banco
 * (supabase/tests/database/63_dashboard_periodo_personalizado.test.sql).
 */

type Result = { data: unknown; error: { message: string; code?: string } | null };

const state = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpc: (() => ({ data: null, error: null })) as (fn: string, args: Record<string, unknown>) => Result,
  push: vi.fn(),
}));

vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.calls.push({ fn, args });
      return state.rpc(fn, args);
    },
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push, refresh: vi.fn() }) }));
vi.mock("@/modules/activities/actions", () => ({ completeActivityAction: vi.fn() }));
vi.mock("@/modules/shell/queries", () => ({
  getShellContext: async () => ({ user: { id: "u", fullName: "Ana Teste", initials: "A", role: "owner" } }),
}));
vi.mock("@/server/authz/permissions", () => ({ requireWorkspace: async () => "w-1" }));
vi.mock("@/modules/team/queries", () => ({ listTeamMembers: async () => [] }));
vi.mock("@/modules/opportunities/queries", () => ({ getOpportunity: async () => null }));
vi.mock("@/components/app-shell/topbar", () => ({ Topbar: ({ title }: { title: string }) => <h1>{title}</h1> }));

const period = await import("@/modules/dashboard/period");
const { parseDashboardFilters, dashboardHref } = await import("@/modules/dashboard/schema");
const { getDashboard } = await import("@/modules/dashboard/queries");
const { getDashboardAttribution } = await import("@/modules/attribution/queries");
const { PeriodRangeError } = await import("@/modules/dashboard/period-query");
const { periodTexts } = await import("@/modules/dashboard/presentation");
const { DataLoadError } = await import("@/server/data/load-error");
const { PeriodPicker } = await import("@/components/dashboard/period-picker");
const { UNAVAILABLE_PERIOD_MESSAGE, REJECTED_PERIOD_MESSAGE } = await import("@/components/dashboard/period-problem");
const { default: VisaoGeralPage } = await import("@/app/(app)/visao-geral/page");

const TODAY = "2026-11-26";
const PIPE = "50000000-0000-0000-0000-000000000010";
const LUCAS = "20000000-0000-0000-0000-000000000011";

beforeEach(() => {
  state.calls.length = 0;
  state.push.mockReset();
  state.rpc = () => ({ data: null, error: null });
});

describe("seleção no calendário", () => {
  const applied = { from: "2026-10-28", to: TODAY };
  const click = (days: string[], start: ReturnType<typeof period.pickDay> = applied) =>
    days.reduce((selection, day) => period.pickDay(selection, day, TODAY), start);

  it("22 → 26: o primeiro clique começa, o segundo fecha; são cinco dias", () => {
    expect(click(["2026-11-22"])).toEqual({ from: "2026-11-22", to: null });
    expect(click(["2026-11-22", "2026-11-26"])).toEqual({ from: "2026-11-22", to: "2026-11-26" });
    expect(period.rangeLength({ from: "2026-11-22", to: "2026-11-26" })).toBe(5);
  });

  it("um único dia: dois cliques no mesmo", () => {
    expect(click(["2026-11-10", "2026-11-10"])).toEqual({ from: "2026-11-10", to: "2026-11-10" });
    expect(period.rangeLength({ from: "2026-11-10", to: "2026-11-10" })).toBe(1);
  });

  it("segundo clique antes do início vira o novo início e continua esperando o fim", () => {
    expect(click(["2026-11-26", "2026-11-22"])).toEqual({ from: "2026-11-22", to: null });
    expect(click(["2026-11-26", "2026-11-22", "2026-11-24"])).toEqual({ from: "2026-11-22", to: "2026-11-24" });
  });

  it("com o intervalo completo, outro clique começa de novo", () => {
    expect(click(["2026-11-22", "2026-11-26", "2026-11-05"])).toEqual({ from: "2026-11-05", to: null });
  });

  it("futuro nunca é escolhido; esperando o fim, nada além de 366 dias contando as pontas", () => {
    expect(period.pickDay(null, "2026-11-27", TODAY)).toBeNull();
    const pending = { from: "2025-01-01", to: null };
    expect(period.lastSelectableEnd("2025-01-01", TODAY)).toBe("2026-01-01");
    expect(period.pickDay(pending, "2026-01-02", TODAY)).toBe(pending);
    const full = period.pickDay(pending, "2026-01-01", TODAY)!;
    expect(period.rangeLength({ from: full.from, to: full.to! })).toBe(366);
    // Um dia anterior ao início continua valendo como novo início.
    expect(period.pickDay(pending, "2023-05-01", TODAY)).toEqual({ from: "2023-05-01", to: null });
    expect(period.lastSelectableEnd("2026-11-01", TODAY)).toBe(TODAY);
  });
});

describe("datas e textos", () => {
  it.each([
    [undefined, "2026-11-20", "Informe a data inicial e a data final do período."],
    ["2026-11-20", "", "Informe a data inicial e a data final do período."],
    ["2026-02-30", "2026-03-02", "Uma das datas do período não existe."],
    ["26/11/2026", "2026-11-26", "Uma das datas do período não existe."],
    ["2026-11-26", "2026-11-22", "A data inicial é depois da data final."],
    ["2026-11-20", "2026-11-27", "O período não pode ter datas futuras."],
    ["2024-01-01", "2025-01-01", "O período pode ter no máximo 366 dias."],
  ])("recusa %s a %s", (from, to, error) => {
    expect(period.checkRange(from, to, TODAY)).toEqual({ ok: false, error });
  });

  it("aceita 366 dias, um dia só, hoje, fevereiro bissexto e a virada de ano", () => {
    for (const [from, to, days] of [
      ["2024-01-01", "2024-12-31", 366],
      [TODAY, TODAY, 1],
      ["2024-02-28", "2024-03-01", 3],
      ["2025-02-28", "2025-03-01", 2],
      ["2025-12-30", "2026-01-02", 4],
    ] as const) {
      const result = period.checkRange(from, to, TODAY);
      expect(result).toEqual({ ok: true, range: { from, to } });
      expect(period.rangeLength({ from, to })).toBe(days);
    }
  });

  it("os atalhos são os N dias terminando hoje", () => {
    expect(period.presetRange(7, TODAY)).toEqual({ from: "2026-11-20", to: TODAY });
    expect(period.presetRange(30, TODAY)).toEqual({ from: "2026-10-28", to: TODAY });
    expect(period.presetRange(90, TODAY)).toEqual({ from: "2026-08-29", to: TODAY });
  });

  it.each([
    ["2026-11-22", "2026-11-26", "22–26 nov 2026"],
    ["2026-11-26", "2026-11-26", "26 nov 2026"],
    ["2026-10-28", "2026-11-03", "28 out – 3 nov 2026"],
    ["2025-12-28", "2026-01-03", "28 dez 2025 – 3 jan 2026"],
  ])("rótulo de %s a %s", (from, to, label) => {
    expect(period.formatRangeLabel({ from, to })).toBe(label);
  });

  it("a grade do mês tem sempre seis semanas começando no domingo", () => {
    const november = period.monthGrid("2026-11");
    expect(november).toHaveLength(42);
    expect(november[0]).toBe("2026-11-01");
    const february = period.monthGrid("2024-02");
    expect(february).toHaveLength(42);
    expect(february.filter(Boolean)).toHaveLength(29);
    expect(february.indexOf("2024-02-01")).toBe(4);
  });

  const payload = (start: string, end: string, previousStart: string, previousEnd: string, custom: boolean, days: number) => ({
    days,
    currentStart: "",
    currentEnd: "",
    previousStart: "",
    previousEnd: "",
    today: TODAY,
    startDate: start,
    endDate: end,
    previousStartDate: previousStart,
    previousEndDate: previousEnd,
    custom,
  });

  it("textos explicativos: atalho como antes; datas escolhidas por extenso; ano só quando precisa", () => {
    expect(periodTexts(payload("2026-10-28", TODAY, "2026-09-28", "2026-10-27", false, 30))).toEqual({
      current: "28/10 a 26/11",
      previous: "28/09 a 27/10",
      inPeriod: "nos últimos 30 dias",
    });
    expect(periodTexts(payload("2026-11-22", TODAY, "2026-11-17", "2026-11-21", true, 5))).toEqual({
      current: "22/11 a 26/11",
      previous: "17/11 a 21/11",
      inPeriod: "de 22/11 a 26/11",
    });
    expect(periodTexts(payload(TODAY, TODAY, "2026-11-25", "2026-11-25", true, 1))).toMatchObject({ previous: "25/11", inPeriod: "em 26/11" });
    expect(periodTexts(payload("2025-12-30", "2026-01-02", "2025-12-26", "2025-12-29", true, 4)).current).toBe("30/12/2025 a 02/01/2026");
  });
});

describe("endereço", () => {
  const parse = (params: Record<string, string>) => parseDashboardFilters(params, TODAY);

  it("guarda o intervalo junto com os demais filtros e volta igual", () => {
    const f = parse({ periodo: "personalizado", de: "2026-11-22", ate: "2026-11-26", responsavel: LUCAS, area: "Família", pipeline: PIPE, origem: "Site", modelo: "last_touch" });
    expect(f.range).toEqual({ from: "2026-11-22", to: "2026-11-26" });
    const href = dashboardHref(f);
    expect(href).toBe(
      `/visao-geral?periodo=personalizado&de=2026-11-22&ate=2026-11-26&responsavel=${LUCAS}&area=Fam%C3%ADlia&pipeline=${PIPE}&modelo=last_touch&origem=Site`,
    );
    expect(parse(Object.fromEntries(new URLSearchParams(href.split("?")[1])))).toEqual(f);
    // Trocar para um atalho tira só as datas.
    expect(dashboardHref(f, { periodDays: 7, range: null })).toBe(
      `/visao-geral?periodo=7&responsavel=${LUCAS}&area=Fam%C3%ADlia&pipeline=${PIPE}&modelo=last_touch&origem=Site`,
    );
  });

  it("endereços antigos continuam como antes", () => {
    for (const [periodo, days] of [["7", 7], ["90", 90], ["15", 30], ["abc", 30]] as const) {
      const f = parse({ periodo });
      expect(f.periodDays).toBe(days);
      expect(f.range).toBeUndefined();
      expect(f.rangeError).toBeUndefined();
    }
    expect(parse({})).toMatchObject({ periodDays: 30 });
  });

  it("datas sem 'periodo' valem como intervalo; intervalo errado vira erro, nunca outro período em silêncio", () => {
    expect(parse({ de: "2026-11-01", ate: "2026-11-02" }).range).toEqual({ from: "2026-11-01", to: "2026-11-02" });
    for (const params of [{ periodo: "personalizado" }, { de: "2026-11-01" }, { periodo: "7", de: "2026-11-10", ate: "2026-11-01" }] as Record<string, string>[]) {
      const f = parse(params);
      expect(f.rangeError).toBeTruthy();
      expect(f.range).toBeUndefined();
      expect(f.periodDays).toBe(30);
    }
  });
});

/** Resposta mínima do banco para um período. */
function rawFor(start: string, end: string, custom: boolean) {
  const next = new Date(Date.parse(`${end}T03:00:00Z`) + 86_400_000).toISOString();
  return {
    role: "owner",
    generated_at: "2026-11-26T15:00:00Z",
    period: { days: 5, current_start: `${start}T03:00:00+00:00`, current_end: next, previous_start: "2026-11-17T03:00:00+00:00", previous_end: `${start}T03:00:00+00:00`, today: TODAY, custom },
  };
}

describe("consultas", () => {
  const custom = parseDashboardFilters({ periodo: "personalizado", de: "2026-11-22", ate: "2026-11-26" }, TODAY);
  const attribution = (filters: DashboardFilters) =>
    getDashboardAttribution("w-1", {
      periodDays: filters.periodDays,
      range: filters.range,
      model: "first_touch",
      source: null,
      assignedTo: null,
      onlyUnassigned: false,
      legalArea: null,
    });

  it("o painel e a origem recebem exatamente as mesmas datas", async () => {
    state.rpc = (fn) => ({
      data: fn === "get_dashboard" ? rawFor("2026-11-22", "2026-11-26", true) : { model: "first_touch", start_date: "2026-11-22", end_date: "2026-11-26" },
      error: null,
    });
    const d = await getDashboard("w-1", custom);
    expect(d.period).toMatchObject({ startDate: "2026-11-22", endDate: "2026-11-26", custom: true });
    await attribution(custom);
    for (const call of state.calls) {
      expect(call.args).toMatchObject({ p_start_date: "2026-11-22", p_end_date: "2026-11-26" });
      expect(call.args).not.toHaveProperty("p_period_days");
    }
    expect(state.calls.map((c) => c.fn)).toEqual(["get_dashboard", "get_dashboard_attribution"]);
  });

  it("o atalho vai como antes, sem os parâmetros novos (funciona antes da migration)", async () => {
    state.rpc = (fn) => ({ data: fn === "get_dashboard" ? rawFor("2026-11-20", "2026-11-26", false) : { model: "first_touch" }, error: null });
    const filters = parseDashboardFilters({ periodo: "7" }, TODAY);
    await getDashboard("w-1", filters);
    await attribution(filters);
    for (const call of state.calls) {
      expect(call.args).toMatchObject({ p_period_days: 7 });
      expect(Object.keys(call.args)).not.toContain("p_start_date");
    }
  });

  it.each([
    [{ message: "Could not find the function", code: "PGRST202" }, "unavailable"],
    [{ message: "invalid_period", code: "P0001" }, "rejected"],
  ])("com datas, o erro %j é explicado como %s", async (error, reason) => {
    state.rpc = () => ({ data: null, error });
    for (const query of [() => getDashboard("w-1", custom), () => attribution(custom)]) {
      const thrown = await query().catch((e) => e);
      expect(thrown).toBeInstanceOf(PeriodRangeError);
      expect(thrown.reason).toBe(reason);
    }
    // No atalho, os mesmos códigos são falha comum.
    const plain = await getDashboard("w-1", parseDashboardFilters({}, TODAY)).catch((e) => e);
    expect(plain).toBeInstanceOf(DataLoadError);
    expect(plain).not.toBeInstanceOf(PeriodRangeError);
  });

  it("resposta de outro período vira erro: nunca aparece como se fosse a pedida", async () => {
    state.rpc = (fn) => ({
      data: fn === "get_dashboard" ? rawFor("2026-10-28", "2026-11-26", false) : { model: "first_touch" },
      error: null,
    });
    await expect(getDashboard("w-1", custom)).rejects.toBeInstanceOf(DataLoadError);
    await expect(attribution(custom)).rejects.toBeInstanceOf(DataLoadError);
  });
});

describe("página quando o período não pode ser mostrado", () => {
  const html = async (params: Record<string, string>) => renderToStaticMarkup(await VisaoGeralPage({ searchParams: Promise.resolve(params) }));

  it("datas inválidas: mensagem clara, nenhuma consulta e nenhum indicador", async () => {
    const markup = await html({ periodo: "personalizado", de: "2020-01-10", ate: "2020-01-01", area: "Família" });
    expect(markup).toContain("Período não aplicado");
    expect(markup).toContain("A data inicial é depois da data final.");
    expect(markup).toContain("Nenhum indicador é mostrado no lugar do período pedido.");
    expect(markup).toContain("Escolher período");
    expect(markup).toContain('href="/visao-geral?area=Fam%C3%ADlia"');
    expect(markup).not.toMatch(/Leads recebidos|Oportunidades ganhas|Funil por etapa/);
    expect(state.calls).toEqual([]);
  });

  it.each([
    [{ message: "x", code: "PGRST202" }, UNAVAILABLE_PERIOD_MESSAGE],
    [{ message: "invalid_period", code: "P0001" }, REJECTED_PERIOD_MESSAGE],
  ])("banco responde %j: explica, sem número algum", async (error, message) => {
    state.rpc = () => ({ data: null, error });
    const markup = await html({ periodo: "personalizado", de: "2020-01-01", ate: "2020-01-05" });
    expect(markup).toContain(message);
    expect(markup).not.toMatch(/Leads recebidos|Funil por etapa/);
  });

  it("outra falha continua indo para a tela de erro da rota", async () => {
    state.rpc = () => ({ data: null, error: { message: "timeout" } });
    await expect(html({ periodo: "personalizado", de: "2020-01-01", ate: "2020-01-05" })).rejects.toBeInstanceOf(DataLoadError);
  });
});

describe("calendário", () => {
  const filters = (params: Record<string, string> = {}) => parseDashboardFilters(params, TODAY);
  const view = (f = filters()) => render(<PeriodPicker filters={f} today={TODAY} />);
  const trigger = () => screen.getByRole("button", { name: /^Período:/ });
  const panel = () => screen.getByRole("dialog", { name: "Escolher o período" });
  const open = () => fireEvent.click(trigger());
  const day = (label: string) => within(panel()).getByRole("button", { name: new RegExp(`^${label}(,|$)`) });
  const guide = () => within(panel()).getByRole("status").textContent ?? "";
  const apply = () => within(panel()).getByRole("button", { name: "Aplicar período" });
  const selectedDays = () => within(panel()).getAllByRole("gridcell", { selected: true }).map((c) => c.textContent);

  it("abre com o período aplicado: um mês, um calendário, sem campo de data", () => {
    view();
    expect(trigger()).toHaveTextContent("Últimos 30 dias");
    open();
    expect(within(panel()).getAllByRole("grid")).toHaveLength(1);
    expect(panel().querySelectorAll("input, select")).toHaveLength(0);
    expect(within(panel()).getByText("Novembro de 2026")).toBeInTheDocument();
    expect(selectedDays()).toHaveLength(26);
    expect(guide()).toContain("Selecione a data inicial");
    expect(guide()).toContain("Período atual: 28 out – 26 nov 2026 · 30 dias");
    expect(day("26 de novembro de 2026")).toHaveFocus();
    expect(day("26 de novembro de 2026")).toHaveAttribute("aria-current", "date");
    expect(within(panel()).getByRole("button", { name: "Últimos 30 dias" })).toHaveAttribute("aria-pressed", "true");
  });

  it("22 → 26: não aplica no primeiro clique; destaca os cinco dias e aplica só no botão", () => {
    view();
    open();
    fireEvent.click(day("22 de novembro de 2026"));
    expect(guide()).toContain("Selecione a data final");
    expect(apply()).toBeDisabled();
    expect(selectedDays()).toEqual(["22"]);
    expect(state.push).not.toHaveBeenCalled();

    fireEvent.click(day("26 de novembro de 2026"));
    expect(selectedDays()).toEqual(["22", "23", "24", "25", "26"]);
    expect(guide()).toContain("22–26 nov 2026 · 5 dias");
    expect(apply()).toBeEnabled();
    expect(state.push).not.toHaveBeenCalled();

    fireEvent.click(apply());
    expect(state.push).toHaveBeenCalledTimes(1);
    expect(state.push).toHaveBeenCalledWith("/visao-geral?periodo=personalizado&de=2026-11-22&ate=2026-11-26", { scroll: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("um dia só: dois cliques no mesmo", () => {
    view();
    open();
    fireEvent.click(day("10 de novembro de 2026"));
    fireEvent.click(day("10 de novembro de 2026"));
    expect(guide()).toContain("10 nov 2026 · 1 dia");
    fireEvent.click(apply());
    expect(state.push).toHaveBeenCalledWith("/visao-geral?periodo=personalizado&de=2026-11-10&ate=2026-11-10", { scroll: false });
  });

  it("intervalo entre meses, navegando com as setas; futuro e próximo mês bloqueados", () => {
    view();
    open();
    const next = () => within(panel()).getByRole("button", { name: "Próximo mês" });
    expect(next()).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(next());
    expect(within(panel()).getByText("Novembro de 2026")).toBeInTheDocument();
    expect(day("27 de novembro de 2026")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(day("27 de novembro de 2026"));
    expect(guide()).toContain("Selecione a data inicial");

    fireEvent.click(within(panel()).getByRole("button", { name: "Mês anterior" }));
    expect(within(panel()).getByText("Outubro de 2026")).toBeInTheDocument();
    fireEvent.click(day("28 de outubro de 2026"));
    fireEvent.click(next());
    fireEvent.click(day("3 de novembro de 2026"));
    expect(guide()).toContain("28 out – 3 nov 2026 · 7 dias");
    fireEvent.click(apply());
    expect(state.push).toHaveBeenCalledWith("/visao-geral?periodo=personalizado&de=2026-10-28&ate=2026-11-03", { scroll: false });
  });

  it("a faixa fica arredondada nas pontas das semanas quando atravessa linhas", () => {
    view();
    open();
    fireEvent.click(day("5 de novembro de 2026"));
    fireEvent.click(day("17 de novembro de 2026"));
    const band = (n: number) => day(`${n} de novembro de 2026`).parentElement!.querySelector("[data-band]");
    expect(band(5)).toHaveClass("left-1/2", "right-0");
    expect(band(7)).toHaveClass("rounded-r-full");
    expect(band(8)).toHaveClass("rounded-l-full");
    expect(band(10)).not.toHaveClass("rounded-l-full", "rounded-r-full");
    expect(band(17)).toHaveClass("left-0", "right-1/2");
    expect(band(18)).toBeNull();
  });

  it("antes do segundo clique, apontar um dia mostra só uma prévia", () => {
    view();
    open();
    fireEvent.click(day("20 de novembro de 2026"));
    fireEvent.pointerEnter(day("23 de novembro de 2026"));
    expect(day("21 de novembro de 2026").parentElement!.querySelector("[data-band]")).toHaveAttribute("data-band", "previa");
    expect(selectedDays()).toEqual(["20"]);
    expect(apply()).toBeDisabled();
  });

  it.each(["Cancelar", "Escape"])("%s descarta a escolha; reabrir mostra o aplicado; o foco volta ao botão", async (how) => {
    view(filters({ periodo: "personalizado", de: "2026-11-22", ate: "2026-11-26" }));
    open();
    fireEvent.click(day("3 de novembro de 2026"));
    if (how === "Cancelar") fireEvent.click(within(panel()).getByRole("button", { name: "Cancelar" }));
    else fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await act(async () => {});
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(state.push).not.toHaveBeenCalled();
    // O Radix devolve o foco num instante depois de desmontar o painel.
    await waitFor(() => expect(trigger()).toHaveFocus());
    open();
    expect(selectedDays()).toEqual(["22", "23", "24", "25", "26"]);
    expect(guide()).toContain("Período atual: 22–26 nov 2026 · 5 dias");
  });

  it("clicar fora fecha e descarta", async () => {
    render(
      <>
        <PeriodPicker filters={filters()} today={TODAY} />
        <button type="button">fora</button>
      </>,
    );
    open();
    fireEvent.click(day("3 de novembro de 2026"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    const outside = screen.getByRole("button", { name: "fora" });
    fireEvent.pointerDown(outside);
    fireEvent.pointerUp(outside);
    fireEvent.click(outside);
    await act(async () => {});
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(state.push).not.toHaveBeenCalled();
  });

  it("teclado: setas, início e fim da semana, troca de mês e limite em hoje", () => {
    view();
    open();
    const key = (k: string) => fireEvent.keyDown(document.activeElement!, { key: k });
    const focused = () => document.activeElement!.getAttribute("data-day");
    expect(focused()).toBe(TODAY);
    key("ArrowRight");
    expect(focused()).toBe(TODAY);
    key("ArrowLeft");
    expect(focused()).toBe("2026-11-25");
    key("ArrowUp");
    expect(focused()).toBe("2026-11-18");
    key("Home");
    expect(focused()).toBe("2026-11-15");
    key("End");
    expect(focused()).toBe("2026-11-21");
    key("PageUp");
    expect(focused()).toBe("2026-10-21");
    expect(within(panel()).getByText("Outubro de 2026")).toBeInTheDocument();
    key("PageDown");
    expect(focused()).toBe("2026-11-21");
    key("ArrowDown");
    expect(focused()).toBe(TODAY);
    // Um único dia na ordem de tabulação.
    expect(panel().querySelectorAll('[data-day][tabindex="0"]')).toHaveLength(1);
  });

  it("os atalhos aplicam na hora e mantêm os outros filtros", () => {
    view(filters({ periodo: "personalizado", de: "2026-11-22", ate: "2026-11-26", area: "Família", pipeline: PIPE, origem: "Site", modelo: "last_touch", op: LUCAS }));
    open();
    for (const name of ["Últimos 7 dias", "Últimos 30 dias", "Últimos 90 dias"]) {
      expect(within(panel()).getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
    }
    fireEvent.click(within(panel()).getByRole("button", { name: "Últimos 7 dias" }));
    expect(state.push).toHaveBeenCalledWith(`/visao-geral?periodo=7&area=Fam%C3%ADlia&pipeline=${PIPE}&modelo=last_touch&origem=Site`, { scroll: false });
  });

  it("voltar/avançar: se o período aplicado muda, o painel fecha e botão e calendário acompanham", () => {
    const { rerender } = view();
    open();
    fireEvent.click(day("3 de novembro de 2026"));
    rerender(<PeriodPicker filters={filters({ periodo: "personalizado", de: "2025-12-28", ate: "2026-01-03" })} today={TODAY} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger()).toHaveTextContent("28 dez 2025 – 3 jan 2026");
    open();
    expect(within(panel()).getByText("Janeiro de 2026")).toBeInTheDocument();
    expect(selectedDays()).toEqual(["1", "2", "3"]);
    rerender(<PeriodPicker filters={filters()} today={TODAY} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger()).toHaveTextContent("Últimos 30 dias");
  });

  it("sem JavaScript os atalhos continuam como links", () => {
    const markup = renderToStaticMarkup(<PeriodPicker filters={filters({ area: "Família" })} today={TODAY} />);
    expect(markup).toContain("<noscript>");
    for (const n of [7, 90]) expect(markup).toContain(`href="/visao-geral?periodo=${n}&amp;area=Fam%C3%ADlia"`);
  });
});
