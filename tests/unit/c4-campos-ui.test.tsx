/**
 * C4 — interação: o formulário de valores dentro da tela do registro (por tipo,
 * somente leitura sem permissão de edição, erro sanitizado), a seção que não
 * desenha nada sem campos, o diálogo de definição (tipo e entidade fixos ao editar,
 * opção usada não sai) e a lista com arquivamento em dois passos.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { saveValuesMock, saveDefMock, archiveMock, valuesQueryMock } = vi.hoisted(() => ({
  saveValuesMock: vi.fn(),
  saveDefMock: vi.fn(),
  archiveMock: vi.fn(),
  valuesQueryMock: vi.fn(),
}));

vi.mock("@/modules/custom-fields/actions", () => ({
  saveCustomFieldValuesAction: saveValuesMock,
  saveCustomFieldDefinitionAction: saveDefMock,
  setCustomFieldArchivedAction: archiveMock,
}));
vi.mock("@/modules/custom-fields/queries", () => ({ getCustomFieldValues: valuesQueryMock }));

import { CustomFieldsForm } from "@/components/custom-fields/custom-fields-form";
import { CustomFieldsSection } from "@/components/custom-fields/custom-fields-section";
import { CustomFieldDefinitionDialog } from "@/components/custom-fields/definition-dialog";
import { CustomFieldDefinitionList } from "@/components/custom-fields/definition-list";
import type { CustomFieldDefinition, CustomFieldValueField } from "@/modules/custom-fields/queries";

const LEAD = "80000000-0000-0000-0000-000000000001";
const D_TEXT = "a0000000-0000-0000-0000-000000000001";
const D_NUM = "a0000000-0000-0000-0000-000000000002";
const D_DATE = "a0000000-0000-0000-0000-000000000003";
const D_BOOL = "a0000000-0000-0000-0000-000000000004";
const D_SEL = "a0000000-0000-0000-0000-000000000005";
const O1 = "b0000000-0000-0000-0000-000000000001";
const O2 = "b0000000-0000-0000-0000-000000000002";

const FIELDS: CustomFieldValueField[] = [
  { definitionId: D_TEXT, name: "Observação", type: "text", position: 0, options: [], value: "Indicação" },
  { definitionId: D_NUM, name: "Valor da causa", type: "number", position: 1, options: [], value: 1234.5 },
  { definitionId: D_DATE, name: "Audiência", type: "date", position: 2, options: [], value: "2026-12-15" },
  { definitionId: D_BOOL, name: "Prioritário", type: "boolean", position: 3, options: [], value: false },
  {
    definitionId: D_SEL,
    name: "Fase",
    type: "select",
    position: 4,
    options: [
      { id: O1, label: "Conhecimento" },
      { id: O2, label: "Recursal" },
    ],
    value: O2,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("formulário de valores", () => {
  it("com permissão de edição: um campo por definição, no tipo certo, com o valor atual", () => {
    render(<CustomFieldsForm entity="lead" recordId={LEAD} fields={FIELDS} canEdit />);
    expect((screen.getByLabelText("Observação") as HTMLInputElement).value).toBe("Indicação");
    expect((screen.getByLabelText("Valor da causa") as HTMLInputElement).value).toBe("1234.5");
    const date = screen.getByLabelText("Audiência") as HTMLInputElement;
    expect(date.type).toBe("date");
    expect(date.value).toBe("2026-12-15");
    expect((screen.getByLabelText("Prioritário") as HTMLSelectElement).value).toBe("false");
    const select = screen.getByLabelText("Fase") as HTMLSelectElement;
    expect(select.value).toBe(O2);
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Não informado", "Conhecimento", "Recursal"]);
  });

  it("salvar envia UMA chamada com todos os campos (cf_<id>) e mostra o resultado", async () => {
    saveValuesMock.mockResolvedValue({ ok: true, changed: 1 });
    render(<CustomFieldsForm entity="lead" recordId={LEAD} fields={FIELDS} canEdit />);
    fireEvent.change(screen.getByLabelText("Valor da causa"), { target: { value: "99,9" } });
    fireEvent.change(screen.getByLabelText("Prioritário"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar campos" }));

    await waitFor(() => expect(screen.getByText("Campos salvos.")).toBeTruthy());
    expect(saveValuesMock).toHaveBeenCalledTimes(1);
    const [entity, recordId, data] = saveValuesMock.mock.calls[0] as [string, string, FormData];
    expect([entity, recordId]).toEqual(["lead", LEAD]);
    expect(Object.fromEntries(data.entries())).toEqual({
      [`cf_${D_TEXT}`]: "Indicação",
      [`cf_${D_NUM}`]: "99,9",
      [`cf_${D_DATE}`]: "2026-12-15",
      [`cf_${D_BOOL}`]: "",
      [`cf_${D_SEL}`]: O2,
    });
  });

  it("erro do servidor aparece como veio (já sanitizado) e nada é dado como salvo", async () => {
    saveValuesMock.mockResolvedValue({ ok: false, error: "Valor da causa: Número inválido." });
    render(<CustomFieldsForm entity="lead" recordId={LEAD} fields={FIELDS} canEdit />);
    fireEvent.click(screen.getByRole("button", { name: "Salvar campos" }));
    await waitFor(() => expect(screen.getByText("Valor da causa: Número inválido.")).toBeTruthy());
    expect(screen.queryByText("Campos salvos.")).toBeNull();
  });

  it("sem permissão de edição: só leitura, sem campo de entrada nem botão, com os valores legíveis", () => {
    render(<CustomFieldsForm entity="client" recordId={LEAD} fields={FIELDS} canEdit={false} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Indicação")).toBeTruthy();
    expect(screen.getByText("15/12/2026")).toBeTruthy();
    expect(screen.getByText("Recursal")).toBeTruthy();
    expect(screen.getByText("Não")).toBeTruthy();
    expect(screen.getByText("1.234,5")).toBeTruthy();
  });

  it("valor vazio aparece como traço na leitura", () => {
    render(<CustomFieldsForm entity="lead" recordId={LEAD} fields={[{ ...FIELDS[0]!, value: null }]} canEdit={false} />);
    expect(screen.getByText("—")).toBeTruthy();
  });
});

describe("seção na tela do registro", () => {
  it("sem nenhuma definição ativa (ou sem alcance) não desenha nada — a tela fica como era", async () => {
    valuesQueryMock.mockResolvedValue([]);
    expect(await CustomFieldsSection({ entity: "lead", recordId: LEAD, canEdit: true })).toBeNull();
    valuesQueryMock.mockResolvedValue(null);
    expect(await CustomFieldsSection({ entity: "lead", recordId: LEAD, canEdit: true })).toBeNull();
  });

  it("com campos, consulta a entidade e o registro certos", async () => {
    valuesQueryMock.mockResolvedValue(FIELDS);
    const element = await CustomFieldsSection({ entity: "opportunity", recordId: LEAD, canEdit: false });
    expect(element).not.toBeNull();
    expect(valuesQueryMock).toHaveBeenCalledWith("opportunity", LEAD);
  });

  it("falha ao carregar não derruba a tela: vira um aviso só na seção", async () => {
    valuesQueryMock.mockRejectedValue(new Error("senha=segredo"));
    const element = await CustomFieldsSection({ entity: "contact", recordId: LEAD, canEdit: true });
    render(element!);
    expect(screen.getByText(/Não foi possível carregar os campos personalizados/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("segredo");
  });
});

const SELECT_DEF: CustomFieldDefinition = {
  id: D_SEL,
  entity: "lead",
  name: "Fase",
  type: "select",
  position: 4,
  archived: false,
  options: [
    { id: O1, label: "Conhecimento", inUse: false },
    { id: O2, label: "Recursal", inUse: true },
  ],
};

describe("diálogo de definição", () => {
  it("ao editar, entidade e tipo ficam fixos; opção em uso não pode ser removida, a livre pode", () => {
    render(<CustomFieldDefinitionDialog definition={SELECT_DEF} trigger={<button>Editar</button>} />);
    fireEvent.click(screen.getByText("Editar"));
    expect((screen.getByLabelText("Entidade") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText("Tipo") as HTMLSelectElement).disabled).toBe(true);
    const removers = screen.getAllByRole("button", { name: "Remover" }) as HTMLButtonElement[];
    expect(removers.map((b) => b.disabled)).toEqual([false, true]);
    expect(screen.getByText(/não podem ser removidas/)).toBeTruthy();
  });

  it("salvar uma edição manda o id da definição, o nome e as opções com seus ids (a nova sem id)", async () => {
    saveDefMock.mockResolvedValue({ ok: true, definitionId: D_SEL });
    render(<CustomFieldDefinitionDialog definition={SELECT_DEF} trigger={<button>Editar</button>} />);
    fireEvent.click(screen.getByText("Editar"));
    fireEvent.click(screen.getByRole("button", { name: "Adicionar opção" }));
    fireEvent.change(screen.getByLabelText("Opção 3"), { target: { value: "Cumprimento" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(saveDefMock).toHaveBeenCalledTimes(1));
    const data = saveDefMock.mock.calls[0]![0] as FormData;
    expect(data.get("definitionId")).toBe(D_SEL);
    expect(data.get("name")).toBe("Fase");
    expect(JSON.parse(String(data.get("options")))).toEqual([
      { id: O1, label: "Conhecimento" },
      { id: O2, label: "Recursal" },
      { label: "Cumprimento" },
    ]);
  });

  it("ao criar: só seleção única mostra opções; o aviso de segredo está visível; o erro volta sem fechar", async () => {
    saveDefMock.mockResolvedValue({ ok: false, error: "Já existe um campo ativo com esse nome nesta entidade." });
    render(<CustomFieldDefinitionDialog defaultEntity="client" trigger={<button>Novo</button>} />);
    fireEvent.click(screen.getByText("Novo"));
    expect((screen.getByLabelText("Entidade") as HTMLSelectElement).value).toBe("client");
    expect(screen.queryByText("Opções permitidas")).toBeNull();
    expect(screen.getByText(/Não use campos personalizados para CPF, credenciais, senhas/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Tipo"), { target: { value: "select" } });
    expect(screen.getByText("Opções permitidas")).toBeTruthy();
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(
      expect.arrayContaining(["Texto curto", "Número", "Data", "Sim ou não", "Seleção única"]),
    );
    expect(screen.queryByRole("option", { name: /múltipla|fórmula|arquivo/i })).toBeNull();

    fireEvent.change(screen.getByLabelText("Nome do campo"), { target: { value: "Nível" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar campo" }));
    await waitFor(() => expect(screen.getByText("Já existe um campo ativo com esse nome nesta entidade.")).toBeTruthy());
    expect(screen.getByLabelText("Nome do campo")).toBeTruthy();
  });
});

describe("lista de definições", () => {
  const defs: CustomFieldDefinition[] = [
    SELECT_DEF,
    { id: D_TEXT, entity: "contact", name: "Antigo", type: "text", position: 0, archived: true, options: [] },
  ];

  it("mostra tipo, entidade e estado; entidade vazia tem texto próprio", () => {
    render(<CustomFieldDefinitionList definitions={defs} />);
    expect(screen.getByText(/Leads · Seleção única · posição 4/)).toBeTruthy();
    expect(screen.getByText("Ativo")).toBeTruthy();
    expect(screen.getByText("Arquivado")).toBeTruthy();
    expect(screen.getByText(/Nenhum campo em oportunidades ainda/)).toBeTruthy();
    expect(screen.getByText(/1 de 50 campos ativos/)).toBeTruthy();
  });

  it("arquivar pede confirmação (dois passos) e só então chama o servidor; cancelar não chama", async () => {
    archiveMock.mockResolvedValue({ ok: true });
    render(<CustomFieldDefinitionList definitions={defs} />);
    fireEvent.click(screen.getByRole("button", { name: "Arquivar" }));
    expect(archiveMock).not.toHaveBeenCalled();
    expect(screen.getByText(/valores preenchidos continuam guardados/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(archiveMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Arquivar" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar arquivamento" }));
    await waitFor(() => expect(archiveMock).toHaveBeenCalledWith(D_SEL, true));
  });

  it("campo arquivado oferece restaurar (e não editar nem arquivar de novo)", async () => {
    archiveMock.mockResolvedValue({ ok: true });
    render(<CustomFieldDefinitionList definitions={[defs[1]!]} />);
    expect(screen.queryByRole("button", { name: "Editar" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restaurar" }));
    await waitFor(() => expect(archiveMock).toHaveBeenCalledWith(D_TEXT, false));
  });

  it("erro do servidor ao arquivar aparece no campo", async () => {
    archiveMock.mockResolvedValue({ ok: false, error: "Campo não encontrado." });
    render(<CustomFieldDefinitionList definitions={[SELECT_DEF]} />);
    fireEvent.click(screen.getByRole("button", { name: "Arquivar" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar arquivamento" }));
    await waitFor(() => expect(screen.getByText("Campo não encontrado.")).toBeTruthy());
  });
});
