import type { Metadata } from "next";

import { QaFormularioA11Client } from "./client";

/**
 * Página de QA para exercitar o formulário público da A11 (Turnstile,
 * CORS, rate limit, idempotência) contra um deployment real, sem tocar
 * na landing da Vizentini. Existe só neste branch de preview — nunca
 * deve ser levada para produção.
 */
export const metadata: Metadata = {
  title: "QA — formulário A11",
  robots: { index: false, follow: false },
};

export default function QaFormularioA11Page() {
  return <QaFormularioA11Client />;
}
