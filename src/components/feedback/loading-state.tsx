import { cn } from "@/lib/cn";

/** Bloco cinza pulsante, para compor esqueletos de carregamento. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("animate-pulse rounded-input bg-border-subtle", className)}
      aria-hidden
    />
  );
}

type LoadingStateProps = {
  /** Quantas linhas de esqueleto exibir. */
  rows?: number;
  label?: string;
};

export function LoadingState({
  rows = 5,
  label = "Carregando…",
}: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4"
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-8 w-full" />
      ))}
    </div>
  );
}
