import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts"],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    /**
     * Barreira do cliente administrativo (checklist §14): o cliente com
     * service_role só poderá ser importado por webhooks e jobs. A regra já
     * nasce aqui para que o caminho nunca exista sem ela — os arquivos
     * alvo entram em A2.
     */
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/app/api/webhooks/**",
      "src/app/api/cron/**",
      // A11: a captação pública e o worker do Inngest são a MESMA
      // categoria de webhooks e jobs — entrada sem sessão de usuário,
      // atrás de Turnstile/rate limit, que precisa falar com o banco.
      "src/app/api/forms/**",
      "src/app/api/inngest/**",
      "src/server/supabase/admin.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/server/supabase/admin", "@/server/supabase/admin"],
              message:
                "O cliente service_role da A11 (getIngestConfig) exige Turnstile/Upstash/Inngest junto — não serve para outra feature. Importe-o só em webhooks e jobs (src/app/api/webhooks/**, src/app/api/cron/**, src/app/api/forms/**, src/app/api/inngest/**). Para outro caminho autorizado por sessão que precise de service_role, crie um cliente próprio e isolado (ver src/server/proposals/admin/supabase.ts, motivo documentado no arquivo) — nunca reaproveite este.",
            },
          ],
        },
      ],
    },
  },
  {
    /**
     * B1: `src/server/proposals/admin/supabase.ts` é o ÚNICO arquivo
     * autorizado a construir um cliente `service_role` cru
     * (`createClient` direto) fora dos webhooks/jobs — mutação autorizada
     * por sessão de usuário, mas que precisa gravar em Storage e
     * registrar resultado de forma não forjável por RPC
     * (proposal_documents/proposal_email_sends têm GRANT só para
     * service_role, de propósito — ver as migrations b1_*). Nenhum outro
     * arquivo de src/server/proposals/** importa isto — cada um continua
     * checando permissão pela sessão do usuário como o resto da base.
     */
    files: ["src/server/proposals/admin/**/*.{ts,tsx}"],
    ignores: ["src/server/proposals/admin/supabase.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@supabase/supabase-js"],
              importNames: ["createClient"],
              message:
                "Não construa outro cliente service_role aqui — importe createProposalsAdminSupabaseClient de ./supabase.",
            },
          ],
        },
      ],
    },
  },
);
