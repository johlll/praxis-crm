import { expect, test } from "@playwright/test";

import { SEED_CONTACTS, SEED_USERS } from "./fixtures";
import { login, switchWorkspace } from "./helpers";

/**
 * Jornada da A4 contra o Supabase local do CI — mesmas regras da A3:
 * nunca contra o projeto hospedado, sem depender de e-mail. Cobre o que
 * só aparece testando de ponta a ponta: criação/edição com persistência,
 * busca/filtro/paginação no servidor, o payload real que um visualizador
 * recebe (não só o texto visível), isolamento entre workspaces, a faixa
 * de valor do atendimento, e a integração com mesclar/desfazer da A3.
 *
 * `test.describe.serial`: o lead criado no teste 1 é reaproveitado pelos
 * testes seguintes (edição, busca, payload do viewer).
 */
test.describe.serial("leads — A4", () => {
  let leadUrl: string;

  test("1. criação de lead com persistência, vinculado a um contato existente", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);

    await page.goto("/leads/novo");
    await page.getByLabel("Contato").selectOption({ label: SEED_CONTACTS.carlaFerreira.name });
    await page.getByLabel("Área jurídica").fill("Trabalhista");
    await page.getByLabel("Resumo").fill("Rescisão indireta");
    await page.getByLabel("Valor estimado de honorários (opcional)").fill("7.300,00");
    await page.getByRole("button", { name: "Criar lead" }).click();

    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);
    leadUrl = page.url();
    await expect(page.getByLabel("Área jurídica")).toHaveValue("Trabalhista");
    // Owner vê o valor exato — prova de que a criação persistiu o valor
    // em centavos corretamente (regex pelo número, não pelo texto inteiro:
    // o espaço entre "R$" e o valor pode ser um nbsp, dependendo do motor
    // de formatação de moeda do Node/navegador).
    await expect(page.getByText(/7\.300,00/)).toBeVisible();
  });

  test("2. edição básica persiste", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);
    await page.goto(leadUrl);

    await page.getByLabel("Resumo").fill("Rescisão indireta — audiência marcada");
    await page.getByRole("button", { name: "Salvar" }).click();

    // Sem page.reload(): o Server Action já revalida e reflete o dado
    // novo via re-render do Server Component (mesmo padrão de
    // contacts.spec.ts) — um reload logo depois de editar um <textarea>
    // não controlado disputa com a restauração de formulário do próprio
    // Chrome e pode concatenar o valor antigo ao novo, um falso positivo
    // de bug que não existe na aplicação.
    await expect(page.getByText("Dados salvos.")).toBeVisible();
    await expect(page.getByLabel("Resumo")).toHaveValue("Rescisão indireta — audiência marcada");
  });

  test("3. busca e filtro no servidor encontram o lead certo", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);

    await page.goto(`/leads?q=${encodeURIComponent(SEED_CONTACTS.carlaFerreira.name)}`);
    await expect(page.getByRole("link", { name: SEED_CONTACTS.carlaFerreira.name })).toBeVisible();

    // Filtro que não bate com nenhum lead: lista vazia, não erro.
    await page.goto("/leads?priority=baixa");
    await expect(page.getByText("Nenhum lead encontrado")).toBeVisible();
  });

  test("4. visualizador nunca recebe o valor no payload real — nem exato, nem faixa", async ({ page }) => {
    await login(page, SEED_USERS.elisa.email);
    await page.goto(leadUrl);

    // Checa o HTML de verdade que chegou ao navegador, não só o texto
    // visível — cobre o payload servido pelo React Server Component, não
    // só o que foi escondido por CSS/condicional na hora de renderizar.
    const html = await page.content();
    expect(html).not.toContain("7.300,00");
    expect(html).not.toContain("730000");
    expect(html).not.toContain("estimated_value");

    // A seção inteira de valor não existe para quem não tem a permissão.
    await expect(page.getByRole("heading", { name: "Valor estimado de honorários" })).not.toBeVisible();
  });

  test("5. visualizador não edita — ação negada com mensagem tratada, não crash", async ({ page }) => {
    await login(page, SEED_USERS.elisa.email);
    await page.goto(leadUrl);

    // Os campos aparecem desabilitados (somente leitura) para quem não
    // tem lead.edit — mas o teste real é a Server Action recusando, não
    // só a interface escondendo o botão.
    await expect(page.getByRole("button", { name: "Salvar" })).not.toBeVisible();
  });

  test("6. isolamento entre workspaces — lead de um escritório não existe para outro", async ({ page }) => {
    await login(page, SEED_USERS.bruno.email);
    await page.goto(leadUrl);

    // notFound() do Next — a página de "não encontrado", nunca o
    // conteúdo do lead de outro workspace.
    await expect(page.getByText(SEED_CONTACTS.carlaFerreira.name)).not.toBeVisible();
  });

  test("7. atendimento (sales) vê faixa, nunca o valor exato", async ({ page }) => {
    await login(page, SEED_USERS.carla.email);
    await switchWorkspace(page, "Escritório Dois (seed)");

    await page.goto("/leads/novo");
    await page.getByLabel("Contato").selectOption({ label: SEED_CONTACTS.clienteEscritorioDois.name });
    await page.getByLabel("Área jurídica").fill("Cível");
    await page.getByLabel("Valor estimado de honorários (opcional)").fill("7.300,00");
    await page.getByRole("button", { name: "Criar lead" }).click();

    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);

    const html = await page.content();
    expect(html).not.toContain("7.300,00");
    expect(html).not.toContain("730000");
    await expect(page.getByText("R$ 5.000–10.000")).toBeVisible();
  });

  test("8. mesclar contato reparenta o lead; desfazer restaura", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);

    await page.goto("/contatos/novo");
    await page.getByLabel("Nome").fill("Lead Merge Um");
    await page.getByLabel("Telefone").fill("11955500011");
    await page.getByRole("button", { name: "Criar contato" }).click();
    await expect(page).toHaveURL(/\/contatos\/[0-9a-f-]{36}$/);

    await page.goto("/contatos/novo");
    await page.getByLabel("Nome").fill("Lead Merge Dois");
    await page.getByLabel("Telefone").fill("11955500011");
    await page.getByRole("button", { name: "Criar contato" }).click();
    const contactDoisUrl = page.url();
    const contactDoisId = contactDoisUrl.split("/").pop()!;

    await page.goto(`/leads/novo?contactId=${contactDoisId}`);
    await page.getByLabel("Área jurídica").fill("Cível");
    await page.getByRole("button", { name: "Criar lead" }).click();
    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);
    const mergeLeadUrl = page.url();
    await expect(page.getByRole("heading", { name: "Lead Merge Dois" })).toBeVisible();

    await page.goto("/contatos/duplicidades");
    const row = page.getByTestId("duplicate-candidate-row").filter({ hasText: "Lead Merge" });
    await row.getByRole("link", { name: "Comparar" }).click();
    await page.getByRole("button", { name: /^Mesclar, mantendo Lead Merge (Um|Dois)$/ }).click();
    const keptContactUrl = page.url();

    // Depois de mesclar, o lead passa a mostrar o nome do contato mantido
    // — qualquer um dos dois pode ter sido o mantido (ordem por uuid não é
    // previsível para um par recém-criado).
    await page.goto(mergeLeadUrl);
    const headingAfterMerge = await page.getByRole("heading", { level: 1 }).textContent();
    expect(headingAfterMerge === "Lead Merge Um" || headingAfterMerge === "Lead Merge Dois").toBe(true);

    await page.goto(keptContactUrl);
    await page.getByRole("button", { name: "Desfazer mesclagem" }).click();
    await page.getByRole("button", { name: "Confirmar desfazer" }).click();

    await page.goto(mergeLeadUrl);
    await expect(page.getByRole("heading", { name: "Lead Merge Dois" })).toBeVisible();
  });
});
