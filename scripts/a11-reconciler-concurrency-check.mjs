#!/usr/bin/env node
// A11 — teste de concorrência REAL do reconciliador da outbox: o workflow do GitHub (rota /api/cron/outbox) e o
// agendador do Inngest (a11-reconciler-scheduler) chamam a MESMA operação (`reconcileOutbox`,
// src/server/ingest/outbox-reconciler.ts). Enquanto os dois convivem (transição), eles podem rodar ao mesmo tempo.
//
// O que se prova, contra o banco local de verdade: duas execuções simultâneas NUNCA publicam o mesmo evento duas
// vezes — a garantia é do banco (`claim_outbox_batch` com `for update skip locked` e trava de 120 s), reaproveitada
// sem lógica nova. Mais linhas pendentes (30) do que cabem num lote (20): as duas execuções precisam dividir o
// trabalho, e o resultado final tem de ser "cada evento publicado exatamente uma vez".
//
// pgTAP roda numa única transação por arquivo e não prova isso; aqui são duas conexões genuinamente concorrentes
// (Promise.all). O Inngest é substituído por um publicador em memória (nada sai da máquina). Só dados fictícios,
// no Postgres descartável do CI.
//
//   NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... \
//     SUPABASE_SECRET_KEY=... node scripts/a11-reconciler-concurrency-check.mjs
//
// Node 24 executa o TypeScript da operação direto (só tipos são importados lá; sem build).

import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

import { reconcileOutbox } from "../src/server/ingest/outbox-reconciler.ts";

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
  p_name: `CI concorrência reconciliador ${suffix}`,
  p_pipeline_id: pipeline.id,
  p_stage_id: stage.id,
  p_legal_area: "Concorrência (CI)",
  p_initial_activity_type: "call",
  p_initial_activity_due_minutes: 60,
  p_capture_mode: "new_intake",
  p_turnstile_action: "ci_concurrency",
  p_allowed_hostnames: ["localhost"],
  p_public_key: `ci-reconciler-concurrency-${suffix}`,
});
if (endpointError || !endpointResult?.id) {
  console.error("Não foi possível criar o endpoint de teste:", endpointError?.message ?? endpointResult);
  process.exit(1);
}
const formEndpointId = endpointResult.id;

// 30 eventos fictícios pela RPC oficial de ingestão (a mesma da rota pública): cada um nasce com uma outbox
// `pending`. São mais do que cabem num lote de reserva (20), então duas execuções precisam dividir o trabalho.
const TOTAL = 30;
const sourceIds = [];
for (let i = 0; i < TOTAL; i += 1) {
  const sourceEventId = randomUUID();
  sourceIds.push(sourceEventId);
  const { error: ingestError } = await admin.rpc("ingest_form_event", {
    p_form_endpoint_id: formEndpointId,
    p_source_event_id: sourceEventId,
    p_content_hash: `\\x${randomBytes(32).toString("hex")}`,
    p_public_protocol: `ci-reconciler-${suffix}-${i}`,
    p_payload_ciphertext: "\\xde",
    p_payload_iv: `\\x${randomBytes(12).toString("hex")}`,
    p_payload_auth_tag: `\\x${randomBytes(16).toString("hex")}`,
    p_payload_algorithm: "aes-256-gcm",
    p_payload_key_version: "1",
    p_payload_sanitized: {},
    p_occurred_at: new Date().toISOString(),
  });
  if (ingestError) {
    console.error("Falha ao ingerir o evento fictício:", ingestError.message);
    process.exit(1);
  }
}

const { data: events, error: eventsError } = await admin
  .from("webhook_events")
  .select("id")
  .in("source_event_id", sourceIds);
if (eventsError || !events || events.length !== TOTAL) {
  console.error("Não achei os eventos recém-criados:", eventsError?.message, events?.length);
  process.exit(1);
}
const eventIds = events.map((event) => event.id);

const { data: outboxBefore, error: outboxBeforeError } = await admin
  .from("outbox")
  .select("id, state")
  .in("webhook_event_id", eventIds);
if (outboxBeforeError || !outboxBefore) {
  console.error("Não achei a outbox recém-criada:", outboxBeforeError?.message);
  process.exit(1);
}
assert(
  outboxBefore.length === TOTAL && outboxBefore.every((row) => row.state === "pending"),
  `Ponto de partida: ${TOTAL} outbox pendentes (maior que o lote de 20)`,
);

// Publicadores em memória: um para cada "origem" (rota do workflow e agendador do Inngest). Demoram um instante
// para abrir a janela de corrida e registram o que cada um publicou.
const published = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const publisher = (origin) => async ({ webhookEventId }) => {
  await sleep(5);
  published.push({ origin, webhookEventId });
};

// Rodadas de DUAS execuções simultâneas até esvaziar as nossas linhas (outras pendências do banco, se houver, podem
// ocupar parte do lote). Em nenhuma rodada pode haver publicação repetida.
const summaries = [];
for (let round = 1; round <= 6; round += 1) {
  const [workflowRun, inngestRun] = await Promise.all([
    reconcileOutbox(admin, publisher("workflow")),
    reconcileOutbox(admin, publisher("inngest")),
  ]);
  summaries.push({ round, workflowRun, inngestRun });
  const ours = published.filter((item) => eventIds.includes(item.webhookEventId));
  if (new Set(ours.map((item) => item.webhookEventId)).size >= TOTAL) break;
}

const ours = published.filter((item) => eventIds.includes(item.webhookEventId));
const counts = new Map();
for (const item of ours) counts.set(item.webhookEventId, (counts.get(item.webhookEventId) ?? 0) + 1);

assert(counts.size === TOTAL, `Todos os ${TOTAL} eventos foram publicados (obtido: ${counts.size})`);
assert(
  [...counts.values()].every((times) => times === 1),
  "Nenhum evento foi publicado duas vezes, mesmo com as duas execuções simultâneas",
);
const everything = published.map((item) => item.webhookEventId);
assert(new Set(everything).size === everything.length, "Nenhuma publicação repetida em todo o banco, em todas as rodadas");

const first = summaries[0];
assert(
  first.workflowRun.claimed > 0 && first.inngestRun.claimed > 0,
  `As duas execuções trabalharam de verdade e dividiram o lote (workflow: ${first.workflowRun.claimed}, inngest: ${first.inngestRun.claimed})`,
);
assert(
  first.workflowRun.claimed + first.inngestRun.claimed <= 40,
  "Nenhuma das duas passou do limite de 20 por lote",
);
assert(
  first.workflowRun.failed === 0 && first.inngestRun.failed === 0,
  "Nenhuma falha de publicação nas duas execuções",
);

const { data: outboxAfter } = await admin.from("outbox").select("id, state, locked_at, lock_expires_at").in("webhook_event_id", eventIds);
assert(
  (outboxAfter ?? []).length === TOTAL && (outboxAfter ?? []).every((row) => row.state === "published"),
  "Estado final: todas as outbox `published`",
);
assert(
  (outboxAfter ?? []).every((row) => row.locked_at === null && row.lock_expires_at === null),
  "Nenhum lock remanescente",
);

// Uma rodada a mais não republica nada nosso: o que já foi publicado não é reivindicado de novo.
const before = ours.length;
await Promise.all([reconcileOutbox(admin, publisher("workflow")), reconcileOutbox(admin, publisher("inngest"))]);
const after = published.filter((item) => eventIds.includes(item.webhookEventId)).length;
assert(after === before, "Rodada seguinte, também simultânea, não republica o que já foi publicado");

if (failed) {
  console.error("\nTeste de concorrência do reconciliador FALHOU.");
  process.exit(1);
}
console.log("\nTeste de concorrência do reconciliador passou.");
