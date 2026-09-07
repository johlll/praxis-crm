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
  // 0 mesmo no CI: os testes são "describe.serial" com efeito colateral
  // real no banco (convite criado, workspace criado) e sem reset entre
  // tentativas — uma retentativa reexecuta o teste sobre estado que a
  // primeira tentativa já alterou (ex.: workspace já existente), mascarando
  // a causa real da falha atrás de um sintoma diferente na retentativa.
  retries: 0,
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
