import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { SEED_PAINEL } from "./fixtures";
import { login } from "./helpers";

/**
 * A11 — jornada de ponta a ponta com dados fictícios.
 *
 * Roda contra o Supabase local do CI, com `A11_INGEST_MODE=test-adapters`:
 * Turnstile, rate limit e publicação são substituídos por adaptadores de
 * teste, que o código RECUSA em produção e preview. A RPC transacional
 * exercida é exatamente a de produção.
 */

test.describe.serial("A11 — formulários próprios e atribuição", () => {
  let publicKey: string;

  async function submit(
    request: APIRequestContext,
    key: string,
    overrides: Record<string, unknown> = {},
  ) {
    const body = {
      sourceEventId: crypto.randomUUID(),
      contractVersion: 1,
      occurredAt: new Date().toISOString(),
      turnstileToken: "teste-turnstile-ok",
      contact: {
        name: "Visitante do Site",
        type: "pf",
        email: "visitante@exemplo.test",
        phone: "(11) 98888-7777",
      },
      answers: { motivo: "Rescisão indireta" },
      attribution: { channel: "formulario", source: "google", campaign: "marca" },
      consent: { decision: "granted", textVersion: "v1" },
      ...overrides,
    };

    return request.post(`/api/forms/${key}`, {
      data: body,
      headers: { "x-vercel-forwarded-for": "203.0.113.55" },
      failOnStatusCode: false,
    });
  }

  test("1. owner configura um formulário pela interface", async ({ page }) => {
    await login(page, SEED_PAINEL.owner.email);
    await page.goto("/configuracoes/formularios");

    await page.getByLabel("Nome").fill("Captação e2e");
    await page.getByLabel("Área jurídica").fill("Trabalhista");
    await page.getByLabel("Prazo da atividade inicial (minutos)").fill("90");
    await page.getByLabel("Ação do Turnstile").fill("formulario");
    // O verificador de teste exige "localhost" na lista — mesma
    // conferência de hostname do verificador real.
    await page.getByLabel("Domínios permitidos (separados por vírgula)").fill("localhost");
    await page.getByRole("button", { name: "Criar formulário" }).click();

    const alert = page.getByText("/api/forms/", { exact: false });
    await expect(alert).toBeVisible();
    const text = (await alert.innerText()).trim();
    publicKey = text.split("/api/forms/")[1]!.trim();
    expect(publicKey.length).toBeGreaterThan(20);
  });

  test("2. submissão pública materializa contato, demanda, oportunidade e atividade", async ({
    page,
    request,
  }) => {
    const response = await submit(request, publicKey);
    expect(response.status()).toBe(202);

    const body = (await response.json()) as Record<string, unknown>;
    // A resposta pública devolve SÓ o protocolo opaco e um estado
    // genérico — nunca id interno, contato, lead ou oportunidade.
    expect(Object.keys(body).sort()).toEqual(["protocol", "status"]);
    expect(body.status).toBe("received");
    expect(String(body.protocol).length).toBeGreaterThan(10);

    await login(page, SEED_PAINEL.owner.email);
    await page.goto("/leads");
    await expect(page.getByText("Visitante do Site").first()).toBeVisible();
  });

  test("3. a mesma submissão repetida não cria nada novo e responde igual", async ({ request }) => {
    const sourceEventId = crypto.randomUUID();
    const first = await submit(request, publicKey, { sourceEventId });
    const second = await submit(request, publicKey, { sourceEventId });

    expect(first.status()).toBe(202);
    // Mesmo status e mesmo corpo: repetição é indistinguível de novidade.
    expect(second.status()).toBe(202);
    expect(await second.json()).toEqual(await first.json());
  });

  test("4. mesma chave com conteúdo diferente é recusada com 409", async ({ request }) => {
    const sourceEventId = crypto.randomUUID();
    await submit(request, publicKey, { sourceEventId });
    const conflicting = await submit(request, publicKey, {
      sourceEventId,
      contact: { name: "Outra Pessoa", type: "pf", email: "outra@exemplo.test" },
    });

    expect(conflicting.status()).toBe(409);
    expect((await conflicting.json()).error).toBe("idempotency_payload_conflict");
  });

  test("5. honeypot, token inválido e chave desconhecida são recusados", async ({ request }) => {
    const honeypot = await submit(request, publicKey, { website: "http://spam.test" });
    expect(honeypot.status()).toBe(400);

    const badToken = await submit(request, publicKey, { turnstileToken: "token-qualquer" });
    expect(badToken.status()).toBe(403);

    const unknownKey = await submit(request, "chave-que-nao-existe-aaaaaa");
    expect(unknownKey.status()).toBe(404);
    expect((await unknownKey.json()).error).toBe("form_endpoint_unavailable");
  });

  test("6. a sequência de origem aparece no Perfil 360", async ({ page }) => {
    await login(page, SEED_PAINEL.owner.email);
    await page.goto("/leads");
    await page.getByText("Visitante do Site").first().click();
    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);

    await page.getByRole("tab", { name: "Origem" }).click();
    await expect(page.getByRole("heading", { name: "Origem e atribuição" })).toBeVisible();
    await expect(page.getByText("formulario · google").first()).toBeVisible();
    // Primeiro toque e conversão coincidem na captação de origem.
    await expect(page.getByText("Primeiro toque").first()).toBeVisible();
    await expect(page.getByText("Conversão").first()).toBeVisible();
  });

  test("7. o painel mostra origem nos três modelos, com primeiro toque como padrão", async ({ page }) => {
    await login(page, SEED_PAINEL.owner.email);
    await page.goto("/visao-geral");

    const section = page.getByRole("region", { name: "Origem das oportunidades" });
    await expect(section).toBeVisible();

    // Primeiro toque é o modelo INICIAL: marcado sem nada na URL.
    const models = page.getByRole("navigation", { name: "Modelo de atribuição" });
    await expect(models.getByRole("link", { name: "Primeiro toque" })).toHaveAttribute("aria-current", "true");

    await models.getByRole("link", { name: "Último toque" }).click();
    await expect(page).toHaveURL(/modelo=last_touch/);
    await expect(models.getByRole("link", { name: "Último toque" })).toHaveAttribute("aria-current", "true");

    await models.getByRole("link", { name: "Conversão" }).click();
    await expect(page).toHaveURL(/modelo=conversion/);

    // Voltar e avançar mantêm URL e interface sincronizadas.
    await page.goBack();
    await expect(page).toHaveURL(/modelo=last_touch/);
    await expect(models.getByRole("link", { name: "Último toque" })).toHaveAttribute("aria-current", "true");

    await page.goForward();
    await expect(page).toHaveURL(/modelo=conversion/);
    await expect(models.getByRole("link", { name: "Conversão" })).toHaveAttribute("aria-current", "true");
  });

  test("8. filtrar por origem é coerente com o modelo e pode ser limpo", async ({ page }) => {
    await login(page, SEED_PAINEL.owner.email);
    await page.goto("/visao-geral");

    const section = page.getByRole("region", { name: "Origem das oportunidades" });
    await section.getByRole("link", { name: "google" }).click();
    await expect(page).toHaveURL(/origem=google/);

    await page.getByRole("link", { name: "Limpar origem" }).click();
    await expect(page).toHaveURL(/\/visao-geral$/);
  });

  test("9. desativar o formulário derruba a captação sem apagar o que já entrou", async ({
    page,
    request,
  }) => {
    await login(page, SEED_PAINEL.owner.email);
    await page.goto("/configuracoes/formularios");

    const card = page.locator("li", { hasText: "Captação e2e" });
    const eventosAntes = await card.getByText(/Eventos recebidos:/).innerText();

    await card.getByRole("button", { name: "Desativar" }).click();
    await expect(card.getByText("Desativado")).toBeVisible();

    // Chave válida, endpoint desativado: MESMA recusa genérica de uma
    // chave inexistente — sem revelar que o formulário existe.
    const refused = await submit(request, publicKey);
    expect(refused.status()).toBe(404);
    expect((await refused.json()).error).toBe("form_endpoint_unavailable");

    await page.reload();
    await expect(card.getByText(eventosAntes)).toBeVisible();
  });

  test("10. rotacionar a chave revoga a anterior", async ({ page, request }) => {
    await login(page, SEED_PAINEL.owner.email);
    await page.goto("/configuracoes/formularios");

    const card = page.locator("li", { hasText: "Captação e2e" });
    await card.getByRole("button", { name: "Reativar" }).click();
    await expect(card.getByText("Ativo")).toBeVisible();

    await card.getByRole("button", { name: "Rotacionar chave" }).click();
    const alert = page.getByText("Chave rotacionada", { exact: false });
    await expect(alert).toBeVisible();

    // A chave ANTIGA passa a receber a recusa genérica.
    const withOldKey = await submit(request, publicKey);
    expect(withOldKey.status()).toBe(404);
  });

  test("11. sem erro de console nas telas novas", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });

    await login(page, SEED_PAINEL.owner.email);
    await page.goto("/configuracoes/formularios");
    await page.goto("/visao-geral");
    await expect(page.getByRole("region", { name: "Origem das oportunidades" })).toBeVisible();

    expect(errors).toEqual([]);
  });
});

/** Papel sem permissão não enxerga a tela de configuração. */
test("atendimento não acessa a configuração de formulários", async ({ page }: { page: Page }) => {
  await login(page, SEED_PAINEL.sales.email);
  const response = await page.goto("/configuracoes/formularios");
  expect(response?.status()).toBe(404);
});
