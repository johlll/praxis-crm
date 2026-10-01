import { inflateSync } from "node:zlib";

/**
 * Extração do texto realmente desenhado num PDF, independente da fonte
 * usada.
 *
 * Por que não dá para ler o hex do fluxo como latin1: com fonte padrão
 * (Helvetica/WinAnsiEncoding) os códigos no fluxo SÃO os caracteres, mas
 * com fonte embutida em subconjunto (o caso desde que o template passou
 * a usar a Manrope da marca) os códigos são índices de glifo, que não
 * têm relação nenhuma com Unicode. O que faz a ponte é o `/ToUnicode`
 * que o próprio PDF carrega — é ele que um leitor de PDF usa para
 * copiar texto, e é ele que usamos aqui.
 *
 * Mantido separado de pdf-validate.ts porque é a parte "ler PDF", que
 * nada tem a ver com as regras do que a B1 considera um documento
 * válido.
 */

export type ObjetoPdf = { numero: number; dicionario: string; fluxo: Buffer | null };

/** Objetos `N 0 obj ... endobj`, com o fluxo bruto quando houver. */
export function lerObjetos(pdf: Buffer): Map<number, ObjetoPdf> {
  const texto = pdf.toString("latin1");
  const objetos = new Map<number, ObjetoPdf>();
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(texto)) !== null) {
    const numero = Number(m[1]);
    const inicio = m.index + m[0].length;
    const fimObj = texto.indexOf("endobj", inicio);
    if (fimObj < 0) continue;

    const corpo = texto.slice(inicio, fimObj);
    const posStream = corpo.indexOf("stream");
    let dicionario = corpo;
    let fluxo: Buffer | null = null;

    if (posStream >= 0) {
      dicionario = corpo.slice(0, posStream);
      let ini = inicio + posStream + "stream".length;
      if (texto[ini] === "\r") ini++;
      if (texto[ini] === "\n") ini++;
      const fim = texto.indexOf("endstream", ini);
      if (fim > 0) fluxo = pdf.subarray(ini, fim);
    }

    objetos.set(numero, { numero, dicionario, fluxo });
  }
  return objetos;
}

function descomprimir(obj: ObjetoPdf): Buffer | null {
  if (!obj.fluxo) return null;
  if (!obj.dicionario.includes("/FlateDecode")) return obj.fluxo;
  const declarado = Number(/\/Length (\d+)/.exec(obj.dicionario)?.[1] ?? NaN);
  const bruto = Number.isFinite(declarado) ? obj.fluxo.subarray(0, declarado) : obj.fluxo;
  try {
    return inflateSync(bruto);
  } catch {
    return null;
  }
}

type Decodificador = { bytesPorCodigo: 1 | 2; mapa: Map<number, string> | null };

/**
 * Um destino pode trazer MAIS DE UM code point dentro do mesmo `<>`,
 * separados por espaço — é assim que uma ligadura é mapeada de volta
 * para as letras que a compõem (`<0066 0069>` = "fi"). Aceitar espaço
 * aqui não é tolerância cosmética: ignorar essas entradas desalinha
 * todas as posições seguintes de um `bfrange` em forma de array, e o
 * texto sai embaralhado a partir da primeira ligadura.
 */
const HEX_DESTINO = "([0-9A-Fa-f\\s]+)";

function lerCMap(cmap: string): Map<number, string> {
  const mapa = new Map<number, string>();
  const utf16 = (hexBruto: string) => {
    const hex = hexBruto.replace(/\s+/g, "");
    let s = "";
    for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return s;
  };

  for (const bloco of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    const re = new RegExp(`<([0-9A-Fa-f]+)>\\s*<${HEX_DESTINO}>`, "g");
    for (const par of (bloco[1] ?? "").matchAll(re)) {
      mapa.set(parseInt(par[1]!, 16), utf16(par[2]!));
    }
  }

  for (const bloco of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const corpo = bloco[1] ?? "";

    const reFaixa = new RegExp(`<([0-9A-Fa-f]+)>\\s*<([0-9A-Fa-f]+)>\\s*<${HEX_DESTINO}>`, "g");
    for (const faixa of corpo.matchAll(reFaixa)) {
      const lo = parseInt(faixa[1]!, 16);
      const hi = parseInt(faixa[2]!, 16);
      const base = parseInt(faixa[3]!.replace(/\s+/g, ""), 16);
      for (let c = lo; c <= hi && c - lo < 65536; c++) mapa.set(c, String.fromCharCode(base + (c - lo)));
    }

    const reArray = new RegExp(`<([0-9A-Fa-f]+)>\\s*<([0-9A-Fa-f]+)>\\s*\\[([\\s\\S]*?)\\]`, "g");
    for (const faixa of corpo.matchAll(reArray)) {
      const lo = parseInt(faixa[1]!, 16);
      const destinos = [...(faixa[3] ?? "").matchAll(new RegExp(`<${HEX_DESTINO}>`, "g"))];
      destinos.forEach((d, i) => mapa.set(lo + i, utf16(d[1]!)));
    }
  }

  return mapa;
}

/** `/F1 -> decodificador`, montado a partir dos recursos de fonte. */
function montarDecodificadores(objetos: Map<number, ObjetoPdf>): Map<string, Decodificador> {
  const porNome = new Map<string, Decodificador>();

  for (const obj of objetos.values()) {
    const blocoFontes = /\/Font\s*<<([\s\S]*?)>>/.exec(obj.dicionario);
    if (!blocoFontes) continue;

    for (const ref of (blocoFontes[1] ?? "").matchAll(/\/(\w+)\s+(\d+)\s+\d+\s+R/g)) {
      const nome = ref[1]!;
      const fonte = objetos.get(Number(ref[2]));
      if (!fonte) continue;

      const bytesPorCodigo: 1 | 2 = fonte.dicionario.includes("/Type0") ? 2 : 1;
      const refToUnicode = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(fonte.dicionario);
      let mapa: Map<number, string> | null = null;

      if (refToUnicode) {
        const alvo = objetos.get(Number(refToUnicode[1]));
        const conteudo = alvo ? descomprimir(alvo) : null;
        if (conteudo) mapa = lerCMap(conteudo.toString("latin1"));
      }

      porNome.set(nome, { bytesPorCodigo, mapa });
    }
  }

  return porNome;
}

function desescapar(literal: string): string {
  return literal.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_t, g: string) => {
    const simples: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
    return simples[g] ?? String.fromCharCode(parseInt(g, 8) & 0xff);
  });
}

function decodificarHex(hex: string, dec: Decodificador | undefined): string {
  const passo = (dec?.bytesPorCodigo ?? 1) * 2;
  let saida = "";
  for (let i = 0; i + passo <= hex.length; i += passo) {
    const codigo = parseInt(hex.slice(i, i + passo), 16);
    if (dec?.mapa) saida += dec.mapa.get(codigo) ?? "";
    else saida += String.fromCharCode(codigo & 0xff);
  }
  return saida;
}

/**
 * Texto desenhado pelos operadores Tj/TJ, na ordem do fluxo, já
 * convertido para Unicode quando o PDF traz `/ToUnicode`.
 */
export function extrairTextoDesenhado(pdf: Buffer): string {
  const objetos = lerObjetos(pdf);
  const decodificadores = montarDecodificadores(objetos);
  const partes: string[] = [];

  for (const obj of objetos.values()) {
    const conteudo = descomprimir(obj);
    if (!conteudo) continue;
    const s = conteudo.toString("latin1");
    if (!s.includes("BT") || !s.includes("Tf")) continue; // não é fluxo de página

    let atual: Decodificador | undefined;
    const re = /\/(\w+)\s+[\d.]+\s+Tf|\[([^\]]*)\]\s*TJ|<([0-9A-Fa-f]*)>\s*Tj|\(((?:[^()\\]|\\.)*)\)\s*Tj/g;
    let m: RegExpExecArray | null;

    while ((m = re.exec(s)) !== null) {
      if (m[1] !== undefined) {
        atual = decodificadores.get(m[1]);
        continue;
      }
      if (m[2] !== undefined) {
        for (const h of m[2].matchAll(/<([0-9A-Fa-f]*)>/g)) partes.push(decodificarHex(h[1] ?? "", atual));
        for (const l of m[2].matchAll(/\(((?:[^()\\]|\\.)*)\)/g)) partes.push(desescapar(l[1] ?? ""));
        continue;
      }
      if (m[3] !== undefined) partes.push(decodificarHex(m[3], atual));
      if (m[4] !== undefined) partes.push(desescapar(m[4]));
    }
  }

  return partes.join("");
}
