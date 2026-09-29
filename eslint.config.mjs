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
      // B1: primeira exceção que NÃO é webhook/job sem sessão — é uma
      // mutação autorizada por sessão de usuário, mas que precisa gravar
      // em Storage e registrar resultado de forma não forjável por RPC
      // (proposal_documents/proposal_email_sends têm GRANT só para
      // service_role, de propósito — ver as migrations b1_*). Por isso a
      // pasta fica isolada e estreita, nunca o restante de
      // src/server/proposals/**: tudo que não precisa do service_role
      // continua fora desta exceção, checando permissão pela sessão do
      // usuário como o resto da base.
      "src/server/proposals/admin/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/server/supabase/admin", "@/server/supabase/admin"],
              message:
                "O cliente service_role ignora a RLS. Importe-o apenas em webhooks e jobs (src/app/api/webhooks/**, src/app/api/cron/**, src/app/api/forms/**, src/app/api/inngest/**) ou em src/server/proposals/admin/** (B1, motivo documentado no arquivo).",
            },
          ],
        },
      ],
    },
  },
);
