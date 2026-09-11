"use client";

import { useActionState, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, FormLabel } from "@/components/ui/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { WhatsAppChannel } from "@/modules/conversations/queries";
import { simulateInboundMessageAction, type SimulateActionState } from "@/modules/conversations/actions";

const INITIAL_STATE: SimulateActionState = { ok: false };

export function SimulateInboundForm({ channels }: { channels: WhatsAppChannel[] }) {
  const [state, formAction, pending] = useActionState(simulateInboundMessageAction, INITIAL_STATE);
  const [channelId, setChannelId] = useState(channels[0]?.id ?? "");
  const selectedChannel = channels.find((c) => c.id === channelId);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <FormField>
        <FormLabel htmlFor="sim-channel">Canal</FormLabel>
        <select
          id="sim-channel"
          value={channelId}
          onChange={(e) => setChannelId(e.target.value)}
          className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text"
        >
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </FormField>
      <input type="hidden" name="channelId" value={channelId} />
      <input type="hidden" name="phoneNumberId" value={selectedChannel?.phoneNumberId ?? ""} />

      <div className="grid grid-cols-2 gap-3">
        <FormField>
          <FormLabel htmlFor="sim-from-phone">Número de quem envia</FormLabel>
          <Input id="sim-from-phone" name="fromPhone" required placeholder="+55 11 98888-7777" />
        </FormField>
        <FormField>
          <FormLabel htmlFor="sim-profile-name">Nome (opcional)</FormLabel>
          <Input id="sim-profile-name" name="profileName" maxLength={160} placeholder="Como apareceria no WhatsApp" />
        </FormField>
      </div>

      <FormField>
        <FormLabel htmlFor="sim-body-text">Mensagem</FormLabel>
        <textarea
          id="sim-body-text"
          name="bodyText"
          required
          rows={2}
          maxLength={4096}
          className="rounded-input border border-border-input bg-surface px-3 py-2 text-body text-text"
        />
      </FormField>

      {state.error ? (
        <Alert variant="danger">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      {state.ok && state.conversationId ? (
        <Alert variant="success">
          <AlertDescription>
            Mensagem simulada recebida.{" "}
            <Link href={`/conversas/${state.conversationId}` as never} className="font-semibold underline">
              Ver conversa
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}

      <div>
        <Button type="submit" size="sm" disabled={pending || !channelId}>
          {pending ? "Enviando…" : "Simular mensagem recebida"}
        </Button>
      </div>
    </form>
  );
}
