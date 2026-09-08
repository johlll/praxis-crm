"use client";

import { useTransition } from "react";
import { LogOut } from "lucide-react";

import { signOutAction } from "@/modules/auth/actions";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";

/**
 * Um <form action={signOutAction}> dentro de DropdownMenuItem (asChild)
 * falhava silenciosamente: o Radix fecha o menu — desmontando o form — ao
 * selecionar o item, correndo contra a submissão nativa do form e
 * cancelando-a antes de completar. Chamar a Server Action direto por
 * onSelect (mesmo padrão já usado na troca de workspace) evita a corrida.
 */
export function SignOutItem() {
  const [isPending, startTransition] = useTransition();

  return (
    <DropdownMenuItem
      variant="danger"
      disabled={isPending}
      onSelect={() => startTransition(() => void signOutAction())}
    >
      <LogOut size={14} aria-hidden />
      Sair
    </DropdownMenuItem>
  );
}
