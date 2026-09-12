import { expect, test } from "@playwright/test";

import { SEED_USERS } from "./fixtures";
import { login } from "./helpers";

/**
 * Jornada da A8 contra o Supabase local do CI. O pgTAP
 * (13_a8_clients.test.sql) já cobre exaustivamente alcance por registro,
 * projeção financeira por papel, concorrência via lock_version,
 * reativação conflitante e integração com merge/undo de contato — este
 * arquivo foca no que só um e2e prova de verdade: o fluxo real de UI
 * (ganhar → "Ver cliente" → histórico/handoff → mudança de status) e o
 * payload real de rede que um papel restrito recebe.
 *
 * `test.describe.serial`: o cliente ganho no teste 1 é reaproveitado
 * pelos testes seguintes — mesmo padrão de pipeline.spec.ts/leads.spec.ts.
 */
test.describe.serial("clientes — A8", () => {
  let leadUrl: string;
  let clientUrl: string;

  test("1. ganhar a oportunidade cria o cliente; 'Ver cliente' aparece no lead e na oportunidade ganha", async ({
    page,
  }) => {
    await login(page, SEED_USERS.ana.email);

    await page.goto("/contatos/novo");
    await page.getByLabel("Nome").fill("Cliente A8 E2E");
    await page.getByLabel("Telefone").fill("11955500099");
    await page.getByRole("button", { name: "Criar contato" }).click();
    await expect(page).toHaveURL(/\/contatos\/[0-9a-f-]{36}$/);

    await page.goto("/leads/novo");
    await page.getByLabel("Contato").selectOption({ label: "Cliente A8 E2E" });
    await page.getByLabel("Área jurídica").fill("Empresarial");
    await page.getByRole("button", { name: "Criar lead" }).click();
    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);
    leadUrl = page.url();

    await page.getByRole("button", { name: "Nova oportunidade" }).click();
    await page.getByRole("button", { name: "Criar oportunidade" }).click();
    await expect(page.getByRole("link", { name: /Fazer primeiro contato/ })).toBeVisible();

    const opportunityLink = page.getByRole("link", { name: /Fazer primeiro contato/ });
    const opportunityHref = await opportunityLink.getAttribute("href");
    const opportunityUrl = new URL(opportunityHref!, page.url()).toString();

    await page.goto(opportunityUrl);
    await page.getByRole("button", { name: "Ganhou" }).click();
    await page.getByLabel("Valor final").fill("350");
    await expect(page.getByRole("button", { name: "Registrar ganho" })).toBeEnabled();
    const wonResponse = page.waitForResponse(
      (response) => response.url() === opportunityUrl && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Registrar ganho" }).click();
    await wonResponse;

    await page.reload();
    const clientLink = page.getByRole("link", { name: "Ver cliente" });
    await expect(clientLink).toBeVisible();
    const clientHref = await clientLink.getAttribute("href");
    clientUrl = new URL(clientHref!, page.url()).toString();
    expect(clientUrl).toMatch(/\/clientes\/[0-9a-f-]{36}$/);

    // O mesmo link aparece a partir do lead, sem uma segunda consulta —
    // reaproveita o client_id já carregado com as oportunidades do lead.
    await page.goto(leadUrl);
    await expect(page.getByRole("link", { name: "Ver cliente" })).toHaveAttribute(
      "href",
      new URL(clientUrl).pathname,
    );
  });

  test("2. Central de Clientes mostra o cliente na lista, e o detalhe mostra histórico + handoff honesto", async ({
    page,
  }) => {
    await login(page, SEED_USERS.ana.email);

    await page.goto("/clientes");
    await expect(page.getByRole("link", { name: "Cliente A8 E2E" })).toBeVisible();

    await page.goto(clientUrl);
    await expect(page.getByRole("heading", { name: "Cliente A8 E2E" })).toBeVisible();
    // Aparece duas vezes (resumo do valor total do cliente e item do
    // histórico) — ambas as ocorrências têm de existir, .first() basta
    // para confirmar visibilidade sem violar o modo estrito do Playwright.
    await expect(page.getByText("R$ 350,00").first()).toBeVisible();
    // Mesmo motivo do R$ 350,00 acima: aparece no resumo e no histórico.
    await expect(page.getByText("Empresarial").first()).toBeVisible();

    // Handoff honesto (item 6 do pedido): sem integração configurada,
    // nunca finge que um processo foi criado.
    await expect(page.getByText("Aguardando integração")).toBeVisible();
    await expect(page.getByText(/concluíd[oa]/i)).not.toBeVisible();
  });

  test("3. owner muda o status do cliente; a mudança persiste depois de recarregar", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);
    await page.goto(clientUrl);

    await page.getByLabel("Status do cliente").selectOption("suspenso");
    await page.getByRole("button", { name: "Salvar status" }).click();
    // Restrito ao Topbar: a mesma palavra também existe como <option> do
    // select de status, que ainda "resolve" no locator mesmo oculto.
    await expect(page.getByRole("banner").getByText("Suspenso")).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Status do cliente")).toHaveValue("suspenso");
  });

  test("4. viewer enxerga o cliente, mas nunca o valor financeiro nem os controles de gestão", async ({ page }) => {
    await login(page, SEED_USERS.elisa.email);

    const bodies: string[] = [];
    page.on("response", (response) => {
      const contentType = response.headers()["content-type"] ?? "";
      if (contentType.includes("html") || contentType.includes("json") || contentType.includes("text")) {
        void response
          .text()
          .then((text) => bodies.push(text))
          .catch(() => {});
      }
    });

    await page.goto(clientUrl);
    await expect(page.getByRole("heading", { name: "Cliente A8 E2E" })).toBeVisible();
    await expect(page.getByLabel("Status do cliente")).not.toBeVisible();
    await expect(page.getByLabel("Responsável pelo cliente")).not.toBeVisible();

    await page.waitForTimeout(300);
    const html = await page.content();
    for (const forbidden of ["350,00", "value_cents", "3500"]) {
      expect(html, `HTML final não deve conter "${forbidden}"`).not.toContain(forbidden);
      for (const body of bodies) {
        expect(body, `resposta de rede não deve conter "${forbidden}"`).not.toContain(forbidden);
      }
    }
  });

  test("5. isolamento entre workspaces — cliente de um escritório não existe para outro", async ({ page }) => {
    await login(page, SEED_USERS.bruno.email);
    await page.goto(clientUrl);
    await expect(page.getByText("Cliente A8 E2E")).not.toBeVisible();
  });
});
