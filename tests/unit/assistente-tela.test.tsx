/**
 * Assistente — tela: estado inicial, envio, blocos de resposta e os cartões de duplicidade e de
 * confirmação (corrigir, cancelar, clique duplo). As ações do servidor são simuladas aqui; o que elas
 * fazem está em assistente-servidor.test.ts.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { primaryNav, sidebarLayout } from "@/components/app-shell/navigation";
import type { AssistantBlock, AssistantReply, ConfirmResult } from "@/modules/assistant/types";

const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("@/modules/assistant/actions", () => ({
  askAssistantAction: mocks.ask,
  confirmRegistrationAction: mocks.confirm,
}));

const { AssistantChat } = await import("@/components/assistant/assistant-chat");

const replyWith = (blocks: AssistantBlock[], pending: AssistantReply["pending"] = null): AssistantReply => ({
  blocks,
  pending,
  interpreter: { id: "simulado-v1", simulated: true },
});

const REQ = "e0000000-0000-4000-8000-000000000001";
const draft = { name: "Ana Ribeiro", legalArea: "Imobiliário", summary: "Regularização de imóvel" };

beforeEach(() => {
  mocks.ask.mockReset();
  mocks.confirm.mockReset();
  Element.prototype.scrollTo = vi.fn();
});

async function sendSuggestion(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
  await waitFor(() => expect(mocks.ask).toHaveBeenCalled());
}

describe("menu", () => {
  it("Assistente entra logo depois da Visão geral", () => {
    expect(primaryNav[1]).toMatchObject({ href: "/assistente", label: "Assistente" });
    expect(sidebarLayout[1]).toMatchObject({ kind: "item", item: { href: "/assistente" } });
  });
});

describe("tela inicial", () => {
  it("saudação, as duas sugestões, o aviso da simulação e o campo de mensagem", () => {
    render(<AssistantChat firstName="Henrique" />);
    expect(screen.getByRole("heading", { name: "Olá, Henrique. Como posso ajudar?" })).toBeInTheDocument();
    const suggestions = within(screen.getByRole("group", { name: "Sugestões" })).getAllByRole("button");
    expect(suggestions.map((b) => b.textContent)).toEqual(["O que precisa da minha atenção hoje?", "Cadastre um cliente"]);
    expect(screen.getByRole("note")).toHaveTextContent("Interpretação simulada");
    expect(screen.getByRole("textbox", { name: "Mensagem" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
  });

  it("a sugestão é enviada como mensagem, e a resposta aparece", async () => {
    mocks.ask.mockResolvedValue(replyWith([{ type: "question", text: "Qual é o nome da pessoa?", missing: ["name"] }], {}));
    render(<AssistantChat firstName="Henrique" />);
    await sendSuggestion("Cadastre um cliente");
    expect(mocks.ask).toHaveBeenCalledWith({ text: "Cadastre um cliente", pending: null });
    expect(await screen.findByText("Qual é o nome da pessoa?")).toBeInTheDocument();
    expect(screen.getByText(/Cadastro em andamento/)).toBeInTheDocument();
  });

  it("o rascunho em aberto vai junto da próxima mensagem; Enter envia", async () => {
    mocks.ask.mockResolvedValueOnce(replyWith([{ type: "question", text: "Qual é a área?", missing: ["legalArea"] }], { name: "Ana Ribeiro" }));
    mocks.ask.mockResolvedValueOnce(replyWith([{ type: "text", text: "ok" }]));
    render(<AssistantChat firstName="Henrique" />);
    await sendSuggestion("Cadastre um cliente");
    await screen.findByText("Qual é a área?");
    const box = screen.getByRole("textbox", { name: "Mensagem" });
    fireEvent.change(box, { target: { value: "Família" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(mocks.ask).toHaveBeenLastCalledWith({ text: "Família", pending: { name: "Ana Ribeiro" } }));
  });

  it("falha de rede vira erro na conversa", async () => {
    mocks.ask.mockRejectedValue(new Error("rede"));
    render(<AssistantChat firstName="Henrique" />);
    await sendSuggestion("O que precisa da minha atenção hoje?");
    expect(await screen.findByRole("alert")).toHaveTextContent("Não consegui falar com o servidor");
  });
});

describe("diagnóstico", () => {
  it("prioridades com motivo e link do registro; parte indisponível dita como tal", async () => {
    mocks.ask.mockResolvedValue(
      replyWith([
        {
          type: "diagnosis",
          summary: "Encontrei 7 atividades atrasadas.",
          generatedAt: "2026-11-26T15:00:00Z",
          sections: [
            {
              key: "overdue",
              title: "Atividades atrasadas",
              status: "ok",
              total: 7,
              items: [{ id: "a1", title: "Carla Dias · Retornar", reason: "Ligação atrasada desde 25/11", href: "/leads/l1", tone: "danger" }],
              emptyText: "Nenhuma",
              moreHref: "/atividades?filter=overdue",
            },
            { key: "today", title: "Agenda de hoje", status: "unavailable", total: 0, items: [], emptyText: "x", moreHref: "/agenda" },
            { key: "attention", title: "Oportunidades que exigem atenção", status: "ok", total: 0, items: [], emptyText: "Nenhuma oportunidade.", moreHref: "/" },
          ],
        },
      ]),
    );
    render(<AssistantChat firstName="Henrique" />);
    await sendSuggestion("O que precisa da minha atenção hoje?");
    expect(await screen.findByRole("link", { name: /Carla Dias · Retornar/ })).toHaveAttribute("href", "/leads/l1");
    expect(screen.getByRole("link", { name: "Ver todas (7)" })).toHaveAttribute("href", "/atividades?filter=overdue");
    expect(screen.getByText(/Informação indisponível: não consegui consultar agenda de hoje agora/)).toBeInTheDocument();
    expect(screen.getByText("Nenhuma oportunidade.")).toBeInTheDocument();
  });
});

async function renderWithCard(block: AssistantBlock) {
  mocks.ask.mockResolvedValue(replyWith([block]));
  render(<AssistantChat firstName="Henrique" />);
  await sendSuggestion("Cadastre um cliente");
}

describe("cartão de confirmação", () => {
  const confirmBlock: AssistantBlock = { type: "confirm", requestId: REQ, draft, decision: null };

  it("mostra o que será criado", async () => {
    await renderWithCard(confirmBlock);
    const card = await screen.findByRole("region", { name: "Cadastrar pessoa e caso" });
    expect(card).toHaveTextContent("Ana Ribeiro");
    expect(card).toHaveTextContent("Imobiliário");
    expect(card).toHaveTextContent("Regularização de imóvel");
    expect(card).toHaveTextContent("não informado");
  });

  it("clique duplo chama o servidor uma vez; sucesso só depois da resposta, com os links", async () => {
    let resolve!: (r: ConfirmResult) => void;
    mocks.confirm.mockReturnValue(new Promise<ConfirmResult>((r) => (resolve = r)));
    await renderWithCard(confirmBlock);
    const button = await screen.findByRole("button", { name: "Confirmar cadastro" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("button", { name: /Gravando/ })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /Gravando/ }));
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.confirm).toHaveBeenCalledWith({ requestId: REQ, draft, decision: null });
    expect(screen.queryByText("Cadastro gravado")).toBeNull();

    await act(async () =>
      resolve({
        outcome: "saved",
        blocks: [
          { type: "success", contactName: "Ana Ribeiro", contactHref: "/contatos/c9", leadHref: "/leads/l9", legalArea: "Imobiliário", contactCreated: true, replayed: false },
        ],
      }),
    );
    expect(await screen.findByText("Cadastro gravado")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Abrir o lead" })).toHaveAttribute("href", "/leads/l9");
    expect(screen.getByRole("link", { name: "Abrir o contato" })).toHaveAttribute("href", "/contatos/c9");
  });

  it("cancelar não chama o servidor", async () => {
    await renderWithCard(confirmBlock);
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));
    expect(screen.getByText("Cadastro cancelado. Nada foi gravado.")).toBeInTheDocument();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("corrigir envia os dados corrigidos", async () => {
    mocks.confirm.mockResolvedValue({ outcome: "failed", blocks: [], message: "Recusado. Nada foi gravado." });
    await renderWithCard({ ...confirmBlock, decision: { kind: "new" } });
    fireEvent.click(await screen.findByRole("button", { name: "Corrigir" }));
    fireEvent.change(screen.getByLabelText("Área jurídica"), { target: { value: "Cível" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar cadastro" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith({ requestId: REQ, draft: { ...draft, legalArea: "Cível" }, decision: { kind: "new" } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Recusado. Nada foi gravado.");
    // O cartão continua para tentar de novo.
    expect(screen.getByRole("button", { name: "Confirmar cadastro" })).toBeEnabled();
  });

  it("mudar o nome na correção pede nova conferência de duplicidade", async () => {
    mocks.confirm.mockResolvedValue({ outcome: "failed", blocks: [], message: "x" });
    await renderWithCard({ ...confirmBlock, decision: { kind: "new" } });
    fireEvent.click(await screen.findByRole("button", { name: "Corrigir" }));
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Ana Ribeiro Lima" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar cadastro" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ decision: null })));
  });

  it("perfil sem permissão: o cartão vira a recusa", async () => {
    mocks.confirm.mockResolvedValue({ outcome: "denied", blocks: [{ type: "denied", text: "Seu perfil (Visualizador) pode consultar o CRM, mas não cadastrar." }] });
    await renderWithCard(confirmBlock);
    fireEvent.click(await screen.findByRole("button", { name: "Confirmar cadastro" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Visualizador");
    expect(screen.queryByRole("button", { name: "Confirmar cadastro" })).toBeNull();
  });
});

describe("cartão de duplicidade", () => {
  const duplicate: AssistantBlock = {
    type: "duplicate",
    requestId: REQ,
    draft,
    matches: [{ contactId: "a6400000-0000-4000-8000-000000000001", name: "Ana Ribeiro", reasons: ["nome igual"], leadCount: 1, href: "/contatos/c1" }],
  };

  it("mostra o registro encontrado, com link e motivo", async () => {
    await renderWithCard(duplicate);
    const card = await screen.findByRole("region", { name: /Possível duplicidade/ });
    expect(within(card).getByRole("link", { name: /Ana Ribeiro/ })).toHaveAttribute("href", "/contatos/c1");
    expect(card).toHaveTextContent("nome igual · 1 lead");
  });

  it("usar o contato encontrado leva ao cartão de caso novo nesse contato", async () => {
    mocks.confirm.mockResolvedValue({ outcome: "failed", blocks: [], message: "x" });
    await renderWithCard(duplicate);
    fireEvent.click(await screen.findByRole("button", { name: "Usar este contato" }));
    expect(screen.getByRole("region", { name: "Novo caso para Ana Ribeiro" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar cadastro" }));
    await waitFor(() =>
      expect(mocks.confirm).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: REQ, decision: { kind: "existing", contactId: "a6400000-0000-4000-8000-000000000001", contactName: "Ana Ribeiro" } }),
      ),
    );
  });

  it("cadastrar como pessoa nova mantém a decisão explícita", async () => {
    await renderWithCard(duplicate);
    fireEvent.click(await screen.findByRole("button", { name: "Cadastrar como pessoa nova" }));
    expect(screen.getByRole("region", { name: "Cadastrar pessoa e caso" })).toBeInTheDocument();
  });

  it("cancelar descarta sem gravar", async () => {
    await renderWithCard(duplicate);
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));
    expect(screen.getByText("Cadastro cancelado. Nada foi gravado.")).toBeInTheDocument();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
});
