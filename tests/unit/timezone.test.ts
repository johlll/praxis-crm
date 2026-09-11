import { describe, expect, it } from "vitest";

import { formatDate, formatDateTime, formatDue, formatTime } from "@/lib/timezone";

/**
 * A5 já encontrou um bug real de hidratação por formatar data/hora sem
 * `timeZone` explícito (servidor UTC vs. navegador local — A5-HANDOFF.md
 * §3.1). Este teste prova que os utilitários da A6 ficam ANCORADOS em
 * America/Sao_Paulo mesmo trocando o fuso do processo Node que roda o
 * teste — nunca dependem do fuso da máquina.
 */
describe("timezone", () => {
  // 2026-09-10T23:30:00Z — 20:30 em São Paulo (UTC-3, sem horário de
  // verão desde 2019); escolhido de propósito perto da virada de dia em
  // UTC, para pegar justamente o caso onde um bug de fuso trocaria a data.
  const iso = "2026-09-10T23:30:00.000Z";

  const originalTz = process.env.TZ;

  function withProcessTimezone<T>(tz: string, fn: () => T): T {
    process.env.TZ = tz;
    try {
      return fn();
    } finally {
      process.env.TZ = originalTz;
    }
  }

  it("formatDateTime fixa America/Sao_Paulo independente do TZ do processo", () => {
    const utc = withProcessTimezone("UTC", () => formatDateTime(iso));
    const la = withProcessTimezone("America/Los_Angeles", () => formatDateTime(iso));
    expect(utc).toBe(la);
    expect(utc).toBe("10/09/2026, 20:30:00");
  });

  it("formatDate mostra o dia certo em São Paulo mesmo quando UTC já virou o dia seguinte", () => {
    // 23:30 UTC de 10/09 ainda é 10/09 às 20:30 em São Paulo — um bug de
    // fuso (usar o dia em UTC) mostraria 11/09 errado.
    expect(formatDate(iso)).toBe("10/09/2026");
  });

  it("formatTime mostra só a hora, no fuso certo", () => {
    expect(formatTime(iso)).toBe("20:30");
  });

  it("formatDue alterna entre data+hora e só data conforme hasTime", () => {
    expect(formatDue(iso, true)).toBe(formatDateTime(iso));
    expect(formatDue(iso, false)).toBe(formatDate(iso));
  });
});
