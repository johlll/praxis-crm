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

  // A action é assíncrona (useActionState) — dá tempo real de sobra
  // (auto-retry do expect) antes de decidir que travou. Só se travar de
  // verdade é que vale a pena olhar se apareceu uma Alert de erro; checar
  // page.url() de forma síncrona logo após o clique (como a primeira
  // versão deste helper fazia) sempre pega a URL antiga, antes do
  // redirect acontecer — não é sinal de falha nenhuma.
  try {
    await expect(page).not.toHaveURL(/\/entrar/, { timeout: 8000 });
  } catch (error) {
    const alertText = await page
      .getByRole("alert")
      .first()
      .textContent({ timeout: 1000 })
      .catch(() => null);
    throw new Error(
      `login para ${email} não saiu de /entrar — alerta na tela: ${alertText ?? "(nenhum)"}\n${String(error)}`,
    );
  }
}

export async function logout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Menu do usuário" }).click();
  // "menuitem", não "button": é um item de menu do Radix (mesmo papel
  // ARIA dos itens de "Trocar de workspace"), não um <button> solto.
  await page.getByRole("menuitem", { name: "Sair" }).click();
  await expect(page).toHaveURL(/\/entrar/);
}

export async function switchWorkspace(page: Page, workspaceName: string): Promise<void> {
  await page.getByRole("button", { name: "Trocar de workspace" }).click();
  // Nome direto (substring), não RegExp: nomes de workspace têm
  // parênteses literais (ex.: "Escritório Um (seed)") — um RegExp
  // construído a partir da string trataria "(seed)" como grupo de
  // captura, não texto literal, e nunca bateria com o nome real.
  await page.getByRole("menuitem", { name: workspaceName }).click();

  // switchWorkspaceAction() troca o cookie e faz redirect("/visao-geral")
  // — sem esperar essa navegação terminar, uma chamada seguinte (ex.:
  // page.goto de uma tela que lê o workspace ativo) pode correr na
  // frente do cookie novo ainda não confirmado, lendo o workspace
  // ANTERIOR (achado testando a A4: dependia de listagem escopada ao
  // workspace ativo, que os testes anteriores nunca precisaram fazer
  // logo após trocar). Espera pela URL E pelo texto do seletor de
  // workspace na sidebar refletir o nome novo — o sinal observável que
  // realmente importa, não um proxy indireto (a URL sozinha já se provou
  // insuficiente).
  await expect(page).toHaveURL(/\/visao-geral/, { timeout: 8000 });
  await expect(page.getByRole("button", { name: "Trocar de workspace" })).toContainText(
    workspaceName,
    { timeout: 8000 },
  );
}
