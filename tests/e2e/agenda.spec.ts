import { expect, test, type Page } from "@playwright/test";

import { SEED_USERS } from "./fixtures";
import { login } from "./helpers";

/**
 * Agenda mensal contra o Supabase local do CI: seleção de dia pela URL
 * (recarregar e Voltar/Avançar), troca de mês com o dia 1 selecionado,
 * "Nova atividade" com a data do dia selecionado, contagem e painel
 * atualizados depois de criar e concluir — sem perder a seleção — e papel
 * sem permissão. O pgTAP (54_agenda_mensal_intervalo) cobre fronteiras de
 * fuso, alcance por papel, isolamento e paginação da consulta.
 */
test.describe.serial("agenda mensal", () => {
  test.use({ timezoneId: "America/Sao_Paulo" });

  const contactName = "Contato Agenda Mensal (teste e2e)";
  const leadArea = "Agenda mensal teste e2e";
  const title = "Audiência na agenda mensal (teste e2e)";

  /** "AAAA-MM" de hoje e do mês seguinte, no fuso do escritório. */
  function months() {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
    const [y, m] = today.split("-").map(Number) as [number, number];
    const next = new Date(Date.UTC(y, m, 1));
    const nextKey = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
    return { today, current: today.slice(0, 7), next: nextKey };
  }

  const dayButton = (page: Page, day: string) => page.locator(`button[data-day="${day}"]`);

  test("1. abre em hoje; seleção de dia e de mês vivem na URL", async ({ page }) => {
    const { today, current, next } = months();
    await login(page, SEED_USERS.ana.email);
    await page.goto("/agenda");

    await expect(dayButton(page, today)).toHaveAttribute("aria-current", "date");
    await expect(dayButton(page, today)).toHaveAttribute("aria-pressed", "true");

    const other = today.endsWith("-10") ? `${current}-11` : `${current}-10`;
    await dayButton(page, other).click();
    await expect(page).toHaveURL(new RegExp(`/agenda\\?mes=${current}&dia=${other}$`));
    await expect(dayButton(page, other)).toHaveAttribute("aria-pressed", "true");

    await page.reload();
    await expect(dayButton(page, other)).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Próximo mês" }).click();
    await expect(page).toHaveURL(new RegExp(`mes=${next}&dia=${next}-01$`));
    await expect(dayButton(page, `${next}-01`)).toHaveAttribute("aria-pressed", "true");

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`mes=${current}&dia=${other}$`));
    await expect(dayButton(page, other)).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Hoje", exact: true }).click();
    await expect(dayButton(page, today)).toHaveAttribute("aria-pressed", "true");
  });

  test("2. criar no dia selecionado e concluir, mantendo a seleção", async ({ page }) => {
    const { next } = months();
    const day = `${next}-10`;
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

    await page.goto(`/agenda?mes=${next}&dia=${day}`);
    await expect(dayButton(page, day)).toHaveAttribute("aria-pressed", "true");
    await expect(dayButton(page, day)).toHaveAccessibleName(/nenhuma atividade$/);
    await expect(page.getByText("Nada agendado para este dia.")).toBeVisible();

    await page.getByRole("button", { name: "Nova atividade" }).click();
    await expect(page.getByLabel("Data", { exact: true })).toHaveValue(day);
    await page.getByLabel("Lead", { exact: true }).selectOption({ label: `${contactName} — ${leadArea}` });
    await page.getByLabel("Título", { exact: true }).fill(title);
    await page.getByLabel("Horário (opcional)").fill("14:30");
    await page.getByRole("button", { name: "Criar atividade" }).click();
    await expect(page.getByText("Atividade criada")).toBeVisible();
    await page.getByRole("button", { name: "Concluir", exact: true }).click();

    // Revalidação: painel e contagem atualizados, mesmo mês e dia.
    await expect(page).toHaveURL(new RegExp(`mes=${next}&dia=${day}$`));
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await expect(dayButton(page, day)).toHaveAccessibleName(/1 atividade$/);
    const panel = page.getByRole("region", { name: /de \d{4}$/ }).filter({ hasText: title });
    await expect(panel.getByText("14:30")).toBeVisible();

    await page.getByRole("button", { name: `Concluir ${title}` }).click();
    await expect(page.getByText("Concluída", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`mes=${next}&dia=${day}$`));
    await expect(dayButton(page, day)).toHaveAttribute("aria-pressed", "true");
    await expect(dayButton(page, day)).toHaveAccessibleName(/1 atividade$/);
  });

  test("3. papel de leitura vê a agenda, sem criar nem agir", async ({ page }) => {
    const { next } = months();
    await login(page, SEED_USERS.elisa.email);
    await page.goto(`/agenda?mes=${next}&dia=${next}-10`);
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Nova atividade" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Excluir ${title}` })).toHaveCount(0);
  });
});
