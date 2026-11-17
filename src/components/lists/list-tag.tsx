import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export type ListTagTone = "neutral" | "success" | "warning" | "danger";

const TONE: Record<ListTagTone, { box: string; dot: string }> = {
  neutral: { box: "border-border-strong bg-neutral-bg text-text-secondary", dot: "bg-text-tertiary" },
  success: { box: "border-success/30 bg-success-bg text-success", dot: "bg-success" },
  warning: { box: "border-warning/30 bg-warning-bg text-warning", dot: "bg-warning" },
  danger: { box: "border-danger/30 bg-danger-bg text-danger", dot: "bg-danger" },
};

/**
 * Etiqueta discreta das listagens: contorno fino, fundo tingido e o texto
 * sempre presente — a cor reforça, nunca é a única pista.
 */
export function ListTag({
  tone = "neutral",
  dot = false,
  title,
  children,
}: {
  tone?: ListTagTone;
  dot?: boolean;
  title?: string;
  children: ReactNode;
}) {
  const t = TONE[tone];
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-[22px] max-w-full items-center gap-1.5 rounded-pill border px-2 text-[11.5px] leading-none font-semibold whitespace-nowrap",
        t.box,
      )}
    >
      {dot ? <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", t.dot)} /> : null}
      {children}
    </span>
  );
}
