import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    // getEnv() (src/server/env.ts) valida o schema inteiro de uma vez — os
    // testes que exercitam src/server/crypto/contact-sensitive.ts direto
    // precisam de todo o resto do schema presente também, não só das
    // variáveis novas da A3. Nenhum valor aqui é segredo de verdade — nem
    // o de antes (WORKSPACE_ACTIVE_COOKIE_SECRET), nem os novos. Roda
    // antes do Supabase local existir no CI (unit tests não dependem
    // dele), por isso não vem de .env.local.
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "https://teste-unitario.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "teste-unitario-nao-e-chave-real",
      WORKSPACE_ACTIVE_COOKIE_SECRET: "dGVzdGUtdW5pdC1uYW8tZS1zZWdyZWRvLXJlYWwtMzJieXRlcw==",
      CONTACTS_ACTIVE_KEY_VERSION: "1",
      CONTACTS_KEY_VERSIONS:
        '{"1":{"cipher":"EJn8xOi/LndtKMmLXhYJcdpHsV6uOlYLeyxVMDH+Gpo=","hmac":"DpvUCkbNyVHMdcdTwxa865Ho2zlg4tccndsxuVAhv2U="}}',
    },
  },
});
