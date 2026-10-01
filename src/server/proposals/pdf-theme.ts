/**
 * Identidade visual da Vizentini Advocacia aplicada à proposta em PDF.
 *
 * Os valores vieram do código real do site
 * (`vizentini-advocacia/design-briefing-claude-design/README.md`, extraído
 * do `site/index.html`), não de aproximação visual — por isso o verde é
 * `#082B24` e não um verde "parecido".
 *
 * ATENÇÃO, dívida conhecida: a B1 atende um escritório só, e por isso a
 * marca está fixa aqui. Quando entrar o segundo workspace, logo e paleta
 * precisam virar dado do workspace (como já são razão social, CNPJ e
 * OAB) — este arquivo é o ponto único a trocar.
 */

export const CORES = {
  /** Verde-floresta da marca — títulos e o essencial. */
  verde: "#082B24",
  /** Bronze fosco — só fios, rótulos e detalhes. Nunca área cheia. */
  bronze: "#A47C56",
  /** Marfim quente do fundo da página. */
  marfim: "#FAF9F6",
  /** Marfim um pouco mais presente, para o bloco de honorários. */
  marfimBloco: "#F2EFE7",
  /** Grafite esverdeado do texto. */
  grafite: "#2A3330",
  corpo: "#3E4D48",
  meta: "#6F7773",
  fio: "#E4E0D5",
  /** Bronze bem diluído — só para o fio do rodapé, que precisa existir
   *  sem competir com o conteúdo nem sumir na impressão. */
  bronzeClaro: "#D9CDBE",
} as const;

export const FONTE = "Manrope";

/** A4 em pontos: 595,28 × 841,89. Margens laterais generosas para dar
 *  medida de leitura confortável ao texto do objeto. */
export const PAGINA = {
  margemLateral: 58,
  margemTopo: 46,
  /** Espaço reservado ao rodapé fixo, para texto nunca encostar nele. */
  margemRodape: 72,
  /** Largura útil = A4 (595,28pt) menos as duas margens. Usada explicitamente
   *  nos elementos do rodapé: num `Text` absoluto, `right` não resolve a
   *  largura (a paginação ia parar fora da página), e `width` resolve. */
  larguraUtil: 595.28 - 58 * 2,
} as const;
