/**
 * B2 — recuperação adicional da agenda (§9.2, item 2), chamada pelo workflow
 * manual `.github/workflows/b2-calendar-recovery.yml`. Roda direto no Node 24
 * (só tipos apagáveis) e é importado pelos testes.
 *
 * Os dois segredos (cron e bypass da Vercel) só saem para um destino da lista
 * APROVADA, por comparação exata da string informada: nada de normalizar,
 * completar ou aceitar parecidos. Com destino recusado ou segredo ausente,
 * nenhuma requisição é feita. O bypass vai por cabeçalho (nunca na URL) e
 * redirecionamento não é seguido.
 */
import { pathToFileURL } from "node:url";

/** Únicos destinos aceitos. Hoje: o Preview da branch de validação. */
export const APPROVED_TARGETS: readonly string[] = ["https://praxis-crm-git-validacao-b2-johllls-projects.vercel.app"];

export type RecoveryEnv = {
  TARGET_URL?: string | undefined;
  CRON_SECRET?: string | undefined;
  BYPASS_SECRET?: string | undefined;
};

export type RecoveryResult =
  | { ok: true; status: number; body: string }
  | { ok: false; reason: "target_not_approved" | "missing_cron_secret" | "missing_bypass_secret" | "redirect_refused" | "http_error" | "network_error"; status?: number; body?: string };

type Fetch = (url: string, init: { method: string; redirect: "manual"; headers: Record<string, string> }) => Promise<{ status: number; text(): Promise<string> }>;

/** O destino aprovado (idêntico ao informado) ou `null`. */
export function approvedTarget(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const match = APPROVED_TARGETS.find((target) => target === raw);
  if (!match) return null;
  // Defesa extra: o aprovado é uma origem HTTPS pura (sem credenciais, caminho,
  // parâmetros nem fragmento).
  const url = new URL(match);
  if (url.protocol !== "https:" || url.origin !== match || url.username || url.password) return null;
  return match;
}

export async function runRecovery(env: RecoveryEnv, fetchImpl: Fetch): Promise<RecoveryResult> {
  const target = approvedTarget(env.TARGET_URL);
  if (!target) return { ok: false, reason: "target_not_approved" };
  if (!env.CRON_SECRET) return { ok: false, reason: "missing_cron_secret" };
  if (!env.BYPASS_SECRET) return { ok: false, reason: "missing_bypass_secret" };

  let response: { status: number; text(): Promise<string> };
  try {
    response = await fetchImpl(`${target}/api/cron/calendar?source=github`, {
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${env.CRON_SECRET}`,
        "x-vercel-protection-bypass": env.BYPASS_SECRET,
      },
    });
  } catch {
    return { ok: false, reason: "network_error" };
  }
  // `redirect: "manual"`: um 3xx (ou a resposta opaca, status 0) não é seguido.
  if (response.status === 0 || (response.status >= 300 && response.status < 400)) {
    return { ok: false, reason: "redirect_refused", status: response.status };
  }
  // O corpo da rota tem só o desfecho e contagens (nunca conteúdo de evento).
  const body = await response.text();
  if (response.status < 200 || response.status >= 300) return { ok: false, reason: "http_error", status: response.status, body };
  return { ok: true, status: response.status, body };
}

async function main() {
  const result = await runRecovery(
    { TARGET_URL: process.env.TARGET_URL, CRON_SECRET: process.env.CRON_SECRET, BYPASS_SECRET: process.env.BYPASS_SECRET },
    (url, init) => fetch(url, init),
  );
  if (result.ok) {
    console.log(`${result.body}\nHTTP ${result.status}`);
    return;
  }
  // Nunca imprime a URL com parâmetros nem os segredos: só o motivo, o status e o corpo da rota.
  console.error(`recuperação não executada: ${result.reason}${result.status !== undefined ? ` (HTTP ${result.status})` : ""}`);
  if (result.body) console.error(result.body);
  process.exitCode = 1;
}

// Executado direto (`node scripts/b2-calendar-recovery.ts`); importado pelos testes, não roda.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
