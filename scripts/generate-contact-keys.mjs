#!/usr/bin/env node
// Gera um par novo de chaves (cifra + HMAC) para CONTACTS_KEY_VERSIONS —
// ver docs/decisoes/a3-criptografia.md para o procedimento de rotação
// completo. Roda só localmente, no terminal de quem precisa das chaves:
// nada aqui é impresso ou lido por processo nenhum além deste script.
//
//   node scripts/generate-contact-keys.mjs [versao]
//
// Sem argumento, sugere "1". Copie a saída manualmente para as variáveis
// de ambiente do provedor (Vercel) — nunca cole a chave em nenhum chat,
// commit ou log.

import { randomBytes } from "node:crypto";

const version = process.argv[2] ?? "1";

const cipher = randomBytes(32).toString("base64");
const hmac = randomBytes(32).toString("base64");

console.log(`Par de chaves gerado para a versão "${version}".`);
console.log("");
console.log("1) Se CONTACTS_KEY_VERSIONS já existir, mescle esta entrada nele");
console.log("   (mantenha as versões anteriores — necessárias para ler dados antigos).");
console.log("2) Se for a primeira vez, use os dois valores abaixo como estão.");
console.log("");
console.log(`CONTACTS_ACTIVE_KEY_VERSION=${version}`);
console.log(
  `CONTACTS_KEY_VERSIONS={"${version}":{"cipher":"${cipher}","hmac":"${hmac}"}}`,
);
console.log("");
console.log(
  "Se esta chave for perdida, todo dado cifrado com ela fica permanentemente irrecuperável.",
);
