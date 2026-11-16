import { describe, expect, it } from "vitest";

import { cn } from "@/lib/cn";

/**
 * Achado no refinamento visual: sem conhecer a escala tipográfica do
 * projeto, o tailwind-merge lia `text-small` como cor e descartava a cor de
 * verdade — o botão primário pequeno com link ("Novo contato") ficava com o
 * texto da cor do link sobre o próprio fundo verde.
 */
describe("cn — escala tipográfica do projeto", () => {
  it("tamanho de fonte do projeto não apaga a cor do texto", () => {
    expect(cn("text-body text-on-solid", "text-small")).toBe("text-on-solid text-small");
    expect(cn("text-meta text-text-secondary")).toBe("text-meta text-text-secondary");
  });

  it("continua resolvendo conflitos reais (tamanho com tamanho, cor com cor)", () => {
    expect(cn("text-small", "text-body")).toBe("text-body");
    expect(cn("text-text", "text-danger")).toBe("text-danger");
  });
});
