import { expect, test, type Page } from "@playwright/test";

import { SEED_PAINEL, SEED_USERS } from "./fixtures";
import { login } from "./helpers";

/**
 * Central de Integrações com sessão e papéis reais (Supabase local do CI, sem Google configurado). Abrir a central
 * só lê: o teste confere que nenhuma requisição de escrita sai dela.
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

const nav = (page: Page) => page.getByRole("navigation", { name: "Navegação principal" });

async function noSidewaysScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const main = document.querySelector("main")!;
    return { page: document.documentElement.scrollWidth - window.innerWidth, main: main.scrollWidth - main.clientWidth };
  });
  expect(overflow, label).toEqual({ page: 0, main: 0 });
}

test.describe("Central de Integrações", () => {
  test("estados honestos, categorias, nenhuma escrita e caminho para a configuração do Google Agenda", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);
    const seen = watch(page);
    await nav(page).getByRole("link", { name: "Integrações" }).click();
    await expect(page).toHaveURL(/\/integracoes$/);
    await page.reload({ waitUntil: "networkidle" });
    const list = page.getByRole("list", { name: "Integrações" });
    await expect(list.getByRole("listitem")).toHaveCount(6);
    await expect(page.getByTestId("integration-state-google-agenda")).toHaveText("Não configurado neste ambiente");
    await expect(page.getByTestId("integration-state-whatsapp")).toHaveText("Canal real não validado");
    await expect(page.getByTestId("integration-state-meta-ads")).toHaveText("Ainda não disponível");
    await expect(page.getByTestId("integration-state-google-ads")).toHaveText("Ainda não disponível");
    await expect(page.getByTestId("integration-state-assinatura-digital")).toHaveText("Funcionalidade futura");
    await expect(page.getByTestId("integration-state-automacoes")).toHaveText("Recurso interno do Praxis");
    expect(await page.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).length)).toBe(0);

    await page.getByRole("button", { name: "Marketing (2)" }).click();
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await page.getByRole("button", { name: "Todas (6)" }).click();

    for (const width of [1440, 1280, 1100, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await noSidewaysScroll(page, `integracoes ${width}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    expect(seen.writes).toEqual([]);

    await page.getByRole("link", { name: "Abrir configuração: Google Agenda" }).click();
    await expect(page).toHaveURL(/\/configuracoes\/integracoes$/);
    await expect(page.getByText("A integração com o Google Agenda ainda não está configurada neste ambiente.")).toBeVisible();
    expect(seen.errors).toEqual([]);
  });

  test("visualizador: vê a central sem ações que o papel não permite; configuração do Google segue fechada", async ({ page }) => {
    await login(page, SEED_PAINEL.viewer.email);
    await page.goto("/integracoes");
    await expect(page.getByRole("list", { name: "Integrações" }).getByRole("listitem")).toHaveCount(6);
    await expect(page.getByRole("link", { name: /Abrir configuração|Gerenciar|Configurar|Abrir automações|Abrir simulador/ })).toHaveCount(0);
    expect((await page.request.get("/configuracoes/integracoes")).status()).toBe(404);
  });
});
