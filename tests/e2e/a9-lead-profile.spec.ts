import { expect, test } from "@playwright/test";

import { SEED_USERS } from "./fixtures";
import { login, logout } from "./helpers";

/**
 * Jornada e achados específicos da A9 (Perfil 360º) não cobertos pelos
 * e2e pré-existentes (que só passavam POR CIMA da página de lead a
 * caminho de outra coisa). O pgTAP (14_a9_perfil_360.test.sql, 34
 * asserções) já cobre alcance por registro, projeção financeira por
 * papel e paginação da timeline sem furo/repetição — este arquivo foca
 * no que só um e2e prova: os fluxos reais de UI, incluindo os 5 ajustes
 * do review pós-CI (mudar de etapa sem sair do Perfil 360, envio de
 * proposta com texto honesto, e a nota de conflito nunca chegando ao
 * navegador do visualizador).
 *
 * `test.describe.serial`: os testes reaproveitam o lead criado no
 * primeiro.
 */
test.describe.serial("Perfil 360º do lead — A9", () => {
  const contactName = "Contato Perfil 360 A9 (teste e2e)";
  const leadArea = "Perfil 360 A9 teste e2e";
  let leadUrl: string;

  test("1. criar lead + oportunidade e mudar de etapa sem sair do Perfil 360", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);

    await page.goto("/contatos/novo");
    await page.getByLabel("Nome", { exact: true }).fill(contactName);
    await page.getByRole("button", { name: "Criar contato" }).click();
    await expect(page).toHaveURL(/\/contatos\/[0-9a-f-]{36}$/);

    await page.goto("/leads/novo");
    await page.getByLabel("Contato").selectOption({ label: contactName });
    await page.getByLabel("Área jurídica").fill(leadArea);
    await page.getByRole("button", { name: "Criar lead" }).click();
    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);
    leadUrl = page.url();

    await page.getByRole("button", { name: "Nova oportunidade" }).click();
    await page.getByRole("button", { name: "Criar oportunidade" }).click();
    await expect(page.getByText("Etapa 1 de 8")).toBeVisible();

    // Mudar de etapa direto no Perfil 360 (achado do review pós-CI: só
    // dava pra mover indo ao Pipeline) — a etapa de destino não tem
    // requisito configurado no seed, então não abre StageAdvanceDialog.
    await page.getByLabel("Mover etapa para").selectOption({ index: 1 });
    await page.getByRole("button", { name: "Mover etapa" }).click();
    await expect(page.getByText("Etapa 2 de 8")).toBeVisible();
  });

  test("2. registrar proposta com texto honesto de envio manual", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);
    await page.goto(leadUrl);
    await page.getByRole("tab", { name: "Propostas" }).click();

    await page.getByRole("button", { name: "Nova proposta" }).click();
    await page.getByLabel("Valor (R$)").fill("5000");
    await page.getByRole("button", { name: "Criar proposta" }).click();
    await page.getByRole("button", { name: "Concluir" }).click();

    // O botão nunca deve prometer um envio que o CRM não faz — o texto
    // "Enviar proposta"/"Enviando…" enganava o usuário (achado do review
    // pós-CI); a interface agora deixa claro que é um registro manual.
    await expect(page.getByRole("button", { name: "Enviar proposta" })).toHaveCount(0);
    await expect(page.getByText("o CRM não despacha a mensagem")).toBeVisible();
    await page.getByRole("button", { name: "Registrar envio manual" }).click();
    await expect(page.getByText("Aguardando retorno")).toBeVisible();

    await page.getByRole("button", { name: "Aceita" }).click();
    await expect(page.getByText("Aceita", { exact: true })).toBeVisible();

    // A proposta precisa aparecer na Linha do tempo filtrando por
    // "Propostas" — achado do review pós-CI: o filtro só olhava os
    // eventos já carregados na tela (nunca ia buscar de novo no
    // servidor), então um evento fora da primeira página sumia mesmo
    // existindo de verdade.
    await page.getByRole("tab", { name: "Visão geral" }).click();
    const timelineSection = page.locator("section", { hasText: "Linha do tempo" });
    await timelineSection.getByRole("button", { name: "Propostas", exact: true }).click();
    await expect(timelineSection.getByText(/^Proposta PROP-/)).toBeVisible();
  });

  test("3. verificação de conflito: nota some para o visualizador, status continua visível", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);
    await page.goto(leadUrl);
    await page.getByRole("tab", { name: "Visão geral" }).click();

    const noteText = "Nota confidencial de conflito (teste e2e)";
    await page.getByPlaceholder("Nota (opcional)").fill(noteText);
    await page.getByLabel("Status da verificação de conflito").selectOption({ label: "Sem conflito" });
    await page.getByRole("button", { name: "Registrar verificação" }).click();
    // Só o <p> exibido, não o <textarea> do próprio formulário (que
    // continua com a nota como defaultValue) — getByText bateria nos
    // dois.
    await expect(page.locator("p", { hasText: noteText })).toBeVisible();
    await logout(page);

    // Elisa é viewer no Escritório Um (seed) — só lê, e a nota é
    // restrita a quem pode escrever a verificação (owner/admin/manager/
    // lawyer). Achado do review pós-CI: get_conflict_check() devolvia a
    // nota pra qualquer um dos 6 papéis; escondê-la só na interface não
    // bastaria (o dado não pode nem chegar ao navegador).
    await login(page, SEED_USERS.elisa.email);
    await page.goto(leadUrl);
    await expect(page.getByText("Sem conflito")).toBeVisible();
    await expect(page.getByText(noteText)).toHaveCount(0);
  });
});
