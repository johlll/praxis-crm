import { initialsOf } from "@/lib/initials";
import { cn } from "@/lib/cn";

/**
 * Iniciais (só das palavras com letras: "Escritório (seed)" não vira "E(")
 * no lugar de foto (não há foto no cadastro). Decorativo: o nome
 * sempre aparece em texto ao lado, então o círculo fica fora da leitura.
 * - contact: contato do escritório (tom neutro).
 * - member: pessoa da equipe, como o responsável (tom da marca, igual à
 *   tabela de equipe da Visão geral).
 */
export function PersonInitials({
  name,
  tone = "contact",
  size = "md",
  className,
}: {
  name: string;
  tone?: "contact" | "member";
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-bold tracking-[0.3px] select-none",
        size === "md" ? "size-8 text-[11px]" : "size-6 text-[10px]",
        tone === "member"
          ? "bg-primary-tint text-primary"
          : "border border-border-strong bg-surface-hover text-text-secondary",
        className,
      )}
    >
      {initialsOf(name.replace(/[^\p{L}\s]/gu, " ").trim() || name)}
    </span>
  );
}

/** Marcador de "sem responsável": tracejado, como na tabela de equipe. */
export function NoOwnerMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-border-unassigned text-[10px] text-text-tertiary",
        className,
      )}
    >
      —
    </span>
  );
}
