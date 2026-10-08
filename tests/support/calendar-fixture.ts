import type { CalendarEnvironment } from "@/server/calendar/environment";
import { SimulatedCalendarProvider } from "@/server/calendar/simulated-provider";
import type { ActivitySnapshot, ConnectionContext, SyncDeps } from "@/server/calendar/sync/types";

import { MemoryStore } from "./calendar-memory-store";

/** Dados 100% fictícios. */
export const ACTIVITY_ID = "a1b2c3d4-0000-4000-8000-00000000a001";
export const CALENDAR_ID = "principal@calendar.simulated";

export async function makeFixture(environment: CalendarEnvironment = "preview") {
  const provider = new SimulatedCalendarProvider();
  const tokens = await provider.exchangeAuthorization("teste.qa@exemplo.test");
  const store = new MemoryStore(environment, CALENDAR_ID);
  const deps: SyncDeps = { api: provider, store, environment };
  const conn: ConnectionContext = {
    connectionId: "conn-1",
    calendarId: CALENDAR_ID,
    environment,
    accessToken: tokens.accessToken,
  };
  return { provider, store, deps, conn };
}

export function activity(overrides: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
  return {
    id: ACTIVITY_ID,
    title: "Reunião com cliente fictício",
    dueAt: "2026-11-10T14:00:00.000Z",
    hasTime: true,
    type: "meeting",
    lockVersion: 3,
    ...overrides,
  };
}

export const countCalls = (provider: SimulatedCalendarProvider, operation: string) =>
  provider.calls.filter((c) => c.operation === operation).length;
