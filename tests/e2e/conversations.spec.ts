import { expect, test } from "@playwright/test";

import { SEED_USERS } from "./fixtures";
import { login } from "./helpers";

/**
 * Jornada da A7 contra o Supabase local do CI. pgTAP
 * (12_a7_conversations.test.sql) e o teste de concorrência real
 * (scripts/a7-concurrency-check.mjs) já cobrem exaustivamente idempotência,
 * isolamento, alcance por papel e consentimento no nível do banco — este
 * arquivo foca no que só um e2e prova de verdade: o fluxo real de UI de
 * ponta a ponta (mensagem recebida → cadastro inicial → conversa →
 * consentimento → resposta simulada → estados de entrega/leitura).
 *
 * `test.describe.serial`: os testes reaproveitam o canal/conversa criados
 * no teste anterior.
 */
test.describe.serial("conversas + simulador de WhatsApp — A7", () => {
  const phoneNumberId = `e2e-phone-${Date.now()}`;
  const fromPhone = "+55 11 96543-2109";
  let conversationUrl: string;

  test("1. cria canal e simula mensagem recebida de número desconhecido", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);

    await page.goto("/configuracoes/simulador-whatsapp");
    await page.getByLabel("Nome do canal").fill("Canal e2e");
    await page.getByLabel("Número (fictício)").fill("+55 11 5555-9999");
    await page.getByLabel("Identificador do número (phone_number_id)").fill(phoneNumberId);
    await page.getByRole("button", { name: "Criar canal" }).click();
    // "Canal e2e" aparece na lista de canais E como <option> do select do
    // formulário de simulação logo abaixo — getByRole("list") escopa só a
    // lista (achado real no CI: strict mode violation do Playwright).
    await expect(page.getByRole("list").getByText("Canal e2e")).toBeVisible();

    await page.getByLabel("Número de quem envia").fill(fromPhone);
    await page.getByLabel("Nome (opcional)").fill("Contato E2E A7");
    await page.getByLabel("Mensagem").fill("Olá, preciso de ajuda jurídica (teste e2e)");
    await page.getByRole("button", { name: "Simular mensagem recebida" }).click();

    const conversationLink = page.getByRole("link", { name: "Ver conversa" });
    await expect(conversationLink).toBeVisible();
    const href = await conversationLink.getAttribute("href");
    conversationUrl = new URL(href!, page.url()).toString();

    await page.goto(conversationUrl);
    await expect(page.getByRole("heading", { name: "Contato E2E A7" })).toBeVisible();
    await expect(page.getByText("Olá, preciso de ajuda jurídica (teste e2e)")).toBeVisible();
    // Número desconhecido: nunca fica com "Vínculo pendente" — já sai
    // totalmente resolvido (contato+lead+oportunidade+atividade automáticos).
    await expect(page.getByText("Vínculo pendente")).toHaveCount(0);
  });

  test("2. envio sem consentimento é bloqueado; registrar consentimento libera", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);
    await page.goto(conversationUrl);

    await expect(page.getByText("Sem consentimento vigente para WhatsApp", { exact: false })).toBeVisible();

    const composer = page.getByPlaceholder("Escreva uma mensagem (simulada)…");
    await composer.fill("Oi! Recebemos sua mensagem.");
    await page.getByRole("button", { name: "Enviar" }).click();
    // O servidor recusa (consent_required) com uma mensagem tratada — nunca
    // um erro cru, nem a mensagem enviada silenciosamente.
    await expect(page.getByText("Sem consentimento vigente para enviar mensagem por este canal", { exact: false })).toBeVisible();
    // O texto continua no <textarea> (não perde o que foi digitado numa
    // falha) — getByText("...") bate nisso também, então checa a ausência
    // de BOLHA de mensagem (item de lista), não de qualquer ocorrência do
    // texto na página (achado real no CI).
    await expect(page.getByRole("listitem").filter({ hasText: "Oi! Recebemos sua mensagem." })).toHaveCount(0);

    await page.getByLabel("Finalidade").fill("Atendimento via WhatsApp (teste e2e)");
    await page.getByRole("button", { name: "Registrar consentimento" }).click();
    await expect(page.getByText("Vigente desde", { exact: false })).toBeVisible();

    await composer.fill("Oi! Recebemos sua mensagem.");
    await page.getByRole("button", { name: "Enviar" }).click();
    await expect(page.getByText("Oi! Recebemos sua mensagem.")).toBeVisible();
  });

  test("3. simular entregue/lida no simulador reflete na tela", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);
    await page.goto(conversationUrl);

    await page.getByRole("button", { name: "SIMULAR" }).first().click();
    await page.getByRole("button", { name: "Marcar entregue" }).click();
    await page.getByRole("button", { name: "SIMULAR" }).first().click();
    await page.getByRole("button", { name: "Marcar lida" }).click();

    // A mensagem lida não oferece mais "SIMULAR" (nada a simular depois de lida).
    await expect(page.getByRole("button", { name: "SIMULAR" })).toHaveCount(0);
  });

  test("4. papel sem permissão de simulador não acessa a tela de configuração", async ({ page }) => {
    await login(page, SEED_USERS.elisa.email);

    await page.goto("/configuracoes/simulador-whatsapp");
    await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
  });
});
