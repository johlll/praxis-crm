"use client";

import { useEffect } from "react";

import { ErrorState } from "@/components/feedback/error-state";

export default function CamposPersonalizadosError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return <main className="flex-1 p-5"><div className="mx-auto max-w-[720px]"><ErrorState title="Não foi possível carregar os campos personalizados" description="Tente novamente em instantes." onRetry={retry} /></div></main>;
}
