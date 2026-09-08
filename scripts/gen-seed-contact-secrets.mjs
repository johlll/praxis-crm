#!/usr/bin/env node
// Gera os literais SQL (bytea em hex) de CPF/CNPJ cifrado para
// supabase/seed.sql — usa a MESMA chave de teste fixa que
// .github/workflows/ci.yml declara em CONTACTS_KEY_VERSIONS, e o MESMO
// formato de cifra de src/server/crypto/contact-sensitive.ts (iv || authTag
// || ciphertext, AES-256-GCM), para que a aplicação consiga decifrar o que
// o seed grava. Roda só quando o seed de contatos precisar mudar — não faz
// parte do CI nem de nenhum fluxo automático.
//
//   node scripts/gen-seed-contact-secrets.mjs
//
// Chave de teste, documentada como tal em docs/decisoes/a3-criptografia.md
// — nunca usada em nenhum ambiente real.

import { createCipheriv, createHmac, randomBytes } from "node:crypto";

const TEST_CIPHER_KEY = Buffer.from("EJn8xOi/LndtKMmLXhYJcdpHsV6uOlYLeyxVMDH+Gpo=", "base64");
const TEST_HMAC_KEY = Buffer.from("DpvUCkbNyVHMdcdTwxa865Ho2zlg4tccndsxuVAhv2U=", "base64");
const KEY_VERSION = "1";

function encrypt(workspaceId, cpfRaw) {
  const normalized = cpfRaw.replace(/\D/g, "");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", TEST_CIPHER_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(normalized, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([iv, authTag, encrypted]);
  const blindIndex = createHmac("sha256", TEST_HMAC_KEY)
    .update(`${workspaceId}:${normalized}`)
    .digest();
  return {
    ciphertextHex: `\\x${ciphertext.toString("hex")}`,
    blindIndexHex: `\\x${blindIndex.toString("hex")}`,
  };
}

// contatos fictícios do seed — CPFs inventados (algoritmo de dígito
// verificador não importa aqui, nunca é validado como documento real).
const rows = [
  { workspace: "10000000-0000-0000-0000-000000000001", contactLabel: "carla_ferreira", cpf: "111.111.111-11" },
  { workspace: "10000000-0000-0000-0000-000000000001", contactLabel: "carla_ferreira_duplicata", cpf: "111.111.111-11" },
  { workspace: "10000000-0000-0000-0000-000000000002", contactLabel: "mesmo_cpf_outro_workspace", cpf: "111.111.111-11" },
];

for (const row of rows) {
  const { ciphertextHex, blindIndexHex } = encrypt(row.workspace, row.cpf);
  console.log(`-- ${row.contactLabel} (workspace ${row.workspace}, CPF fictício ${row.cpf})`);
  console.log(`--   key_version: ${KEY_VERSION}`);
  console.log(`--   ciphertext:  '${ciphertextHex}'`);
  console.log(`--   blind_index: '${blindIndexHex}'`);
  console.log("");
}
