"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { processAutomationsAction } from "@/modules/automations/actions";

/**
 * "Processar agora": roda uma rodada do workspace (eventos pendentes e
 * tentativas vencidas). Idempotente — apertar duas vezes nunca duplica
 * atividade. Só aparece para quem gerencia as regras.
 */
export function ProcessNowButton() {
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const [pending, startTransition] = useTransition();

  function run() {
    setMessage(null);
    startTransition(async () => {
      const result = await processAutomationsAction();
      if (!result.ok) {
        setIsError(true);
        setMessage(result.error);
        return;
      }
      setIsError(false);
      setMessage(
        result.events === 0 && result.executions === 0
          ? "Nada pendente agora."
          : `${result.events} evento(s) lido(s) e ${result.executions} execução(ões) tentada(s).`,
      );
    });
  }

  return (
    <div className="flex items-center gap-3">
      <Button variant="secondary" size="sm" onClick={run} disabled={pending}>
        {pending ? "Processando…" : "Processar agora"}
      </Button>
      {message ? (
        <span role="status" className={`text-meta ${isError ? "text-danger" : "text-text-tertiary"}`}>
          {message}
        </span>
      ) : null}
    </div>
  );
}
