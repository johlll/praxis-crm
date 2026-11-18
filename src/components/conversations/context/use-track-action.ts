"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import type { TrackActionState } from "@/modules/status-tracks/queries";
import { useOthersBusy } from "./track-busy";

/**
 * Estado comum dos controles de escrita do painel de contexto: pendente,
 * erro, conflito de versão e confirmação. Conflito NUNCA é repetido à força:
 * a tela avisa que o registro mudou e oferece atualizar (`refresh`).
 *
 * `pending` cobre também a atualização da tela depois de salvar e as ações dos
 * OUTROS controles do painel: enquanto a tela não atualiza, a versão que os
 * controles guardam ainda é a anterior e um segundo clique cairia em conflito à toa.
 */
export function useTrackAction() {
  const router = useRouter();
  const [saving, start] = useTransition();
  const [refreshing, startRefresh] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  function run(call: () => Promise<TrackActionState>, onOk?: () => void) {
    setError(null);
    setConflict(false);
    setDone(null);
    start(async () => {
      const result = await call();
      if (result.ok) {
        setDone(result.result.replayed ? "Nada mudou: este pedido já tinha sido registrado." : "Registrado.");
        onOk?.();
        startRefresh(() => router.refresh());
        return;
      }
      if (result.conflict) {
        setConflict(true);
        return;
      }
      setError(result.error);
    });
  }

  function refresh() {
    setConflict(false);
    setError(null);
    setDone(null);
    startRefresh(() => router.refresh());
  }

  const local = saving || refreshing;
  const othersBusy = useOthersBusy(local);

  // pending: ESTE controle está salvando/atualizando; blocked: outro controle do painel está.
  return { pending: local, blocked: othersBusy, error, conflict, done, run, refresh };
}
