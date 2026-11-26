import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { SEED_PAINEL, SEED_USERS } from "./fixtures";
import { login } from "./helpers";

/**
 * Tráfego Pago com navegação real: o Escritório Painel (seed, is_demo) vê a demonstração; um escritório comum vê
 * "Nenhuma conta conectada". A página não grava nada: estes testes não deixam estado no banco. Os totais dos
 * últimos 30 dias são fixos porque o conjunto fictício é relativo a "hoje".
 */

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

const kpi = (page: Page, key: string) => page.getByTestId(`traffic-kpi-${key}`);
const spaced = (s: string) => new RegExp(s.replace(/\$/g, "\\$").replace(/ /g, "\\s"));

test.describe("Tráfego Pago", () => {
  test("menu, demonstração identificada e filtros com navegação real", async ({ page }) => {
    const errors = watchConsole(page);
    await login(page, SEED_PAINEL.owner.email);

    const link = page.getByRole("navigation", { name: "Navegação principal" }).getByRole("link", { name: "Tráfego Pago" });
    await link.click();
    await expect(page).toHaveURL(/\/trafego-pago$/);
    await expect(link).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("note")).toContainText("Dados demonstrativos");
    await expect(kpi(page, "investmentCents")).toHaveText(spaced("R$ 7.890,00"));
    await expect(kpi(page, "qualifiedLeads")).toHaveText("127");
    await expect(page.getByTestId("traffic-total-qualifiedLeads")).toHaveText("127");
    await expect(page.getByTestId("traffic-share-total")).toHaveText(spaced("R$ 7.890,00"));

    // Plataforma: a URL, os cartões, a tabela e a distribuição mudam juntos, e o foco fica no controle.
    const google = page.getByRole("checkbox", { name: "Google" });
    await google.focus();
    await page.keyboard.press("Space");
    await expect(page).toHaveURL(/\?plataforma=meta$/);
    await expect(kpi(page, "investmentCents")).toHaveText(spaced("R$ 4.265,20"));
    await expect(page.getByTestId("traffic-total-investmentCents")).toHaveText(spaced("R$ 4.265,20"));
    await expect(page.getByTestId("traffic-share-google")).toContainText("fora do filtro");
    await expect(google).toBeFocused();

    const period = page.getByRole("combobox", { name: "Período" });
    await period.selectOption("7");
    await expect(page).toHaveURL(/plataforma=meta&periodo=7$/);
    await expect(page.getByTestId("traffic-period")).toContainText("(7 dias)");

    // Voltar do navegador: os controles voltam junto com os números.
    await page.goBack();
    await expect(page).toHaveURL(/\?plataforma=meta$/);
    await expect(period).toHaveValue("30");
    await expect(kpi(page, "investmentCents")).toHaveText(spaced("R$ 4.265,20"));

    // Personalizado: datas invertidas são recusadas sem navegar.
    await period.selectOption("personalizado");
    const end = await page.getByLabel("Fim").inputValue();
    const start = await page.getByLabel("Início").inputValue();
    await page.getByLabel("Início").fill(end);
    await page.getByLabel("Fim").fill(start);
    await page.getByRole("button", { name: "Aplicar período" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "anterior à data de fim" })).toBeVisible();
    await expect(page).toHaveURL(/\?plataforma=meta$/);
    await page.getByLabel("Início").fill(start);
    await page.getByLabel("Fim").fill(end);
    await page.getByRole("button", { name: "Aplicar período" }).click();
    await expect(page).toHaveURL(new RegExp(`periodo=personalizado&de=${start}&ate=${end}$`));
    await expect(page.getByTestId("traffic-period")).toContainText("(30 dias)");

    // Carregamento direto (não só navegação no cliente): nenhum erro de CSP ou de hidratação.
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByTestId("traffic-period")).toContainText("(30 dias)");
    expect(errors).toEqual([]);
  });

  test("URL com datas recusadas ou sem dados: estados próprios", async ({ page }) => {
    await login(page, SEED_PAINEL.owner.email);
    await page.goto("/trafego-pago?periodo=personalizado&de=2026-02-30&ate=2026-03-01");
    await expect(page.getByText("Período inválido")).toBeVisible();
    await expect(kpi(page, "investmentCents")).toHaveCount(0);

    await page.goto("/trafego-pago?periodo=personalizado&de=2001-01-01&ate=2001-01-31");
    await expect(page.getByRole("heading", { name: "Sem resultados no período" })).toBeVisible();
    await expect(kpi(page, "investmentCents")).toHaveCount(0);
  });

  test("ordenação e exportação do conjunto filtrado", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await login(page, SEED_PAINEL.owner.email);
    await page.goto("/trafego-pago?plataforma=google");
    const table = page.getByRole("table", { name: "Campanhas do período, com totais" });
    await table.getByRole("button", { name: "Conversas" }).click();
    await table.getByRole("button", { name: "Conversas" }).click();
    await expect(table.locator("tbody tr").first()).toContainText("Usucapião Extrajudicial");

    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Exportar CSV" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^trafego-pago-demonstracao_google_\d{4}-\d{2}-\d{2}_a_\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = readFileSync(await download.path(), "utf8").trimEnd().split("\r\n");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("Usucapião Extrajudicial");
    expect(lines.slice(1).every((l) => l.includes('"DEMONSTRAÇÃO (dados fictícios)"') && l.includes('"Google"'))).toBe(true);
  });

  test("sem rolagem lateral em desktop, 1100, 1024, tablet e celular", async ({ page }) => {
    await login(page, SEED_PAINEL.owner.email);
    for (const width of [1440, 1280, 1100, 1024, 768, 390, 360]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/trafego-pago");
      await expect(kpi(page, "investmentCents")).toBeVisible();
      const overflow = await page.evaluate(() => {
        const main = document.querySelector("main")!;
        const cut = [...main.querySelectorAll("section")].filter((s) => s.scrollWidth > s.clientWidth + 1).map((s) => s.textContent!.slice(0, 40));
        return { page: document.documentElement.scrollWidth - window.innerWidth, main: main.scrollWidth - main.clientWidth, cut };
      });
      expect(overflow, `largura ${width}`).toEqual({ page: 0, main: 0, cut: [] });
    }
  });

  test("sem JavaScript, a tela diz que precisa dele em vez de carregar para sempre", async ({ page, browser }) => {
    await login(page, SEED_PAINEL.owner.email);
    const context = await browser.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
    const plain = await context.newPage();
    await plain.goto("/trafego-pago");
    // Seletor por estrutura: a busca por texto do Playwright ignora o conteúdo de <noscript>.
    const warning = plain.locator("main noscript > p");
    await expect(warning).toBeVisible();
    expect(await warning.evaluate((e) => e.textContent)).toContain("Esta página precisa de JavaScript.");
    await expect(plain.getByTestId("traffic-kpi-investmentCents")).toBeHidden();
    await context.close();
  });

  test("escritório comum: 'Nenhuma conta conectada' e nenhum dado de demonstração no HTML", async ({ page }) => {
    const errors = watchConsole(page);
    await login(page, SEED_USERS.ana.email);
    await page.goto("/trafego-pago?periodo=90&plataforma=meta");
    await expect(page.getByRole("heading", { name: "Nenhuma conta conectada" })).toBeVisible();
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await expect(page.getByRole("table")).toHaveCount(0);

    const html = await (await page.request.get("/trafego-pago?periodo=90")).text();
    expect(html).not.toMatch(/Captação de Leads|demo-1|Dados demonstrativos|traffic-kpi/);

    await page.getByRole("button", { name: "Conectar Google Ads" }).click();
    await expect(page.getByRole("dialog")).toContainText("Conexão ainda não disponível");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Conectar Google Ads" })).toBeFocused();
    expect(errors).toEqual([]);
  });
});
