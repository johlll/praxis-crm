#!/usr/bin/env node
// A11 — teste de concorrência REAL para resolve_stale_outbox_batch.
//
// O achado: uma outbox cujo webhook_event já é terminal por outro
// caminho (processed/expired_unprocessed/purged) nunca convergia —
// ficava pending/failed/publishing para sempre, e claim_outbox_batch
// recusa (corretamente) reivindicá-la. resolve_stale_outbox_batch fecha
// essa lacuna com `for update ... skip locked`.
//
// pgTAP roda numa única conexão/transação por arquivo — não prova que
// duas execuções CONCORRENTES do reconciliador (dois cron disparados ao
// mesmo tempo, por exemplo) não finalizam nem "publicam" a mesma outbox
// órfã duas vezes. Aqui, duas chamadas RPC via @supabase/supabase-js
// disparadas com Promise.all são duas transações Postgres genuinamente
// concorrentes contra a MESMA linha.
//
//   NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... \
//     SUPABASE_SECRET_KEY=... node scripts/a11-outbox-resolve-concurrency-check.mjs

import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

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
  p_name: `CI concorrência outbox ${suffix}`,
  p_pipeline_id: pipeline.id,
  p_stage_id: stage.id,
  p_legal_area: "Concorrência (CI)",
  p_initial_activity_type: "call",
  p_initial_activity_due_minutes: 60,
  p_capture_mode: "new_intake",
  p_turnstile_action: "ci_concurrency",
  p_allowed_hostnames: ["localhost"],
  p_public_key: `ci-outbox-concurrency-${suffix}`,
});
if (endpointError || !endpointResult?.id) {
  console.error("Não foi possível criar o endpoint de teste:", endpointError?.message ?? endpointResult);
  process.exit(1);
}
const formEndpointId = endpointResult.id;

// Cria UM evento + outbox pela RPC oficial de ingestão (mesma usada pela
// rota pública), com dados fictícios em bytea via literal `\x<hex>`.
const sourceEventId = randomUUID();
const contentHash = `\\x${randomBytes(32).toString("hex")}`;
const publicProtocol = `ci-outbox-concurrency-${suffix}`;

const { error: ingestError } = await admin.rpc("ingest_form_event", {
  p_form_endpoint_id: formEndpointId,
  p_source_event_id: sourceEventId,
  p_content_hash: contentHash,
  p_public_protocol: publicProtocol,
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

const { data: event, error: eventLookupError } = await admin
  .from("webhook_events")
  .select("id")
  .eq("source_event_id", sourceEventId)
  .single();
if (eventLookupError || !event) {
  console.error("Não achei o webhook_event recém-criado:", eventLookupError?.message);
  process.exit(1);
}

const { data: outboxRow, error: outboxLookupError } = await admin
  .from("outbox")
  .select("id, state")
  .eq("webhook_event_id", event.id)
  .single();
if (outboxLookupError || !outboxRow) {
  console.error("Não achei a outbox recém-criada:", outboxLookupError?.message);
  process.exit(1);
}
assert(outboxRow.state === "pending", "Outbox nasce pending");

// Processa o evento (worker) SEM passar pela outbox — reproduz
// exatamente o achado real: evento processed, outbox continua pending.
const { error: processError } = await admin.rpc("process_form_event", {
  p_webhook_event_id: event.id,
  p_input: {
    contact: { name: `Visitante CI Concorrência ${suffix}` },
    attribution: { channel: "formulario" },
    consent: {
      decision: "granted",
      channel: "email",
      legal_basis: "consentimento",
      purpose: "Teste de concorrência (CI)",
    },
  },
});
if (processError) {
  console.error("Falha ao processar o evento fictício:", processError.message);
  process.exit(1);
}

const { data: eventAfterProcess } = await admin
  .from("webhook_events")
  .select("status")
  .eq("id", event.id)
  .single();
assert(eventAfterProcess?.status === "processed", "Evento fica processed sem tocar a outbox");

const { data: outboxBeforeResolve } = await admin
  .from("outbox")
  .select("state")
  .eq("id", outboxRow.id)
  .single();
assert(outboxBeforeResolve?.state === "pending", "Órfã reproduzida: evento processed, outbox ainda pending");

// DUAS chamadas concorrentes de verdade contra a MESMA outbox órfã.
const [resolveA, resolveB] = await Promise.all([
  admin.rpc("resolve_stale_outbox_batch", { p_limit: 200 }),
  admin.rpc("resolve_stale_outbox_batch", { p_limit: 200 }),
]);

if (resolveA.error || resolveB.error) {
  console.error("Falha numa das chamadas concorrentes:", resolveA.error?.message, resolveB.error?.message);
  process.exit(1);
}

const idsA = (resolveA.data ?? []).map((item) => item.outbox_id);
const idsB = (resolveB.data ?? []).map((item) => item.outbox_id);
const totalTimesResolved =
  idsA.filter((id) => id === outboxRow.id).length + idsB.filter((id) => id === outboxRow.id).length;

assert(
  totalTimesResolved === 1,
  `Duas execuções concorrentes resolvem a MESMA outbox órfã exatamente UMA vez no total (obtido: ${totalTimesResolved})`,
);

const { data: outboxAfterResolve } = await admin
  .from("outbox")
  .select("state, resolved_reason, resolved_at, locked_at, lock_expires_at")
  .eq("id", outboxRow.id)
  .single();

assert(outboxAfterResolve?.state === "resolved", "Estado final é `resolved` — nunca `published`");
assert(outboxAfterResolve?.resolved_reason === "event_processed", "Motivo sanitizado gravado corretamente");
assert(outboxAfterResolve?.resolved_at !== null, "resolved_at gravado");
assert(outboxAfterResolve?.locked_at === null, "Nenhum lock remanescente");
assert(outboxAfterResolve?.lock_expires_at === null, "Nenhum lock remanescente");

// O reconciliador nunca republica o que já convergiu.
const { data: claimAfter } = await admin.rpc("claim_outbox_batch", { p_limit: 20, p_lock_seconds: 120 });
const claimedAfter = (claimAfter ?? []).filter((item) => item.outbox_id === outboxRow.id);
assert(claimedAfter.length === 0, "Outbox resolvida nunca é reivindicada/republicada pelo cron");

if (failed) {
  console.error("\nTeste de concorrência do outbox FALHOU.");
  process.exit(1);
}
console.log("\nTeste de concorrência do outbox passou.");
