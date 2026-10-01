"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, FormLabel } from "@/components/ui/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  updateWorkspaceLegalProfileAction,
  type UpdateWorkspaceLegalProfileState,
} from "@/modules/workspace/actions";
import type { WorkspaceLegalProfile } from "@/modules/workspace/queries";

const INITIAL: UpdateWorkspaceLegalProfileState = { ok: false };

export function WorkspaceLegalProfileForm({
  workspaceId,
  profile,
}: {
  workspaceId: string;
  profile: WorkspaceLegalProfile | null;
}) {
  const action = updateWorkspaceLegalProfileAction.bind(null, workspaceId);
  const [state, formAction, pending] = useActionState(action, INITIAL);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <p className="text-meta text-text-tertiary">
        Aparece no cabeçalho do PDF de proposta (B1). Nenhum campo é obrigatório — deixar em branco só reduz o que
        aparece no documento. Só a razão social é exigida para habilitar o envio real por e-mail.
      </p>
      <FormField>
        <FormLabel htmlFor="legal-name">Razão social</FormLabel>
        <Input id="legal-name" name="legalName" defaultValue={profile?.legalName ?? ""} maxLength={200} />
      </FormField>
      <FormField>
        <FormLabel htmlFor="cnpj">CNPJ</FormLabel>
        <Input id="cnpj" name="cnpj" defaultValue={profile?.cnpj ?? ""} placeholder="Só números" />
      </FormField>
      <div className="grid grid-cols-[1fr_120px] gap-3">
        <FormField>
          <FormLabel htmlFor="oab-number">Número OAB</FormLabel>
          <Input id="oab-number" name="oabNumber" defaultValue={profile?.oabNumber ?? ""} maxLength={40} />
        </FormField>
        <FormField>
          <FormLabel htmlFor="oab-uf">UF da OAB</FormLabel>
          <Input id="oab-uf" name="oabUf" defaultValue={profile?.oabUf ?? ""} maxLength={2} />
        </FormField>
      </div>
      <FormField>
        <FormLabel htmlFor="address-line">Endereço</FormLabel>
        <Input id="address-line" name="addressLine" defaultValue={profile?.addressLine ?? ""} maxLength={200} />
      </FormField>
      <div className="grid grid-cols-[1fr_80px_140px] gap-3">
        <FormField>
          <FormLabel htmlFor="address-city">Cidade</FormLabel>
          <Input id="address-city" name="addressCity" defaultValue={profile?.addressCity ?? ""} maxLength={120} />
        </FormField>
        <FormField>
          <FormLabel htmlFor="address-uf">UF</FormLabel>
          <Input id="address-uf" name="addressUf" defaultValue={profile?.addressUf ?? ""} maxLength={2} />
        </FormField>
        <FormField>
          <FormLabel htmlFor="address-zip">CEP</FormLabel>
          <Input id="address-zip" name="addressZip" defaultValue={profile?.addressZip ?? ""} placeholder="Só números" />
        </FormField>
      </div>
      {state.error ? (
        <Alert variant="danger">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.ok ? (
        <Alert variant="success">
          <AlertDescription>Salvo.</AlertDescription>
        </Alert>
      ) : null}
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Salvando…" : "Salvar"}
        </Button>
      </div>
    </form>
  );
}
