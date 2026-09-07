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
                "O cliente service_role ignora a RLS. Importe-o apenas em webhooks e jobs (src/app/api/webhooks/**, src/app/api/cron/**).",
            },
          ],
        },
      ],
    },
  },
);
