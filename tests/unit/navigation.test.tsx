import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Sidebar, type SidebarWorkspace } from "@/components/app-shell/sidebar";
import { primaryNav, secondaryNav, sidebarLayout } from "@/components/app-shell/navigation";

vi.mock("@/modules/auth/actions", () => ({
  signOutAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/pipeline",
}));

vi.mock("@/modules/workspace/actions", () => ({
  switchWorkspaceAction: vi.fn(),
}));

const activeWorkspace: SidebarWorkspace = {
  id: "10000000-0000-0000-0000-000000000001",
  name: "Escritório Um (seed)",
  slug: "escritorio-um-seed",
  role: "owner",
};

describe("Sidebar", () => {
  it("exibe todos os itens de navegação do protótipo", () => {
    render(<Sidebar activeWorkspace={activeWorkspace} workspaces={[activeWorkspace]} />);

    for (const item of [...primaryNav, ...secondaryNav]) {
      expect(screen.getByRole("link", { name: item.label })).toHaveAttribute(
        "href",
        item.href,
      );
    }
  });

  it("marca apenas a rota atual com aria-current", () => {
    render(<Sidebar activeWorkspace={activeWorkspace} workspaces={[activeWorkspace]} />);

    expect(screen.getByRole("link", { name: "Pipeline" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Leads" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("o agrupamento visual contém cada item de navegação exatamente uma vez (nada escondido)", () => {
    const agrupados = sidebarLayout.flatMap((entry) =>
      entry.kind === "item" ? [entry.item.href] : entry.group.items.map((i) => i.href),
    );
    const todos = [...primaryNav, ...secondaryNav].map((i) => i.href);

    expect([...agrupados].sort()).toEqual([...todos].sort());
    expect(new Set(agrupados).size).toBe(agrupados.length);
  });

  it("grupos começam abertos e podem ser recolhidos e reabertos", () => {
    render(<Sidebar activeWorkspace={activeWorkspace} workspaces={[activeWorkspace]} overdueActivitiesCount={3} />);

    const operacao = screen.getByRole("button", { name: /Operação/ });
    expect(operacao).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(operacao);
    expect(operacao).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: /Atividades/ })).not.toBeInTheDocument();
    // Recolhido, o grupo continua mostrando as atrasadas.
    expect(screen.getByLabelText("3 atrasadas")).toBeInTheDocument();

    fireEvent.click(operacao);
    expect(screen.getByRole("link", { name: /Atividades/ })).toBeInTheDocument();
  });

  it("mostra a conta e as ações de conta no rodapé quando há usuário", () => {
    render(
      <Sidebar
        activeWorkspace={activeWorkspace}
        workspaces={[activeWorkspace]}
        user={{ fullName: "Ana Owner (seed)", initials: "AO", role: "owner" }}
      />,
    );

    expect(screen.getByRole("button", { name: "Menu do usuário" })).toHaveTextContent("Ana Owner (seed)");
  });

  it("mostra o workspace ativo no seletor", () => {
    render(<Sidebar activeWorkspace={activeWorkspace} workspaces={[activeWorkspace]} />);

    expect(screen.getByText("Escritório Um (seed)")).toBeInTheDocument();
  });

  it("A6: mostra o número de atrasadas como badge em Atividades", () => {
    render(
      <Sidebar activeWorkspace={activeWorkspace} workspaces={[activeWorkspace]} overdueActivitiesCount={3} />,
    );

    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByLabelText("3 atrasadas")).toBeInTheDocument();
  });

  it("A6: não mostra badge quando não há atrasadas", () => {
    render(
      <Sidebar activeWorkspace={activeWorkspace} workspaces={[activeWorkspace]} overdueActivitiesCount={0} />,
    );

    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
});
