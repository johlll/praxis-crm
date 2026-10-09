/**
 * @vitest-environment node
 *
 * B2, etapa 2 — comparação por campo com a base (puro) e id determinístico.
 */
import { describe, expect, it } from "vitest";

import { deterministicEventId, meetRequestId } from "@/server/calendar/sync/ids";
import { googleChangedSinceBase, mergeFields, type SyncState } from "@/server/calendar/sync/merge";

const BASE: SyncState = {
  title: "Reunião",
  start: "2026-11-10T14:00:00.000Z",
  end: "2026-11-10T15:00:00.000Z",
  cancelled: false,
  hasMeet: false,
};
const NOVO = { start: "2026-11-11T14:00:00.000Z", end: "2026-11-11T15:00:00.000Z" };

describe("mergeFields — base por campo", () => {
  it("só o CRM mudou: envia ao Google, sem conflito", () => {
    const plan = mergeFields(BASE, { title: "Reunião", schedule: NOVO }, BASE);
    expect(plan.push).toEqual({ schedule: NOVO });
    expect(plan.conflicts).toEqual([]);
    expect(plan.reconciled).toContain("schedule");
  });

  it("só o Google mudou: nada a enviar e a base NÃO avança nesse campo", () => {
    const google = { ...BASE, title: "Reunião (renomeada no Google)" };
    const plan = mergeFields(BASE, { title: "Reunião", schedule: { start: BASE.start!, end: BASE.end! } }, google);
    expect(plan.push).toEqual({});
    expect(plan.conflicts).toEqual([]);
    expect(plan.reconciled).not.toContain("title");
  });

  it("os dois mudaram o MESMO campo para o MESMO valor: não é conflito", () => {
    const google = { ...BASE, ...NOVO };
    const plan = mergeFields(BASE, { schedule: NOVO }, google);
    expect(plan.conflicts).toEqual([]);
    expect(plan.push).toEqual({});
    expect(plan.reconciled).toContain("schedule");
  });

  it("os dois mudaram o mesmo campo para valores DIFERENTES: conflito com os dois valores", () => {
    const google = { ...BASE, start: "2026-11-12T09:00:00.000Z", end: "2026-11-12T10:00:00.000Z" };
    const plan = mergeFields(BASE, { schedule: NOVO }, google);
    expect(plan.push).toEqual({});
    expect(plan.conflicts).toEqual([
      { field: "schedule", crmValue: NOVO, googleValue: { start: google.start, end: google.end } },
    ]);
  });

  it("instantes equivalentes em formatos diferentes são iguais (não geram conflito falso)", () => {
    const google = { ...BASE, start: "2026-11-10T11:00:00-03:00", end: "2026-11-10T12:00:00-03:00" };
    expect(mergeFields(BASE, { schedule: { start: BASE.start!, end: BASE.end! } }, google).conflicts).toEqual([]);
    expect(googleChangedSinceBase(BASE, google)).toBe(false);
  });

  it("título e horário são independentes: cada um tem o seu veredito", () => {
    const google = { ...BASE, title: "Outro título no Google" };
    const plan = mergeFields(BASE, { title: "Título do CRM", schedule: NOVO }, google);
    expect(plan.push).toEqual({ schedule: NOVO });
    expect(plan.conflicts).toEqual([{ field: "title", crmValue: "Título do CRM", googleValue: "Outro título no Google" }]);
  });

  it("cancelado no Google + editado no CRM: conflito de cancelamento com a edição do CRM", () => {
    const plan = mergeFields(BASE, { schedule: NOVO }, { ...BASE, cancelled: true });
    expect(plan.googleCancelled).toBe(true);
    expect(plan.push).toEqual({});
    expect(plan.conflicts).toEqual([
      { field: "cancellation", crmValue: { title: null, schedule: NOVO }, googleValue: { cancelled: true } },
    ]);
  });

  it("cancelado no Google sem edição do CRM: sem conflito", () => {
    const plan = mergeFields(BASE, {}, { ...BASE, cancelled: true });
    expect(plan.googleCancelled).toBe(true);
    expect(plan.conflicts).toEqual([]);
  });

  it("Meet: pedido atendido sem conflito quando o Google já tem a conferência; senão, envia", () => {
    expect(mergeFields(BASE, { meet: true }, { ...BASE, hasMeet: true }).push).toEqual({});
    expect(mergeFields(BASE, { meet: true }, BASE).push).toEqual({ meet: true });
  });

  it("Meet removido no Google não é recriado sozinho", () => {
    const comMeet = { ...BASE, hasMeet: true };
    const plan = mergeFields(comMeet, { title: "Reunião" }, { ...comMeet, hasMeet: false });
    expect(plan.push).toEqual({});
  });
});

describe("id determinístico do evento", () => {
  const A = "a1b2c3d4-0000-4000-8000-00000000a001";

  it("é estável, no alfabeto base32hex do Google e com tamanho permitido", () => {
    const id = deterministicEventId("preview", A, 1);
    expect(id).toBe(deterministicEventId("preview", A, 1));
    expect(id).toMatch(/^[0-9a-v]{32}$/);
  });

  it("muda com o ambiente, a atividade e a geração", () => {
    const base = deterministicEventId("preview", A, 1);
    expect(deterministicEventId("production", A, 1)).not.toBe(base);
    expect(deterministicEventId("preview", A.replace("a001", "a002"), 1)).not.toBe(base);
    expect(deterministicEventId("preview", A, 2)).not.toBe(base);
  });

  it("o pedido de Meet é derivado do evento (repetição reaproveita o mesmo pedido)", () => {
    const id = deterministicEventId("preview", A, 1);
    expect(meetRequestId(id)).toBe(meetRequestId(id));
    expect(meetRequestId(id, 2)).not.toBe(meetRequestId(id, 1));
  });
});
