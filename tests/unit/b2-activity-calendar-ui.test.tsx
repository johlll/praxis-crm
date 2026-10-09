import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B2 — interface do Google Agenda nas telas de atividade: selo, ações de
 * linha, campos de criação (duração, Meet, disponibilidade, convidados),
 * diálogo de reagendar e o aviso depois de salvar. Dados fictícios; as ações
 * de servidor são substituídas.
 */

const actions = vi.hoisted(() => ({
  createActivityAction: vi.fn(),
  rescheduleActivityAction: vi.fn(),
  updateActivityAction: vi.fn(),
  completeActivityAction: vi.fn(),
  deleteActivityAction: vi.fn(),
  reassignActivityAction: vi.fn(),
  addMeetAction: vi.fn(),
  cancelAppointmentAction: vi.fn(),
  createAppointmentAction: vi.fn(),
  rescheduleAppointmentAction: vi.fn(),
  checkSlotAvailabilityAction: vi.fn(),
}));

vi.mock("@/modules/activities/actions", () => ({
  createActivityAction: actions.createActivityAction,
  rescheduleActivityAction: actions.rescheduleActivityAction,
  updateActivityAction: actions.updateActivityAction,
  completeActivityAction: actions.completeActivityAction,
  deleteActivityAction: actions.deleteActivityAction,
  reassignActivityAction: actions.reassignActivityAction,
}));
vi.mock("@/modules/calendar/appointment-actions", () => ({
  addMeetAction: actions.addMeetAction,
  cancelAppointmentAction: actions.cancelAppointmentAction,
  createAppointmentAction: actions.createAppointmentAction,
  rescheduleAppointmentAction: actions.rescheduleAppointmentAction,
  checkSlotAvailabilityAction: actions.checkSlotAvailabilityAction,
}));

import { CalendarBadge } from "@/components/calendar/calendar-badge";
import { CalendarCapabilitiesProvider } from "@/components/calendar/calendar-capabilities";
import { CalendarOptionsFields } from "@/components/calendar/calendar-options-fields";
import { CalendarRowActions } from "@/components/calendar/calendar-row-actions";
import { CreateActivityDialog } from "@/components/activities/create-activity-dialog";
import { RescheduleActivityDialog } from "@/components/activities/reschedule-activity-dialog";
import { ActivityRowActions } from "@/components/activities/activity-row-actions";
import type { ActivityListItem } from "@/modules/activities/queries";
import type { ActivityCalendarInfo, CalendarCapabilities } from "@/modules/calendar/types";

const ON: CalendarCapabilities = { enabled: true, canUse: true, hasConnection: true };
const OFF: CalendarCapabilities = { enabled: false, canUse: false, hasConnection: false };

const INFO: ActivityCalendarInfo = {
  status: "linked",
  isMine: true,
  durationMinutes: 90,
  meetStatus: null,
  meetUrl: null,
  lastSyncedAt: null,
};

function activity(overrides: Partial<ActivityListItem> = {}): ActivityListItem {
  return {
    id: "a1b2c3d4-0000-4000-8000-00000000a001",
    leadId: "33333333-3333-4333-8333-333333333333",
    opportunityId: null,
    contactName: "Cliente Fictício",
    legalArea: "Trabalhista",
    type: "meeting",
    title: "Reunião fictícia",
    notes: null,
    assignedTo: null,
    assignedToName: null,
    priority: "media",
    dueAt: "2026-11-10T17:00:00.000Z",
    hasTime: true,
    status: "pending",
    completedAt: null,
    source: "manual",
    lockVersion: 3,
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    isOverdue: false,
    calendar: null,
    ...overrides,
  };
}

function withCaps(caps: CalendarCapabilities, ui: React.ReactElement) {
  return render(<CalendarCapabilitiesProvider value={caps}>{ui}</CalendarCapabilitiesProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("selo da agenda", () => {
  it("sem vínculo não mostra nada", () => {
    const { container } = render(<CalendarBadge info={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("vinculado: mostra 'No Google Agenda' e o link do Meet", () => {
    render(<CalendarBadge info={{ ...INFO, meetUrl: "https://meet.simulated/x" }} />);
    expect(screen.getByText(/No Google Agenda/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Entrar no Meet/ })).toHaveAttribute("href", "https://meet.simulated/x");
  });

  it("pendente e de outra pessoa ficam explícitos", () => {
    render(<CalendarBadge info={{ ...INFO, status: "needs_attention", isMine: false }} />);
    expect(screen.getByText(/Google Agenda: pendente/)).toBeInTheDocument();
    expect(screen.getByText(/agenda de outra pessoa/)).toBeInTheDocument();
  });

  it("Meet em criação aparece como tal", () => {
    render(<CalendarBadge info={{ ...INFO, meetStatus: "pending" }} />);
    expect(screen.getByText(/Meet sendo criado/)).toBeInTheDocument();
  });
});

describe("ações de linha do Google Agenda", () => {
  it("integração desligada: nenhum controle de agenda", () => {
    const { container } = withCaps(OFF, <CalendarRowActions activity={activity()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("só reunião com horário e pendente", () => {
    const task = withCaps(ON, <CalendarRowActions activity={activity({ type: "task" })} />);
    expect(task.container).toBeEmptyDOMElement();
    task.unmount();
    const semHora = withCaps(ON, <CalendarRowActions activity={activity({ hasTime: false })} />);
    expect(semHora.container).toBeEmptyDOMElement();
    semHora.unmount();
    const feita = withCaps(ON, <CalendarRowActions activity={activity({ status: "done" })} />);
    expect(feita.container).toBeEmptyDOMElement();
  });

  it("sem vínculo e com conexão: oferece adicionar à agenda", () => {
    withCaps(ON, <CalendarRowActions activity={activity()} />);
    expect(screen.getByRole("button", { name: /Adicionar Reunião fictícia ao Google Agenda/ })).toBeInTheDocument();
  });

  it("sem vínculo e SEM conexão: não oferece nada", () => {
    const { container } = withCaps({ ...ON, hasConnection: false }, <CalendarRowActions activity={activity()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("vinculado e meu, sem Meet: oferece Meet e remover", () => {
    withCaps(ON, <CalendarRowActions activity={activity({ calendar: INFO })} />);
    expect(screen.getByRole("button", { name: /Criar link do Meet/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Remover .* do Google Agenda/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sincronizar/ })).not.toBeInTheDocument();
  });

  it("com Meet já criado, não oferece criar de novo", () => {
    withCaps(ON, <CalendarRowActions activity={activity({ calendar: { ...INFO, meetUrl: "https://meet.simulated/x" } })} />);
    expect(screen.queryByRole("button", { name: /Criar link do Meet/ })).not.toBeInTheDocument();
  });

  it("pendente: oferece sincronizar de novo", () => {
    withCaps(ON, <CalendarRowActions activity={activity({ calendar: { ...INFO, status: "needs_attention" } })} />);
    expect(screen.getByRole("button", { name: /Sincronizar/ })).toBeInTheDocument();
  });

  it("agenda de outra pessoa: nenhum controle", () => {
    const { container } = withCaps(ON, <CalendarRowActions activity={activity({ calendar: { ...INFO, isMine: false } })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("criar o Meet chama a ação e confirma", async () => {
    actions.addMeetAction.mockResolvedValue({ ok: true, result: "updated", meetUrl: "https://meet.simulated/x" });
    withCaps(ON, <CalendarRowActions activity={activity({ calendar: INFO })} />);
    fireEvent.click(screen.getByRole("button", { name: /Criar link do Meet/ }));
    await waitFor(() => expect(screen.getByText("Link do Meet criado.")).toBeInTheDocument());
    const sent = actions.addMeetAction.mock.calls[0]![1] as FormData;
    expect(sent.get("activityId")).toBe("a1b2c3d4-0000-4000-8000-00000000a001");
  });

  it("remover da agenda pede confirmação e só então chama a ação", async () => {
    actions.cancelAppointmentAction.mockResolvedValue({ ok: true, result: "cancelled" });
    const confirm = vi.spyOn(window, "confirm");
    withCaps(ON, <CalendarRowActions activity={activity({ calendar: INFO })} />);

    confirm.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: /Remover .* do Google Agenda/ }));
    expect(actions.cancelAppointmentAction).not.toHaveBeenCalled();

    confirm.mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: /Remover .* do Google Agenda/ }));
    await waitFor(() => expect(actions.cancelAppointmentAction).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[1]![0]).toContain("A atividade continua no CRM");
  });

  it("falha mostra o motivo, não finge sucesso", async () => {
    actions.addMeetAction.mockResolvedValue({ ok: false, error: "Não foi possível acessar a agenda." });
    withCaps(ON, <CalendarRowActions activity={activity({ calendar: INFO })} />);
    fireEvent.click(screen.getByRole("button", { name: /Criar link do Meet/ }));
    await waitFor(() => expect(screen.getByText("Não foi possível acessar a agenda.")).toBeInTheDocument());
  });
});

describe("campos do Google Agenda no formulário", () => {
  const slot = () => ({ dueDate: "2026-11-10", dueTime: "14:00" });

  it("tudo desligado por padrão: só a caixa de adicionar", () => {
    render(<CalendarOptionsFields idPrefix="t" getSlot={slot} />);
    const add = screen.getByLabelText("Adicionar ao Google Agenda") as HTMLInputElement;
    expect(add.checked).toBe(false);
    expect(screen.queryByLabelText(/Duração/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Convidados/)).not.toBeInTheDocument();
  });

  it("ao adicionar: duração 60 (15–480), Meet e livre desmarcados, sem confirmação de convite", () => {
    render(<CalendarOptionsFields idPrefix="t" getSlot={slot} />);
    fireEvent.click(screen.getByLabelText("Adicionar ao Google Agenda"));
    const duration = screen.getByLabelText(/Duração/) as HTMLInputElement;
    expect(duration.value).toBe("60");
    expect(duration).toHaveAttribute("min", "15");
    expect(duration).toHaveAttribute("max", "480");
    expect((screen.getByLabelText(/Criar link do Google Meet/) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText(/Só criar se o horário estiver livre/) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByTestId("invite-confirmation")).not.toBeInTheDocument();
    expect(screen.getByText(/ninguém é convidado e nenhum e-mail é enviado/)).toBeInTheDocument();
  });

  it("convidados: a confirmação de envio de e-mail só aparece ao digitar e vem desmarcada", () => {
    render(<CalendarOptionsFields idPrefix="t" getSlot={slot} />);
    fireEvent.click(screen.getByLabelText("Adicionar ao Google Agenda"));
    fireEvent.change(screen.getByLabelText(/Convidados/), { target: { value: "convidado@exemplo.test" } });

    const box = screen.getByTestId("invite-confirmation").querySelector("input") as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(box.name).toBe("confirmInvites");
    expect(screen.getByTestId("invite-confirmation")).toHaveTextContent(/enviar um e-mail de convite/);
  });

  it("disponibilidade livre e ocupada", async () => {
    render(
      <form>
        <CalendarOptionsFields idPrefix="t" getSlot={slot} />
      </form>,
    );
    fireEvent.click(screen.getByLabelText("Adicionar ao Google Agenda"));

    actions.checkSlotAvailabilityAction.mockResolvedValueOnce({ ok: true, busy: [] });
    fireEvent.click(screen.getByRole("button", { name: "Verificar disponibilidade" }));
    await waitFor(() => expect(screen.getByText("Horário livre na sua agenda.")).toBeInTheDocument());
    const sent = actions.checkSlotAvailabilityAction.mock.calls[0]![1] as FormData;
    expect([sent.get("dueDate"), sent.get("dueTime"), sent.get("durationMinutes")]).toEqual(["2026-11-10", "14:00", "60"]);

    actions.checkSlotAvailabilityAction.mockResolvedValueOnce({
      ok: true,
      busy: [{ start: "2026-11-10T17:30:00.000Z", end: "2026-11-10T18:30:00.000Z" }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Verificar disponibilidade" }));
    await waitFor(() => expect(screen.getByText(/Ocupado na sua agenda/)).toBeInTheDocument());
  });

  it("verificar sem data e horário pede para preenchê-los (sem chamar o servidor)", async () => {
    render(
      <form>
        <CalendarOptionsFields idPrefix="t" getSlot={() => null} />
      </form>,
    );
    fireEvent.click(screen.getByLabelText("Adicionar ao Google Agenda"));
    fireEvent.click(screen.getByRole("button", { name: "Verificar disponibilidade" }));
    expect(await screen.findByText(/Informe a data e o horário/)).toBeInTheDocument();
    expect(actions.checkSlotAvailabilityAction).not.toHaveBeenCalled();
  });

  it("no diálogo de 'adicionar', a caixa de ligar some e o formulário já é da agenda", () => {
    render(
      <form>
        <CalendarOptionsFields idPrefix="t" alwaysOn getSlot={slot} />
      </form>,
    );
    expect(screen.queryByLabelText("Adicionar ao Google Agenda")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Duração/)).toBeInTheDocument();
  });
});

describe("nova atividade", () => {
  function open(caps: CalendarCapabilities) {
    withCaps(caps, <CreateActivityDialog leadId="33333333-3333-4333-8333-333333333333" members={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /Nova atividade/ }));
  }

  it("integração desligada: o formulário é o de sempre, mesmo com reunião e horário", async () => {
    open(OFF);
    fireEvent.change(await screen.findByLabelText("Tipo"), { target: { value: "meeting" } });
    fireEvent.change(screen.getByLabelText(/Horário/), { target: { value: "14:00" } });
    expect(screen.queryByTestId("calendar-options")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Adicionar ao Google Agenda")).not.toBeInTheDocument();
  });

  it("com a agenda ligada, só aparece para reunião COM horário", async () => {
    open(ON);
    const type = await screen.findByLabelText("Tipo");
    expect(screen.queryByTestId("calendar-options")).not.toBeInTheDocument();

    fireEvent.change(type, { target: { value: "meeting" } });
    expect(screen.queryByTestId("calendar-options")).not.toBeInTheDocument(); // sem horário ainda

    fireEvent.change(screen.getByLabelText(/Horário/), { target: { value: "14:00" } });
    expect(screen.getByTestId("calendar-options")).toBeInTheDocument();

    fireEvent.change(type, { target: { value: "task" } });
    expect(screen.queryByTestId("calendar-options")).not.toBeInTheDocument();
  });

  it("sem conexão: orienta a conectar em vez de mostrar os campos", async () => {
    open({ ...ON, hasConnection: false });
    fireEvent.change(await screen.findByLabelText("Tipo"), { target: { value: "meeting" } });
    fireEvent.change(screen.getByLabelText(/Horário/), { target: { value: "14:00" } });
    expect(screen.getByText(/conecte a sua agenda em Configurações/)).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-options")).not.toBeInTheDocument();
  });
});

describe("reagendar", () => {
  function open(info: ActivityCalendarInfo | null, caps: CalendarCapabilities = ON) {
    withCaps(caps, <RescheduleActivityDialog activity={activity({ calendar: info })} />);
    fireEvent.click(screen.getByRole("button", { name: /Reagendar/ }));
  }

  it("vinculado e meu: mostra a duração atual do evento", async () => {
    open(INFO);
    const input = (await screen.findByLabelText(/Duração no Google Agenda/)) as HTMLInputElement;
    expect(input.value).toBe("90");
  });

  it("sem mudar a duração, ela NÃO viaja (vale a real do evento)", async () => {
    actions.rescheduleActivityAction.mockResolvedValue({ ok: true });
    open({ ...INFO, durationMinutes: 600 }); // evento externo fora de 15–480
    await screen.findByLabelText(/Duração no Google Agenda/);
    fireEvent.click(screen.getByRole("button", { name: "Reagendar" }));
    await waitFor(() => expect(actions.rescheduleActivityAction).toHaveBeenCalled());
    expect(actions.rescheduleActivityAction.mock.calls[0]![5]).toBeUndefined();
  });

  it("duração alterada viaja; fora de 15–480 é recusada na tela", async () => {
    actions.rescheduleActivityAction.mockResolvedValue({ ok: true });
    open(INFO);
    const input = await screen.findByLabelText(/Duração no Google Agenda/);

    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Reagendar" }));
    expect(await screen.findByText(/entre 15 e 480 minutos/)).toBeInTheDocument();
    expect(actions.rescheduleActivityAction).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "Reagendar" }));
    await waitFor(() => expect(actions.rescheduleActivityAction).toHaveBeenCalled());
    expect(actions.rescheduleActivityAction.mock.calls[0]![5]).toEqual({ durationMinutes: 120 });
  });

  it("agenda de outra pessoa: avisa e não oferece duração", async () => {
    open({ ...INFO, isMine: false });
    expect(await screen.findByText(/agenda de outra pessoa: o Google Agenda não será alterado/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Duração no Google Agenda/)).not.toBeInTheDocument();
  });

  it("sem vínculo ou com a integração desligada: o diálogo é o de sempre", async () => {
    open(null);
    await screen.findByLabelText("Data");
    expect(screen.queryByLabelText(/Duração no Google Agenda/)).not.toBeInTheDocument();
  });

  it("aviso do Google depois de reagendar fica visível até o usuário fechar", async () => {
    actions.rescheduleActivityAction.mockResolvedValue({
      ok: true,
      calendar: { level: "warning", message: "O evento foi cancelado no Google Agenda." },
    });
    open(INFO);
    await screen.findByLabelText("Data");
    fireEvent.click(screen.getByRole("button", { name: "Reagendar" }));
    expect(await screen.findByText("O evento foi cancelado no Google Agenda.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Fechar" }).length).toBeGreaterThan(0);
  });
});

describe("excluir", () => {
  it("o aviso de confirmação cita o Google só quando o evento é meu e a agenda está ligada", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    actions.deleteActivityAction.mockResolvedValue({ ok: true });

    const linked = withCaps(ON, <ActivityRowActions activity={activity({ calendar: INFO })} members={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /Excluir/ }));
    expect(confirm.mock.calls[0]![0]).toContain("removido do Google Agenda");
    linked.unmount();

    withCaps(OFF, <ActivityRowActions activity={activity({ calendar: INFO })} members={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /Excluir/ }));
    expect(confirm.mock.calls[1]![0]).not.toContain("Google");
  });
});
