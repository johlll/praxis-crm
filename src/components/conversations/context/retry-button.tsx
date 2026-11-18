"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

/**
 * "Tentar novamente" do painel de contexto: busca os dados de novo no servidor.
 * Não pode ser um link para a própria URL — o Next não refaz a leitura quando o
 * destino é o endereço em que a pessoa já está.
 */
export function ContextRetryButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      onClick={() => start(() => router.refresh())}
      disabled={pending}
      className="w-fit text-small font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring disabled:opacity-60"
    >
      {pending ? "Tentando…" : "Tentar novamente"}
    </button>
  );
}
