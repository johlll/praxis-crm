import { defineConfig, devices } from "@playwright/test";

/**
 * e2e da A2: login, criação/seleção de workspace, convite, aceite pelo
 * segundo usuário, troca de workspace, tentativa de acesso não autorizado,
 * logout. Roda contra o Supabase LOCAL que o CI já subiu via Docker
 * (`supabase start` + `supabase db reset --local`) — nunca contra o
 * projeto hospedado `praxis-crm-dev` nem produção. As credenciais chegam
 * por variável de ambiente (ver .github/workflows/ci.yml); localmente,
 * exigem `supabase start` rodando e `.env.local` preenchido.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : "list",
  use: {
    baseURL: "http://localhost:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run start -- -p 3100",
    url: "http://localhost:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
