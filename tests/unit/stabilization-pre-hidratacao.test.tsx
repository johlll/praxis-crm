import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * Estabilização pós-A9 — inventário §5c
 * (docs/decisoes/estabilizacao-pos-a9.md).
 *
 * Uma edição feita enquanto a página hidratava já apareceu misturada ao
 * valor que veio do servidor — artefato observado uma vez no CI. A
 * tentativa posterior de reproduzir isso no ambiente hospedado foi
 * inválida (o script digitava sem limpar o campo e não segurava todos os
 * scripts) e foi descartada. A proteção do formulário foi comprovada
 * depois no preview, com o bloqueio correto (inventário §7.4).
 *
 * Proteção: enquanto o React não assume o formulário, ele não aceita
 * edição. Quem garante isso é o HTML que o servidor manda (`<fieldset
 * disabled>`), não uma espera no teste: antes do JavaScript chegar não há
 * nada nosso rodando no navegador.
 */

vi.mock("@/modules/leads/actions", () => ({
  updateLeadBasicFieldsAction: vi.fn(async () => ({ ok: true })),
  assignLeadAction: vi.fn(async () => ({ ok: true })),
}));

const { EditForm } = await import("@/components/feedback/edit-form");
const { LeadBasicFieldsForm } = await import("@/components/leads/lead-basic-fields-form");

const lead = {
  id: "l1",
  contactId: "c1",
  contactName: "X",
  legalArea: "Cível",
  summary: "Resumo do servidor",
  tags: [],
  priority: "media" as const,
  status: "ativo" as const,
  assignedTo: null,
  assignedToName: null,
  createdAt: "2026-09-01",
  updatedAt: "2026-09-01T00:00:00Z",
};

describe("janela antes da hidratação", () => {
  it("o HTML do servidor já chega com a edição bloqueada", () => {
    const html = renderToStaticMarkup(<LeadBasicFieldsForm lead={lead} readOnly={false} />);
    expect(html).toMatch(/<fieldset[^>]*\sdisabled/);
    // O valor do servidor está lá para ser lido, só não é editável ainda.
    expect(html).toContain("Resumo do servidor");
  });

  it("um campo dentro do EditForm sai desabilitado do servidor", () => {
    const html = renderToStaticMarkup(
      <EditForm action={() => {}}>
        <input name="x" defaultValue="valor do servidor" />
      </EditForm>,
    );
    expect(html).toMatch(/<fieldset[^>]*\sdisabled/);
  });

  it("depois de montado no navegador, a edição é liberada e o valor do servidor é preservado", () => {
    render(<LeadBasicFieldsForm lead={lead} readOnly={false} />);
    const campo = screen.getByLabelText("Resumo") as HTMLTextAreaElement;
    expect(campo).not.toBeDisabled();
    expect(campo.value).toBe("Resumo do servidor");
    fireEvent.change(campo, { target: { value: "Resumo novo" } });
    expect((screen.getByLabelText("Resumo") as HTMLTextAreaElement).value).toBe("Resumo novo");
  });

  it("readOnly continua desabilitando os campos depois da hidratação", () => {
    render(<LeadBasicFieldsForm lead={lead} readOnly />);
    expect(screen.getByLabelText("Resumo")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Salvar" })).toBeNull();
  });
});
