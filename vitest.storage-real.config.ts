import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Documentos por caso contra um Storage e um Postgres REAIS (não roda no `npm test`).
 *
 * Usa as server actions e o módulo administrativo de verdade; só a sessão do usuário é simulada (o banco
 * confere papel, escritório e alcance de novo). Precisa de um ambiente descartável compatível com o Supabase
 * — `supabase start` (API em 54321, banco em 54322) ou o storage-api oficial atrás de uma API compatível — com
 * a migration dos documentos aplicada, a seed e arquivos sintéticos. NUNCA aponte para um projeto hospedado: a
 * suíte abre o portão do recebimento no banco indicado e grava documentos de teste.
 *
 *   CASE_DOCS_REAL_SUPABASE_URL      API compatível com o Supabase (REST + Storage)
 *   CASE_DOCS_REAL_SECRET_KEY        chave de serviço desse ambiente
 *   CASE_DOCS_REAL_PUBLISHABLE_KEY   chave pública desse ambiente
 *   CASE_DOCS_REAL_STORAGE_URL       endereço direto do Storage (envio em andamento, sem intermediário)
 *   CASE_DOCS_REAL_DB_URL            Postgres desse ambiente (psql)
 *   CASE_DOCS_REAL_PSQL              opcional: caminho do psql
 *
 *   npx vitest run --config vitest.storage-real.config.ts
 */
const env = (name: string) => process.env[name] ?? "";

export default defineConfig({
  resolve: { alias: { "@": resolve(import.meta.dirname, "./src") } },
  test: {
    environment: "node",
    globals: false,
    include: ["tests/storage-real/**/*.real.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: env("CASE_DOCS_REAL_SUPABASE_URL"),
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: env("CASE_DOCS_REAL_PUBLISHABLE_KEY"),
      SUPABASE_SECRET_KEY: env("CASE_DOCS_REAL_SECRET_KEY"),
      CASE_DOCUMENTS_UPLOAD_ENABLED: "true",
    },
  },
});
