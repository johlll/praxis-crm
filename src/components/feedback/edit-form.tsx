"use client";

import { startTransition, type ComponentProps } from "react";

/**
 * Formulário de EDIÇÃO de um registro existente. `<form action={fn}>` faz o
 * React 19 chamar `form.reset()` ao fim do envio: campos voltam aos valores
 * da montagem e `<select>` controlado nem é restaurado (o estado não mudou),
 * então a tela mostrava o valor anterior ao salvo. Enviar pelo `onSubmit`
 * dentro de uma transição mantém `pending`/estado do useActionState sem esse
 * reset. Para formulários de criação, o reset automático é o comportamento
 * certo — use `<form action>` normal.
 */
export function EditForm({
  action,
  ...props
}: Omit<ComponentProps<"form">, "action" | "onSubmit"> & { action: (formData: FormData) => void }) {
  return (
    <form
      {...props}
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        startTransition(() => action(formData));
      }}
    />
  );
}
