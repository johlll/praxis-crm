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

const periodButton = (page: Page) => page.getByRole("button", { name: /^Período:/ });
const periodPanel = (page: Page) => page.getByRole("dialog", { name: "Escolher o período" });

/** Hoje no fuso do escritório, e a conta de dias em datas civis. */
const officeToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
const addDays = (iso: string, delta: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
const dayMonth = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** Clica no dia indo ao mês dele pelas setas (o calendário mostra um mês por vez). */
async function clickDay(page: Page, iso: string) {
  const panel = periodPanel(page);
  const target = panel.locator(`[data-day="${iso}"]`);
  for (let i = 0; i < 14 && (await target.count()) === 0; i += 1) {
    const shown = await panel.locator("[data-day]").first().getAttribute("data-day");
    await panel.getByRole("button", { name: shown!.slice(0, 7) > iso.slice(0, 7) ? "Mês anterior" : "Próximo mês" }).click();
  }
  await target.click();
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
    // Os rótulos também aparecem no cabeçalho da tabela da equipe: o primeiro é o cartão.
    await expect(page.getByText("Leads recebidos", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Honorários das ganhas", { exact: true })).toBeVisible();
    await expect(page.getByText("Valor em negociação")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Oportunidades que exigem atenção" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Funil por etapa/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Agenda de hoje" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Desempenho da equipe" })).toBeVisible();
    // Período e posição separados na interface.
    await expect(page.getByText("No período", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Agora", { exact: true }).first()).toBeVisible();

    await page.getByRole("group", { name: "Leitura do funil" }).getByRole("button", { name: "Agora" }).click();
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
    // Sem JavaScript o calendário não abre: o período troca pelos links, e o formulário o leva junto.
    await tab.getByRole("link", { name: "Últimos 7 dias" }).click();
    await expect(tab).toHaveURL(/periodo=7/);
    await expect(tab.getByText("Últimos 7 dias", { exact: false }).first()).toBeVisible();
    await tab.getByLabel("Área jurídica").selectOption("Família");
    await tab.getByRole("button", { name: "Aplicar", exact: true }).click();
    await expect(tab).toHaveURL(/periodo=7.*area=Fam/);
    await noJs.close();
  });

  test("5. com JavaScript: aplicar, limpar e voltar/avançar mantêm URL, seletores e indicadores juntos", async ({ page }) => {
    await login(page, SEED_PAINEL.owner.email);
    await page.goto("/visao-geral");

    const period = periodButton(page);
    const owner = page.getByLabel("Responsável pelo lead");
    const area = page.getByLabel("Área jurídica");
    const leads = () => kpiValue(page, "Leads recebidos");

    /**
     * Confere os três seletores contra a URL que está na barra agora —
     * é isso que o defeito quebrava: a navegação do cliente trocava os
     * números sem trocar o seletor. Não depende de quantas entradas o
     * histórico tem.
     */
    async function selectorsMatchUrl() {
      const params = new URL(page.url()).searchParams;
      await expect(period).toContainText(`Últimos ${params.get("periodo") ?? "30"} dias`);
      await expect(owner).toHaveValue(params.get("responsavel") ?? "");
      await expect(area).toHaveValue(params.get("area") ?? "");
    }

    await expect(period).toContainText("Últimos 30 dias");
    const leads30 = await leads();

    // Aplicar período, responsável e área (cada troca já navega).
    await period.click();
    await periodPanel(page).getByRole("button", { name: "Últimos 7 dias" }).click();
    await expect(page).toHaveURL(/periodo=7/);
    await expect(page.getByText("Últimos 7 dias", { exact: false }).first()).toBeVisible();
    await selectorsMatchUrl();

    await owner.selectOption(SEED_PAINEL.lawyer.userId);
    await expect(page).toHaveURL(new RegExp(`responsavel=${SEED_PAINEL.lawyer.userId}`));
    await selectorsMatchUrl();

    await area.selectOption("Família");
    await expect(page).toHaveURL(/area=Fam/);
    await selectorsMatchUrl();
    const leadsFiltrado = await leads();

    // Limpar filtros: URL, seletores e indicadores voltam juntos ao padrão.
    await page.getByRole("link", { name: "Limpar filtros" }).click();
    await expect(page).toHaveURL(/\/visao-geral$/);
    await selectorsMatchUrl();
    expect(await leads()).toBe(leads30);

    // Voltar: os três filtros de novo, com o número daquela combinação.
    await page.goBack();
    await expect(page).toHaveURL(/area=Fam/);
    await selectorsMatchUrl();
    expect(await leads()).toBe(leadsFiltrado);

    // Avançar: volta ao padrão, seletores e número juntos.
    await page.goForward();
    await expect(page).toHaveURL(/\/visao-geral$/);
    await selectorsMatchUrl();
    expect(await leads()).toBe(leads30);

    // Percorrer o histórico para trás e para frente: a cada entrada, os
    // seletores têm de bater com a URL daquela entrada (voltar além da
    // primeira não muda nada, e a conferência continua valendo).
    // Três passos para trás alcançam as três combinações aplicadas sem
    // risco de sair da Visão geral (antes delas está o login).
    for (let i = 0; i < 3; i += 1) {
      await page.goBack();
      await selectorsMatchUrl();
    }
    for (let i = 0; i < 3; i += 1) {
      await page.goForward();
      await selectorsMatchUrl();
    }
  });

  test("6. ganhar uma oportunidade pelo painel reflete nos indicadores", async ({ page }) => {
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

  test("7. calendário: escolher datas, aplicar, recarregar, voltar e avançar, com os números daquelas datas", async ({ page, request }) => {
    const errors = watchConsole(page);
    const writes: string[] = [];
    await login(page, SEED_PAINEL.owner.email);
    await page.goto("/visao-geral");
    await page.waitForLoadState("networkidle");
    page.on("request", (r) => {
      if (!["GET", "HEAD", "OPTIONS"].includes(r.method())) writes.push(`${r.method()} ${r.url()}`);
    });
    const leads30 = await kpiValue(page, "Leads recebidos");

    const to = addDays(officeToday(), -2);
    const from = addDays(to, -11);
    const status = () => periodPanel(page).getByRole("status");
    const apply = () => periodPanel(page).getByRole("button", { name: "Aplicar período" });

    await periodButton(page).click();
    await clickDay(page, from);
    await expect(status()).toContainText("Selecione a data final");
    await expect(apply()).toBeDisabled();
    await expect(page).toHaveURL(/\/visao-geral$/);
    await clickDay(page, to);
    await expect(status()).toContainText("12 dias");

    // Escape descarta e devolve o foco; reabrir mostra o que está aplicado.
    await page.keyboard.press("Escape");
    await expect(periodPanel(page)).toHaveCount(0);
    await expect(periodButton(page)).toBeFocused();
    await expect(periodButton(page)).toContainText("Últimos 30 dias");

    await periodButton(page).click();
    await expect(status()).toContainText("30 dias");
    await clickDay(page, from);
    await clickDay(page, to);
    await apply().click();
    await expect(page).toHaveURL(new RegExp(`periodo=personalizado&de=${from}&ate=${to}`));
    await expect(periodButton(page)).toBeFocused();

    const detail = page.getByText("cada indicador pela sua própria data", { exact: false });
    await expect(detail).toContainText(dayMonth(from));
    await expect(detail).toContainText(`comparado com ${dayMonth(addDays(from, -12))}`);

    // Os cartões mostram o que o banco devolve para essas datas.
    const token = await getSupabaseAccessToken(request, SEED_PAINEL.owner.email);
    const direct = await callRpcDirect(request, token, "get_dashboard", {
      p_workspace_id: SEED_PAINEL.workspaceId,
      p_start_date: from,
      p_end_date: to,
    });
    expect(direct.status).toBe(200);
    const metrics = (direct.body as { period_metrics: { leads_received: { current: number }; opportunities_won: { current: number } } })
      .period_metrics;
    await expect.poll(() => kpiValue(page, "Leads recebidos")).toBe(String(metrics.leads_received.current));
    expect(await kpiValue(page, "Oportunidades ganhas")).toBe(String(metrics.opportunities_won.current));
    const leadsCustom = await kpiValue(page, "Leads recebidos");
    const label = (await periodButton(page).locator("span.tabular").innerText()).trim();

    await page.reload({ waitUntil: "networkidle" });
    await expect(periodButton(page)).toContainText(label);
    expect(await kpiValue(page, "Leads recebidos")).toBe(leadsCustom);

    // Outro filtro mantém as datas.
    await page.getByLabel("Área jurídica").selectOption("Família");
    await expect(page).toHaveURL(new RegExp(`de=${from}&ate=${to}.*area=Fam`));
    await expect(periodButton(page)).toContainText(label);
    await page.goBack();
    await expect(page).not.toHaveURL(/area=/);
    await expect(periodButton(page)).toContainText(label);
    await page.goBack();
    await expect(page).toHaveURL(/\/visao-geral$/);
    await expect(periodButton(page)).toContainText("Últimos 30 dias");
    await expect.poll(() => kpiValue(page, "Leads recebidos")).toBe(leads30);
    await page.goForward();
    await expect(periodButton(page)).toContainText(label);
    await expect.poll(() => kpiValue(page, "Leads recebidos")).toBe(leadsCustom);

    // No celular o mesmo calendário cabe na tela, sem rolagem lateral.
    await page.setViewportSize({ width: 390, height: 844 });
    await periodButton(page).click();
    await expect(periodPanel(page).getByRole("grid")).toHaveCount(1);
    const box = (await periodPanel(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
      .toBe(0);
    await page.keyboard.press("Escape");

    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("8. datas inválidas no endereço: mensagem clara e nenhum indicador", async ({ page }) => {
    await login(page, SEED_PAINEL.owner.email);
    await page.goto(`/visao-geral?periodo=personalizado&de=${officeToday()}&ate=2020-01-01`);
    const problem = page.getByRole("alert").filter({ hasText: "Período não aplicado" });
    await expect(problem).toContainText("A data inicial é depois da data final.");
    await expect(page.getByText("Leads recebidos", { exact: true })).toHaveCount(0);
    await problem.getByRole("link", { name: "Ver os últimos 30 dias" }).click();
    await expect(periodButton(page)).toContainText("Últimos 30 dias");
    await expect(page.getByText("Leads recebidos", { exact: true }).first()).toBeVisible();
  });
});
