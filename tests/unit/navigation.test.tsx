import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Sidebar } from "@/components/app-shell/sidebar";
import { primaryNav, secondaryNav } from "@/components/app-shell/navigation";

vi.mock("next/navigation", () => ({
  usePathname: () => "/pipeline",
}));

describe("Sidebar", () => {
  it("exibe todos os itens de navegação do protótipo", () => {
    render(<Sidebar />);

    for (const item of [...primaryNav, ...secondaryNav]) {
      expect(screen.getByRole("link", { name: item.label })).toHaveAttribute(
        "href",
        item.href,
      );
    }
  });

  it("marca apenas a rota atual com aria-current", () => {
    render(<Sidebar />);

    expect(screen.getByRole("link", { name: "Pipeline" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Leads" })).not.toHaveAttribute(
      "aria-current",
    );
  });
});
