"use client";

import { Pause, Play } from "lucide-react";

import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatStamp } from "@/modules/conversations/context-format";
import { setStatusTrackAutomationAction } from "@/modules/status-tracks/actions";
import type { StatusTrack } from "@/modules/status-tracks/schema";
import { useTrackAction } from "./use-track-action";

/**
 * Pausa e retomada das FUTURAS alterações automáticas de status de uma trilha
 * (por trilha e alvo). É coisa diferente do bot de atendimento: estes controles
 * não pausam nem retomam a Vitória nem nenhuma mensagem automática. Também
 * nunca bloqueiam a correção manual autorizada. Como a automação de status
 * ainda não foi ativada, a pausa hoje só protege decisões futuras.
 */
export function AutomationControl({
  track,
  targetId,
  paused,
  pausedAt,
  pausedByName,
  version,
  canEdit,
  deniedReason,
}: {
  track: StatusTrack;
  targetId: string;
  paused: boolean;
  pausedAt: string | null;
  pausedByName: string | null;
  version: number;
  canEdit: boolean;
  deniedReason: string;
}) {
  const { pending, blocked, error, conflict, done, run, refresh } = useTrackAction();

  function toggle() {
    run(() => setStatusTrackAutomationAction({ track, targetId, paused: !paused, expectedVersion: version }));
  }

  return (
    <div className="flex flex-col gap-2 rounded-input border border-border bg-surface-subtle px-3 py-2.5" aria-busy={pending}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="text-meta font-semibold text-text-secondary">Alterações automáticas de status</span>
          <span className={cn("text-meta font-bold", paused ? "text-warning" : "text-text-tertiary")}>
            {paused
              ? `Pausadas${pausedByName ? ` por ${pausedByName}` : ""}${pausedAt ? ` em ${formatStamp(pausedAt)}` : ""}`
              : "Liberadas (ainda não ativadas)"}
          </span>
        </div>
        {canEdit ? (
          <Button type="button" size="sm" variant="secondary" onClick={toggle} disabled={pending || blocked} className="shrink-0">
            {paused ? <Play size={13} aria-hidden /> : <Pause size={13} aria-hidden />}
            {pending ? "Salvando…" : paused ? "Retomar" : "Pausar"}
          </Button>
        ) : null}
      </div>
      <p className="m-0 text-meta text-text-tertiary">
        {canEdit
          ? "Vale só para as futuras alterações automáticas deste status. Não pausa nem retoma o bot de atendimento e não impede correção manual."
          : deniedReason}
      </p>
      <div aria-live="polite" className="flex flex-col gap-2">
        {done ? <p className="m-0 text-meta font-semibold text-success">{done}</p> : null}
        {conflict ? (
          <Alert variant="warning">
            <AlertDescription>
              Este registro mudou enquanto você editava. Atualize para ver o estado atual antes de tentar de novo.{" "}
              <button type="button" onClick={refresh} className="font-semibold underline">
                Atualizar
              </button>
            </AlertDescription>
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="danger">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    </div>
  );
}
