#!/usr/bin/env node
// A11 — teste de concorrência REAL dos agendadores da A11: o workflow antigo do GitHub (rotas /api/cron/outbox e
// /api/cron/retention, uma depois da outra), o reconciliador do Inngest (a11-reconciler-scheduler) e a retenção do
// Inngest (a11-retention-scheduler) podem rodar AO MESMO TEMPO durante a transição. As três pontas chamam as MESMAS
// duas operações: `reconcileOutbox` (src/server/ingest/outbox-reconciler.ts) e `runRetentionMaintenance`
// (src/server/ingest/retention-maintenance.ts).
//
// O que se prova, contra o banco local de verdade, com as três pontas largando juntas rodada após rodada:
//   - nenhum evento é republicado duas vezes (a garantia é do banco: `claim_outbox_batch`, `for update skip locked`
//     e trava de 120 s);
//   - nenhum alerta (travado, a vencer, vencido) é emitido duas vezes, nenhuma expiração é aplicada duas vezes e
//     nenhuma auditoria é gravada duas vezes (`flag_*` e `purge_*` reservam as linhas com `for update skip locked`
//     e gravam o marcador e a auditoria na mesma transação);
//   - nenhuma ponta falha (nenhum deadlock, nenhum erro) e o resultado final é o mesmo de uma execução sozinha;
//   - a rodada seguinte, também simultânea, não repete nenhum efeito concluído.
//
// pgTAP roda numa única transação por arquivo e não prova isso; aqui são conexões genuinamente concorrentes
// (Promise.all). Cada categoria tem MAIS linhas do que cabem num lote (100 por chamada), então as pontas precisam
// dividir o trabalho. O Inngest é substituído por um publicador em memória (nada sai da máquina). Os eventos nascem
// pela RPC oficial de ingestão (`ingest_form_event`, com a retenção e o prazo de "travado" do próprio evento — nenhuma
// tabela é editada). Só dados fictícios, no Postgres descartável do CI.
//
//   NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... \
//     SUPABASE_SECRET_KEY=... node scripts/a11-schedulers-concurrency-check.mjs
//
// Node 24 executa o TypeScript das operações direto (só tipos são importados lá; sem build).

import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

import { reconcileOutbox } from "../src/server/ingest/outbox-reconciler.ts";
import { runRetentionMaintenance } from "../src/server/ingest/retention-maintenance.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const serviceKey = process.env.SUPABASE_SECRET_KEY;

if (!url || !anonKey || !serviceKey) {
  console.error(
    "Faltam NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY no ambiente.",
  );
  process.exit(1);
}

const anon = createClient(url, anonKey);
const admin = createClient(url, serviceKey);

let failed = false;
function assert(condition, message) {
  if (condition) {
    console.log(`OK: ${message}`);
  } else {
    failed = true;
    console.error(`FALHA: ${message}`);
  }
}
const info = (message) => console.log(`INFO: ${message}`);

const { error: signInError } = await anon.auth.signInWithPassword({
  email: "owner-a.seed@praxis.test",
  password: "praxis-seed-nao-e-senha-real",
});
if (signInError) {
  console.error("Não foi possível entrar como o usuário do seed:", signInError.message);
  process.exit(1);
}

const WORKSPACE_ID = "10000000-0000-0000-0000-000000000001";

const { data: pipeline, error: pipelineError } = await anon
  .from("pipelines")
  .select("id")
  .eq("workspace_id", WORKSPACE_ID)
  .eq("is_default", true)
  .single();
if (pipelineError || !pipeline) {
  console.error("Não foi possível achar o pipeline padrão do seed:", pipelineError?.message);
  process.exit(1);
}

const { data: stage, error: stageError } = await anon
  .from("pipeline_stages")
  .select("id")
  .eq("pipeline_id", pipeline.id)
  .eq("position", 0)
  .single();
if (stageError || !stage) {
  console.error("Não foi possível achar a etapa inicial do pipeline:", stageError?.message);
  process.exit(1);
}

const suffix = randomUUID().slice(0, 8);
const { data: endpointResult, error: endpointError } = await anon.rpc("create_form_endpoint", {
  p_workspace_id: WORKSPACE_ID,
  p_name: `CI concorrência agendadores ${suffix}`,
  p_pipeline_id: pipeline.id,
  p_stage_id: stage.id,
  p_legal_area: "Concorrência (CI)",
  p_initial_activity_type: "call",
  p_initial_activity_due_minutes: 60,
  p_capture_mode: "new_intake",
  p_turnstile_action: "ci_concurrency",
  p_allowed_hostnames: ["localhost"],
  p_public_key: `ci-schedulers-concurrency-${suffix}`,
});
if (endpointError || !endpointResult?.id) {
  console.error("Não foi possível criar o endpoint de teste:", endpointError?.message ?? endpointResult);
  process.exit(1);
}
const formEndpointId = endpointResult.id;

// ---- Eventos fictícios, pela RPC oficial de ingestão ---------------------------------------------------------
// Cada categoria tem seu próprio prazo, e só ele decide o que a retenção faz com o evento:
//   outbox   — só a outbox: prazos normais (nada de retenção a fazer);
//   travado  — `p_stuck_after_minutes` negativo: já passou do tempo operacional esperado;
//   avencer  — retenção de 3 dias: entra no alerta antecipado (7 dias antes), sem estar travado;
//   vencido  — retenção de -1 dia e NÃO processado: o vencimento o marca `expired_unprocessed`;
//   processado — retenção de -1 dia e JÁ processado: o vencimento o transforma em tombstone (`purged`).
// Mais do que o lote de 100 por chamada nas três categorias de retenção, para as pontas dividirem o trabalho.
const QUANTIDADE = { outbox: 40, travado: 120, avencer: 120, vencido: 120, processado: 6 };
const PRAZOS = {
  outbox: {},
  travado: { p_stuck_after_minutes: -5 },
  avencer: { p_retention_days: 3, p_stuck_after_minutes: 600 },
  vencido: { p_retention_days: -1, p_stuck_after_minutes: 600 },
  processado: { p_retention_days: -1, p_stuck_after_minutes: 600 },
};

const events = []; // { id, categoria }
for (const [categoria, quantidade] of Object.entries(QUANTIDADE)) {
  for (let i = 0; i < quantidade; i += 1) {
    const { data, error } = await admin.rpc("ingest_form_event", {
      p_form_endpoint_id: formEndpointId,
      p_source_event_id: randomUUID(),
      p_content_hash: `\\x${randomBytes(32).toString("hex")}`,
      p_public_protocol: `ci-schedulers-${suffix}-${categoria}-${i}`,
      p_payload_ciphertext: "\\xde",
      p_payload_iv: `\\x${randomBytes(12).toString("hex")}`,
      p_payload_auth_tag: `\\x${randomBytes(16).toString("hex")}`,
      p_payload_algorithm: "aes-256-gcm",
      p_payload_key_version: "1",
      p_payload_sanitized: {},
      p_occurred_at: new Date().toISOString(),
      ...PRAZOS[categoria],
    });
    if (error || !data?.webhook_event_id) {
      console.error("Falha ao ingerir o evento fictício:", error?.message ?? data);
      process.exit(1);
    }
    events.push({ id: data.webhook_event_id, categoria });
  }
}

// Os "processados" passam pelo worker (RPC oficial) SEM passar pela outbox: evento processado, outbox ainda pendente.
for (const [index, event] of events.filter((e) => e.categoria === "processado").entries()) {
  const { error } = await admin.rpc("process_form_event", {
    p_webhook_event_id: event.id,
    p_input: {
      contact: { name: `Visitante CI Agendadores ${suffix} ${index}` },
      attribution: { channel: "formulario" },
      consent: {
        decision: "granted",
        channel: "email",
        legal_basis: "consentimento",
        purpose: "Teste de concorrência (CI)",
      },
    },
  });
  if (error) {
    console.error("Falha ao processar o evento fictício:", error.message);
    process.exit(1);
  }
}

const idsDe = (...categorias) => events.filter((e) => categorias.includes(e.categoria)).map((e) => e.id);
const todosOsIds = events.map((e) => e.id);
const categoriaDe = new Map(events.map((e) => [e.id, e.categoria]));

// Consultas em pedaços (a lista de ids vai na URL).
async function selecionar(tabela, colunas, coluna, ids) {
  const linhas = [];
  for (let i = 0; i < ids.length; i += 40) {
    const { data, error } = await admin.from(tabela).select(colunas).in(coluna, ids.slice(i, i + 40));
    if (error) {
      console.error(`Falha ao ler ${tabela}:`, error.message);
      process.exit(1);
    }
    linhas.push(...data);
  }
  return linhas;
}

const outboxAntes = await selecionar("outbox", "webhook_event_id, state", "webhook_event_id", todosOsIds);
assert(
  outboxAntes.length === todosOsIds.length && outboxAntes.every((row) => row.state === "pending"),
  `Ponto de partida: ${todosOsIds.length} eventos, cada um com a outbox pendente`,
);
const eventosAntes = await selecionar("webhook_events", "id, status, stuck_alerted_at, expiring_alerted_at, purged_at", "id", todosOsIds);
assert(
  eventosAntes.every((row) => row.stuck_alerted_at === null && row.expiring_alerted_at === null && row.purged_at === null),
  "Ponto de partida: nenhum evento alertado nem vencido ainda",
);

// ---- Os três atores ------------------------------------------------------------------------------------------
const published = []; // { origem, webhookEventId }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const publisher = (origem) => async ({ webhookEventId }) => {
  await sleep(5);
  published.push({ origem, webhookEventId });
};

// Os alertas saem como sempre: uma linha estruturada em console.warn, só com identificadores. Aqui são recolhidos.
const alerts = []; // { level, event, kind, webhook_event_id, workspace_id }
const warnOriginal = console.warn;
function recolherAlertas() {
  console.warn = (...args) => {
    try {
      const parsed = JSON.parse(String(args[0]));
      if (parsed?.event === "a11.ingest.alert") {
        alerts.push(parsed);
        return;
      }
    } catch {
      // não é um alerta da retenção: segue para o log normal
    }
    warnOriginal(...args);
  };
}
const pararDeRecolher = () => {
  console.warn = warnOriginal;
};

const totais = {
  workflow: { stuck: 0, expiring: 0, purged: 0, expired_unprocessed: 0 },
  inngest: { stuck: 0, expiring: 0, purged: 0, expired_unprocessed: 0 },
};
const somar = (origem, resumo) => {
  for (const chave of Object.keys(totais[origem])) totais[origem][chave] += resumo[chave];
};

// O workflow antigo chama a outbox e, DEPOIS, a retenção (dois passos de curl, um após o outro). O reconciliador e a
// retenção do Inngest são duas funções independentes. As três pontas largam juntas.
async function rodada() {
  const workflow = (async () => {
    const outbox = await reconcileOutbox(admin, publisher("workflow"));
    const retention = await runRetentionMaintenance(admin);
    somar("workflow", retention);
    return { outbox, retention };
  })();
  const inngestReconciler = reconcileOutbox(admin, publisher("inngest"));
  const inngestRetention = runRetentionMaintenance(admin).then((retention) => {
    somar("inngest", retention);
    return retention;
  });
  return Promise.allSettled([workflow, inngestReconciler, inngestRetention]);
}

const publicaveis = new Set(idsDe("outbox", "travado", "avencer"));
const publicadosDeNos = () => new Set(published.map((p) => p.webhookEventId).filter((id) => publicaveis.has(id)));

const falhas = [];
recolherAlertas();
let primeira = null;
let rodadas = 0;
for (let round = 1; round <= 40; round += 1) {
  rodadas = round;
  const results = await rodada();
  for (const result of results) {
    if (result.status === "rejected") falhas.push(`rodada ${round}: ${result.reason?.code ?? result.reason?.name ?? "erro"}`);
  }
  if (round === 1) primeira = results;
  if (publicadosDeNos().size >= publicaveis.size) break;
}
pararDeRecolher();
info(`${rodadas} rodada(s) de três pontas simultâneas; workflow = ${JSON.stringify(totais.workflow)}; inngest = ${JSON.stringify(totais.inngest)}`);

assert(falhas.length === 0, `Nenhuma ponta falhou em nenhuma rodada (nenhum deadlock, nenhum erro) ${falhas.join(", ")}`.trim());

// ---- 1. Outbox: ninguém republicado duas vezes ----------------------------------------------------------------
const vezes = new Map();
for (const item of published) vezes.set(item.webhookEventId, (vezes.get(item.webhookEventId) ?? 0) + 1);
const dasCategorias = (...categorias) => idsDe(...categorias).map((id) => vezes.get(id) ?? 0);

assert(
  dasCategorias("outbox", "travado", "avencer").every((n) => n === 1),
  "Nenhum evento publicável foi republicado: cada um foi publicado exatamente uma vez",
);
assert(dasCategorias("vencido").every((n) => n <= 1), "Evento vencido: no máximo uma publicação (nunca duas)");
assert(dasCategorias("processado").every((n) => n === 0), "Evento já processado nunca é republicado");
assert([...vezes.values()].every((n) => n === 1), "Nenhuma publicação repetida em todo o banco, em todas as rodadas");

if (primeira && primeira[1]?.status === "fulfilled" && primeira[0]?.status === "fulfilled") {
  const w = primeira[0].value.outbox;
  const g = primeira[1].value;
  assert(
    w.claimed > 0 && g.claimed > 0,
    `Na primeira rodada o workflow e o reconciliador do Inngest dividiram a outbox (workflow: ${w.claimed}, inngest: ${g.claimed})`,
  );
  assert(w.claimed <= 20 && g.claimed <= 20, "Nenhuma das duas reservou mais de 20 por lote");
}

// ---- 2. Auditoria e alertas: nada em duplicidade --------------------------------------------------------------
const auditoria = await selecionar("audit_logs", "resource_id, action", "resource_id", todosOsIds);
const auditoriaDeNos = auditoria.filter((row) => row.action.startsWith("webhook_event."));
const porAuditoria = new Map();
for (const row of auditoriaDeNos) {
  const chave = `${row.action}|${row.resource_id}`;
  porAuditoria.set(chave, (porAuditoria.get(chave) ?? 0) + 1);
}
assert([...porAuditoria.values()].every((n) => n === 1), "Nenhuma auditoria foi gravada duas vezes (por ação e evento)");

const auditados = (acao, ...categorias) => idsDe(...categorias).map((id) => porAuditoria.get(`${acao}|${id}`) ?? 0);
assert(auditados("webhook_event.stuck", "travado").every((n) => n === 1), `Cada evento travado teve UM alerta de travado (${QUANTIDADE.travado})`);
assert(
  auditados("webhook_event.expiring_unprocessed", "avencer").every((n) => n === 1),
  `Cada evento a vencer teve UM alerta antecipado de vencimento (${QUANTIDADE.avencer})`,
);
assert(
  auditados("webhook_event.expired_unprocessed", "vencido").every((n) => n === 1),
  `Cada evento vencido sem processamento foi expirado UMA vez (${QUANTIDADE.vencido})`,
);
assert(
  auditados("webhook_event.purged", "processado").every((n) => n === 1),
  `Cada evento vencido já processado virou tombstone UMA vez (${QUANTIDADE.processado})`,
);
assert(
  auditados("webhook_event.expiring_unprocessed", "vencido").every((n) => n <= 1) &&
    auditados("webhook_event.stuck", "outbox", "avencer", "vencido", "processado").every((n) => n === 0) &&
    auditados("webhook_event.expiring_unprocessed", "outbox", "travado", "processado").every((n) => n === 0),
  "Nenhum alerta ou auditoria fora do lugar (só o que cada categoria deve receber)",
);

const porAlerta = new Map();
for (const alert of alerts) {
  const chave = `${alert.kind}|${alert.webhook_event_id}`;
  porAlerta.set(chave, (porAlerta.get(chave) ?? 0) + 1);
}
const dosNossos = [...porAlerta.entries()].filter(([chave]) => categoriaDe.has(chave.split("|")[1]));
assert(dosNossos.length > 0 && dosNossos.every(([, n]) => n === 1), "Nenhum alerta estruturado foi emitido duas vezes (por tipo e evento)");
const alertasDe = (tipo) => dosNossos.filter(([chave]) => chave.startsWith(`${tipo}|`)).length;
const auditoriasDe = (acao) => [...porAuditoria.keys()].filter((chave) => chave.startsWith(`${acao}|`)).length;
assert(
  alertasDe("stuck") === auditoriasDe("webhook_event.stuck") &&
    alertasDe("expiring_unprocessed") === auditoriasDe("webhook_event.expiring_unprocessed") &&
    alertasDe("expired_unprocessed") === auditoriasDe("webhook_event.expired_unprocessed"),
  "Cada alerta emitido corresponde a exatamente uma auditoria gravada",
);
assert(
  alerts.every((alert) => Object.keys(alert).sort().join(",") === "event,kind,level,webhook_event_id,workspace_id"),
  "O alerta no log leva só os cinco campos de sempre (nenhum dado pessoal)",
);
assert(
  totais.workflow.stuck + totais.inngest.stuck >= QUANTIDADE.travado &&
    totais.workflow.purged + totais.inngest.purged >= QUANTIDADE.processado &&
    totais.workflow.expired_unprocessed + totais.inngest.expired_unprocessed >= QUANTIDADE.vencido,
  "As contagens devolvidas pelas duas retenções somam, no mínimo, tudo o que foi feito",
);

// ---- 3. Estado final no banco ---------------------------------------------------------------------------------
const eventosDepois = await selecionar(
  "webhook_events",
  "id, status, stuck_alerted_at, expiring_alerted_at, purged_at, payload_ciphertext",
  "id",
  todosOsIds,
);
const dosEventos = (categoria) => eventosDepois.filter((row) => categoriaDe.get(row.id) === categoria);
assert(
  dosEventos("vencido").every((row) => row.status === "expired_unprocessed" && row.purged_at !== null && row.payload_ciphertext === null),
  "Vencidos sem processamento: `expired_unprocessed`, conteúdo eliminado, tombstone preservada",
);
assert(
  dosEventos("processado").every((row) => row.status === "processed" && row.purged_at !== null && row.payload_ciphertext === null),
  "Vencidos já processados: continuam `processed`, conteúdo eliminado",
);
assert(
  dosEventos("travado").every((row) => row.stuck_alerted_at !== null && row.purged_at === null) &&
    dosEventos("avencer").every((row) => row.expiring_alerted_at !== null && row.purged_at === null) &&
    dosEventos("outbox").every((row) => row.stuck_alerted_at === null && row.expiring_alerted_at === null && row.purged_at === null),
  "Travados e a vencer só marcados (nada apagado); os demais, intocados",
);

const outboxDepois = await selecionar("outbox", "webhook_event_id, state, locked_at, lock_expires_at", "webhook_event_id", todosOsIds);
const estados = (categoria) => outboxDepois.filter((row) => categoriaDe.get(row.webhook_event_id) === categoria).map((row) => row.state);
assert(
  ["outbox", "travado", "avencer"].every((c) => estados(c).every((s) => s === "published")),
  "Outbox dos eventos publicáveis: todas `published`",
);
assert(estados("vencido").every((s) => s === "abandoned" || s === "published"), "Outbox dos vencidos: `abandoned` (ou `published` se a publicação ganhou a corrida)");
assert(estados("processado").every((s) => s === "resolved"), "Outbox dos já processados: convergida (`resolved`), nunca publicada");
assert(outboxDepois.every((row) => row.locked_at === null && row.lock_expires_at === null), "Nenhum lock remanescente");

// ---- 4. A rodada seguinte, também simultânea, não repete nada --------------------------------------------------
const publicacoesAntes = published.length;
const auditoriaAntes = auditoriaDeNos.length;
const alertasAntes = alerts.length;
recolherAlertas();
const extra = await rodada();
pararDeRecolher();
assert(extra.every((r) => r.status === "fulfilled"), "Rodada extra: nenhuma ponta falhou");
const auditoriaDepois = (await selecionar("audit_logs", "resource_id, action", "resource_id", todosOsIds)).filter((row) =>
  row.action.startsWith("webhook_event."),
);
assert(
  published.length === publicacoesAntes && auditoriaDepois.length === auditoriaAntes && alerts.length === alertasAntes,
  "Rodada seguinte, também simultânea, não repete nenhuma publicação, alerta, expiração nem auditoria",
);

if (failed) {
  console.error("\nTeste de concorrência dos agendadores da A11 FALHOU.");
  process.exit(1);
}
console.log("\nTeste de concorrência dos agendadores da A11 passou.");
