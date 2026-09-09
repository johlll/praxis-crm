import { expect, test } from "@playwright/test";

import { SEED_CONTACTS, SEED_CPF_RAW, SEED_USERS } from "./fixtures";
import { login, switchWorkspace } from "./helpers";

/**
 * Jornada da A3 contra o Supabase local do CI (`supabase start` + seed —
 * nunca o projeto hospedado nem produção, nunca depende de envio de e-mail
 * nenhum: só contas fictícias já confirmadas pelo seed). Cobre exatamente o
 * que só aparece testando de verdade, contra requisições HTTP separadas —
 * não em uma única transação pgTAP: criação/edição, busca por CPF via
 * blind index, revelação por papel, revisão e mesclagem de duplicidade,
 * desfazer, e a mensagem de conflito quando o desfazer não é seguro.
 *
 * `test.describe.serial`: o par Roberto (seed) é mesclado num teste e
 * desfeito no seguinte — precisa da ordem.
 */
test.describe.serial("contatos — A3", () => {
  test("1. criação e edição de contato", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);

    await page.goto("/contatos/novo");
    await page.getByLabel("Nome").fill("Contato E2E Criado");
    await page.getByLabel("Telefone").fill("11912345678");
    await page.getByRole("button", { name: "Criar contato" }).click();

    await expect(page).toHaveURL(/\/contatos\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name: "Contato E2E Criado" })).toBeVisible();
    // Telefone normalizado pro formato E.164 antes de gravar.
    await expect(page.getByText("+5511912345678")).toBeVisible();

    await page.getByLabel("Nome").fill("Contato E2E Editado");
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Dados salvos.")).toBeVisible();
    await expect(page.getByLabel("Nome")).toHaveValue("Contato E2E Editado");
  });

  test("2. busca exata por CPF encontra os dois contatos com o mesmo CPF", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);

    await page.goto("/contatos");
    await page.getByRole("searchbox", { name: "Buscar contatos" }).fill(SEED_CPF_RAW);
    await page.getByRole("searchbox", { name: "Buscar contatos" }).press("Enter");

    await expect(page).toHaveURL(/\/contatos\?q=/);
    await expect(page.getByText(SEED_CONTACTS.carlaFerreira.name, { exact: true })).toBeVisible();
    await expect(page.getByText(SEED_CONTACTS.carlaFerreiraAdvocacia.name, { exact: true })).toBeVisible();
    // Um contato sem esse CPF não pode aparecer — prova que é busca exata
    // pelo blind index, não um "contém" por acaso no nome.
    await expect(page.getByText(SEED_CONTACTS.robertoSilva.name, { exact: true })).not.toBeVisible();
  });

  test("3. proprietário revela CPF sem precisar de motivo", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);

    await page.goto(`/contatos/${SEED_CONTACTS.carlaFerreira.id}`);
    await expect(page.getByText("•••.•••.•••-••")).toBeVisible();
    await page.getByRole("button", { name: "Revelar" }).click();

    await expect(page.getByText("22222222222")).toBeVisible();
    // Nenhum campo de motivo chegou a aparecer — owner não precisa.
    await expect(page.getByPlaceholder("Motivo da consulta")).not.toBeVisible();
  });

  test("4. atendimento (sales) precisa informar motivo pra revelar", async ({ page }) => {
    await login(page, SEED_USERS.carla.email);
    await switchWorkspace(page, "Escritório Dois (seed)");

    await page.goto(`/contatos/${SEED_CONTACTS.clienteEscritorioDois.id}`);
    await page.getByRole("button", { name: "Revelar" }).click();

    const reasonInput = page.getByPlaceholder("Motivo da consulta (obrigatório para o seu papel)");
    await expect(reasonInput).toBeVisible();
    const confirmButton = page.getByRole("button", { name: "Confirmar" });
    await expect(confirmButton).toBeDisabled();

    await reasonInput.fill("Cliente pediu confirmação por telefone");
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();

    await expect(page.getByText("22222222222")).toBeVisible();
  });

  test("5. visualizador nunca revela CPF — mensagem tratada, não erro cru", async ({ page }) => {
    await login(page, SEED_USERS.elisa.email);

    await page.goto(`/contatos/${SEED_CONTACTS.carlaFerreira.id}`);
    await page.getByRole("button", { name: "Revelar" }).click();

    await expect(page.getByText("Você não tem permissão para fazer isso.")).toBeVisible();
    // O valor continua mascarado — a tentativa negada não vazou nada.
    await expect(page.getByText("•••.•••.•••-••")).toBeVisible();
    await expect(page.getByText("22222222222")).not.toBeVisible();
  });

  test("6. revisão e mesclagem de duplicidade (par do seed, ainda pendente)", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);

    await page.goto("/contatos/duplicidades");
    const robertoRow = page.getByTestId("duplicate-candidate-row").filter({
      hasText: `${SEED_CONTACTS.robertoSilva.name} × ${SEED_CONTACTS.robertoSilvaFilho.name}`,
    });
    await expect(robertoRow).toBeVisible();
    await expect(robertoRow.getByText("Mesmo telefone")).toBeVisible();

    await robertoRow.getByRole("link", { name: "Comparar" }).click();
    await expect(page).toHaveURL(/\/contatos\/duplicidades\/[0-9a-f-]{36}$/);

    await page
      .getByRole("button", { name: `Mesclar, mantendo ${SEED_CONTACTS.robertoSilva.name}` })
      .click();

    await expect(page).toHaveURL(new RegExp(`/contatos/${SEED_CONTACTS.robertoSilva.id}$`));
    await expect(page.getByText("Mesclagens")).toBeVisible();
    await expect(page.getByText(`Mesclado com ${SEED_CONTACTS.robertoSilvaFilho.name}`)).toBeVisible();
  });

  test("7. desfazer pela interface funciona sem edição posterior", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);

    // Requisição separada da mesclagem do teste anterior — exatamente o
    // cenário (tempo real passando entre mesclar e desfazer, cada um numa
    // transação própria) que uma pgTAP de arquivo único não reproduz
    // sozinha, e onde o bug de timestamp congelado foi achado.
    await page.goto(`/contatos/${SEED_CONTACTS.robertoSilva.id}`);
    await page.getByRole("button", { name: "Desfazer mesclagem" }).click();
    await page.getByRole("button", { name: "Confirmar desfazer" }).click();

    await expect(page.getByText(/Desfeito em/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Desfazer mesclagem" })).not.toBeVisible();

    // O contato reaparece como independente.
    await page.goto(`/contatos/${SEED_CONTACTS.robertoSilvaFilho.id}`);
    await expect(page.getByRole("heading", { name: SEED_CONTACTS.robertoSilvaFilho.name })).toBeVisible();
  });

  test("8. mensagem de conflito ao tentar desfazer após alteração incompatível", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);

    // Par fresco, criado agora — o mesmo telefone garante um candidato
    // "Para revisão" (ver docs/decisoes/a3-duplicidades.md).
    await page.goto("/contatos/novo");
    await page.getByLabel("Nome").fill("Conflito E2E Um");
    await page.getByLabel("Telefone").fill("11900001111");
    await page.getByRole("button", { name: "Criar contato" }).click();
    await expect(page).toHaveURL(/\/contatos\/[0-9a-f-]{36}$/);

    await page.goto("/contatos/novo");
    await page.getByLabel("Nome").fill("Conflito E2E Dois");
    await page.getByLabel("Telefone").fill("11900001111");
    await page.getByRole("button", { name: "Criar contato" }).click();
    await expect(page).toHaveURL(/\/contatos\/[0-9a-f-]{36}$/);

    // contact_a/contact_b da candidata vêm de least()/greatest() do id
    // (uuid aleatório) dos dois contatos — a ordem de exibição "Um × Dois"
    // ou "Dois × Um" não é previsível, só a presença dos dois nomes.
    await page.goto("/contatos/duplicidades");
    const conflitoRow = page
      .getByTestId("duplicate-candidate-row")
      .filter({ hasText: "Conflito E2E" });
    await expect(conflitoRow).toBeVisible();
    await conflitoRow.getByRole("link", { name: "Comparar" }).click();
    // Mesmo raciocínio: qual dos dois vira "a" (mantido por padrão) não é
    // previsível — só interessa que ALGUM dos dois seja mantido.
    await page.getByRole("button", { name: /^Mesclar, mantendo Conflito E2E (Um|Dois)$/ }).click();

    await expect(page).toHaveURL(/\/contatos\/[0-9a-f-]{36}$/);
    const keptUrl = page.url();

    // Os dois telefones (o próprio + o movido de "Dois") ficam idênticos —
    // remover os dois garante que a linha movida some, sem depender de
    // qual das duas cópias visualmente idênticas era qual.
    await page.getByRole("button", { name: "Remover telefone" }).first().click();
    await expect(page.getByRole("button", { name: "Remover telefone" })).toHaveCount(1);
    await page.getByRole("button", { name: "Remover telefone" }).first().click();
    await expect(page.getByText("Nenhum telefone cadastrado.")).toBeVisible();

    await page.goto(keptUrl);
    await page.getByRole("button", { name: "Desfazer mesclagem" }).click();
    await page.getByRole("button", { name: "Confirmar desfazer" }).click();

    await expect(
      page.getByText(
        "Não é possível desfazer automaticamente: algo foi alterado depois da mesclagem. Resolva manualmente.",
      ),
    ).toBeVisible();
    // Recusado, não sobrescrito: a mesclagem continua de pé.
    await expect(page.getByText(/Desfeito em/)).not.toBeVisible();
  });
});
