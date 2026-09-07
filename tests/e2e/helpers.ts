import { expect, type Page } from "@playwright/test";

import { SEED_PASSWORD } from "./fixtures";

export async function login(page: Page, email: string): Promise<void> {
  await page.goto("/entrar");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(SEED_PASSWORD);
  // Scoped ao <form>: a aba "Entrar" (troca de modo) e o botão de submit
  // têm o mesmo texto exato, então um getByRole solto na página inteira é
  // ambíguo — só o formulário tem exatamente um botão "Entrar".
  await page.locator("form").getByRole("button", { name: "Entrar", exact: true }).click();

  // Se ficou em /entrar, o motivo quase sempre é a Alert de erro da própria
  // action — inclui o texto dela na falha em vez de só "esperava sair de
  // /entrar", que não diz o porquê.
  if (/\/entrar/.test(page.url())) {
    const alertText = await page
      .getByRole("alert")
      .first()
      .textContent({ timeout: 2000 })
      .catch(() => null);
    expect(
      page.url(),
      `login para ${email} não saiu de /entrar — alerta na tela: ${alertText ?? "(nenhum)"}`,
    ).not.toMatch(/\/entrar/);
  }

  await expect(page).not.toHaveURL(/\/entrar/);
}

export async function logout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Menu do usuário" }).click();
  await page.getByRole("button", { name: "Sair" }).click();
  await expect(page).toHaveURL(/\/entrar/);
}

export async function switchWorkspace(page: Page, workspaceName: string): Promise<void> {
  await page.getByRole("button", { name: "Trocar de workspace" }).click();
  await page.getByRole("menuitem", { name: new RegExp(workspaceName) }).click();
}
