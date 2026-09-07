import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  breakpoint,
  color,
  density,
  font,
  fontSize,
  layout,
  radius,
  shadow,
} from "@/design/tokens";

const cssRaw = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

/**
 * Extrai as declarações `--nome: valor;` de dentro do bloco `@theme { ... }`
 * de globals.css, como um mapa nome -> valor. Comentários são removidos
 * antes, para não interferirem na captura.
 *
 * Isto substitui a checagem anterior (`css.includes(valor)`), que só
 * confirmava que o texto do valor aparecia em algum lugar do arquivo — não
 * que a variável certa tivesse o valor certo. Duas cores trocadas entre si,
 * ou uma variável renomeada cujo valor antigo sobrevivesse em outro lugar do
 * arquivo, passariam por aquele teste sem serem notadas.
 */
function parseThemeVariables(css: string): Map<string, string> {
  const themeBlock = css.match(/@theme\s*\{([\s\S]*?)\n\}/);
  const corpo = themeBlock?.[1];
  if (!corpo) {
    throw new Error("Bloco @theme não encontrado em globals.css");
  }

  const semComentarios = corpo.replace(/\/\*[\s\S]*?\*\//g, "");
  const variaveis = new Map<string, string>();
  const declaracao = /--([a-z0-9-]+)\s*:\s*([^;]+);/g;

  for (const match of semComentarios.matchAll(declaracao)) {
    const [, nome, valor] = match;
    if (nome && valor) {
      variaveis.set(nome, valor.trim());
    }
  }

  return variaveis;
}

/** camelCase -> kebab-case (ex.: sidebarActiveText -> sidebar-active-text). */
function toKebabCase(input: string): string {
  return input.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** Remove espaços e normaliza maiúsculas — para comparar sombras e cores
 * escritas com convenções de espaçamento diferentes (ex.: "rgba(23,32,30,.1)"
 * vs "rgba(23, 32, 30, .1)"), sem deixar de detectar valor divergente. */
function normalize(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

const cssVars = parseThemeVariables(cssRaw);

describe("tokens de design — cores", () => {
  it.each(Object.entries(color))(
    "--color-%s existe e vale o mesmo que color.%s",
    (key, expected) => {
      const varName = `color-${toKebabCase(key)}`;
      const actual = cssVars.get(varName);

      expect(actual, `variável --${varName} não encontrada em globals.css`).toBeDefined();
      expect(normalize(actual!)).toBe(normalize(expected));
    },
  );

  it("não sobrou nenhuma cor em globals.css sem correspondente em tokens.ts", () => {
    const declaradasNoCss = [...cssVars.keys()].filter((nome) =>
      nome.startsWith("color-"),
    );
    const esperadasDoTs = Object.keys(color).map((key) => `color-${toKebabCase(key)}`);

    expect(declaradasNoCss.sort()).toEqual(esperadasDoTs.sort());
  });
});

describe("tokens de design — tipografia", () => {
  it.each(Object.entries(fontSize))(
    "--text-%s existe e vale o mesmo que fontSize.%s",
    (key, expected) => {
      const varName = `text-${toKebabCase(key)}`;
      const actual = cssVars.get(varName);

      expect(actual, `variável --${varName} não encontrada`).toBeDefined();
      expect(actual).toBe(`${expected}px`);
    },
  );

  // As famílias de fonte usam valores DIFERENTES por design: tokens.ts guarda
  // a pilha literal (para contextos fora do Tailwind), globals.css referencia
  // a CSS variable injetada pelo next/font. O que precisa continuar igual
  // entre os dois é a lista de fallback depois da primeira fonte — é o que
  // detecta alguém trocando "Arial" por outra coisa em só um dos arquivos.
  it.each(Object.entries(font))(
    "--font-%s existe e mantém o mesmo fallback que font.%s",
    (key, expected) => {
      const varName = `font-${key}`;
      const actual = cssVars.get(varName);

      expect(actual, `variável --${varName} não encontrada`).toBeDefined();

      const fallbackEsperado = expected.split(",").slice(1).join(",");
      const fallbackAtual = actual!.split(",").slice(1).join(",");

      expect(normalize(fallbackAtual).replace(/["']/g, "")).toBe(
        normalize(fallbackEsperado).replace(/["']/g, ""),
      );
    },
  );
});

describe("tokens de design — raios e sombras", () => {
  it.each(Object.entries(radius))(
    "--radius-%s existe e vale o mesmo que radius.%s",
    (key, expected) => {
      const varName = `radius-${toKebabCase(key)}`;
      const actual = cssVars.get(varName);

      expect(actual, `variável --${varName} não encontrada`).toBeDefined();
      expect(actual).toBe(`${expected}px`);
    },
  );

  it.each(Object.entries(shadow))(
    "--shadow-%s existe e vale o mesmo que shadow.%s",
    (key, expected) => {
      const varName = `shadow-${toKebabCase(key)}`;
      const actual = cssVars.get(varName);

      expect(actual, `variável --${varName} não encontrada`).toBeDefined();
      expect(normalize(actual!)).toBe(normalize(expected));
    },
  );
});

describe("tokens de design — larguras estruturais", () => {
  // Só os quatro medidos diretamente no protótipo viram CSS var; o passo do
  // kanban (derivado: largura + espaçamento) e a largura máxima de conteúdo
  // são usados só em TypeScript. A lista abaixo é o registro explícito dessa
  // escolha — se alguém adicionar uma chave nova a `layout` sem decidir se
  // ela também é uma CSS var, este teste força a decisão a aparecer aqui.
  const comCssVar: Partial<Record<keyof typeof layout, string>> = {
    sidebarWidth: "spacing-sidebar",
    detailPanelWidth: "spacing-detail-panel",
    profilePanelWidth: "spacing-profile-panel",
    kanbanColumnWidth: "spacing-kanban-column",
  };
  const semCssVarDeclarado = ["kanbanColumnStep", "contentMaxWidth"] as const;

  it.each(Object.entries(comCssVar))("--%s existe e vale o mesmo que layout.%s", (key, varName) => {
    const expected = layout[key as keyof typeof layout];
    const actual = cssVars.get(varName as string);

    expect(actual, `variável --${varName} não encontrada`).toBeDefined();
    expect(actual).toBe(`${expected}px`);
  });

  it("toda chave de layout está classificada (tem CSS var ou está na lista de exceção)", () => {
    const todasAsChaves = Object.keys(layout).sort();
    const classificadas = [...Object.keys(comCssVar), ...semCssVarDeclarado].sort();

    expect(todasAsChaves).toEqual(classificadas);
  });

  it("mantém as larguras medidas na conferência visual contra o protótipo", () => {
    // Pin explícito dos valores em si (não só da consistência com o CSS) —
    // conferidos no DOM do Pipeline.dc.html a 1440×900 na fase A1.
    expect(layout.sidebarWidth).toBe(228);
    expect(layout.detailPanelWidth).toBe(372);
    expect(layout.kanbanColumnWidth).toBe(272);
    expect(layout.kanbanColumnStep).toBe(282);
  });
});

describe("tokens de design — densidade e breakpoints", () => {
  it.each(Object.entries(density))(
    "--density-%s existe e vale o mesmo que density.%s",
    (key, expected) => {
      const varName = `density-${toKebabCase(key)}`;
      const actual = cssVars.get(varName);

      expect(actual, `variável --${varName} não encontrada`).toBeDefined();
      expect(actual).toBe(`${expected}px`);
    },
  );

  it.each(Object.entries(breakpoint))(
    "--breakpoint-%s existe e vale o mesmo que breakpoint.%s",
    (key, expected) => {
      const varName = `breakpoint-${toKebabCase(key)}`;
      const actual = cssVars.get(varName);

      expect(actual, `variável --${varName} não encontrada`).toBeDefined();
      expect(actual).toBe(`${expected}px`);
    },
  );
});
