import { expect, test } from "@playwright/test";

import { SEED_CONTACTS, SEED_USERS } from "./fixtures";
import { login } from "./helpers";

/**
 * Jornada da A6 contra o Supabase local do CI. O pgTAP
 * (11_a6_activities.test.sql, 72 asserções) já cobre exaustivamente
 * alcance por registro, coerência de vínculos, concorrência via
 * lock_version, fronteiras de hoje/amanhã/semana/atrasada e a atividade
 * automática por etapa (incluindo o bloqueio por requisito pendente e a
 * ausência de duplicação) — este arquivo foca só no que só um e2e prova
 * de verdade: o fluxo real de UI de ponta a ponta.
 *
 * `test.describe.serial`: os testes reaproveitam o lead/oportunidade
 * criados no teste anterior.
 */
test.describe.serial("atividades e agenda — A6", () => {
  test.use({ timezoneId: "America/Sao_Paulo" });

  const leadArea = "Atividades A6 teste e2e";
  let leadUrl: string;

  function tomorrowIso(): string {
    const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  }

  function inThreeDaysIso(): string {
    const d = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  }

  test("1. criar atividade pela Central de Atividades e concluir", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);

    await page.goto("/leads/novo");
    await page.getByLabel("Contato").selectOption({ label: SEED_CONTACTS.carlaFerreiraAdvocacia.name });
    await page.getByLabel("Área jurídica").fill(leadArea);
    await page.getByRole("button", { name: "Criar lead" }).click();
    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);
    leadUrl = page.url();

    await page.goto("/atividades");
    await page.getByRole("button", { name: "Nova atividade" }).click();
    await page
      .getByLabel("Lead", { exact: true })
      .selectOption({ label: `${SEED_CONTACTS.carlaFerreiraAdvocacia.name} — ${leadArea}` });
    await page.getByLabel("Título", { exact: true }).fill("Ligar pro cliente (teste e2e)");
    await page.getByLabel("Data", { exact: true }).fill(tomorrowIso());
    await page.getByRole("button", { name: "Criar atividade" }).click();
    await expect(page.getByText("Atividade criada")).toBeVisible();
    await page.getByRole("button", { name: "Concluir", exact: true }).click();

    await expect(page.getByText("Ligar pro cliente (teste e2e)")).toBeVisible();

    await page.getByRole("button", { name: "Concluir Ligar pro cliente (teste e2e)" }).click();
    // Some da listagem padrão (status=pending) assim que a Server Action
    // conclui e revalida a rota — sem precisar de reload manual, mesmo
    // padrão já usado (e comprovado) por stage-row.tsx na A5.
    await expect(page.getByText("Ligar pro cliente (teste e2e)")).toHaveCount(0);
  });

  test("2. reagendar e transferir responsável persistem de verdade", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);

    await page.goto(leadUrl);
    await page.getByRole("button", { name: "Nova atividade" }).click();
    await page.getByLabel("Título", { exact: true }).fill("Revisar contrato (teste e2e)");
    await page.getByLabel("Data", { exact: true }).fill(tomorrowIso());
    await page.getByRole("button", { name: "Criar atividade" }).click();
    await expect(page.getByText("Atividade criada")).toBeVisible();
    await page.getByRole("button", { name: "Concluir", exact: true }).click();
    await expect(page.getByText("Revisar contrato (teste e2e)")).toBeVisible();

    await page.getByRole("button", { name: "Reagendar Revisar contrato (teste e2e)" }).click();
    const novaData = inThreeDaysIso();
    await page.getByLabel("Data", { exact: true }).fill(novaData);
    await page.getByRole("button", { name: "Reagendar", exact: true }).click();
    // A ação só fecha o diálogo (onDone) em caso de sucesso — se a RPC
    // tivesse recusado, o Alert de erro apareceria e o diálogo
    // continuaria aberto, o que faria esta espera dar timeout.
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.reload();
    const [dd, mm] = novaData.split("-").slice(1);
    await expect(page.getByText(`${dd}/${mm}`)).toBeVisible();

    const responsavelSelect = page.getByLabel("Transferir Revisar contrato (teste e2e) para");
    await responsavelSelect.selectOption({ label: SEED_USERS.ana.fullName });
    await page.reload();
    await expect(page.getByLabel("Transferir Revisar contrato (teste e2e) para").locator("option:checked")).toHaveText(
      SEED_USERS.ana.fullName,
    );
  });

  test("3. mover oportunidade para etapa com regra cria atividade automática", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);

    await page.goto("/configuracoes/pipelines");
    // "Configurar" (sem regra ainda) ou "Editar" (se um retry do CI já
    // rodou este teste antes contra o mesmo banco) — o rótulo muda
    // conforme já existe regra ou não; o regex cobre os dois estados.
    await page
      .getByRole("button", { name: /(Configurar|Editar) atividade automática de Qualificar oportunidade/ })
      .click();
    await page.getByLabel("Título", { exact: true }).fill("Enviar proposta inicial (teste e2e)");
    await page.getByRole("button", { name: "Salvar regra" }).click();
    await expect(page.getByText("Regra salva")).toBeVisible();
    await page.getByRole("button", { name: "Concluir", exact: true }).click();

    await page.goto("/leads/novo");
    await page.getByLabel("Contato").selectOption({ label: SEED_CONTACTS.carlaFerreiraAdvocacia.name });
    await page.getByLabel("Área jurídica").fill(`${leadArea} (mover)`);
    await page.getByRole("button", { name: "Criar lead" }).click();
    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);

    await page.getByRole("button", { name: "Nova oportunidade" }).click();
    await page.getByRole("button", { name: "Criar oportunidade" }).click();
    const link = page.getByRole("link", { name: /Fazer primeiro contato/ });
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    const opportunityUrl = new URL(href!, page.url()).toString();

    await page.goto("/pipeline");
    await page
      .getByLabel(`Mover ${SEED_CONTACTS.carlaFerreiraAdvocacia.name} para etapa`)
      .selectOption({ label: "Qualificar oportunidade" });
    await expect(page.getByRole("heading", { name: "Qualificar oportunidade" })).toBeVisible();

    await page.goto(opportunityUrl);
    await expect(page.getByText("Enviar proposta inicial (teste e2e)")).toBeVisible();
    await expect(page.getByText("Sem próxima ação")).toHaveCount(0);
  });

  test("4. papel sem permissão não vê ações de atividade", async ({ page }) => {
    await login(page, SEED_USERS.elisa.email);

    await page.goto("/atividades");
    await expect(page.getByRole("button", { name: "Nova atividade" })).toHaveCount(0);
  });
});
