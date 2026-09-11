import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Sidebar, type SidebarWorkspace } from "@/components/app-shell/sidebar";
import { primaryNav, secondaryNav } from "@/components/app-shell/navigation";

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

  it("mostra o workspace ativo no rodapé", () => {
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
