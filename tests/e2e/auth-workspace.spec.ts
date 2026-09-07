import { expect, test } from "@playwright/test";

import { SEED_PASSWORD, SEED_USERS } from "./fixtures";
import { login, logout, switchWorkspace } from "./helpers";

/**
 * Jornada completa da A2, contra o Supabase local do CI (nunca o projeto
 * hospedado nem produção): login → criação/seleção de workspace → convite
 * → aceite pelo segundo usuário → troca de workspace → tentativa de
 * acesso não autorizado → logout. `test.describe.serial` porque o convite
 * criado no passo 3 é reaproveitado pelo passo 4.
 */
test.describe.serial("autenticação e workspace", () => {
  let inviteLink = "";

  test("1. login com credenciais corretas entra no workspace", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);
    await expect(page.getByText(SEED_USERS.ana.workspaceName)).toBeVisible();
    await expect(page.getByRole("button", { name: "Menu do usuário" })).toContainText(
      SEED_USERS.ana.fullName,
    );
  });

  test("1b. login com senha errada mostra erro e não entra", async ({ page }) => {
    await page.goto("/entrar");
    await page.getByLabel("E-mail").fill(SEED_USERS.ana.email);
    await page.getByLabel("Senha").fill("senha-errada-de-proposito");
    await page.locator("form").getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(page.getByText("E-mail ou senha incorretos.")).toBeVisible();
    await expect(page).toHaveURL(/\/entrar/);
  });

  test("2. usuário sem membership é levado ao onboarding e cria workspace", async ({ page }) => {
    await login(page, SEED_USERS.daniel.email);
    await expect(page).toHaveURL(/\/onboarding/);

    const nome = `Escritório do Daniel ${Date.now()}`;
    await page.getByLabel("Nome do escritório").fill(nome);
    await page.getByRole("button", { name: "Criar workspace" }).click();

    await expect(page).toHaveURL(/\/visao-geral/);
    await expect(page.getByText(nome)).toBeVisible();
  });

  test("3. owner cria convite para o e-mail de outro usuário seed", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);
    await page.goto("/configuracoes/equipe");

    await page.getByRole("button", { name: "Convidar" }).click();
    await page.getByLabel("E-mail").fill(SEED_USERS.bruno.email);
    await page.getByRole("button", { name: "Criar convite" }).click();

    const linkInput = page.getByLabel("Link do convite");
    await expect(linkInput).toBeVisible();
    inviteLink = await linkInput.inputValue();
    expect(inviteLink).toContain("/convite/");

    await page.getByRole("button", { name: "Concluir" }).click();
    await expect(page.getByText(SEED_USERS.bruno.email)).toBeVisible();
  });

  test("4. segundo usuário aceita o convite e passa a ver os dois workspaces", async ({
    page,
  }) => {
    expect(inviteLink, "convite criado no passo 3").not.toBe("");

    // Sem sessão: a prévia do convite tem que aparecer mesmo assim (RPC
    // callável por anon), com um link para entrar.
    await page.goto(inviteLink);
    await expect(page.getByText(SEED_USERS.ana.workspaceName)).toBeVisible();
    await page.getByRole("link", { name: "Entrar para aceitar" }).click();

    await page.getByLabel("Senha").fill(SEED_PASSWORD);
    await page.locator("form").getByRole("button", { name: "Entrar", exact: true }).click();

    await expect(page).toHaveURL(/\/convite\//);
    await page.getByRole("button", { name: "Aceitar convite" }).click();
    await expect(page).toHaveURL(/\/visao-geral/);

    await page.getByRole("button", { name: "Trocar de workspace" }).click();
    await expect(page.getByRole("menuitem", { name: SEED_USERS.ana.workspaceName })).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: SEED_USERS.bruno.workspaceName }),
    ).toBeVisible();
  });

  test("5. troca de workspace muda o workspace ativo de verdade", async ({ page }) => {
    await login(page, SEED_USERS.bruno.email);
    await expect(page.getByText(SEED_USERS.bruno.workspaceName)).toBeVisible();

    await switchWorkspace(page, SEED_USERS.ana.workspaceName);

    await expect(page.getByText(SEED_USERS.ana.workspaceName)).toBeVisible();
  });

  test("6. cookie de workspace adulterado não concede acesso a outro workspace", async ({
    page,
    context,
  }) => {
    // Carla é membro só do Escritório Um pelo seed original — ainda que o
    // teste 4 tenha dado a Bruno acesso a ele também, Carla nunca ganhou
    // acesso ao workspace criado no teste 2 nem a nenhum outro alheio.
    await login(page, SEED_USERS.carla.email);
    await expect(page).toHaveURL(/\/visao-geral/);

    // Forja um cookie de workspace ativo com uma assinatura que não bate
    // com HMAC nenhum válido — simula adulteração no navegador.
    await context.addCookies([
      {
        name: "praxis_active_workspace",
        value: "00000000-0000-0000-0000-000000000099.assinatura-forjada-invalida",
        domain: "localhost",
        path: "/",
      },
    ]);

    await page.goto("/visao-geral");

    // Assinatura inválida → getActiveWorkspaceId() devolve null → sem
    // workspace ativo válido → onboarding, nunca o workspace forjado.
    await expect(page).toHaveURL(/\/onboarding/);
  });

  test("7. logout limpa a sessão e o workspace ativo", async ({ page, context }) => {
    await login(page, SEED_USERS.ana.email);
    await logout(page);

    const cookies = await context.cookies();
    const workspaceCookie = cookies.find((c) => c.name === "praxis_active_workspace");
    expect(workspaceCookie).toBeUndefined();

    await page.goto("/visao-geral");
    await expect(page).toHaveURL(/\/entrar/);
  });
});
