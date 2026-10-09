"use client";

import { createContext, useContext, type ReactNode } from "react";

import { NO_CALENDAR, type CalendarCapabilities } from "@/modules/calendar/types";

const CalendarCapabilitiesContext = createContext<CalendarCapabilities>(NO_CALENDAR);

/** Entrega, uma vez por página, o que o usuário pode fazer com o Google
 * Agenda — as telas de atividade só mostram controles de agenda quando
 * `enabled` e `canUse`. */
export function CalendarCapabilitiesProvider({
  value,
  children,
}: {
  value: CalendarCapabilities;
  children: ReactNode;
}) {
  return <CalendarCapabilitiesContext.Provider value={value}>{children}</CalendarCapabilitiesContext.Provider>;
}

export function useCalendarCapabilities(): CalendarCapabilities {
  return useContext(CalendarCapabilitiesContext);
}
