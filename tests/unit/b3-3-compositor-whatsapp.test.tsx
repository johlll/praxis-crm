import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B3.3 — compositor do canal real (§28.18). A tela só lê as regras que o
 * servidor aplica: janela de 24 h, motivo de bloqueio, template fora da janela e
 * a chave de idempotência por intenção. Ações simuladas; nenhuma rede.
 */

const h = vi.hoisted(() => ({ send: vi.fn(), sendTemplate: vi.fn() }));
vi.mock("@/modules/conversations/actions", () => ({
  sendMessageAction: h.send,
  sendWhatsAppTemplateAction: h.sendTemplate,
}));

const { WhatsAppComposer } = await import("@/components/conversations/whatsapp-composer");
import type { MessageListItem } from "@/modules/conversations/queries";
import type { WhatsAppSendUi } from "@/modules/conversations/whatsapp-send";

const CONV = "62000000-0000-0000-0000-00000000000a";
const TEMPLATE = {
  id: "65000000-0000-0000-0000-00000000000a",
  name: "lembrete_audiencia",
  language: "pt_BR",
  bodyText: "Olá {{1}}, sua audiência é em {{2}}.",
  paramCount: 2,
};

function ui(overrides: Partial<WhatsAppSendUi> = {}): WhatsAppSendUi {
  return {
    route: "b3",
    provider: "simulated",
    blockedReason: null,
    windowOpen: true,
    windowExpiresAt: "2026-11-09T14:00:00Z",
    caseLinked: true,
    templates: [TEMPLATE],
    ...overrides,
  };
}

function message(overrides: Partial<MessageListItem> = {}): MessageListItem {
  return {
    id: "m1",
    direction: "outbound",
    bodyText: "Olá",
    status: "accepted",
    statusUpdatedAt: "2026-11-08T12:00:00Z",
    errorReason: null,
    sentBy: "u1",
    createdAt: "2026-11-08T12:00:00Z",
    waMessageId: "w1",
    ...overrides,
  };
}

let keys: string[];

beforeEach(() => {
  h.send.mockReset();
  h.sendTemplate.mockReset();
  keys = ["k-1", "k-2", "k-3", "k-4"];
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation((() => keys.shift() ?? "k-extra") as never);
});

const typeText = (value: string) => fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value } });
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
};

describe("compositor do canal real", () => {
  it("envio desligado: mostra o motivo e não deixa enviar", () => {
    render(<WhatsAppComposer conversationId={CONV} context={ui({ blockedReason: "send_disabled" })} onSent={vi.fn()} />);
    expect(screen.getByText(/O envio está desligado neste canal/)).toBeInTheDocument();
    typeText("Olá");
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
  });

  it("janela aberta: texto livre, com o aviso da janela, e envia uma vez com a chave da intenção", async () => {
    h.send.mockResolvedValue({ ok: true, message: message(), duplicateSubmit: false });
    const onSent = vi.fn();
    render(<WhatsAppComposer conversationId={CONV} context={ui()} onSent={onSent} />);
    expect(screen.getByText(/Janela de atendimento aberta/)).toBeInTheDocument();
    typeText("  Olá, tudo bem?  ");
    await click("Enviar");
    expect(h.send).toHaveBeenCalledExactlyOnceWith(CONV, "Olá, tudo bem?", "k-1");
    expect(onSent).toHaveBeenCalledWith(message());
    expect(screen.getByLabelText("Mensagem")).toHaveValue("");
  });

  it("janela fechada: sem texto livre, só template, com pré-visualização e campos obrigatórios", async () => {
    h.sendTemplate.mockResolvedValue({ ok: true, message: message({ bodyText: "Olá Maria, sua audiência é em 12/12." }), duplicateSubmit: false });
    const onSent = vi.fn();
    render(<WhatsAppComposer conversationId={CONV} context={ui({ windowOpen: false })} onSent={onSent} />);
    expect(screen.getByText(/janela de 24 horas está fechada/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Mensagem")).not.toBeInTheDocument();
    expect(screen.getByText("Olá {{1}}, sua audiência é em {{2}}.")).toBeInTheDocument();

    const send = screen.getByRole("button", { name: "Enviar template" });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Campo 1 do template"), { target: { value: " Maria " } });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Campo 2 do template"), { target: { value: "12/12" } });
    expect(screen.getByText("Olá Maria, sua audiência é em 12/12.")).toBeInTheDocument();
    expect(send).toBeEnabled();

    await click("Enviar template");
    expect(h.sendTemplate).toHaveBeenCalledExactlyOnceWith(CONV, TEMPLATE.id, ["Maria", "12/12"], "k-1");
    expect(h.send).not.toHaveBeenCalled();
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it("janela fechada e nenhum template aprovado: avisa e não oferece envio", () => {
    render(<WhatsAppComposer conversationId={CONV} context={ui({ windowOpen: false, templates: [] })} onSent={vi.fn()} />);
    expect(screen.getByText(/Nenhum template aprovado está disponível/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Enviar/ })).not.toBeInTheDocument();
  });

  it("resultado incerto: mostra o erro, a mensagem gravada, e a próxima tentativa é OUTRA intenção", async () => {
    const uncertain = message({ id: "m-inc", status: "queued", errorReason: "send_uncertain" });
    h.send.mockResolvedValueOnce({ ok: false, error: "O resultado do envio é incerto. A mensagem não será reenviada sozinha — confira no WhatsApp antes de enviar de novo.", persisted: uncertain });
    h.send.mockResolvedValueOnce({ ok: true, message: message({ id: "m2" }), duplicateSubmit: false });
    const onSent = vi.fn();
    render(<WhatsAppComposer conversationId={CONV} context={ui()} onSent={onSent} />);

    typeText("Olá");
    await click("Enviar");
    expect(screen.getByText(/resultado do envio é incerto/)).toBeInTheDocument();
    expect(onSent).toHaveBeenCalledWith(uncertain);

    // O texto continua na caixa; reenviar é uma nova decisão humana, com chave nova.
    expect(screen.getByLabelText("Mensagem")).toHaveValue("Olá");
    await click("Enviar");
    expect(h.send.mock.calls.map((c) => c[2])).toEqual(["k-1", "k-2"]);
  });

  it("falha de rede sem mensagem gravada: reenviar usa a MESMA chave", async () => {
    h.send.mockResolvedValueOnce({ ok: false, error: "Não foi possível concluir. Tente novamente." });
    h.send.mockResolvedValueOnce({ ok: true, message: message(), duplicateSubmit: true });
    render(<WhatsAppComposer conversationId={CONV} context={ui()} onSent={vi.fn()} />);
    typeText("Olá");
    await click("Enviar");
    await click("Enviar");
    expect(h.send.mock.calls.map((c) => c[2])).toEqual(["k-1", "k-1"]);
  });
});
