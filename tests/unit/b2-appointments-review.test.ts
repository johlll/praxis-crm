/**
 * @vitest-environment node
 *
 * B2, etapa 2 — revisão da PR #25: quatro achados reproduzidos com teste
 * (provedor SIMULADO, dados fictícios).
 *
 *  1. conexão/calendário do vínculo × conexão da sessão;
 *  2. edição do CRM entre a leitura e a aplicação dos valores do Google;
 *  3. Meet removido no Google × campo omitido;
 *  4. duração coerente depois que o Google vence um conflito de horário.
 */
import { describe, expect, it } from "vitest";

import {
  addMeetToAppointment,
  cancelAppointment,
  createAppointment,
  rescheduleAppointment,
} from "@/server/calendar/sync/appointments";
import { deterministicEventId } from "@/server/calendar/sync/ids";
import type { ConnectionContext } from "@/server/calendar/sync/types";

import { ACTIVITY_ID, CALENDAR_ID, activity, countCalls, makeFixture } from "../support/calendar-fixture";

const EVENT_ID = deterministicEventId("preview", ACTIVITY_ID, 1);
const CRIADA = activity({ lockVersion: 3 });
const REMARCADA = activity({ dueAt: "2026-11-12T16:00:00.000Z", lockVersion: 4 });

async function comEventoCriado(options: { withMeet?: boolean } = {}) {
  const f = await makeFixture();
  f.store.setActivity(CRIADA);
  await createAppointment(f.deps, f.conn, CRIADA, options);
  return f;
}

// ---------------------------------------------------------------------
// 1) Conexão / calendário do vínculo
// ---------------------------------------------------------------------

describe("achado 1 — o vínculo manda na conexão e no calendário", () => {
  async function comOutroUsuario() {
    const f = await comEventoCriado();
    const outro = await f.provider.exchangeAuthorization("outro.usuario@exemplo.test|agenda-do-outro");
    const connOutro: ConnectionContext = {
      connectionId: "conn-2",
      calendarId: "agenda-do-outro@calendar.simulated",
      environment: "preview",
      accessToken: outro.accessToken,
    };
    return { ...f, connOutro };
  }

  it.each([
    ["reagendar", (f: Awaited<ReturnType<typeof comOutroUsuario>>) => rescheduleAppointment(f.deps, f.connOutro, REMARCADA)],
    ["adicionar Meet", (f: Awaited<ReturnType<typeof comOutroUsuario>>) => addMeetToAppointment(f.deps, f.connOutro, CRIADA)],
    ["cancelar", (f: Awaited<ReturnType<typeof comOutroUsuario>>) => cancelAppointment(f.deps, f.connOutro, CRIADA)],
  ])("%s com a conexão de OUTRO usuário: recusa antes de qualquer chamada e NÃO trata como evento apagado", async (_nome, run) => {
    const f = await comOutroUsuario();
    const chamadas = f.provider.calls.length;
    const intencoes = f.store.intents.length;

    await expect(run(f)).rejects.toMatchObject({ code: "link_connection_mismatch" });

    expect(f.provider.calls.length).toBe(chamadas); // nenhuma chamada ao Google
    expect(f.store.intents.length).toBe(intencoes); // nem intenção
    expect(f.store.conflicts).toEqual([]);
    // O vínculo e o evento continuam exatamente como estavam.
    expect([...f.store.links.values()][0]).toMatchObject({ status: "linked", baseCancelled: false, connectionId: "conn-1" });
    expect(f.provider.peek(CALENDAR_ID, EVENT_ID)?.status).toBe("confirmed");
  });

  it("a conexão certa (mesma conexão, mesma agenda) continua funcionando", async () => {
    const f = await comEventoCriado();
    expect((await rescheduleAppointment(f.deps, f.conn, REMARCADA)).status).toBe("updated");
  });
});

// ---------------------------------------------------------------------
// 2) Concorrência: edição do CRM entre a leitura e a aplicação
// ---------------------------------------------------------------------

describe("achado 2 — a aplicação dos valores do Google compara a versão da atividade", () => {
  const googleMoveParaDia13 = (f: Awaited<ReturnType<typeof comEventoCriado>>) =>
    f.provider.externalEdit(CALENDAR_ID, EVENT_ID, {
      start: { dateTime: "2026-11-13T09:00:00.000Z" },
      end: { dateTime: "2026-11-13T10:00:00.000Z" },
    });

  it("edição do CRM no meio: NÃO é sobrescrita; relê a atividade e reavalia o conflito", async () => {
    const f = await comEventoCriado();
    f.store.setActivity(REMARCADA); // o CRM remarcou para o dia 12 (v4)
    googleMoveParaDia13(f); // e o Google moveu para o dia 13

    // Entre a leitura do CRM e a aplicação, outra pessoa renomeia a atividade no CRM (v5).
    f.store.onceBeforeApply(() => f.store.setActivity({ ...REMARCADA, title: "Título novo escrito no CRM", lockVersion: 5 }));

    const result = await rescheduleAppointment(f.deps, f.conn, REMARCADA);

    expect(result.status).toBe("conflict_resolved");
    // Primeira tentativa com a versão LIDA (4) e recusada; a segunda, com a versão relida (5).
    expect(f.store.applyAttempts).toEqual([
      { activityId: ACTIVITY_ID, expectedVersion: 4, applied: false },
      { activityId: ACTIVITY_ID, expectedVersion: 5, applied: true },
    ]);
    // A edição do CRM sobreviveu: o título novo não foi apagado...
    const noCrm = f.store.activities.get(ACTIVITY_ID)!;
    expect(noCrm.title).toBe("Título novo escrito no CRM");
    // ...e foi reavaliado contra a base: mudou só no CRM, então vai ao Google.
    expect(f.provider.peek(CALENDAR_ID, EVENT_ID)?.summary).toBe("Título novo escrito no CRM");
    // O horário em conflito converge para o Google, com o valor do CRM gravado UMA vez.
    expect(noCrm.dueAt).toBe("2026-11-13T09:00:00.000Z");
    expect(f.store.conflicts).toEqual([
      {
        linkId: expect.any(String),
        field: "schedule",
        crmValue: { start: "2026-11-12T16:00:00.000Z", end: "2026-11-12T17:00:00.000Z" },
        googleValue: { start: "2026-11-13T09:00:00.000Z", end: "2026-11-13T10:00:00.000Z" },
        resolution: "google_prevails",
      },
    ]);
  });

  it("a edição concorrente muda o próprio horário: o conflito é reavaliado com o valor NOVO do CRM", async () => {
    const f = await comEventoCriado();
    f.store.setActivity(REMARCADA);
    googleMoveParaDia13(f);
    f.store.onceBeforeApply(() => f.store.setActivity({ ...REMARCADA, dueAt: "2026-11-14T11:00:00.000Z", lockVersion: 5 }));

    await rescheduleAppointment(f.deps, f.conn, REMARCADA);

    expect(f.store.conflicts).toHaveLength(1);
    expect(f.store.conflicts[0]).toMatchObject({
      field: "schedule",
      crmValue: { start: "2026-11-14T11:00:00.000Z", end: "2026-11-14T12:00:00.000Z" }, // o valor que de fato estava no CRM
    });
  });

  it("disputa permanente (a versão muda a cada tentativa): para, sinaliza atenção e NÃO aplica nem grava conflito falso", async () => {
    const f = await comEventoCriado();
    f.store.setActivity(REMARCADA);
    googleMoveParaDia13(f);
    let v = 4;
    const edita = () => {
      v += 1;
      f.store.setActivity({ ...REMARCADA, lockVersion: v });
      f.store.onceBeforeApply(edita);
    };
    f.store.onceBeforeApply(edita);

    const result = await rescheduleAppointment(f.deps, f.conn, REMARCADA);

    expect(result).toEqual({ status: "needs_attention" });
    expect(f.store.appliedToActivity).toEqual([]);
    expect(f.store.conflicts).toMatchObject([{ resolution: "needs_attention" }]); // nenhum "google_prevails" que não aconteceu
    expect(f.store.applyAttempts.every((a) => !a.applied)).toBe(true);
  });

  it("sem edição concorrente, uma única tentativa com a versão lida", async () => {
    const f = await comEventoCriado();
    f.store.setActivity(REMARCADA);
    googleMoveParaDia13(f);

    await rescheduleAppointment(f.deps, f.conn, REMARCADA);

    expect(f.store.applyAttempts).toEqual([{ activityId: ACTIVITY_ID, expectedVersion: 4, applied: true }]);
  });

  it("o conflito não é regravado quando o PATCH seguinte pega 412 e o ciclo repete", async () => {
    const f = await comEventoCriado();
    f.store.setActivity({ ...REMARCADA, title: "Novo título do CRM" });
    googleMoveParaDia13(f);
    // Depois do conflito de horário, o título (só do CRM) vai ao Google; o Google muda de novo no meio.
    f.provider.onBefore("patch", () => f.provider.externalEdit(CALENDAR_ID, EVENT_ID, { attendees: [{ email: "externo@exemplo.test" }] }));

    await rescheduleAppointment(f.deps, f.conn, { ...REMARCADA, title: "Novo título do CRM" });

    expect(countCalls(f.provider, "patch")).toBe(2); // 412 e depois sucesso
    expect(f.store.conflicts.filter((c) => c.field === "schedule")).toHaveLength(1);
    expect(f.store.applyAttempts.filter((a) => a.applied)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------
// 3) Meet removido × campo omitido
// ---------------------------------------------------------------------

describe("achado 3 — Meet removido no Google é gravado como removido", () => {
  it("o Google removeu o Meet: um reagendamento limpa status e URL no vínculo", async () => {
    const f = await comEventoCriado({ withMeet: true });
    expect(await f.store.getLink(ACTIVITY_ID)).toMatchObject({ meetStatus: "success", meetUrl: expect.stringContaining("meet") });
    f.provider.externalEdit(CALENDAR_ID, EVENT_ID, { conferenceData: undefined });
    f.store.setActivity(REMARCADA);

    await rescheduleAppointment(f.deps, f.conn, REMARCADA);

    expect(await f.store.getLink(ACTIVITY_ID)).toMatchObject({ meetStatus: null, meetUrl: null });
  });

  it("Meet intacto: status e URL são preservados", async () => {
    const f = await comEventoCriado({ withMeet: true });
    const antes = await f.store.getLink(ACTIVITY_ID);
    f.store.setActivity(REMARCADA);

    await rescheduleAppointment(f.deps, f.conn, REMARCADA);

    expect(await f.store.getLink(ACTIVITY_ID)).toMatchObject({ meetStatus: "success", meetUrl: antes?.meetUrl });
  });

  it("o estado enviado ao banco leva as três chaves do Meet de forma EXPLÍCITA (null = removido)", async () => {
    const f = await comEventoCriado({ withMeet: true });
    f.provider.externalEdit(CALENDAR_ID, EVENT_ID, { conferenceData: undefined });
    f.store.setActivity(REMARCADA);
    const original = f.store.resolveEffect.bind(f.store);
    const vistos: Array<Record<string, unknown>> = [];
    f.store.resolveEffect = async (p) => {
      if (p.state) vistos.push(JSON.parse(JSON.stringify(p.state)));
      return original(p);
    };

    await rescheduleAppointment(f.deps, f.conn, REMARCADA);

    expect(vistos[0]).toMatchObject({ meetStatus: null, meetUrl: null });
    expect(Object.keys(vistos[0]!)).toEqual(expect.arrayContaining(["meetStatus", "meetUrl", "meetRequestId"]));
  });
});

// ---------------------------------------------------------------------
// 4) Duração coerente
// ---------------------------------------------------------------------

describe("achado 4 — a duração acompanha o horário que o Google venceu", () => {
  const minutos = (f: Awaited<ReturnType<typeof comEventoCriado>>) => {
    const e = f.provider.peek(CALENDAR_ID, EVENT_ID)!;
    return (Date.parse(e.end!.dateTime!) - Date.parse(e.start!.dateTime!)) / 60_000;
  };

  it("o Google vence o conflito com 90 min: o vínculo passa a 90 e um reagendamento posterior no CRM preserva os 90", async () => {
    const f = await comEventoCriado();
    f.store.setActivity(REMARCADA);
    // O Google move E alonga o evento para 90 minutos...
    f.provider.externalEdit(CALENDAR_ID, EVENT_ID, {
      start: { dateTime: "2026-11-13T09:00:00.000Z" },
      end: { dateTime: "2026-11-13T10:30:00.000Z" },
    });

    const conflito = await rescheduleAppointment(f.deps, f.conn, REMARCADA);
    expect(conflito.status).toBe("conflict_resolved");
    expect(f.store.activities.get(ACTIVITY_ID)?.dueAt).toBe("2026-11-13T09:00:00.000Z");
    // início, fim e duração do vínculo coerentes entre si:
    expect(await f.store.getLink(ACTIVITY_ID)).toMatchObject({
      baseStart: "2026-11-13T09:00:00.000Z",
      baseEnd: "2026-11-13T10:30:00.000Z",
      durationMinutes: 90,
    });

    // ...e depois o CRM reagenda para o dia 20.
    const depois = { ...f.store.activities.get(ACTIVITY_ID)!, dueAt: "2026-11-20T14:00:00.000Z", lockVersion: 9 };
    f.store.setActivity(depois);
    const reagendado = await rescheduleAppointment(f.deps, f.conn, depois);

    expect(reagendado.status).toBe("updated");
    const evento = f.provider.peek(CALENDAR_ID, EVENT_ID)!;
    expect(evento.start?.dateTime).toBe("2026-11-20T14:00:00.000Z");
    expect(evento.end?.dateTime).toBe("2026-11-20T15:30:00.000Z"); // 90 minutos preservados
    expect(await f.store.getLink(ACTIVITY_ID)).toMatchObject({ durationMinutes: 90 });
  });

  it("o Google só alongou 60 → 90 (mesmo início): um reagendamento posterior no CRM vale e mantém os 90", async () => {
    const f = await comEventoCriado();
    f.provider.externalEdit(CALENDAR_ID, EVENT_ID, { end: { dateTime: "2026-11-10T15:30:00.000Z" } });
    f.store.setActivity(REMARCADA);

    const result = await rescheduleAppointment(f.deps, f.conn, REMARCADA);

    expect(result.status).toBe("updated"); // sem conflito: o CRM só mexe no início
    expect(f.store.conflicts).toEqual([]);
    expect(f.provider.peek(CALENDAR_ID, EVENT_ID)?.start?.dateTime).toBe("2026-11-12T16:00:00.000Z");
    expect(minutos(f)).toBe(90);
    expect(await f.store.getLink(ACTIVITY_ID)).toMatchObject({ durationMinutes: 90, baseEnd: "2026-11-12T17:30:00.000Z" });
  });

  it("duração explícita pedida pelo CRM continua mandando", async () => {
    const f = await comEventoCriado();
    f.store.setActivity(REMARCADA);

    await rescheduleAppointment(f.deps, f.conn, REMARCADA, { durationMinutes: 120 });

    expect(minutos(f)).toBe(120);
    expect(await f.store.getLink(ACTIVITY_ID)).toMatchObject({ durationMinutes: 120 });
  });

  it.each([
    ["10 minutos (abaixo de 15)", "2026-11-10T14:10:00.000Z", 10],
    ["10 horas (acima de 480)", "2026-11-10T00:00:00.000Z", 600],
  ])("evento externo vinculado com %s: a duração real é preservada e um reagendamento posterior a mantém", async (_nome, fim, esperado) => {
    const f = await comEventoCriado();
    const inicio = fim === "2026-11-10T00:00:00.000Z" ? "2026-11-09T14:00:00.000Z" : "2026-11-10T14:00:00.000Z";
    const fimReal = fim === "2026-11-10T00:00:00.000Z" ? "2026-11-10T00:00:00.000Z" : fim;
    f.provider.externalEdit(CALENDAR_ID, EVENT_ID, { start: { dateTime: inicio }, end: { dateTime: fimReal } });
    f.store.setActivity({ ...CRIADA, dueAt: inicio }); // o CRM concorda com o início do Google

    // Primeiro reagendamento (sem mudança de início): nada é "corrigido" para caber em 15–480.
    await rescheduleAppointment(f.deps, f.conn, { ...CRIADA, dueAt: inicio });
    const evento = f.provider.peek(CALENDAR_ID, EVENT_ID)!;
    expect((Date.parse(evento.end!.dateTime!) - Date.parse(evento.start!.dateTime!)) / 60_000).toBe(esperado);

    // Reagendamento posterior no CRM: início novo, duração real mantida e gravada sem clamp.
    const novo = { ...CRIADA, dueAt: "2026-11-20T10:00:00.000Z", lockVersion: 9 };
    f.store.setActivity(novo);
    const result = await rescheduleAppointment(f.deps, f.conn, novo);

    expect(result.status).toBe("updated");
    const depois = f.provider.peek(CALENDAR_ID, EVENT_ID)!;
    expect(depois.start?.dateTime).toBe("2026-11-20T10:00:00.000Z");
    expect((Date.parse(depois.end!.dateTime!) - Date.parse(depois.start!.dateTime!)) / 60_000).toBe(esperado);
    expect(await f.store.getLink(ACTIVITY_ID)).toMatchObject({ durationMinutes: esperado });
  });

  it("o intervalo 15–480 continua valendo para a duração DIGITADA", async () => {
    const f = await comEventoCriado();
    f.store.setActivity(REMARCADA);
    await expect(rescheduleAppointment(f.deps, f.conn, REMARCADA, { durationMinutes: 10 })).rejects.toMatchObject({ code: "invalid_duration" });
    await expect(rescheduleAppointment(f.deps, f.conn, REMARCADA, { durationMinutes: 481 })).rejects.toMatchObject({ code: "invalid_duration" });
    expect((await rescheduleAppointment(f.deps, f.conn, REMARCADA, { durationMinutes: 480 })).status).toBe("updated");
  });
});

// ---------------------------------------------------------------------
// Troca da agenda selecionada: só compromissos NOVOS
// ---------------------------------------------------------------------

describe("trocar a agenda selecionada afeta só compromissos novos", () => {
  const SEGUNDA = "segunda-agenda@calendar.simulated";

  it("reagendar depois da troca: o evento continua na agenda ORIGINAL, pela mesma conexão", async () => {
    const f = await comEventoCriado();
    f.store.setActivity(REMARCADA);
    const trocada: ConnectionContext = { ...f.conn, calendarId: SEGUNDA };

    const result = await rescheduleAppointment(f.deps, trocada, REMARCADA);

    expect(result.status).toBe("updated");
    expect(f.provider.peek(CALENDAR_ID, EVENT_ID)?.start?.dateTime).toBe("2026-11-12T16:00:00.000Z");
    expect(f.provider.peek(SEGUNDA, EVENT_ID)).toBeUndefined(); // nada foi movido nem criado na agenda nova
    expect(f.provider.eventCount(SEGUNDA)).toBe(0);
    expect(f.store.conflicts).toEqual([]);
    expect([...f.store.links.values()][0]).toMatchObject({ status: "linked", calendarId: CALENDAR_ID, connectionId: "conn-1", baseCancelled: false });
  });

  it("adicionar Meet depois da troca: o Meet nasce no evento da agenda original", async () => {
    const f = await comEventoCriado();
    const result = await addMeetToAppointment(f.deps, { ...f.conn, calendarId: SEGUNDA }, CRIADA);
    expect(result).toMatchObject({ status: "updated", meet: { status: "success" } });
    expect(f.provider.peek(CALENDAR_ID, EVENT_ID)?.conferenceData?.entryPoints).toHaveLength(1);
    expect(f.provider.eventCount(SEGUNDA)).toBe(0);
  });

  it("cancelar depois da troca: apaga o evento da agenda original e só ele", async () => {
    const f = await comEventoCriado();
    const result = await cancelAppointment(f.deps, { ...f.conn, calendarId: SEGUNDA }, CRIADA);
    expect(result).toEqual({ status: "cancelled" });
    expect(f.provider.peek(CALENDAR_ID, EVENT_ID)?.status).toBe("cancelled");
    expect(f.provider.eventCount(SEGUNDA)).toBe(0);
  });

  it("compromisso NOVO depois da troca nasce na agenda nova; o antigo fica onde estava", async () => {
    const f = await comEventoCriado();
    const trocada: ConnectionContext = { ...f.conn, calendarId: SEGUNDA };
    f.store.selectCalendar("conn-1", SEGUNDA);
    const outra = activity({ id: "a1b2c3d4-0000-4000-8000-00000000a002", title: "Outra reunião fictícia", dueAt: "2026-11-15T10:00:00.000Z" });

    const criada = await createAppointment(f.deps, trocada, outra);

    expect(criada.status).toBe("created");
    expect(f.provider.eventCount(SEGUNDA)).toBe(1);
    expect(f.provider.eventCount(CALENDAR_ID)).toBe(1);
    const links = [...f.store.links.values()];
    expect(links.find((l) => l.activityId === ACTIVITY_ID)?.calendarId).toBe(CALENDAR_ID);
    expect(links.find((l) => l.activityId === outra.id)?.calendarId).toBe(SEGUNDA);
  });

  it("a conexão de OUTRO usuário continua recusada, mesmo com a agenda original selecionada", async () => {
    const f = await comEventoCriado();
    const outro = await f.provider.exchangeAuthorization("outro.usuario@exemplo.test");
    const connOutro: ConnectionContext = { connectionId: "conn-2", calendarId: CALENDAR_ID, environment: "preview", accessToken: outro.accessToken };
    const chamadas = f.provider.calls.length;

    await expect(rescheduleAppointment(f.deps, connOutro, REMARCADA)).rejects.toMatchObject({ code: "link_connection_mismatch" });
    await expect(cancelAppointment(f.deps, connOutro, CRIADA)).rejects.toMatchObject({ code: "link_connection_mismatch" });
    expect(f.provider.calls.length).toBe(chamadas);
  });
});

// ---------------------------------------------------------------------
// Perda de acesso: pendência explícita, nunca "evento apagado"
// ---------------------------------------------------------------------

describe("perda de acesso à agenda do vínculo", () => {
  it.each([
    ["403 (proibido)", 403],
    ["404 (agenda 'não existe' para esta conexão)", 404],
  ] as const)("reagendar com acesso perdido — %s: pendência explícita, evento NÃO é dado como apagado", async (_nome, como) => {
    const f = await comEventoCriado();
    f.store.setActivity(REMARCADA);
    f.provider.revokeCalendarAccess(CALENDAR_ID, como);

    const result = await rescheduleAppointment(f.deps, f.conn, REMARCADA);

    expect(result).toEqual({ status: "access_lost" });
    expect(countCalls(f.provider, "patch")).toBe(0);
    expect(f.store.conflicts).toEqual([]); // nada de "cancelamento" registrado
    expect([...f.store.links.values()][0]).toMatchObject({ status: "needs_attention", baseCancelled: false });
    expect(f.store.intents.at(-1)).toMatchObject({ status: "failed", errorCode: "calendar_access_lost" });
    expect(f.provider.peek(CALENDAR_ID, EVENT_ID)?.status).toBe("confirmed");

    // Com o acesso de volta, a mesma operação funciona e a pendência some.
    f.provider.restoreCalendarAccess(CALENDAR_ID);
    expect((await rescheduleAppointment(f.deps, f.conn, REMARCADA)).status).toBe("updated");
    expect([...f.store.links.values()][0]).toMatchObject({ status: "linked" });
  });

  it.each([403, 404] as const)("cancelar com acesso perdido (%s): não desfaz o vínculo nem finge que o evento sumiu", async (como) => {
    const f = await comEventoCriado();
    f.provider.revokeCalendarAccess(CALENDAR_ID, como);

    const result = await cancelAppointment(f.deps, f.conn, CRIADA);

    expect(result).toEqual({ status: "access_lost" });
    expect(countCalls(f.provider, "delete")).toBe(0);
    expect([...f.store.links.values()][0]).toMatchObject({ status: "needs_attention", baseCancelled: false });
    expect(await f.store.getLink(ACTIVITY_ID)).not.toBeNull(); // vínculo continua ativo

    f.provider.restoreCalendarAccess(CALENDAR_ID);
    expect(await cancelAppointment(f.deps, f.conn, CRIADA)).toEqual({ status: "cancelled" });
  });

  it("adicionar Meet com acesso perdido: mesma pendência", async () => {
    const f = await comEventoCriado();
    f.provider.revokeCalendarAccess(CALENDAR_ID, 404);
    expect(await addMeetToAppointment(f.deps, f.conn, CRIADA)).toEqual({ status: "access_lost" });
    expect([...f.store.links.values()][0]).toMatchObject({ status: "needs_attention" });
  });

  it("evento realmente apagado (agenda acessível) continua sendo cancelamento no Google", async () => {
    const f = await comEventoCriado();
    f.provider.externalEdit(CALENDAR_ID, EVENT_ID, { status: "cancelled" });
    f.store.setActivity(REMARCADA);
    expect(await rescheduleAppointment(f.deps, f.conn, REMARCADA)).toEqual({ status: "cancelled_in_google" });
  });
});
