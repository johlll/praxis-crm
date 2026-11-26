import { expect, test, type Page } from "@playwright/test";

import { SEED_PAINEL, SEED_USERS } from "./fixtures";
import { login } from "./helpers";

/**
 * Financeiro com sessão, papéis e banco reais (Supabase local do CI). A página não grava: o teste confere isso pelas
 * requisições. Os totais do mês atual da demonstração são fixos porque o conjunto é relativo a "hoje".
 */

function watch(page: Page) {
  const errors: string[] = [];
  const writes: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("request", (r) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(r.method())) writes.push(`${r.method()} ${r.url()}`);
  });
  return { errors, writes };
}

const card = (page: Page, key: string) => page.getByTestId(`finance-card-${key}`);
/** Valor exato; entre "R$" e o número o navegador usa um espaço não separável. */
const money = (text: string) => new RegExp(`^${text.replace(/[$.]/g, "\\$&").replace(/ /g, "\\s")}$`);
const nav = (page: Page) => page.getByRole("navigation", { name: "Navegação principal" });

/**
 * Mede o layout JÁ ESTABILIZADO: logo após redimensionar, um gráfico ainda tem a largura anterior por um quadro,
 * até o ResizeObserver redesenhá-lo.
 */
async function noSidewaysScroll(page: Page, label: string) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const main = document.querySelector("main")!;
          return { page: document.documentElement.scrollWidth - window.innerWidth, main: main.scrollWidth - main.clientWidth };
        }),
      { message: label },
    )
    .toEqual({ page: 0, main: 0 });
}

test.describe("Financeiro", () => {
  test("owner na demonstração: menu, totais, simulação sem gravação e reinício ao recarregar", async ({ page }) => {
    await login(page, SEED_PAINEL.owner.email);
    const seen = watch(page);
    const link = nav(page).getByRole("link", { name: "Financeiro" });
    await link.click();
    await expect(page).toHaveURL(/\/financeiro$/);
    await expect(link).toHaveAttribute("aria-current", "page");
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("note")).toContainText("Simulação — não grava no financeiro do escritório");
    await expect(card(page, "received")).toHaveText(money("R$ 38.400"));
    await expect(card(page, "paid")).toHaveText(money("R$ 12.600"));
    await expect(card(page, "result")).toHaveText(money("R$ 25.800"));
    await expect(card(page, "receivable")).toHaveText(money("R$ 14.200"));
    await expect(page.getByTestId("finance-donut-total")).toHaveText(money("R$ 14.200"));

    seen.writes.length = 0;
    await page.getByRole("button", { name: "Novo lançamento" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Descrição").fill("Lançamento do teste");
    await dialog.getByLabel(/\(fictício\)$/).fill("Cliente de Teste");
    await dialog.getByLabel("Valor (R$)").fill("1.000,00");
    await dialog.getByRole("radio", { name: "Recebido" }).check();
    await dialog.getByRole("button", { name: "Adicionar à simulação" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card(page, "received")).toHaveText(money("R$ 39.400"));
    await expect(card(page, "result")).toHaveText(money("R$ 26.800"));
    await expect(page.getByRole("button", { name: "Novo lançamento" })).toBeFocused();
    expect(seen.writes).toEqual([]);

    await page.reload({ waitUntil: "networkidle" });
    await expect(card(page, "received")).toHaveText(money("R$ 38.400"));

    for (const width of [1440, 1280, 1100, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(card(page, "received")).toBeVisible();
      await noSidewaysScroll(page, `financeiro ${width}`);
    }
    expect(seen.errors).toEqual([]);
  });

  test("advogado, atendimento e visualizador: sem item no menu e 'não encontrado' no servidor", async ({ page }) => {
    for (const email of [SEED_PAINEL.lawyer.email, SEED_PAINEL.sales.email, SEED_PAINEL.viewer.email]) {
      await page.context().clearCookies();
      await login(page, email);
      await expect(nav(page).getByRole("link", { name: "Integrações" })).toBeVisible();
      await expect(nav(page).getByRole("link", { name: "Financeiro" })).toHaveCount(0);
      const response = await page.request.get("/financeiro");
      expect(response.status(), email).toBe(404);
      expect(await response.text(), email).not.toMatch(/Helena Duarte|finance-card|Novo lançamento/);
    }
  });

  test("escritório comum: sem lançamentos e sem dado fictício, mesmo com parâmetro na URL", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);
    await page.goto("/financeiro?demo=1&is_demo=true");
    await expect(page.getByRole("heading", { name: "Ainda não há lançamentos neste módulo" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Novo lançamento" })).toHaveCount(0);
    const html = await (await page.request.get("/financeiro?demo=1")).text();
    expect(html).not.toMatch(/Helena Duarte|finance-card|demo-1|Dados demonstrativos/);
  });
});
