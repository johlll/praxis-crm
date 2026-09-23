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

// occurredAt agora integra o hash de idempotência (item 1 da auditoria
// pós-dry-run): precisa ser ESTÁVEL entre chamadas que reutilizam o
// mesmo sourceEventId (testes 3 e 4), exatamente como o exemplo de
// integração documenta (persistido junto do sourceEventId, nunca
// recalculado a cada tentativa). Um valor fixo para todo o arquivo serve
// tão bem quanto, já que nenhum teste depende do instante real.
const DEFAULT_OCCURRED_AT = new Date().toISOString();

test.describe.serial("A11 — formulários próprios e atribuição", () => {
  let publicKey: string;

  /**
   * O rate limit é por endpoint e por IP, com janela de um minuto. Cada
   * teste usa o SEU IP para não gastar a cota do outro — o limite em si é
   * exercido no teste dedicado, com um IP só dele.
   */
  async function submit(
    request: APIRequestContext,
    key: string,
    overrides: Record<string, unknown> = {},
    ip = "203.0.113.55",
    extraHeaders: Record<string, string> = {},
  ) {
    const body = {
      sourceEventId: crypto.randomUUID(),
      contractVersion: 1,
      occurredAt: DEFAULT_OCCURRED_AT,
      turnstileToken: "teste-turnstile-ok",
      contact: {
        name: "Visitante do Site",
        type: "pf",
        email: "visitante@exemplo.test",
        phone: "(11) 98888-7777",
      },
      answers: { motivo: "Rescisão indireta" },
      attribution: { channel: "formulario", source: "google", campaign: "marca" },
      // decision=granted exige textVersion E acceptedText: o texto
      // REALMENTE apresentado ao visitante (item 7 da auditoria
      // pós-dry-run) — sem isso a submissão é recusada por schema.
      consent: { decision: "granted", textVersion: "v1", acceptedText: "Concordo com o tratamento dos meus dados para contato." },
      ...overrides,
    };

    return request.post(`/api/forms/${key}`, {
      data: body,
      headers: { "x-vercel-forwarded-for": ip, ...extraHeaders },
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

    // Configura o campo "motivo" (item 6 da auditoria pós-dry-run): sem
    // isto, a borda recusaria a submissão do teste 2 por campo não
    // configurado — a lista de campos deixou de ser decorativa.
    await page.getByRole("button", { name: "Adicionar campo" }).click();
    await page.getByLabel("Chave do campo").fill("motivo");
    await page.getByLabel("Rótulo do campo").fill("Motivo do contato");

    await page.getByRole("button", { name: "Criar formulário" }).click();

    // O endereço aparece no aviso de sucesso e também na lista de
    // formulários logo abaixo: a chave é lida do aviso.
    const alert = page.getByRole("alert").filter({ hasText: "Formulário criado" }).getByRole("code");
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
    const raw = await response.text();
    // Corpo no diagnóstico: se a resposta não for a esperada, o log mostra
    // o que o servidor respondeu, sem precisar de nova execução.
    expect(response.status(), `chave=${publicKey} corpo=${raw.slice(0, 300)}`).toBe(202);

    const body = JSON.parse(raw) as Record<string, unknown>;
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
    const first = await submit(request, publicKey, { sourceEventId }, "203.0.113.56");
    const second = await submit(request, publicKey, { sourceEventId }, "203.0.113.56");

    expect(first.status()).toBe(202);
    // Mesmo status e mesmo corpo: repetição é indistinguível de novidade.
    expect(second.status()).toBe(202);
    expect(await second.json()).toEqual(await first.json());
  });

  test("4. mesma chave com conteúdo diferente é recusada com 409", async ({ request }) => {
    const sourceEventId = crypto.randomUUID();
    await submit(request, publicKey, { sourceEventId }, "203.0.113.57");
    const conflicting = await submit(
      request,
      publicKey,
      { sourceEventId, contact: { name: "Outra Pessoa", type: "pf", email: "outra@exemplo.test" } },
      "203.0.113.57",
    );

    expect(conflicting.status()).toBe(409);
    expect((await conflicting.json()).error).toBe("idempotency_payload_conflict");
  });

  test("5. honeypot, token inválido e chave desconhecida são recusados", async ({ request }) => {
    const honeypot = await submit(request, publicKey, { website: "http://spam.test" }, "203.0.113.58");
    expect(honeypot.status()).toBe(400);

    const badToken = await submit(request, publicKey, { turnstileToken: "token-qualquer" }, "203.0.113.58");
    expect(badToken.status()).toBe(403);

    const unknownKey = await submit(request, "chave-que-nao-existe-aaaaaa", {}, "203.0.113.58");
    expect(unknownKey.status()).toBe(404);
    expect((await unknownKey.json()).error).toBe("form_endpoint_unavailable");
  });

  test("5b. o rate limit recusa o excesso vindo do mesmo IP", async ({ request }) => {
    const ip = "203.0.113.59";
    const respostas: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const resposta = await submit(request, publicKey, {}, ip);
      respostas.push(resposta.status());
    }
    // As primeiras passam; a partir do limite da janela, a recusa é 429 —
    // e nada depois dela é aceito.
    expect(respostas).toContain(429);
    expect(respostas.at(-1)).toBe(429);
    expect(respostas.indexOf(429)).toBeGreaterThan(0);
  });

  test("5c. CORS: origem autorizada recebe Access-Control-Allow-Origin exato; origem recusada, nenhum", async ({
    request,
  }) => {
    const ip = "203.0.113.62";

    // Preflight de uma origem AUTORIZADA (hostname "localhost", igual ao
    // declarado na criação do endpoint no teste 1).
    const preflightOk = await request.fetch(`/api/forms/${publicKey}`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost",
        "access-control-request-method": "POST",
      },
      failOnStatusCode: false,
    });
    expect(preflightOk.headers()["access-control-allow-origin"]).toBe("http://localhost");
    expect(preflightOk.headers()["access-control-allow-methods"] ?? "").toContain("POST");

    // Preflight de uma origem NÃO autorizada: nenhum cabeçalho de CORS —
    // o navegador bloqueia o POST antes de enviá-lo.
    const preflightRecusado = await request.fetch(`/api/forms/${publicKey}`, {
      method: "OPTIONS",
      headers: {
        origin: "https://atacante.test",
        "access-control-request-method": "POST",
      },
      failOnStatusCode: false,
    });
    expect(preflightRecusado.headers()["access-control-allow-origin"]).toBeUndefined();

    // A resposta de SUCESSO do POST também carrega o cabeçalho para a
    // origem autorizada — não só o preflight.
    const postOk = await submit(request, publicKey, {}, ip, { origin: "http://localhost" });
    expect(postOk.status()).toBe(202);
    expect(postOk.headers()["access-control-allow-origin"]).toBe("http://localhost");

    // E uma resposta de ERRO (aqui, honeypot) também — origem autorizada
    // precisa conseguir LER o erro, não só o sucesso.
    const postErro = await submit(request, publicKey, { website: "http://spam.test" }, ip, {
      origin: "http://localhost",
    });
    expect(postErro.status()).toBe(400);
    expect(postErro.headers()["access-control-allow-origin"]).toBe("http://localhost");

    // Origem não autorizada: o POST ainda é processado no servidor (CORS
    // não é uma barreira de rede), mas sem cabeçalho — o navegador
    // bloqueia a LEITURA da resposta pelo JS da página atacante.
    const postRecusado = await submit(request, publicKey, {}, ip, { origin: "https://atacante.test" });
    expect(postRecusado.headers()["access-control-allow-origin"]).toBeUndefined();
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
    const refused = await submit(request, publicKey, {}, "203.0.113.60");
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
    const withOldKey = await submit(request, publicKey, {}, "203.0.113.61");
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
