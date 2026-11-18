"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";

/**
 * Os controles do painel (corrigir situação, corrigir andamento, pausar e retomar) leem a MESMA
 * versão da trilha. Enquanto um deles salva ou a tela ainda atualiza, os outros ficam desabilitados:
 * sem isto, agir num controle logo depois de outro usaria a versão antiga e cairia em conflito à toa.
 */
type Registry = {
  busyIds: ReadonlySet<string>;
  mark: (id: string, busy: boolean) => void;
};

const Ctx = createContext<Registry | null>(null);

export function TrackBusyProvider({ children }: { children: ReactNode }) {
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const mark = useCallback((id: string, busy: boolean) => {
    setBusyIds((prev) => {
      if (prev.has(id) === busy) return prev;
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const value = useMemo(() => ({ busyIds, mark }), [busyIds, mark]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Registra se ESTE controle está ocupado e diz se algum OUTRO está. Fora do provedor, nunca há "outros". */
export function useOthersBusy(localBusy: boolean): boolean {
  const ctx = useContext(Ctx);
  const id = useId();
  const mark = ctx?.mark;

  useEffect(() => {
    mark?.(id, localBusy);
    return () => mark?.(id, false);
  }, [mark, id, localBusy]);

  if (!ctx) return false;
  for (const other of ctx.busyIds) if (other !== id) return true;
  return false;
}
