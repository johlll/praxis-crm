import { fireEvent, render, screen, within } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FinanceEntry } from "@/modules/finance/ledger";

/**
 * Financeiro (docs/decisoes/financeiro.md): cálculos, comparação mensal, meses e anos diferentes, zero e negativo,
 * simulação em memória, busca e ordenação, estados vazios, isolamento da demonstração e permissões.
 */

const state = vi.hoisted(() => ({
  role: "owner" as string,
  workspace: { data: { is_demo: false } as { is_demo: boolean } | null, error: null as { message: string } | null },
  queries: [] as string[],
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: (column: string, value: string) => ({
          single: async () => {
            state.queries.push(`${table}.${columns}.${column}=${value}`);
            return state.workspace;
          },
        }),
      }),
    }),
  }),
}));
vi.mock("@/server/authz/permissions", async () => {
  const roles = await import("@/lib/roles");
  return {
    roleHasPermission: roles.roleHasPermission,
    requireMembership: async () => ({ userId: "u", workspaceId: "w-1", role: state.role }),
  };
});
vi.mock("@/modules/shell/queries", () => ({
  getShellContext: async () => ({ user: { id: "u", fullName: "Ana", initials: "A", role: "owner" } }),
}));
vi.mock("@/components/app-shell/topbar", () => ({ Topbar: ({ title }: { title: string }) => <h1>{title}</h1> }));

const { DataLoadError } = await import("@/server/data/load-error");
const ledger = await import("@/modules/finance/ledger");
const { buildFinanceDemo, demoEntriesOfMonth } = await import("@/modules/finance/demo-data");
const { parseAmountCents, validateNewEntry } = await import("@/modules/finance/new-entry");
const format = await import("@/modules/finance/format");
const civil = await import("@/lib/civil-date");
const { roleHasPermission } = await import("@/lib/roles");
const { FinanceDashboard } = await import("@/components/finance/finance-dashboard");
const { default: FinanceiroPage } = await import("@/app/(app)/financeiro/page");

const TODAY = "2026-11-26";
/** Intl usa espaço não separável depois de "R$". */
const plain = (s: string | null | undefined) => (s ?? "").replace(/ /g, " ");
const demo = buildFinanceDemo(TODAY);
const viewOf = (month: string, today = TODAY, data = buildFinanceDemo(today)) =>
  ledger.buildMonthView(data.entries, month, today, data.coverageStart);

const entry = (patch: Partial<FinanceEntry>) => ({
  id: "x",
  kind: "receita" as const,
  description: "Honorários",
  party: "Pessoa Fictícia",
  amountCents: 10_000,
  createdDate: "2026-11-01",
  dueDate: "2026-11-10",
  paidDate: null,
  ...patch,
});

beforeEach(() => {
  state.role = "owner";
  state.queries.length = 0;
  state.workspace = { data: { is_demo: false }, error: null };
});

describe("cálculos da demonstração", () => {
  const view = viewOf("2026-11");

  it("novembro: recebido, despesas pagas, resultado e a receber", () => {
    expect(view.totals).toEqual({ receivedCents: 3_840_000, paidCents: 1_260_000, resultCents: 2_580_000 });
    expect(view.receivable).toEqual({ totalCents: 1_420_000, upcomingCents: 1_100_000, overdueCents: 320_000 });
    expect(view.reference).toBe(TODAY);
    expect(view.phase).toBe("current");
  });

  it("mês em curso compara o MESMO intervalo de dias do mês anterior, com as contas fechando", () => {
    expect(view.comparisonWindow).toEqual({ month: "2026-10", from: "2026-10-01", to: "2026-10-26", partial: true });
    expect(view.comparison.received).toEqual({ kind: "change", percent: 18.5, previousCents: 3_240_000 });
    expect(view.comparison.paid).toEqual({ kind: "change", percent: -7.8, previousCents: 1_366_000 });
    // 32.400 − 13.660 = 18.740 (a imagem de referência traz 19.120, que não fecha).
    expect(view.comparison.result).toEqual({ kind: "change", percent: 37.7, previousCents: 1_874_000 });
    expect(view.comparison.receivable).toEqual({ kind: "change", percent: 12.7, previousCents: 1_260_000 });
    expect(format.comparisonTarget(view)).toBe("1 a 26/10");
  });

  it("o gráfico é a soma diária dos mesmos lançamentos, até hoje", () => {
    expect(view.flow).toHaveLength(26);
    expect(view.flow.find((d) => d.date === "2026-11-18")).toEqual({ date: "2026-11-18", receivedCents: 480_000, paidCents: 120_000 });
    expect(view.flow.reduce((s, d) => s + d.receivedCents, 0)).toBe(view.totals.receivedCents);
    expect(view.flow.reduce((s, d) => s + d.paidCents, 0)).toBe(view.totals.paidCents);
  });

  it("previsto não entra no realizado", () => {
    const open = demo.entries.filter((e) => e.paidDate === null);
    expect(open.length).toBeGreaterThan(0);
    expect(ledger.realizedBetween(open, "2000-01-01", "2100-01-01")).toEqual({ receivedCents: 0, paidCents: 0, resultCents: 0 });
  });

  it.each(["2026-11-26", "2026-12-01", "2026-12-31", "2027-01-03", "2027-02-28", "2028-02-29", "2027-03-15"])(
    "com hoje em %s tudo continua batendo em todos os meses",
    (today) => {
      const data = buildFinanceDemo(today);
      expect(new Set(data.entries.map((e) => e.id)).size).toBe(data.entries.length);
      for (const month of ledger.selectableMonths(data.entries, today)) {
        const m = ledger.buildMonthView(data.entries, month, today, data.coverageStart);
        expect(m.flow.reduce((s, d) => s + d.receivedCents, 0)).toBe(m.totals.receivedCents);
        expect(m.flow.reduce((s, d) => s + d.paidCents, 0)).toBe(m.totals.paidCents);
        expect(m.totals.resultCents).toBe(m.totals.receivedCents - m.totals.paidCents);
        expect(m.receivable.totalCents).toBe(m.receivable.upcomingCents + m.receivable.overdueCents);
        expect(m.rows.every((r) => ledger.movementDate(r).startsWith(month))).toBe(true);
        expect(data.entries.every((e) => Number.isInteger(e.amountCents) && e.amountCents > 0)).toBe(true);
        expect(data.entries.every((e) => e.paidDate === null || e.paidDate <= today)).toBe(true);
      }
    },
  );

  it("virada de ano: janeiro compara com dezembro do ano anterior", () => {
    const v = viewOf("2027-01", "2027-01-10");
    expect(v.comparisonWindow).toMatchObject({ month: "2026-12", from: "2026-12-01", to: "2026-12-10" });
    expect(format.comparisonTarget(v)).toBe("1 a 10/12");
    expect(civil.monthLabel(civil.addMonths("2027-01", -1))).toBe("Dezembro de 2026");
  });

  it("no último dia do mês e em mês fechado a comparação é de mês inteiro", () => {
    expect(viewOf("2026-12", "2026-12-31").comparisonWindow).toMatchObject({ from: "2026-11-01", to: "2026-11-30", partial: false });
    const october = viewOf("2026-10");
    expect(october.phase).toBe("past");
    expect(october.reference).toBe("2026-10-31");
    expect(october.comparisonWindow).toMatchObject({ from: "2026-09-01", to: "2026-09-30", partial: false });
    expect(format.comparisonTarget(october)).toBe("setembro");
    expect(october.receivable.totalCents).toBe(1_260_000);
  });

  it("dia 31 contra mês de 30 e março contra fevereiro respeitam o fim do mês anterior", () => {
    expect(viewOf("2027-03", "2027-03-30").comparisonWindow).toMatchObject({ to: "2027-02-28", partial: true });
    expect(viewOf("2027-03", "2027-03-01").comparisonWindow).toMatchObject({ from: "2027-02-01", to: "2027-02-01" });
    expect(format.comparisonTarget(viewOf("2027-03", "2027-03-01"))).toBe("01/02");
  });

  it("sem base: primeiro mês com dados, mês futuro e antes do começo dos dados (zeros)", () => {
    const first = viewOf("2026-06");
    expect(first.comparison.received).toMatchObject({ kind: "no_base", reason: "no_data" });
    const future = viewOf("2026-12");
    expect(future.totals).toEqual({ receivedCents: 0, paidCents: 0, resultCents: 0 });
    expect(future.flow).toEqual([]);
    expect(future.comparison.received).toMatchObject({ kind: "no_base", reason: "future" });
    // A posição "a receber" de um mês futuro é a de hoje.
    expect(future.reference).toBe(TODAY);
    const old = viewOf("2026-01");
    expect(old.beforeCoverage).toBe(true);
    expect(old.totals.resultCents).toBe(0);
    expect(old.receivable.totalCents).toBe(0);
    expect(old.rows).toEqual([]);
  });

  it("base zero e resultado anterior negativo não viram percentual; resultado atual negativo é calculado", () => {
    expect(ledger.compareCents(500, 0)).toEqual({ kind: "no_base", reason: "zero", previousCents: 0 });
    expect(ledger.compareCents(500, -100)).toEqual({ kind: "no_base", reason: "negative", previousCents: -100 });
    expect(ledger.compareCents(-500, 1000)).toEqual({ kind: "change", percent: -150, previousCents: 1000 });
    const entries = [
      entry({ id: "a", kind: "despesa", amountCents: 5000, paidDate: "2026-10-05", dueDate: "2026-10-05" }),
      entry({ id: "b", kind: "despesa", amountCents: 9000, paidDate: "2026-11-05", dueDate: "2026-11-05" }),
    ];
    const v = ledger.buildMonthView(entries, "2026-11", TODAY, "2026-01-01");
    expect(v.totals.resultCents).toBe(-9000);
    expect(v.comparison.result).toMatchObject({ kind: "no_base", reason: "negative", previousCents: -5000 });
    expect(v.comparison.received).toMatchObject({ kind: "no_base", reason: "zero" });
    expect(plain(format.formatMoney(-9000))).toBe("−R$ 90");
  });

  it("a receber é posição na data: lançado depois ou recebido até a data fica de fora; vence no dia = a vencer", () => {
    const list = [
      entry({ id: "1", createdDate: "2026-11-27" }),
      entry({ id: "2", paidDate: TODAY }),
      entry({ id: "3", dueDate: TODAY, amountCents: 100 }),
      entry({ id: "4", dueDate: "2026-11-25", amountCents: 200 }),
      entry({ id: "5", paidDate: "2026-11-27", dueDate: "2026-12-01", amountCents: 400 }),
      entry({ id: "6", kind: "despesa" }),
    ];
    expect(ledger.receivableAt(list, TODAY)).toEqual({ totalCents: 700, upcomingCents: 500, overdueCents: 200 });
  });

  it("situações", () => {
    expect(ledger.statusOf(entry({ paidDate: TODAY }), TODAY)).toBe("recebido");
    expect(ledger.statusOf(entry({ kind: "despesa", paidDate: TODAY }), TODAY)).toBe("pago");
    expect(ledger.statusOf(entry({ dueDate: "2026-11-25" }), TODAY)).toBe("em_atraso");
    expect(ledger.statusOf(entry({ dueDate: TODAY }), TODAY)).toBe("a_vencer");
    expect(ledger.statusOf(entry({ kind: "despesa", dueDate: "2026-12-01" }), TODAY)).toBe("a_pagar");
  });

  it("busca sem acento nem caixa e ordenação por data nas duas direções", () => {
    const rows = viewOf("2026-11").rows;
    expect(ledger.searchEntries(rows, "  REGULARIZACAO ").map((r) => r.party)).toEqual(["Helena Duarte"]);
    // Busca pelo fornecedor; o próximo aluguel vence em dezembro, então novembro tem só o pago.
    expect(ledger.searchEntries(rows, "imoveis horizonte").map((r) => r.description)).toEqual(["Aluguel do escritório"]);
    expect(ledger.searchEntries(rows, "inexistente")).toEqual([]);
    const asc = ledger.sortByDate(rows, "asc").map(ledger.movementDate);
    expect(asc).toEqual([...asc].sort());
    expect(ledger.sortByDate(rows, "desc").map(ledger.movementDate)).toEqual([...asc].reverse());
  });
});

describe("lançamentos estáveis por mês", () => {
  const DAYS = ["2026-11-26", "2026-11-27", "2026-12-01", "2026-12-15", "2027-01-10"];
  const ofMonth = (today: string, month: string) => buildFinanceDemo(today).entries.filter((e) => e.id.startsWith(`demo-${month}-`));
  const upTo = (today: string, month: string) => buildFinanceDemo(today).entries.filter((e) => e.id.slice(5, 12) <= month);

  it.each(DAYS.slice(1))("em %s novembro (e o que veio antes) são os MESMOS lançamentos de 26/11", (today) => {
    expect(ofMonth("2026-11-26", "2026-11")).toHaveLength(58);
    expect(ofMonth(today, "2026-11")).toEqual(ofMonth("2026-11-26", "2026-11"));
    expect(upTo(today, "2026-11")).toEqual(upTo("2026-11-26", "2026-11"));
    const nov = viewOf("2026-11", today);
    const original = viewOf("2026-11");
    expect(nov.rows).toEqual(original.rows);
    expect(nov.totals).toEqual({ receivedCents: 3_840_000, paidCents: 1_260_000, resultCents: 2_580_000 });
    expect(nov.receivable).toEqual({ totalCents: 1_420_000, upcomingCents: 1_100_000, overdueCents: 320_000 });
    // Os dias novos do realizado entram zerados; os já vistos não mudam.
    expect(nov.flow.slice(0, original.flow.length)).toEqual(original.flow);
    expect(nov.flow.slice(original.flow.length).every((d) => d.receivedCents === 0 && d.paidCents === 0)).toBe(true);
  });

  it("datas e identificadores de novembro são fixos no calendário", () => {
    const november = ofMonth("2026-12-15", "2026-11");
    expect(november).toHaveLength(58);
    const byId = (id: string) => november.find((e) => e.id === id);
    expect(byId("demo-2026-11-001")).toMatchObject({ party: "Caio Ferraz", amountCents: 50_000, paidDate: "2026-11-01" });
    expect(byId("demo-2026-11-021")).toMatchObject({ party: "Helena Duarte", amountCents: 480_000, paidDate: "2026-11-25" });
    expect(byId("demo-2026-11-040")).toMatchObject({ description: "Aluguel do escritório", amountCents: 150_000, paidDate: "2026-11-13" });
    expect(byId("demo-2026-11-054")).toMatchObject({ party: "Família Moreira", createdDate: "2026-11-24", dueDate: "2026-11-30", paidDate: null });
    expect(byId("demo-2026-11-058")).toMatchObject({ party: "Rafael Nogueira", createdDate: "2026-09-05", dueDate: "2026-11-20", paidDate: null });
  });

  it("depois da virada, novembro é mês fechado: só mudam o corte, a comparação e a situação de vencimento", () => {
    const nov = viewOf("2026-11", "2026-12-01");
    expect(nov.phase).toBe("past");
    expect(nov.reference).toBe("2026-11-30");
    expect(nov.comparisonWindow).toEqual({ month: "2026-10", from: "2026-10-01", to: "2026-10-31", partial: false });
    expect(nov.comparison.received).toEqual({ kind: "change", percent: 18.5, previousCents: 3_240_000 });
    expect(nov.comparison.result).toEqual({ kind: "change", percent: 37.7, previousCents: 1_874_000 });
    expect(nov.comparison.receivable).toEqual({ kind: "change", percent: 12.7, previousCents: 1_260_000 });
    const installment = nov.rows.find((e) => e.id === "demo-2026-11-054")!;
    expect(ledger.statusOf(installment, "2026-11-30")).toBe("a_vencer");
    expect(ledger.statusOf(installment, "2026-12-01")).toBe("em_atraso");
  });

  it("dia após dia, de novembro a fevereiro, nenhum lançamento visto some ou muda; só um pagamento pode se realizar", () => {
    let before = buildFinanceDemo("2026-11-01").entries;
    for (let today = "2026-11-02"; today <= "2027-02-05"; today = civil.addCivilDays(today, 1)) {
      const now = new Map(buildFinanceDemo(today).entries.map((e) => [e.id, e]));
      for (const seen of before) {
        const current = now.get(seen.id);
        const realizedNow = seen.paidDate === null && current?.paidDate != null && current.paidDate <= today;
        expect(current, `${seen.id} em ${today}`).toEqual(realizedNow ? { ...seen, paidDate: current!.paidDate } : seen);
      }
      before = [...now.values()];
    }
  });

  it("a data atual só corta: nada lançado ou movimentado depois dela, sem alterar o conjunto do mês", () => {
    const today = "2026-11-10";
    const data = buildFinanceDemo(today);
    expect(data.entries.every((e) => e.createdDate <= today && (e.paidDate === null || e.paidDate <= today))).toBe(true);
    // Lançado em outubro e recebido só em 24/11: no dia 10 ainda está em aberto, com o mesmo vencimento.
    const pending = data.entries.find((e) => e.description === "Parcela 2 de 2 · Escritura")!;
    expect(pending).toMatchObject({ createdDate: "2026-10-18", dueDate: "2026-11-24", paidDate: null });
    expect(ledger.statusOf(pending, today)).toBe("a_vencer");
    expect(demoEntriesOfMonth("2026-11").find((e) => e.id === pending.id)!.paidDate).toBe("2026-11-24");
  });

  it("meses a partir de dezembro ficam dentro do próprio mês: não mexem em novembro e também são estáveis", () => {
    for (const month of ["2026-12", "2027-01", "2027-06"]) {
      const entries = demoEntriesOfMonth(month);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e) => [e.createdDate, e.dueDate, e.paidDate!].every((d) => d.startsWith(month)))).toBe(true);
    }
    const early = ofMonth("2026-12-05", "2026-12");
    const later = ofMonth("2026-12-20", "2026-12");
    expect(early.length).toBeGreaterThan(0);
    expect(later.filter((e) => e.createdDate <= "2026-12-05")).toEqual(early);
    expect(ofMonth("2027-01-10", "2026-12")).toEqual(demoEntriesOfMonth("2026-12"));
    expect(viewOf("2026-12", "2027-01-10").totals).toEqual({ receivedCents: 3_240_000, paidCents: 1_366_000, resultCents: 1_874_000 });
    expect(viewOf("2026-10", "2027-01-10")).toEqual(viewOf("2026-10"));
    expect(buildFinanceDemo("2027-01-10").coverageStart).toBe("2026-06-01");
  });

  it("na tela, aberta em dezembro, novembro continua com os mesmos números e linhas", () => {
    const data = buildFinanceDemo("2026-12-01");
    render(<FinanceDashboard initialEntries={data.entries} coverageStart={data.coverageStart} today="2026-12-01" />);
    const month = screen.getByRole("combobox", { name: "Mês e ano" });
    expect(month).toHaveValue("2026-12");
    fireEvent.change(month, { target: { value: "2026-11" } });
    const values = ["received", "paid", "result", "receivable"].map((k) => plain(screen.getByTestId(`finance-card-${k}`).textContent));
    expect(values).toEqual(["R$ 38.400", "R$ 12.600", "R$ 25.800", "R$ 14.200"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Buscar lançamento" }), { target: { value: "regularizacao" } });
    const table = screen.getByRole("table", { name: /Lançamentos de novembro/ });
    const row = within(table).getAllByRole("row")[1]!;
    expect(row).toHaveTextContent("Helena Duarte");
    expect(row.querySelector("time")).toHaveAttribute("datetime", "2026-11-25");
  });
});

describe("formulário da simulação", () => {
  const draft = {
    kind: "receita" as const,
    description: "Consulta",
    party: "Cliente Fictício",
    amount: "1.250,50",
    dueDate: "2026-11-30",
    settled: false,
    paidDate: "",
  };

  it.each([
    ["1250", 125_000],
    ["1.250", 125_000],
    ["1.250,5", 125_050],
    ["R$ 1.250,56", 125_056],
    ["0,01", 1],
    ["19,99", 1999],
  ])("lê %s como centavos inteiros", (text, cents) => {
    expect(parseAmountCents(text)).toBe(cents);
  });

  it.each(["", "abc", "1.5", "1,234.56", "-10", "1,999", "12.34,00", "1..000", "999999999999999"])("recusa %j", (text) => {
    expect(parseAmountCents(text)).toBeNull();
  });

  it("monta o lançamento com a data de hoje e marcado como simulado", () => {
    const result = validateNewEntry(draft, TODAY, "sim-1");
    expect(result).toEqual({
      ok: true,
      entry: {
        id: "sim-1",
        kind: "receita",
        description: "Consulta",
        party: "Cliente Fictício",
        amountCents: 125_050,
        createdDate: TODAY,
        dueDate: "2026-11-30",
        paidDate: null,
        simulated: true,
      },
    });
  });

  it.each<[string, Partial<typeof draft>, string]>([
    ["sem descrição", { description: "  " }, "description"],
    ["sem cliente", { party: "" }, "party"],
    ["valor zero", { amount: "0" }, "amount"],
    ["valor acima do limite", { amount: "200.000.000,00" }, "amount"],
    ["vencimento inexistente", { dueDate: "2026-02-30" }, "dueDate"],
    ["vencimento muito distante", { dueDate: "2040-01-01" }, "dueDate"],
    ["recebido sem data", { settled: true, paidDate: "" }, "paidDate"],
    ["recebido no futuro", { settled: true, paidDate: "2026-11-27" }, "paidDate"],
  ])("recusa %s", (_, patch, field) => {
    const result = validateNewEntry({ ...draft, ...patch }, TODAY, "sim-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors)).toEqual([field]);
  });
});

describe("tela da demonstração", () => {
  const view = () => render(<FinanceDashboard initialEntries={demo.entries} coverageStart={demo.coverageStart} today={TODAY} />);
  const card = (key: string) => plain(screen.getByTestId(`finance-card-${key}`).textContent);
  const donut = (key: string) => plain(screen.getByTestId(`finance-donut-${key}`).textContent);
  const month = () => screen.getByRole("combobox", { name: "Mês e ano" });

  function launch(values: { kind?: string; amount: string; settled?: boolean; dueDate?: string; paidDate?: string; description?: string }) {
    fireEvent.click(screen.getByRole("button", { name: "Novo lançamento" }));
    const dialog = screen.getByRole("dialog");
    if (values.kind) fireEvent.click(within(dialog).getByRole("radio", { name: values.kind }));
    fireEvent.change(within(dialog).getByLabelText("Descrição"), { target: { value: values.description ?? "Lançamento de teste" } });
    fireEvent.change(within(dialog).getByLabelText(/\(fictício\)$/), { target: { value: "Pessoa Fictícia" } });
    fireEvent.change(within(dialog).getByLabelText("Valor (R$)"), { target: { value: values.amount } });
    if (values.dueDate) fireEvent.change(within(dialog).getByLabelText("Vencimento"), { target: { value: values.dueDate } });
    if (values.settled) {
      fireEvent.click(within(dialog).getByRole("radio", { name: /^(Recebido|Pago)$/ }));
      if (values.paidDate) fireEvent.change(within(dialog).getByLabelText(/^Data do/), { target: { value: values.paidDate } });
    }
    fireEvent.click(within(dialog).getByRole("button", { name: "Adicionar à simulação" }));
  }

  it("identifica a simulação e mostra os mesmos números nos cartões, na rosca e na tabela do gráfico", () => {
    view();
    expect(screen.getByRole("note")).toHaveTextContent("Simulação — não grava no financeiro do escritório");
    expect(card("received")).toBe("R$ 38.400");
    expect(card("paid")).toBe("R$ 12.600");
    expect(card("result")).toBe("R$ 25.800");
    expect(card("receivable")).toBe("R$ 14.200");
    expect(donut("total")).toBe("R$ 14.200");
    expect(donut("upcoming")).toBe("R$ 11.000");
    expect(donut("overdue")).toBe("R$ 3.200");
    fireEvent.click(screen.getByText("Ver dados em tabela"));
    const totalRow = screen.getByRole("rowheader", { name: "Total do mês" }).closest("tr")!;
    expect(plain(totalRow.textContent)).toBe("Total do mêsR$ 38.400R$ 12.600");
    expect(plain(document.body.textContent)).toContain("vs. 1 a 26/10 (R$ 32.400)");
    expect(document.body.textContent).toContain("Posição em 26/11");
  });

  it("navega entre meses pelas setas e pelo seletor, inclusive mês sem lançamentos", () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: "Mês anterior" }));
    expect(month()).toHaveValue("2026-10");
    expect(card("received")).toBe("R$ 32.400");
    expect(card("receivable")).toBe("R$ 12.600");
    fireEvent.change(month(), { target: { value: "2026-01" } });
    for (const key of ["received", "paid", "result", "receivable"]) expect(card(key)).toBe("R$ 0");
    expect(screen.getByText("Nenhum recebimento ou pagamento em janeiro.")).toBeInTheDocument();
    expect(screen.getByText("Nenhum lançamento em janeiro.")).toBeInTheDocument();
    expect(screen.getByText("Nenhum honorário em aberto nesta data.")).toBeInTheDocument();
    expect(screen.getByText(/Os dados da demonstração começam em 01\/06\/2026/)).toBeInTheDocument();
    fireEvent.change(month(), { target: { value: "2026-12" } });
    expect(screen.getByText("Mês futuro: ainda não há movimentação realizada.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Próximo mês" }));
    expect(month()).toHaveValue("2027-01");
  });

  it("receita recebida atualiza recebido, resultado e tabela, sem tocar no a receber", () => {
    view();
    launch({ amount: "1.000,00", settled: true, description: "Parecer simulado" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(card("received")).toBe("R$ 39.400");
    expect(card("result")).toBe("R$ 26.800");
    expect(card("receivable")).toBe("R$ 14.200");
    const row = within(screen.getByRole("table", { name: /Lançamentos de novembro/ })).getByRole("rowheader", { name: /Parecer simulado/ });
    expect(row).toHaveTextContent("simulado");
    expect(screen.getByText(/Incluído na simulação/).closest('[role="status"]')).toHaveTextContent("(não gravado)");
    expect(document.body.textContent).not.toMatch(/salvo|gravado com sucesso|registrado com sucesso/i);
  });

  it("receita em aberto atualiza o a receber e a rosca; vencida conta como atraso", () => {
    view();
    launch({ amount: "500", dueDate: "2026-11-30" });
    launch({ amount: "300", dueDate: "2026-11-20" });
    expect(card("receivable")).toBe("R$ 15.000");
    expect(donut("total")).toBe("R$ 15.000");
    expect(donut("upcoming")).toBe("R$ 11.500");
    expect(donut("overdue")).toBe("R$ 3.500");
    expect(card("received")).toBe("R$ 38.400");
  });

  it("despesa paga atualiza despesas e resultado, que pode ficar negativo; despesa em aberto não entra no realizado", () => {
    view();
    launch({ kind: "Despesa", amount: "100.000", settled: true });
    expect(card("paid")).toBe("R$ 112.600");
    expect(card("result")).toBe("−R$ 74.200");
    launch({ kind: "Despesa", amount: "900", dueDate: "2026-11-29" });
    expect(card("paid")).toBe("R$ 112.600");
    expect(card("receivable")).toBe("R$ 14.200");
  });

  it("lançamento em outro mês avisa e leva até ele; restaurar volta ao estado inicial", () => {
    view();
    launch({ amount: "700", settled: true, paidDate: "2026-10-12" });
    expect(card("received")).toBe("R$ 38.400");
    fireEvent.click(screen.getByRole("button", { name: "Ver outubro" }));
    expect(card("received")).toBe("R$ 33.100");
    fireEvent.click(screen.getByRole("button", { name: "Restaurar demonstração" }));
    expect(month()).toHaveValue("2026-11");
    expect(card("received")).toBe("R$ 38.400");
    expect(screen.queryByRole("button", { name: "Restaurar demonstração" })).not.toBeInTheDocument();
  });

  it("nada é enviado nem guardado no navegador; montar de novo volta ao início", () => {
    const set = vi.spyOn(Storage.prototype, "setItem");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.reject(new Error("não deveria chamar")));
    const first = view();
    launch({ amount: "1.000", settled: true });
    expect(card("received")).toBe("R$ 39.400");
    first.unmount();
    view();
    expect(card("received")).toBe("R$ 38.400");
    expect(set).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    set.mockRestore();
    fetchSpy.mockRestore();
  });

  it("formulário inválido mostra os erros, marca os campos e leva o foco ao primeiro", () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: "Novo lançamento" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Novo lançamento (simulação)");
    expect(dialog).toHaveTextContent("Simulação — não grava no financeiro do escritório");
    fireEvent.click(within(dialog).getByRole("button", { name: "Adicionar à simulação" }));
    const description = within(dialog).getByLabelText("Descrição");
    expect(description).toHaveAttribute("aria-invalid", "true");
    expect(description).toHaveFocus();
    expect(description).toHaveAccessibleDescription("Informe a descrição.");
    expect(within(dialog).getByText("Informe o valor em reais, como 1.250,00.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(card("received")).toBe("R$ 38.400");
  });

  it("tabela: mais recentes primeiro, mostrar todos, ordenar pela data e buscar", () => {
    view();
    const table = () => screen.getByRole("table", { name: /Lançamentos de novembro/ });
    const bodyRows = () => within(table()).getAllByRole("row").slice(1);
    expect(bodyRows()).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: /Mostrar todos \(\d+\)/ }));
    expect(bodyRows().length).toBeGreaterThan(20);
    const header = within(table()).getByRole("columnheader", { name: "Data" });
    expect(header).toHaveAttribute("aria-sort", "descending");
    fireEvent.click(within(header).getByRole("button"));
    expect(header).toHaveAttribute("aria-sort", "ascending");
    const dates = bodyRows().map((r) => r.querySelector("time")!.getAttribute("datetime")!);
    expect(dates).toEqual([...dates].sort());
    const search = screen.getByRole("searchbox", { name: "Buscar lançamento" });
    fireEvent.change(search, { target: { value: "regularizacao" } });
    expect(bodyRows()).toHaveLength(1);
    expect(bodyRows()[0]).toHaveTextContent("Helena Duarte");
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText("Nenhum lançamento encontrado para “zzz”.")).toBeInTheDocument();
  });

  it("textos longos não quebram o formulário nem a tabela", () => {
    view();
    const long = "Honorários ".repeat(12).trim();
    launch({ amount: "10", settled: true, description: long });
    expect(screen.getAllByText(long).length).toBeGreaterThan(0);
  });
});

describe("isolamento e permissões", () => {
  const html = async (searchParams?: Record<string, string>) => {
    const element = await (FinanceiroPage as (p?: unknown) => Promise<React.ReactElement>)({
      searchParams: Promise.resolve(searchParams ?? {}),
    });
    return { element, markup: plain(renderToStaticMarkup(element)) };
  };

  it("só proprietário, administrador e gestor têm finance.view", () => {
    for (const role of ["owner", "admin", "manager"] as const) expect(roleHasPermission(role, "finance.view")).toBe(true);
    for (const role of ["lawyer", "sales", "viewer"] as const) expect(roleHasPermission(role, "finance.view")).toBe(false);
  });

  it.each(["lawyer", "sales", "viewer"])("%s recebe 'não encontrado' antes de qualquer consulta, mesmo na demonstração", async (role) => {
    state.role = role;
    state.workspace = { data: { is_demo: true }, error: null };
    await expect(html()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(state.queries).toEqual([]);
  });

  it("escritório real: estado sem lançamentos, sem número nem dado fictício, com qualquer parâmetro na URL", async () => {
    const { element, markup } = await html({ demo: "1", is_demo: "true", mes: "2026-11" });
    expect(markup).toContain("Ainda não há lançamentos neste módulo");
    expect(markup).not.toMatch(/R\$|Helena Duarte|Novo lançamento|Simulação|demonstrativ/i);
    expect(JSON.stringify(element)).not.toMatch(/demo-1|Helena Duarte|Regularização/);
    expect(state.queries).toEqual(["workspaces.is_demo.id=w-1"]);
  });

  it.each(["owner", "admin", "manager"])("%s vê a demonstração só quando o servidor diz que o escritório é demonstrativo", async (role) => {
    state.role = role;
    state.workspace = { data: { is_demo: true }, error: null };
    const { markup } = await html();
    expect(markup).toContain("Dados demonstrativos");
    expect(markup).toContain("Novo lançamento");
  });

  it("falha ao conferir o escritório é erro: nunca vira demonstração nem 'sem lançamentos'", async () => {
    state.workspace = { data: null, error: { message: "boom" } };
    await expect(html()).rejects.toBeInstanceOf(DataLoadError);
  });

  it("nada no Financeiro grava, chama servidor, usa armazenamento ou lê o CRM; a demonstração só entra pela página", () => {
    const root = resolve(__dirname, "..", "..", "src");
    const files = [
      ...readdirSync(resolve(root, "components/finance")).map((f) => `components/finance/${f}`),
      ...readdirSync(resolve(root, "modules/finance")).map((f) => `modules/finance/${f}`),
      "app/(app)/financeiro/page.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(resolve(root, file), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(source, file).not.toMatch(
        /localStorage|sessionStorage|indexedDB|fetch\(|"use server"|createServerSupabaseClient|\.insert\(|\.upsert\(|\.rpc\(|modules\/(opportunities|proposals|clients)/,
      );
      if (file !== "app/(app)/financeiro/page.tsx") expect(source, file).not.toMatch(/from "[^"]*demo-data"/);
    }
  });
});
