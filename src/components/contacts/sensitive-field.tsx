"use client";

import { useState, useTransition } from "react";
import { Eye, EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { revealContactCpfCnpjAction } from "@/modules/contacts/actions";

/**
 * CPF/CNPJ mascarado por padrão — o valor completo nunca está no payload
 * inicial da página (`getContactDetail()` só devolve `hasSensitive:
 * boolean`); revelar dispara uma Server Action própria, que audita no
 * servidor (nunca guardando o valor) antes de decifrar e devolver só para
 * esta chamada. Nada aqui fica em cache: é o retorno direto de uma Server
 * Action, não um `fetch` GET que o Next pudesse reter.
 */
export function SensitiveField({ contactId }: { contactId: string }) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [needsReason, setNeedsReason] = useState(false);
  const [pending, startTransition] = useTransition();

  function reveal() {
    setError(null);
    const formData = new FormData();
    formData.set("contactId", contactId);
    if (reason) formData.set("reason", reason);

    startTransition(async () => {
      const result = await revealContactCpfCnpjAction(formData);
      if (!result.ok) {
        if (result.error === "Informe o motivo da consulta para revelar este dado.") {
          setNeedsReason(true);
        }
        setError(result.error ?? "Não foi possível revelar.");
        return;
      }
      setRevealed(result.value ?? null);
    });
  }

  function hide() {
    setRevealed(null);
    setError(null);
  }

  if (revealed) {
    return (
      <div className="flex items-center gap-2">
        <span className="font-mono text-body tabular-nums text-text">{revealed}</span>
        <Button type="button" variant="ghost" size="sm" onClick={hide}>
          <EyeOff size={14} aria-hidden />
          Ocultar
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-body tracking-wider text-text-tertiary">•••.•••.•••-••</span>
        <Button type="button" variant="ghost" size="sm" onClick={reveal} disabled={pending}>
          <Eye size={14} aria-hidden />
          {pending ? "Revelando…" : "Revelar"}
        </Button>
      </div>
      {needsReason ? (
        <div className="flex items-center gap-2">
          <Input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Motivo da consulta (obrigatório para o seu papel)"
            className="max-w-[320px]"
          />
          <Button type="button" size="sm" onClick={reveal} disabled={pending || !reason.trim()}>
            Confirmar
          </Button>
        </div>
      ) : null}
      {error && !needsReason ? <p className="text-small text-danger">{error}</p> : null}
    </div>
  );
}
