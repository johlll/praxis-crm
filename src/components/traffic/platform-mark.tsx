import { cn } from "@/lib/cn";
import type { Platform } from "@/modules/traffic/schema";

/** Cor de cada plataforma, a MESMA no filtro, na distribuição e na tabela. O nome sempre acompanha a cor. */
export const PLATFORM_COLOR: Record<Platform, string> = {
  meta: "var(--color-chart1)",
  google: "var(--color-info)",
};

export function PlatformMark({ platform, className }: { platform: Platform; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2.5 shrink-0 rounded-[3px]", className)}
      style={{ background: PLATFORM_COLOR[platform] }}
    />
  );
}
