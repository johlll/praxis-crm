import { describe, expect, it } from "vitest";

import { contrastRatio, WCAG_AA_NORMAL_TEXT } from "@/lib/contrast";
import {
  color,
  decorativeColorTokens,
  textColorTokens,
} from "@/design/tokens";

/**
 * Fundos claros reais do produto (§11 do plano): superfície de cartão, fundo
 * do app e canvas por trás de tudo. Todo token declarado como texto precisa
 * atingir 4.5:1 (WCAG 2.1 AA, critério 1.4.3) contra os três — o pior caso
 * decide, e nem sempre é o mesmo fundo para cores diferentes.
 */
const lightBackgrounds = {
  surface: color.surface,
  app: color.app,
  canvas: color.canvas,
} as const;

describe("contraste de texto (WCAG 2.1 AA)", () => {
  it.each(textColorTokens)("%s atinge 4.5:1 contra os três fundos", (token) => {
    const hex = color[token];

    for (const [bgName, bgHex] of Object.entries(lightBackgrounds)) {
      const ratio = contrastRatio(hex, bgHex);
      expect(
        ratio,
        `${token} (${hex}) contra ${bgName} (${bgHex}) = ${ratio.toFixed(2)}:1, abaixo de ${WCAG_AA_NORMAL_TEXT}:1`,
      ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    }
  });

  it("nenhum token decorativo aparece na lista de texto", () => {
    for (const token of decorativeColorTokens) {
      expect(textColorTokens).not.toContain(token);
    }
  });

  it("documenta os tokens deliberadamente abaixo de AA", () => {
    // Nenhuma expectativa de contraste aqui — o ponto deste teste é só
    // deixar rastreável, em texto, o que está isento e por quê, para que
    // uma futura mudança de uso (de decorativo para texto real) precise
    // tocar este arquivo.
    expect(decorativeColorTokens).toEqual(["textDisabled"]);
  });
});
