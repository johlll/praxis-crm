import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Agenda mensal — interface: calendário (dias reais, hoje e selecionado
 * marcados sem depender de cor, contagem no nome acessível, teclado),
 * painel do dia (com/sem horário, situação, ações conforme permissão,
 * dia vazio, "Nova atividade" com a data selecionada), seleção pela URL e
 * estados do Google Agenda simulados. Ações de servidor substituídas: nada
 * é chamado só por navegar ou selecionar.
 */

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, refresh: nav.refresh, replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => nav.params,
  usePathname: () => "/agenda",
}));

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
  recoverUncertainCreateAction: vi.fn(),
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
  recoverUncertainCreateAction: actions.recoverUncertainCreateAction,
}));

import { MonthAgenda } from "@/components/agenda/month-agenda";
import { MonthCalendar } from "@/components/agenda/month-calendar";
import { DayPanel, splitDayItems } from "@/components/agenda/day-panel";
import { CalendarCapabilitiesProvider } from "@/components/calendar/calendar-capabilities";
import type { ActivityListItem } from "@/modules/activities/queries";
import type { ActivityCalendarInfo, CalendarCapabilities } from "@/modules/calendar/types";
import type { TeamMember } from "@/modules/team/queries";
import type { MonthKey } from "@/lib/calendar-month";

const ON: CalendarCapabilities = { enabled: true, canUse: true, hasConnection: true };
const MEMBERS = [{ userId: "u1", fullName: "Ana Advogada", email: "ana@exemplo.test" }] as unknown as TeamMember[];

let seq = 0;
function activity(overrides: Partial<ActivityListItem> = {}): ActivityListItem {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    leadId: "33333333-3333-4333-8333-333333333333",
    opportunityId: null,
    contactName: "Cliente Fictício",
    legalArea: "Trabalhista",
    type: "task",
    title: `Atividade ${seq}`,
    notes: null,
    assignedTo: null,
    assignedToName: null,
    priority: "media",
    dueAt: "2026-11-17T13:00:00.000Z",
    hasTime: true,
    status: "pending",
    completedAt: null,
    source: "manual",
    lockVersion: 1,
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    isOverdue: false,
    calendar: null,
    ...overrides,
  };
}

function renderCalendar(props: Partial<Parameters<typeof MonthCalendar>[0]> = {}) {
  const handlers = {
    onSelectDay: vi.fn(),
    onPreviousMonth: vi.fn(),
    onNextMonth: vi.fn(),
    onToday: vi.fn(),
  };
  render(
    <MonthCalendar
      month={"2026-11" as MonthKey}
      today="2026-11-17"
      selected="2026-11-17"
      dayCounts={{ "2026-11-17": 3, "2026-11-19": 1 }}
      busy={false}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

beforeEach(() => {
  vi.clearAllMocks();
  nav.params = new URLSearchParams();
});

describe("calendário do mês", () => {
  it("mostra o mês em português, segunda a domingo e só os dias reais", () => {
    renderCalendar();
    expect(screen.getByRole("heading", { name: "Novembro de 2026" })).toBeInTheDocument();
    const headers = screen.getAllByRole("columnheader").map((th) => th.getAttribute("abbr"));
    expect(headers).toEqual(["Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado", "Domingo"]);
    const days = screen.getAllByRole("button").filter((b) => b.hasAttribute("data-day"));
    expect(days).toHaveLength(30);
    expect(days[0]).toHaveAttribute("data-day", "2026-11-01");
  });

  it("hoje e selecionado têm marcação acessível própria; contagem no nome do dia", () => {
    renderCalendar({ selected: "2026-11-19" });
    const today = screen.getByRole("button", { name: "Terça-feira, 17 de novembro de 2026, hoje, 3 atividades" });
    expect(today).toHaveAttribute("aria-current", "date");
    expect(today).toHaveAttribute("aria-pressed", "false");
    const selected = screen.getByRole("button", { name: "Quinta-feira, 19 de novembro de 2026, 1 atividade" });
    expect(selected).toHaveAttribute("aria-pressed", "true");
    expect(selected).not.toHaveAttribute("aria-current");
    // Só o selecionado entra na ordem do Tab (navegação por setas dentro da grade).
    expect(selected).toHaveAttribute("tabindex", "0");
    expect(today).toHaveAttribute("tabindex", "-1");
  });

  it("dia sem atividades continua selecionável", () => {
    const h = renderCalendar();
    fireEvent.click(screen.getByRole("button", { name: "Sexta-feira, 20 de novembro de 2026, nenhuma atividade" }));
    expect(h.onSelectDay).toHaveBeenCalledWith("2026-11-20");
  });

  it("botões de mês anterior, hoje e próximo mês", () => {
    const h = renderCalendar();
    fireEvent.click(screen.getByRole("button", { name: "Mês anterior" }));
    fireEvent.click(screen.getByRole("button", { name: "Hoje" }));
    fireEvent.click(screen.getByRole("button", { name: "Próximo mês" }));
    expect(h.onPreviousMonth).toHaveBeenCalledTimes(1);
    expect(h.onToday).toHaveBeenCalledTimes(1);
    expect(h.onNextMonth).toHaveBeenCalledTimes(1);
  });

  it("teclado: setas andam entre os dias, sem sair do mês; PageUp/PageDown trocam de mês", () => {
    const h = renderCalendar({ selected: "2026-11-17" });
    const grid = screen.getByRole("table");
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(h.onSelectDay).toHaveBeenLastCalledWith("2026-11-18");
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(h.onSelectDay).toHaveBeenLastCalledWith("2026-11-24");
    fireEvent.keyDown(grid, { key: "ArrowUp" });
    expect(h.onSelectDay).toHaveBeenLastCalledWith("2026-11-10");
    fireEvent.keyDown(grid, { key: "Home" });
    expect(h.onSelectDay).toHaveBeenLastCalledWith("2026-11-16");
    fireEvent.keyDown(grid, { key: "End" });
    expect(h.onSelectDay).toHaveBeenLastCalledWith("2026-11-22");
    fireEvent.keyDown(grid, { key: "PageUp" });
    fireEvent.keyDown(grid, { key: "PageDown" });
    expect(h.onPreviousMonth).toHaveBeenCalledTimes(1);
    expect(h.onNextMonth).toHaveBeenCalledTimes(1);
  });

  it("teclado: nas bordas do mês as setas não saem dele", () => {
    const h = renderCalendar({ selected: "2026-11-30" });
    fireEvent.keyDown(screen.getByRole("table"), { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByRole("table"), { key: "ArrowDown" });
    expect(h.onSelectDay).not.toHaveBeenCalled();
  });

  it("primeira semana: Home vai ao dia 1 quando a segunda é do mês anterior", () => {
    const h = renderCalendar({ selected: "2026-11-01" });
    fireEvent.keyDown(screen.getByRole("table"), { key: "Home" });
    expect(h.onSelectDay).toHaveBeenLastCalledWith("2026-11-01");
  });
});

describe("painel do dia", () => {
  it("separa com horário (cronológico) de sem horário (pendentes primeiro)", () => {
    const late = activity({ title: "Tarde", dueAt: "2026-11-17T19:00:00.000Z" });
    const early = activity({ title: "Manhã", dueAt: "2026-11-17T12:00:00.000Z" });
    const doneUntimed = activity({ title: "A feita", hasTime: false, status: "done", dueAt: "2026-11-18T02:59:59.000Z" });
    const pendingUntimed = activity({ title: "B pendente", hasTime: false, dueAt: "2026-11-18T02:59:59.000Z" });
    const { timed, untimed } = splitDayItems([late, doneUntimed, early, pendingUntimed]);
    expect(timed.map((a) => a.title)).toEqual(["Manhã", "Tarde"]);
    expect(untimed.map((a) => a.title)).toEqual(["B pendente", "A feita"]);
  });

  it("mostra data completa, quantidade, título, tipo, contato, responsável e situação", () => {
    render(
      <DayPanel
        day="2026-11-17"
        canEdit={false}
        members={MEMBERS}
        leadOptions={[]}
        busy={false}
        items={[
          activity({ title: "Audiência", type: "meeting", assignedToName: "Ana Advogada", isOverdue: true, contactName: "Maria Souza" }),
          activity({ title: "Protocolo", hasTime: false, status: "done", dueAt: "2026-11-18T02:59:59.000Z" }),
        ]}
      />,
    );
    expect(screen.getByRole("heading", { name: "Terça-feira, 17 de novembro de 2026" })).toBeInTheDocument();
    expect(screen.getByText("2 atividades · 1 pendente")).toBeInTheDocument();
    const timed = screen.getByRole("list", { name: /Com horário/ });
    expect(within(timed).getByText("Audiência")).toBeInTheDocument();
    expect(within(timed).getByText("10:00")).toBeInTheDocument();
    expect(within(timed).getByText("Atrasada")).toBeInTheDocument();
    expect(within(timed).getByRole("link", { name: "Maria Souza" })).toHaveAttribute("href", "/leads/33333333-3333-4333-8333-333333333333");
    expect(within(timed).getByText(/Reunião ·/)).toHaveTextContent("Responsável: Ana Advogada");
    const untimed = screen.getByRole("list", { name: /Sem horário/ });
    expect(within(untimed).getByText("Concluída")).toBeInTheDocument();
    expect(within(untimed).getByText(/Sem responsável/)).toBeInTheDocument();
  });

  it("sem permissão de edição: nenhuma ação e nenhum 'Nova atividade'", () => {
    render(<DayPanel day="2026-11-17" canEdit={false} members={MEMBERS} leadOptions={[]} busy={false} items={[activity({ title: "Ver só" })]} />);
    expect(screen.queryByRole("button", { name: /Concluir/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Excluir/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Nova atividade" })).toBeNull();
  });

  it("com permissão: as ações existentes (concluir, transferir, reagendar, editar, excluir)", () => {
    render(<DayPanel day="2026-11-17" canEdit members={MEMBERS} leadOptions={[]} busy={false} items={[activity({ title: "Agir" })]} />);
    expect(screen.getByRole("button", { name: "Concluir Agir" })).toBeInTheDocument();
    expect(screen.getByLabelText("Transferir Agir para")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reagendar/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Editar/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Excluir Agir" })).toBeInTheDocument();
  });

  it("dia vazio: mensagem clara e, para quem pode criar, a ação", () => {
    const { unmount } = render(<DayPanel day="2026-11-20" canEdit members={MEMBERS} leadOptions={[]} busy={false} items={[]} />);
    expect(screen.getByText("Nenhuma atividade")).toBeInTheDocument();
    expect(screen.getByText("Nada agendado para este dia.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Nova atividade" })).toHaveLength(1);
    expect(screen.getByText(/Use “Nova atividade”/)).toBeInTheDocument();
    unmount();
    render(<DayPanel day="2026-11-20" canEdit={false} members={MEMBERS} leadOptions={[]} busy={false} items={[]} />);
    expect(screen.getByText("Nada agendado para este dia.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Nova atividade" })).toBeNull();
  });

  it("o diálogo de criação continua aberto quando o dia deixa de estar vazio (revalidação)", () => {
    const props = { day: "2026-11-20", canEdit: true, members: MEMBERS, leadOptions: [], busy: false };
    const { rerender } = render(<DayPanel {...props} items={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Nova atividade" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    rerender(<DayPanel {...props} items={[activity({ title: "Recém-criada", dueAt: "2026-11-20T17:00:00.000Z" })]} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("'Nova atividade' abre o formulário existente com a data selecionada (editável)", () => {
    render(<DayPanel day="2028-02-29" canEdit members={MEMBERS} leadOptions={[]} busy={false} items={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Nova atividade" }));
    const date = screen.getByLabelText("Data") as HTMLInputElement;
    expect(date.value).toBe("2028-02-29");
    expect(date).toBeRequired();
    expect(screen.getByLabelText("Título")).toBeRequired();
    expect(screen.getByLabelText("Lead")).toBeRequired();
    fireEvent.change(date, { target: { value: "2028-03-01" } });
    expect(date.value).toBe("2028-03-01");
    expect(actions.createActivityAction).not.toHaveBeenCalled();
  });

  it("estados do Google Agenda (simulados) aparecem pelo selo existente, sem 'sincronizado' sem confirmação", () => {
    const base: ActivityCalendarInfo = {
      status: "linked",
      isMine: true,
      durationMinutes: 60,
      meetStatus: null,
      meetUrl: null,
      lastSyncedAt: null,
      syncState: "in_sync",
      syncOperation: null,
    };
    render(
      <CalendarCapabilitiesProvider value={ON}>
        <DayPanel
          day="2026-11-17"
          canEdit
          members={MEMBERS}
          leadOptions={[]}
          busy={false}
          items={[
            activity({ title: "Confirmado", type: "meeting", calendar: base }),
            activity({ title: "Pendente Google", type: "meeting", calendar: { ...base, syncState: "pending" } }),
            activity({ title: "Incerto", type: "meeting", calendar: { ...base, status: "not_linked" } }),
            activity({ title: "Outra pessoa", type: "meeting", calendar: { ...base, isMine: false } }),
          ]}
        />
      </CalendarCapabilitiesProvider>,
    );
    const badges = screen.getAllByTestId("calendar-badge").map((b) => b.textContent);
    expect(badges).toContain("No Google Agenda");
    expect(badges).toContain("No Google Agenda · sincronização pendente");
    expect(badges).toContain("Inclusão no Google Agenda incerta");
    expect(badges).toContain("No Google Agenda · agenda de outra pessoa");
    expect(screen.queryByText(/sincronizado/i)).toBeNull();
    // Excluir bloqueado para vínculo incerto ou de outra pessoa (regra existente).
    expect(screen.getByRole("button", { name: "Excluir Incerto" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Excluir Outra pessoa" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Excluir Confirmado" })).toBeEnabled();
  });
});

describe("seleção e URL", () => {
  const items = [
    activity({ title: "Do dia 17", dueAt: "2026-11-17T13:00:00.000Z" }),
    activity({ title: "Do dia 19", dueAt: "2026-11-19T13:00:00.000Z" }),
    // 23:59:59 locais de 30/11 = 02:59:59Z de 01/12: continua no dia 30.
    activity({ title: "Só data no dia 30", hasTime: false, dueAt: "2026-12-01T02:59:59.000Z" }),
  ];
  const counts = { "2026-11-17": 1, "2026-11-19": 1, "2026-11-30": 1 };

  function renderAgenda(month = "2026-11", today = "2026-11-17") {
    return render(
      <MonthAgenda month={month as MonthKey} today={today} items={items} dayCounts={counts} canEdit={false} members={MEMBERS} leadOptions={[]} />,
    );
  }

  it("sem 'dia' na URL: hoje selecionado no mês atual", () => {
    renderAgenda();
    expect(screen.getByRole("heading", { name: "Terça-feira, 17 de novembro de 2026" })).toBeInTheDocument();
    expect(screen.getByText("Do dia 17")).toBeInTheDocument();
    expect(screen.queryByText("Do dia 19")).toBeNull();
  });

  it("'dia' da URL seleciona o dia; data sem horário não desloca para o dia seguinte", () => {
    nav.params = new URLSearchParams("mes=2026-11&dia=2026-11-30");
    renderAgenda();
    expect(screen.getByRole("heading", { name: "Segunda-feira, 30 de novembro de 2026" })).toBeInTheDocument();
    expect(screen.getByText("Só data no dia 30")).toBeInTheDocument();
  });

  it("'dia' impossível ou de outro mês: volta ao padrão", () => {
    nav.params = new URLSearchParams("mes=2026-11&dia=2026-11-31");
    const { unmount } = renderAgenda();
    expect(screen.getByRole("heading", { name: /17 de novembro/ })).toBeInTheDocument();
    unmount();
    nav.params = new URLSearchParams("mes=2026-12&dia=2026-11-19");
    render(<MonthAgenda month={"2026-12" as MonthKey} today="2026-11-17" items={[]} dayCounts={{}} canEdit={false} members={MEMBERS} leadOptions={[]} />);
    expect(screen.getByRole("heading", { name: "Terça-feira, 1 de dezembro de 2026" })).toBeInTheDocument();
  });

  it("clicar num dia troca a URL pelo History API, sem navegar no servidor nem chamar ações", () => {
    const push = vi.spyOn(window.history, "pushState");
    renderAgenda();
    fireEvent.click(screen.getByRole("button", { name: /^Quinta-feira, 19 de novembro de 2026/ }));
    expect(push).toHaveBeenCalledWith(null, "", "/agenda?mes=2026-11&dia=2026-11-19");
    expect(nav.push).not.toHaveBeenCalled();
    for (const fn of Object.values(actions)) expect(fn).not.toHaveBeenCalled();
    push.mockRestore();
  });

  it("trocar de mês navega e seleciona o dia 1 (virada de ano incluída)", () => {
    nav.params = new URLSearchParams("mes=2026-12&dia=2026-12-15");
    render(<MonthAgenda month={"2026-12" as MonthKey} today="2026-11-17" items={[]} dayCounts={{}} canEdit={false} members={MEMBERS} leadOptions={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Próximo mês" }));
    expect(nav.push).toHaveBeenLastCalledWith("/agenda?mes=2027-01&dia=2027-01-01", { scroll: false });
    fireEvent.click(screen.getByRole("button", { name: "Mês anterior" }));
    expect(nav.push).toHaveBeenLastCalledWith("/agenda?mes=2026-11&dia=2026-11-01", { scroll: false });
  });

  it("'Hoje' em outro mês navega para o mês atual com hoje selecionado", () => {
    render(<MonthAgenda month={"2027-03" as MonthKey} today="2026-11-17" items={[]} dayCounts={{}} canEdit={false} members={MEMBERS} leadOptions={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Hoje" }));
    expect(nav.push).toHaveBeenLastCalledWith("/agenda?mes=2026-11&dia=2026-11-17", { scroll: false });
  });

  it("'Hoje' no próprio mês só seleciona (sem nova busca)", () => {
    const push = vi.spyOn(window.history, "pushState");
    nav.params = new URLSearchParams("mes=2026-11&dia=2026-11-19");
    renderAgenda();
    fireEvent.click(screen.getByRole("button", { name: "Hoje" }));
    expect(push).toHaveBeenCalledWith(null, "", "/agenda?mes=2026-11&dia=2026-11-17");
    expect(nav.push).not.toHaveBeenCalled();
    push.mockRestore();
  });

  it("as contagens do calendário são as do servidor", () => {
    renderAgenda();
    expect(screen.getByRole("button", { name: /^Segunda-feira, 30 de novembro de 2026, 1 atividade$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Quarta-feira, 18 de novembro de 2026, nenhuma atividade$/ })).toBeInTheDocument();
  });
});
