import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Menus de Responsável e Área jurídica da Visão geral. O que a tela de verdade faz com o envio (URL,
 * números, toque, largura do celular) é coberto no navegador, em tests/e2e/dashboard.spec.ts.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const { DashboardFilterBar } = await import("@/components/dashboard/filter-bar");
import type { DashboardFilters } from "@/modules/dashboard/schema";

const PIPE = "50000000-0000-0000-0000-000000000010";
const LUCAS = "20000000-0000-0000-0000-000000000011";
const DEMO = "20000000-0000-0000-0000-000000000012";

const members = [
  { userId: LUCAS, name: "Lucas Advogado" },
  { userId: DEMO, name: "Demo Proprietária (A10)" },
];

const base: DashboardFilters = {
  periodDays: 30,
  assignedTo: null,
  onlyUnassigned: false,
  legalArea: null,
  pipelineId: null,
  attributionModel: "first_touch",
  source: null,
  selectedOpportunityId: null,
};

const bar = (filters: DashboardFilters) => (
  <DashboardFilterBar filters={filters} today="2026-11-26" members={members} legalAreas={["Família", "Trabalhista"]} hasActiveFilters={false} />
);

const owner = () => screen.getByRole("button", { name: /^Responsável:/ });
const area = () => screen.getByRole("button", { name: /^Área jurídica:/ });
const options = () => within(screen.getByRole("menu")).getAllByRole("menuitemradio");
const option = (name: string) => within(screen.getByRole("menu")).getByRole("menuitemradio", { name });
const openWithKeyboard = (button: HTMLElement) => fireEvent.keyDown(button, { key: "Enter" });

/** O que o formulário enviaria NO MOMENTO do envio, que é o que vira a URL. */
function watchSubmits(): string[] {
  const sent: string[] = [];
  vi.spyOn(HTMLFormElement.prototype, "requestSubmit").mockImplementation(function (this: HTMLFormElement) {
    sent.push(new URLSearchParams(new FormData(this) as unknown as Record<string, string>).toString());
  });
  return sent;
}

beforeAll(() => {
  // O posicionamento do menu mede o botão; o jsdom não tem ResizeObserver.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => vi.restoreAllMocks());

describe("filtros fechados", () => {
  it("os três botões usam a mesma aparência e não há lista nativa", () => {
    render(bar(base));
    const period = screen.getByRole("button", { name: /^Período:/ });
    expect(owner().className).toBe(period.className);
    expect(area().className).toBe(period.className);
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(owner()).toHaveTextContent("Responsável: Toda a equipe");
    expect(area()).toHaveTextContent("Área jurídica: todas");
    expect(owner()).toHaveAttribute("aria-haspopup", "menu");
  });

  it("o rótulo fica em peso normal e o valor em destaque", () => {
    render(bar(base));
    expect(within(owner()).getByText("Responsável:")).not.toHaveClass("font-semibold");
    expect(within(owner()).getByText("Toda a equipe")).toHaveClass("font-semibold");
  });

  it("nome comprido aparece inteiro no botão e no menu", () => {
    render(bar({ ...base, assignedTo: DEMO }));
    expect(within(owner()).getByText("Demo Proprietária (A10)")).toBeInTheDocument();
    openWithKeyboard(owner());
    expect(option("Demo Proprietária (A10)")).toHaveTextContent("Demo Proprietária (A10)");
  });
});

describe("menu aberto", () => {
  it("lista as opções e marca só a escolhida", () => {
    render(bar({ ...base, legalArea: "Família" }));
    openWithKeyboard(area());
    expect(options().map((item) => item.textContent)).toEqual(["todas", "Família", "Trabalhista"]);
    expect(options().map((item) => item.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(option("Família").querySelector("svg")).not.toBeNull();
    expect(option("Trabalhista").querySelector("svg")).toBeNull();
  });

  it("pelo teclado, o foco começa na opção escolhida", async () => {
    render(bar({ ...base, assignedTo: DEMO }));
    openWithKeyboard(owner());
    await waitFor(() => expect(option("Demo Proprietária (A10)")).toHaveFocus());
  });

  it("área pedida na URL que não está na lista continua no menu", () => {
    render(bar({ ...base, legalArea: "Previdenciário" }));
    openWithKeyboard(area());
    expect(options().map((item) => item.textContent)).toEqual(["todas", "Previdenciário", "Família", "Trabalhista"]);
  });

  it("Escape fecha sem enviar e devolve o foco ao botão", async () => {
    const sent = watchSubmits();
    render(bar(base));
    openWithKeyboard(owner());
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(owner()).toHaveFocus());
    expect(sent).toEqual([]);
  });
});

describe("escolher uma opção", () => {
  it("fecha o menu e envia já com o valor novo, mantendo período, datas, origem, modelo, pipeline e o outro filtro", () => {
    const sent = watchSubmits();
    render(
      bar({
        ...base,
        range: { from: "2026-11-22", to: "2026-11-26" },
        legalArea: "Família",
        pipelineId: PIPE,
        source: "Site",
        attributionModel: "last_touch",
      }),
    );
    openWithKeyboard(owner());
    fireEvent.click(option("Demo Proprietária (A10)"));

    expect(screen.queryByRole("menu")).toBeNull();
    expect(owner()).toHaveTextContent("Responsável: Demo Proprietária (A10)");
    expect(sent).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(sent[0]))).toEqual({
      pipeline: PIPE,
      origem: "Site",
      modelo: "last_touch",
      periodo: "personalizado",
      de: "2026-11-22",
      ate: "2026-11-26",
      responsavel: DEMO,
      area: "Família",
    });
  });

  it("voltar ao padrão envia o campo vazio", () => {
    const sent = watchSubmits();
    render(bar({ ...base, periodDays: 7, legalArea: "Família", onlyUnassigned: true }));
    openWithKeyboard(area());
    fireEvent.click(option("todas"));
    expect(Object.fromEntries(new URLSearchParams(sent[0]))).toEqual({ periodo: "7", responsavel: "sem", area: "" });
  });

  it("escolher a opção que já está marcada só fecha o menu", () => {
    const sent = watchSubmits();
    render(bar(base));
    openWithKeyboard(owner());
    fireEvent.click(option("Toda a equipe"));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(sent).toEqual([]);
  });

  it("a URL manda: depois de escolher, aplicar e voltar, o botão não fica com a escolha antiga", () => {
    watchSubmits();
    const { rerender } = render(bar(base));
    openWithKeyboard(owner());
    fireEvent.click(option("Lucas Advogado"));
    rerender(bar({ ...base, assignedTo: LUCAS }));
    expect(owner()).toHaveTextContent("Responsável: Lucas Advogado");
    rerender(bar(base));
    expect(owner()).toHaveTextContent("Responsável: Toda a equipe");
    expect(document.querySelector<HTMLInputElement>('input[name="responsavel"]')?.value).toBe("");
  });
});
