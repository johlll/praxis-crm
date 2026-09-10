import { expect, test } from "@playwright/test";

import { SEED_CONTACTS, SEED_USERS } from "./fixtures";
import { login } from "./helpers";

/**
 * A5 (revisão pós-fechamento, item 2): interface mínima de configuração
 * de pipeline — etapas, requisitos e motivos de perda. As RPCs já eram
 * exaustivamente testadas pelo pgTAP desde a entrega original; este
 * arquivo cobre só o que só um e2e prova de verdade — a tela existe, o
 * fluxo real de UI funciona ponta a ponta, e quem não tem
 * `pipeline.configure` não vê nem acessa a tela (fase A5, não A6).
 */
test.describe.serial("configuração de pipeline — A5", () => {
  test("1. owner vê o link em Configurações e a tela lista as 8 etapas padrão", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);

    await page.goto("/configuracoes");
    await expect(page.getByRole("link", { name: "Pipelines" })).toBeVisible();

    await page.getByRole("link", { name: "Pipelines" }).click();
    await expect(page).toHaveURL("/configuracoes/pipelines");
    await expect(page.getByText("Fazer primeiro contato")).toBeVisible();
    await expect(page.getByText("Aguardar assinatura")).toBeVisible();
  });

  test("2. criar etapa e marcar como ganho — some do menu \"mover para\" do kanban", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);
    await page.goto("/configuracoes/pipelines");

    await page.getByRole("button", { name: "Nova etapa" }).click();
    await page.getByLabel("Nome").fill("Contrato assinado (teste e2e)");
    await page.getByRole("button", { name: "Criar etapa" }).click();
    await expect(page.getByText("Etapa criada")).toBeVisible();
    await page.getByRole("button", { name: "Concluir" }).click();
    await expect(page.getByText("Contrato assinado (teste e2e)")).toBeVisible();

    await page.getByRole("button", { name: "Editar etapa Contrato assinado (teste e2e)" }).click();
    await page.getByLabel("Etapa de ganho").check();
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Etapa atualizada")).toBeVisible();
    await page.getByRole("button", { name: "Concluir" }).click();
    await expect(page.getByText("Ganho").first()).toBeVisible();

    // Reflexo no Kanban: o "mover para" de qualquer card não pode oferecer
    // uma etapa terminal como destino — o servidor recusaria (stage_is_terminal).
    // Cria a própria oportunidade aqui (não depende de nenhum card deixado
    // por outro arquivo de teste, já que os arquivos e2e compartilham o
    // mesmo banco efêmero do CI sem reset entre eles).
    // Espera cada Server Action confirmar (URL do lead / link da
    // oportunidade) ANTES do próximo passo — mesmo achado já documentado
    // em outras partes da suíte: navegar sem esperar corta a Server
    // Action em voo, e o goto("/pipeline") seguinte chega cedo demais.
    await page.goto("/leads/novo");
    await page.getByLabel("Contato").selectOption({ label: SEED_CONTACTS.robertoSilvaFilho.name });
    await page.getByLabel("Área jurídica").fill("Verificação config e2e");
    await page.getByRole("button", { name: "Criar lead" }).click();
    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);

    await page.getByRole("button", { name: "Nova oportunidade" }).click();
    await page.getByRole("button", { name: "Criar oportunidade" }).click();
    await expect(page.getByRole("link", { name: /Fazer primeiro contato/ })).toBeVisible();

    await page.goto("/pipeline");
    // Seletor escopado ao card desta oportunidade — não .first() num
    // /Mover .* / solto, que colidiria com outros cards que arquivos
    // e2e diferentes deixam no mesmo workspace (banco sem reset entre
    // arquivos no CI; achado real ao rodar junto de pipeline.spec.ts).
    const moveSelect = page.getByLabel(`Mover ${SEED_CONTACTS.robertoSilvaFilho.name} para etapa`);
    await expect(moveSelect).toBeVisible();
    const options = await moveSelect.locator("option").allTextContents();
    expect(options).not.toContain("Contrato assinado (teste e2e)");
  });

  test("3. novo requisito de avanço aparece na etapa e pode ser excluído", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);
    await page.goto("/configuracoes/pipelines");

    await page.getByRole("button", { name: "Novo requisito para Fazer primeiro contato" }).click();
    await page.getByLabel("Rótulo").fill("Conferir conflito (teste e2e)");
    await page.getByRole("button", { name: "Criar requisito" }).click();
    await expect(page.getByText("Requisito criado")).toBeVisible();
    await page.getByRole("button", { name: "Concluir" }).click();
    await expect(page.getByText("Conferir conflito (teste e2e)")).toBeVisible();

    await page
      .getByRole("button", { name: "Excluir requisito Conferir conflito (teste e2e)" })
      .click();
    await expect(page.getByText("Conferir conflito (teste e2e)")).toHaveCount(0);
  });

  test("4. novo motivo de perda aparece na lista e pode ser desativado", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);
    await page.goto("/configuracoes/pipelines");

    await page.getByRole("button", { name: "Novo motivo" }).click();
    await page.getByLabel("Motivo").fill("Motivo de teste e2e");
    await page.getByRole("button", { name: "Criar motivo" }).click();
    await expect(page.getByText("Motivo criado")).toBeVisible();
    await page.getByRole("button", { name: "Concluir" }).click();
    await expect(page.getByText("Motivo de teste e2e")).toBeVisible();

    await page.getByRole("button", { name: "Desativar motivo Motivo de teste e2e" }).click();
    await expect(page.getByText("Motivo de teste e2e")).toHaveCount(0);
  });

  test("5. viewer não vê o link e a tela responde 404 por acesso direto", async ({ page }) => {
    await login(page, SEED_USERS.elisa.email);

    await page.goto("/configuracoes");
    await expect(page.getByRole("link", { name: "Pipelines" })).toHaveCount(0);

    await page.goto("/configuracoes/pipelines");
    await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
  });
});
