"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, FormLabel } from "@/components/ui/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { LEAD_PRIORITIES } from "@/modules/leads/schema";
import { updateLeadBasicFieldsAction, type LeadActionState } from "@/modules/leads/actions";
import type { LeadListItem } from "@/modules/leads/queries";

const INITIAL_STATE: LeadActionState = { ok: false };

const PRIORITY_LABEL: Record<(typeof LEAD_PRIORITIES)[number], string> = {
  baixa: "Baixa",
  media: "Média",
  alta: "Alta",
};

export function LeadBasicFieldsForm({ lead, readOnly }: { lead: LeadListItem; readOnly: boolean }) {
  const [state, formAction, pending] = useActionState(updateLeadBasicFieldsAction, INITIAL_STATE);

  // Campos CONTROLADOS, inicializados só na montagem deste componente
  // (uma instância por lead — navegar para outro lead monta um
  // LeadBasicFieldsForm novo, com o `lead` novo já no useState inicial;
  // este componente nunca ressincroniza esses estados a partir da prop
  // `lead` depois de montado.
  //
  // A versão anterior usava campos NÃO controlados (defaultValue) com
  // `key={lead.updatedAt}` para forçar remontagem quando o dado mudava.
  // Achado real no CI (trace da execução que falhou, corpo do POST
  // inspecionado diretamente): o texto que o usuário digitava podia ficar
  // concatenado com o texto anterior — e isso acontecia ANTES do clique
  // em "Salvar" capturar o FormData, ou seja, o valor CORROMPIDO era o
  // que ia pro banco, não um artefato de exibição pós-save. A causa é a
  // janela entre a hidratação/reconciliação do React 19 num campo não
  // controlado e o momento em que o teste (ou um usuário rápido) já
  // tinha editado o campo — remontar por key não fecha essa janela
  // porque ela ocorre ANTES da key mudar.
  //
  // Controlado, o React é sempre a única autoridade sobre o valor do
  // campo — não há reconciliação de DOM não controlado para corromper.
  // E por nunca reagir a `lead` mudando, uma edição em andamento nunca é
  // sobrescrita por uma resposta de um save anterior ainda em voo
  // (saves consecutivos, resposta lenta): o único efeito de um save
  // bem-sucedido é o hidden `expectedUpdatedAt` abaixo, que sempre lê a
  // prop mais recente — ele não é editável pelo usuário, então não há
  // "edição em andamento" dele para perder.
  const [legalArea, setLegalArea] = useState(lead.legalArea);
  const [summary, setSummary] = useState(lead.summary ?? "");
  const [tags, setTags] = useState(lead.tags.join(", "));
  const [priority, setPriority] = useState(lead.priority);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="leadId" value={lead.id} />
      <input type="hidden" name="expectedUpdatedAt" value={lead.updatedAt} />

      <FormField>
        <FormLabel htmlFor="legalArea">Área jurídica</FormLabel>
        <Input
          id="legalArea"
          name="legalArea"
          value={legalArea}
          onChange={(event) => setLegalArea(event.target.value)}
          required
          disabled={readOnly}
        />
      </FormField>

      <FormField>
        <FormLabel htmlFor="summary">Resumo</FormLabel>
        <textarea
          id="summary"
          name="summary"
          rows={3}
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          disabled={readOnly}
          className="rounded-input border border-border-input bg-surface px-3 py-2 text-body text-text disabled:opacity-60"
        />
      </FormField>

      <FormField>
        <FormLabel htmlFor="tags">Etiquetas</FormLabel>
        <Input
          id="tags"
          name="tags"
          value={tags}
          onChange={(event) => setTags(event.target.value)}
          disabled={readOnly}
        />
      </FormField>

      <FormField>
        <FormLabel htmlFor="priority">Prioridade</FormLabel>
        <select
          id="priority"
          name="priority"
          value={priority}
          onChange={(event) => setPriority(event.target.value as (typeof LEAD_PRIORITIES)[number])}
          disabled={readOnly}
          className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text disabled:opacity-60"
        >
          {LEAD_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]}
            </option>
          ))}
        </select>
      </FormField>

      {state.error ? (
        <Alert variant="danger">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.ok ? (
        <Alert variant="success">
          <AlertDescription>Dados salvos.</AlertDescription>
        </Alert>
      ) : null}

      {readOnly ? null : (
        <Button type="submit" disabled={pending} className="self-start">
          {pending ? "Salvando…" : "Salvar"}
        </Button>
      )}
    </form>
  );
}
