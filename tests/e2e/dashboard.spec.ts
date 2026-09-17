import { expect, test, type Page } from "@playwright/test";

import { SEED_PAINEL } from "./fixtures";
import { callRpcDirect, getSupabaseAccessToken, login } from "./helpers";

/**
 * A10 — Visão geral com os dados do Escritório Painel (seed). Os números
 * exatos são conferidos no banco (16_a10_dashboard.test.sql); aqui:
 * tela por papel, payload real da página, filtros sem JavaScript, ganho
 * refletido no painel e ausência de erro de hidratação.
 */

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

/** Valor atual do cartão de indicador pelo rótulo. */
async function kpiValue(page: Page, label: string): Promise<string> {
  const card = page.locator("div", { has: page.getByText(label, { exact: true }) }).filter({ hasText: "período anterior" }).last();
  return (await card.locator("p").nth(1).innerText()).trim();
}

test.describe.serial("A10 — Visão geral", () => {
  test("1. owner: blocos, marcação demonstrativa e nenhum erro no console", async ({ page }) => {
    const errors = watchConsole(page);
    await login(page, SEED_PAINEL.owner.email);
    await page.goto("/visao-geral");

    await expect(page.getByRole("note")).toContainText("Dados demonstrativos");
    await expect(page.getByText("Leads recebidos", { exact: true })).toBeVisible();
    await expect(page.getByText("Honorários das ganhas", { exact: true })).toBeVisible();
    await expect(page.getByText("Valor em negociação")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Oportunidades que exigem atenção" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Funil por etapa/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Agenda de hoje" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Desempenho da equipe" })).toBeVisible();
    // Período e posição separados na interface.
    await expect(page.getByText("No período", { exact: true })).toBeVisible();
    await expect(page.getByText("Agora", { exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: "Agora" }).click();
    await expect(page.getByText("Oportunidades abertas agora, por etapa")).toBeVisible();

    await page.waitForLoadState("networkidle");
    expect(errors.filter((e) => /hydrat|did not match|server rendered/i.test(e))).toEqual([]);
  });

  test("2. sales e viewer: nenhum valor exato no HTML/payload da página", async ({ page }) => {
    await login(page, SEED_PAINEL.sales.email);
    const salesHtml = await (await page.request.get("/visao-geral")).text();
    expect(salesHtml).not.toMatch(/Cents|forecast/);
    expect(salesHtml).toContain("valueBand");
    await page.goto("/visao-geral");
    await expect(page.getByText("Honorários das ganhas", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Valor em negociação")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Oportunidades ganhas" })).toBeVisible();

    await page.context().clearCookies();
    await login(page, SEED_PAINEL.viewer.email);
    const viewerHtml = await (await page.request.get("/visao-geral")).text();
    expect(viewerHtml).not.toMatch(/Cents|forecast|valueBand/);
  });

  test("3. RPC direta: sales filtrado até uma única oportunidade não recebe valor", async ({ request }) => {
    const token = await getSupabaseAccessToken(request, SEED_PAINEL.sales.email);
    const { status, body } = await callRpcDirect(request, token, "get_dashboard", {
      p_workspace_id: SEED_PAINEL.workspaceId,
      p_period_days: 90,
      p_assigned_to: SEED_PAINEL.lawyer.userId,
      p_legal_area: "Família",
    });
    expect(status).toBe(200);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/cents|forecast|probability|fee_model/);

    const other = await getSupabaseAccessToken(request, SEED_PAINEL.ownerB.email);
    const denied = await callRpcDirect(request, other, "get_dashboard", { p_workspace_id: SEED_PAINEL.workspaceId });
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(denied.body)).toContain("insufficient_permission");
  });

  test("4. filtros funcionam antes da hidratação (sem JavaScript)", async ({ browser, page }) => {
    await login(page, SEED_PAINEL.owner.email);
    const storageState = await page.context().storageState();
    const noJs = await browser.newContext({ storageState, javaScriptEnabled: false });
    const tab = await noJs.newPage();
    await tab.goto("/visao-geral");
    await tab.getByLabel("Período").selectOption("7");
    await tab.getByRole("button", { name: "Aplicar" }).click();
    await expect(tab).toHaveURL(/periodo=7/);
    await expect(tab.getByText("Últimos 7 dias", { exact: false }).first()).toBeVisible();
    await noJs.close();
  });

  test("5. ganhar uma oportunidade pelo painel reflete nos indicadores", async ({ page }) => {
    const errors = watchConsole(page);
    await login(page, SEED_PAINEL.owner.email);
    await page.goto("/visao-geral?periodo=7");
    const before = Number(await kpiValue(page, "Oportunidades ganhas"));

    const attention = page.locator("#atencao");
    const firstItem = attention.getByRole("link").first();
    const contact = (await firstItem.locator("span.font-bold").first().innerText()).trim();
    await firstItem.click();
    const panel = page.getByRole("complementary", { name: contact });
    await expect(panel).toBeVisible();

    await panel.getByRole("button", { name: "Ganhou" }).click();
    await page.getByLabel("Valor final").fill("1500");
    await expect(page.getByRole("button", { name: "Registrar ganho" })).toBeEnabled();
    await page.getByRole("button", { name: "Registrar ganho" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await expect.poll(async () => Number(await kpiValue(page, "Oportunidades ganhas"))).toBe(before + 1);
    await expect(panel.getByText("Ganha", { exact: false })).toBeVisible();
    // Recarregar mantém o número (vem do banco, não do estado da tela).
    await page.reload();
    expect(Number(await kpiValue(page, "Oportunidades ganhas"))).toBe(before + 1);
    expect(errors.filter((e) => /hydrat|did not match|server rendered/i.test(e))).toEqual([]);
  });
});
