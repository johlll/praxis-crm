import { describe, expect, it } from "vitest";

import { contrastRatio, WCAG_AA_NORMAL_TEXT } from "@/lib/contrast";
import {
  color,
  decorativeColorTokens,
  solidBackgroundTokens,
  textColorTokens,
} from "@/design/tokens";

/**
 * Fundos reais do produto (tema escuro aprovado em 15/11/2026): fundo
 * principal, preenchimento rebaixado, superfície de cartão e o hover das
 * superfícies. Todo token declarado como texto precisa atingir 4.5:1 (WCAG
 * 2.1 AA, critério 1.4.3) contra os quatro — o pior caso decide, e nem
 * sempre é o mesmo fundo para cores diferentes.
 */
const backgrounds = {
  canvas: color.canvas,
  app: color.app,
  surface: color.surface,
  surfaceHover: color.surfaceHover,
} as const;

describe("contraste de texto (WCAG 2.1 AA)", () => {
  it.each(textColorTokens)("%s atinge 4.5:1 contra os quatro fundos", (token) => {
    const hex = color[token];

    for (const [bgName, bgHex] of Object.entries(backgrounds)) {
      const ratio = contrastRatio(hex, bgHex);
      expect(
        ratio,
        `${token} (${hex}) contra ${bgName} (${bgHex}) = ${ratio.toFixed(2)}:1, abaixo de ${WCAG_AA_NORMAL_TEXT}:1`,
      ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    }
  });

  it.each(solidBackgroundTokens)("onSolid atinge 4.5:1 sobre %s (botões e badges sólidos)", (token) => {
    const ratio = contrastRatio(color.onSolid, color[token]);
    expect(
      ratio,
      `onSolid (${color.onSolid}) sobre ${token} (${color[token]}) = ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });

  it("textos da barra lateral atingem 4.5:1 contra a barra, o hover e o item ativo", () => {
    for (const fg of [color.sidebarText, color.sidebarTextStrong, color.sidebarMuted, color.sidebarActiveText]) {
      for (const bg of [color.sidebar, color.sidebarHover, color.sidebarActive]) {
        expect(contrastRatio(fg, bg), `${fg} sobre ${bg}`).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
      }
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
