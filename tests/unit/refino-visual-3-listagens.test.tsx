import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * Refinamento visual 3 — listagens de Contatos e Leads. A consulta, a
 * paginação no servidor e os parâmetros de URL são os mesmos; aqui se prova
 * que a apresentação nova mostra os mesmos campos, não esconde ausência
 * atrás de cor e preserva os nomes dos filtros e os links.
 */

import { formatPhoneForDisplay } from "@/lib/format-phone";
import { pageWindow, ListPagination } from "@/components/lists/list-pagination";
import { ContactListTable } from "@/components/contacts/contact-list-table";
import { Pagination } from "@/components/contacts/pagination";
import { LeadListTable } from "@/components/leads/lead-list-table";
import { LeadsPagination } from "@/components/leads/leads-pagination";
import { LeadFilterBar } from "@/components/leads/lead-filter-bar";
import type { ContactListItem } from "@/modules/contacts/queries";
import type { LeadListItem } from "@/modules/leads/queries";

const plain = (s: string | null | undefined) => (s ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();

describe("telefone na listagem", () => {
  it("brasileiro em E.164 fica legível; o resto volta como veio", () => {
    expect(formatPhoneForDisplay("+5511987654321")).toBe("(11) 98765-4321");
    expect(formatPhoneForDisplay("+551633334444")).toBe("(16) 3333-4444");
    expect(formatPhoneForDisplay("+14155550100")).toBe("+14155550100");
    expect(formatPhoneForDisplay("+55119")).toBe("+55119");
  });
});

describe("janela de páginas", () => {
  it("poucas páginas: todas; muitas: primeira, última, vizinhas e reticências", () => {
    expect(pageWindow(1, 4)).toEqual([1, 2, 3, 4]);
    expect(pageWindow(1, 12)).toEqual([1, 2, 3, 4, "gap", 12]);
    expect(pageWindow(6, 12)).toEqual([1, "gap", 5, 6, 7, "gap", 12]);
    expect(pageWindow(12, 12)).toEqual([1, "gap", 9, 10, 11, 12]);
  });
});

const contact = (over: Partial<ContactListItem>): ContactListItem => ({
  id: "00000000-0000-0000-0000-000000000001",
  name: "Carla Ferreira",
  type: "pf",
  city: "Campinas",
  uf: "SP",
  createdAt: "2026-11-01T12:00:00Z",
  phones: ["+5519912345678"],
  emails: ["carla@exemplo.test"],
  ...over,
});

describe("tabela de contatos", () => {
  it("mostra nome (link para o contato), e-mail, tipo, telefone e cidade/UF", () => {
    render(<ContactListTable items={[contact({})]} />);
    const link = screen.getByRole("link", { name: "Carla Ferreira" });
    expect(link).toHaveAttribute("href", "/contatos/00000000-0000-0000-0000-000000000001");
    const row = link.closest("tr")!;
    expect(plain(row.textContent)).toContain("carla@exemplo.test");
    expect(plain(row.textContent)).toContain("PF (pessoa física)");
    expect(plain(row.textContent)).toContain("(19) 91234-5678");
    expect(plain(row.textContent)).toContain("Campinas/SP");
    // Cabeçalhos de coluna continuam existindo para leitores de tela.
    expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["Contato", "Tipo", "Telefone", "Cidade/UF"]);
  });

  it("campo ausente é dito em texto, não só com um traço", () => {
    render(<ContactListTable items={[contact({ phones: [], emails: [], city: null, uf: null, type: "pj", name: "Jo" })]} />);
    const row = screen.getByRole("link", { name: "Jo" }).closest("tr")!;
    expect(plain(row.textContent)).toContain("Sem e-mail");
    expect(plain(row.textContent)).toContain("Telefone não informado");
    expect(plain(row.textContent)).toContain("Cidade não informado");
    expect(plain(row.textContent)).toContain("PJ (pessoa jurídica)");
  });

  it("e-mail longo fica inteiro no title (o corte é só visual)", () => {
    const email = "maria.aparecida.albuquerque.vasconcelos.filha@provedor-muito-longo.test";
    render(<ContactListTable items={[contact({ emails: [email] })]} />);
    expect(screen.getByText(email)).toHaveAttribute("title", email);
  });

  it("o nome aparece uma única vez no DOM (as iniciais são decorativas)", () => {
    render(<ContactListTable items={[contact({})]} />);
    expect(screen.getAllByText("Carla Ferreira", { exact: true })).toHaveLength(1);
    expect(screen.getByText("CF")).toHaveAttribute("aria-hidden", "true");
  });
});

const lead = (over: Partial<LeadListItem>): LeadListItem => ({
  id: "00000000-0000-0000-0000-0000000000aa",
  contactId: "00000000-0000-0000-0000-000000000001",
  contactName: "Carla Ferreira",
  legalArea: "Trabalhista",
  summary: "Rescisão indireta",
  tags: [],
  priority: "alta",
  status: "ativo",
  assignedTo: "u1",
  assignedToName: "Lucas Advogado",
  createdAt: "2026-11-01T12:00:00Z",
  updatedAt: "2026-11-01T12:00:00Z",
  ...over,
});

describe("tabela de leads", () => {
  it("mostra contato (link para o lead), resumo, área, prioridade, status e responsável — com texto, não só cor", () => {
    render(<LeadListTable items={[lead({})]} />);
    const link = screen.getByRole("link", { name: "Carla Ferreira" });
    expect(link).toHaveAttribute("href", "/leads/00000000-0000-0000-0000-0000000000aa");
    const cells = within(link.closest("tr")!).getAllByRole("cell").map((c) => plain(c.textContent));
    expect(cells).toEqual(["CFCarla FerreiraRescisão indireta", "Trabalhista", "Prioridade Alta", "Ativo", "LALucas Advogado"]);
    expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Contato",
      "Área jurídica",
      "Prioridade",
      "Status",
      "Responsável",
    ]);
  });

  it("sem responsável, sem resumo e arquivado", () => {
    render(<LeadListTable items={[lead({ assignedTo: null, assignedToName: null, summary: null, status: "arquivado", priority: "baixa" })]} />);
    const cells = within(screen.getByRole("link", { name: "Carla Ferreira" }).closest("tr")!)
      .getAllByRole("cell")
      .map((c) => plain(c.textContent));
    expect(cells).toEqual(["CFCarla Ferreira", "Trabalhista", "Prioridade Baixa", "Arquivado", "—Sem responsável"]);
  });
});

describe("paginação", () => {
  it("resumo do intervalo, página atual marcada e sem link morto nas pontas", () => {
    render(<Pagination page={1} total={67} pageSize={20} itemCount={20} basePath="/contatos" query="Mar" />);
    expect(plain(screen.getByText(/Mostrando/).textContent)).toBe("Mostrando 1–20 de 67 contatos");
    const nav = screen.getByRole("navigation", { name: "Paginação" });
    expect(within(nav).queryByRole("link", { name: /Anterior/ })).toBeNull();
    expect(within(nav).getByText("Anterior").closest("[aria-disabled=true]")).not.toBeNull();
    expect(within(nav).getByRole("link", { name: /Próxima/ })).toHaveAttribute("href", "/contatos?q=Mar&page=2");
    expect(within(nav).getByRole("link", { name: "Página 4" })).toHaveAttribute("href", "/contatos?q=Mar&page=4");
    expect(within(nav).getByText("Página 1").closest("[aria-current=page]")).not.toBeNull();
  });

  it("leads: troca de página preserva todos os filtros da URL", () => {
    render(
      <LeadsPagination
        page={2}
        total={65}
        pageSize={20}
        itemCount={20}
        currentParams={{ q: "Maria", status: "ativo", priority: "alta", assignedTo: "u1" }}
      />,
    );
    expect(plain(screen.getByText(/Mostrando/).textContent)).toBe("Mostrando 21–40 de 65 leads");
    expect(screen.getByRole("link", { name: /Anterior/ })).toHaveAttribute("href", "/leads?q=Maria&status=ativo&priority=alta&assignedTo=u1&page=1");
    expect(screen.getByRole("link", { name: /Próxima/ })).toHaveAttribute("href", "/leads?q=Maria&status=ativo&priority=alta&assignedTo=u1&page=3");
  });

  it("uma página só: mostra o resumo e nenhuma navegação", () => {
    render(<ListPagination page={1} total={2} pageSize={20} itemCount={2} noun={{ one: "lead", many: "leads" }} hrefFor={(p) => `/leads?page=${p}`} />);
    expect(plain(screen.getByText(/Mostrando/).textContent)).toBe("Mostrando 1–2 de 2 leads");
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});

describe("filtros de leads", () => {
  const members = [{ userId: "u1", fullName: "Lucas Advogado", email: "lucas@exemplo.test", role: "lawyer" }] as never;

  it("mesmos nomes de parâmetro, opções e rótulos; GET para /leads", () => {
    const { container } = render(
      <LeadFilterBar defaultValues={{ search: "", status: "", priority: "", assignedTo: "" }} members={members} hasActiveFilters={false} />,
    );
    const form = container.querySelector("form")!;
    expect(form.getAttribute("action")).toBe("/leads");
    expect(form.getAttribute("method")).toBe("get");
    expect([...form.querySelectorAll("input, select")].map((el) => el.getAttribute("name"))).toEqual(["q", "status", "priority", "assignedTo"]);
    expect(screen.getByRole("searchbox", { name: "Buscar leads" })).toBeInTheDocument();
    expect(within(screen.getByRole("combobox", { name: "Status" })).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Todos os status",
      "Ativo",
      "Arquivado",
    ]);
    expect(within(screen.getByRole("combobox", { name: "Prioridade" })).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Toda prioridade",
      "Baixa",
      "Média",
      "Alta",
    ]);
    expect(within(screen.getByRole("combobox", { name: "Responsável" })).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Todo responsável",
      "Lucas Advogado",
    ]);
    expect(screen.getByRole("button", { name: "Filtrar" })).toHaveAttribute("type", "submit");
    expect(screen.queryByRole("link", { name: /Limpar filtros/ })).toBeNull();
  });

  it("com filtro ativo: mantém os valores e oferece 'Limpar filtros' de volta para /leads", () => {
    render(
      <LeadFilterBar defaultValues={{ search: "Maria", status: "arquivado", priority: "alta", assignedTo: "u1" }} members={members} hasActiveFilters />,
    );
    expect(screen.getByRole("searchbox", { name: "Buscar leads" })).toHaveValue("Maria");
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("arquivado");
    expect(screen.getByRole("combobox", { name: "Prioridade" })).toHaveValue("alta");
    expect(screen.getByRole("combobox", { name: "Responsável" })).toHaveValue("u1");
    expect(screen.getByRole("link", { name: /Limpar filtros/ })).toHaveAttribute("href", "/leads");
  });
});
