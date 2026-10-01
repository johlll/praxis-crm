/**
 * Regera src/server/proposals/assets-embutidos.ts a partir dos binários
 * em src/server/proposals/assets/.
 *
 * Por que embutido em base64 e não lido do disco: o PDF é gerado dentro
 * de uma Server Action, que na Vercel roda como função serverless. Um
 * `readFileSync` com caminho montado em tempo de execução não é
 * rastreado pelo bundler, e o arquivo simplesmente não vai junto — a
 * fonte sumiria em produção e o documento sairia com outra tipografia,
 * em silêncio. Embutido, não existe esse modo de falha.
 *
 * Uso: node scripts/gerar-assets-proposta.mjs
 */
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const pastaAssets = join(raiz, "src", "server", "proposals", "assets");
const destino = join(raiz, "src", "server", "proposals", "assets-embutidos.ts");

// Fontes viram data URL (o carregador do react-pdf espera string);
// a imagem vai como Buffer, que é o que o <Image> aceita direto.
const fontes = [
  ["MANROPE_400", "manrope-400.ttf"],
  ["MANROPE_600", "manrope-600.ttf"],
];
const imagens = [["LOGO_VIZENTINI", "logo-vizentini.png"]];

const partes = [
  "// GERADO — não editar à mão. Fonte: manrope-400.ttf / manrope-600.ttf",
  "// (Manrope, SIL Open Font License 1.1) e logo-vizentini.png.",
  "// Regerar: node scripts/gerar-assets-proposta.mjs",
  "",
];

for (const [nome, arquivo] of fontes) {
  const b64 = readFileSync(join(pastaAssets, arquivo)).toString("base64");
  partes.push(`export const ${nome} =\n  "data:font/truetype;base64,${b64}";\n`);
}

for (const [nome, arquivo] of imagens) {
  const b64 = readFileSync(join(pastaAssets, arquivo)).toString("base64");
  partes.push(`export const ${nome} = Buffer.from(\n  "${b64}",\n  "base64",\n);\n`);
}

writeFileSync(destino, partes.join("\n"));
console.log(`gerado ${destino} (${(statSync(destino).size / 1024).toFixed(0)}KB)`);
