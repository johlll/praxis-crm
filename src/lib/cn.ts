import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

import { fontSize } from "@/design/tokens";

/**
 * O tailwind-merge precisa conhecer a escala tipográfica própria do projeto
 * (text-label, text-meta, text-small, text-body…). Sem isso ele lê
 * `text-small` como COR e descarta a cor de verdade que veio antes
 * (ex.: "text-on-solid text-small" virava só "text-small"), deixando texto
 * da cor do link sobre o fundo do botão.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: Object.keys(fontSize),
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
