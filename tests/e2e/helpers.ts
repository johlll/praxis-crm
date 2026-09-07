import { expect, type Page } from "@playwright/test";

import { SEED_PASSWORD } from "./fixtures";

export async function login(page: Page, email: string): Promise<void> {
  await page.goto("/entrar");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(SEED_PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
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
