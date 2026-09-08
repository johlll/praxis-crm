"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, FormLabel } from "@/components/ui/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { createWorkspaceAction, type OnboardingActionState } from "@/modules/onboarding/actions";
import { slugify } from "@/modules/onboarding/schema";

const INITIAL_STATE: OnboardingActionState = { ok: false };

export function CreateWorkspaceForm() {
  const [state, formAction, pending] = useActionState(createWorkspaceAction, INITIAL_STATE);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);

  function handleNameChange(value: string) {
    setName(value);
    if (!slugTouched) setSlug(slugify(value));
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FormField>
        <FormLabel htmlFor="name">Nome do escritório</FormLabel>
        <Input
          id="name"
          name="name"
          value={name}
          onChange={(event) => handleNameChange(event.target.value)}
          placeholder="Rocha & Antunes Advogados"
          required
        />
      </FormField>
      <FormField>
        <FormLabel htmlFor="slug">Identificador</FormLabel>
        <Input
          id="slug"
          name="slug"
          value={slug}
          onChange={(event) => {
            setSlugTouched(true);
            setSlug(slugify(event.target.value));
          }}
          placeholder="rocha-antunes"
          required
        />
      </FormField>
      {state.error ? (
        <Alert variant="danger">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Criando…" : "Criar workspace"}
      </Button>
    </form>
  );
}
