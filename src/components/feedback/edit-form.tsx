"use client";

import { startTransition, useSyncExternalStore, type ComponentProps } from "react";

/**
 * Formulário de EDIÇÃO de um registro existente.
 *
 * 1. `<form action={fn}>` faz o React 19 chamar `form.reset()` ao fim do
 *    envio: campos voltam aos valores da montagem e `<select>` controlado
 *    nem é restaurado (o estado não mudou), então a tela mostrava o valor
 *    anterior ao salvo. Enviar pelo `onSubmit` dentro de uma transição
 *    mantém `pending`/estado do useActionState sem esse reset. Para
 *    formulários de criação, o reset automático é o comportamento certo —
 *    use `<form action>` normal.
 *
 * 2. Enquanto a página não hidrata, o formulário não aceita edição. Uma
 *    edição nessa janela já apareceu misturada ao valor que veio do
 *    servidor (artefato observado uma vez no CI; uma tentativa posterior de
 *    reproduzir no ambiente hospedado foi inválida e foi descartada —
 *    inventário §5c). O bloqueio é um `<fieldset disabled>`
 *    que já vem no HTML do servidor e só é liberado depois que este
 *    componente monta no navegador: antes disso não há nada nosso rodando
 *    lá para proteger o campo. `display: contents` mantém o layout do
 *    formulário, e o fieldset desabilitado desabilita todos os controles
 *    dentro dele — inclusive o botão de enviar, que só funciona com o
 *    JavaScript carregado. Comprovado depois no preview: o HTML servido
 *    traz o fieldset desabilitado e o campo só é liberado quando os
 *    scripts chegam (inventário §7.4).
 */
const assinaturaVazia = () => () => {};

export function EditForm({
  action,
  children,
  ...props
}: Omit<ComponentProps<"form">, "action" | "onSubmit"> & { action: (formData: FormData) => void }) {
  // useSyncExternalStore com uma "assinatura" que nunca emite: o snapshot
  // do servidor é false e o do navegador é true, então o valor vira true na
  // primeira renderização já hidratada, sem efeito nem temporizador.
  const pronto = useSyncExternalStore(assinaturaVazia, () => true, () => false);

  return (
    <form
      {...props}
      aria-busy={!pronto}
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        startTransition(() => action(formData));
      }}
    >
      <fieldset disabled={!pronto} className="contents">
        {children}
      </fieldset>
    </form>
  );
}
