import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, type APIRequestContext, type Page } from "@playwright/test";

import { SEED_PASSWORD } from "./fixtures";

export async function login(page: Page, email: string): Promise<void> {
  await page.goto("/entrar");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(SEED_PASSWORD);
  // Scoped ao <form>: a aba "Entrar" (troca de modo) e o botão de submit
  // têm o mesmo texto exato, então um getByRole solto na página inteira é
  // ambíguo — só o formulário tem exatamente um botão "Entrar".
  await page.locator("form").getByRole("button", { name: "Entrar", exact: true }).click();

  // A action é assíncrona (useActionState) — dá tempo real de sobra
  // (auto-retry do expect) antes de decidir que travou. Só se travar de
  // verdade é que vale a pena olhar se apareceu uma Alert de erro; checar
  // page.url() de forma síncrona logo após o clique (como a primeira
  // versão deste helper fazia) sempre pega a URL antiga, antes do
  // redirect acontecer — não é sinal de falha nenhuma.
  try {
    await expect(page).not.toHaveURL(/\/entrar/, { timeout: 8000 });
  } catch (error) {
    const alertText = await page
      .getByRole("alert")
      .first()
      .textContent({ timeout: 1000 })
      .catch(() => null);
    throw new Error(
      `login para ${email} não saiu de /entrar — alerta na tela: ${alertText ?? "(nenhum)"}\n${String(error)}`,
    );
  }
}

export async function logout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Menu do usuário" }).click();
  // "menuitem", não "button": é um item de menu do Radix (mesmo papel
  // ARIA dos itens de "Trocar de workspace"), não um <button> solto.
  await page.getByRole("menuitem", { name: "Sair" }).click();
  await expect(page).toHaveURL(/\/entrar/);
}

export async function switchWorkspace(page: Page, workspaceName: string): Promise<void> {
  await page.getByRole("button", { name: "Trocar de workspace" }).click();
  // Nome direto (substring), não RegExp: nomes de workspace têm
  // parênteses literais (ex.: "Escritório Um (seed)") — um RegExp
  // construído a partir da string trataria "(seed)" como grupo de
  // captura, não texto literal, e nunca bateria com o nome real.
  await page.getByRole("menuitem", { name: workspaceName }).click();

  // switchWorkspaceAction() troca o cookie e faz redirect("/visao-geral")
  // — sem esperar essa navegação terminar, uma chamada seguinte (ex.:
  // page.goto de uma tela que lê o workspace ativo) pode correr na
  // frente do cookie novo ainda não confirmado, lendo o workspace
  // ANTERIOR (achado testando a A4: dependia de listagem escopada ao
  // workspace ativo, que os testes anteriores nunca precisaram fazer
  // logo após trocar). Espera pela URL E pelo texto do seletor de
  // workspace na sidebar refletir o nome novo — o sinal observável que
  // realmente importa, não um proxy indireto (a URL sozinha já se provou
  // insuficiente).
  await expect(page).toHaveURL(/\/visao-geral/, { timeout: 8000 });
  await expect(page.getByRole("button", { name: "Trocar de workspace" })).toContainText(
    workspaceName,
    { timeout: 8000 },
  );
}

/**
 * `.env.local` não é carregado automaticamente no processo do Playwright —
 * só o subprocesso `next start` do webServer o lê (Next.js tem seu próprio
 * carregamento de env; o runner de teste, não). Os testes que chamam a API
 * do Supabase DIRETO, por fora da UI (ver `getSupabaseAccessToken`/
 * `callRpcDirect` abaixo), leem o arquivo à mão — sem depender de nenhum
 * pacote de dotenv, que este projeto não tem como dependência.
 */
export function readSupabaseEnv(): { url: string; anonKey: string } {
  const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  const vars: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) vars[match[1]!] = match[2]!;
  }
  const url = vars.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = vars.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anonKey) {
    throw new Error(
      ".env.local sem NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY — necessário para os testes que chamam a API do Supabase direto (tentativa de escrita negada, concorrência real).",
    );
  }
  return { url, anonKey };
}

/**
 * Autentica DIRETO na API do Supabase (grant_type=password), sem passar
 * pelo navegador — dá um access_token real e independente de qualquer
 * cookie de sessão, usado pelos testes que chamam RPC por fora da UI para
 * provar que a proteção não depende da página Next.js.
 */
export async function getSupabaseAccessToken(request: APIRequestContext, email: string): Promise<string> {
  const { url, anonKey } = readSupabaseEnv();
  const res = await request.post(`${url}/auth/v1/token?grant_type=password`, {
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    data: { email, password: SEED_PASSWORD },
  });
  const body = (await res.json()) as { access_token?: string };
  if (!res.ok() || !body.access_token) {
    throw new Error(`Falha ao autenticar ${email} direto na API do Supabase: ${res.status()} ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

/** Chama uma RPC do Supabase direto via REST (PostgREST), por fora do
 * Server Action/Next.js — é assim que se testa que a recusa não depende
 * só da tela. */
export async function callRpcDirect(
  request: APIRequestContext,
  accessToken: string,
  fn: string,
  args: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const { url, anonKey } = readSupabaseEnv();
  const res = await request.post(`${url}/rest/v1/rpc/${fn}`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    data: args,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status(), body };
}
