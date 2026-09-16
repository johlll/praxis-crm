#!/usr/bin/env node
// Estabilização pós-A9 (docs/decisoes/estabilizacao-pos-a9.md §4) — teste de
// concorrência REAL da numeração de propostas contra o Supabase local do CI
// (depois de `supabase db reset --local`, com o seed aplicado).
//
// pgTAP roda numa única conexão por arquivo: não reproduz duas transações
// lendo o mesmo contador ao mesmo tempo. Aqui, cada chamada usa um cliente
// Supabase próprio e todas partem juntas (Promise.all) — cada requisição do
// PostgREST abre sua própria transação Postgres, genuinamente simultâneas.
//
// Cenários:
//   1) um número já emitido antes da rajada é preservado;
//   2) N criações simultâneas no mesmo workspace terminam todas com sucesso,
//      com números distintos e posteriores ao já emitido;
//   3) ao mesmo tempo, outro workspace mantém sua própria série.
//
//   NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... \
//     node scripts/a9-proposal-number-concurrency-check.mjs

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !anonKey) {
  console.error("Faltam NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY no ambiente.");
  process.exit(1);
}

const PASSWORD = "praxis-seed-nao-e-senha-real";
const BURST_WS_UM = 12;
const BURST_WS_DOIS = 6;

let failed = false;
function assert(condition, message) {
  if (condition) {
    console.log(`OK: ${message}`);
  } else {
    failed = true;
    console.error(`FALHA: ${message}`);
  }
}

async function accessTokenFor(email) {
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) {
    console.error(`Não foi possível entrar como ${email}:`, error?.message);
    process.exit(1);
  }
  return data.session.access_token;
}

// Um cliente novo por chamada: nenhuma requisição compartilha instância.
function independentClient(token) {
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

async function mustRpc(token, fn, args) {
  const { data, error } = await independentClient(token).rpc(fn, args);
  if (error) {
    console.error(`${fn} falhou na preparação:`, error.message);
    process.exit(1);
  }
  return data;
}

async function openOpportunity(token, workspaceId, label) {
  const contact = await mustRpc(token, "create_contact", {
    p_workspace_id: workspaceId,
    p_type: "pf",
    p_name: `Contato concorrência propostas ${label} (CI)`,
  });
  const contactId = Array.isArray(contact) ? contact[0].id : contact.id;
  const leadId = await mustRpc(token, "create_lead", {
    p_workspace_id: workspaceId,
    p_contact_id: contactId,
    p_legal_area: `Concorrência propostas ${label}`,
  });
  const opportunityId = await mustRpc(token, "create_opportunity", { p_lead_id: leadId });
  return { leadId, opportunityId };
}

async function proposalNumbers(token, leadId) {
  const rows = await mustRpc(token, "list_proposals_for_lead", { p_lead_id: leadId });
  return rows.map((r) => ({ id: r.id, number: r.number }));
}

const sequence = (number) => Number(/^PROP-\d{4}-(\d+)$/.exec(number)?.[1]);

const WS_UM = "10000000-0000-0000-0000-000000000001";
const WS_DOIS = "10000000-0000-0000-0000-000000000002";

const anaToken = await accessTokenFor("owner-a.seed@praxis.test");
const brunoToken = await accessTokenFor("owner-b.seed@praxis.test");

const um = await openOpportunity(anaToken, WS_UM, "um");
const dois = await openOpportunity(brunoToken, WS_DOIS, "dois");

// Um número emitido ANTES da rajada, em cada workspace.
await mustRpc(anaToken, "create_proposal", { p_opportunity_id: um.opportunityId, p_value_cents: 100000, p_fee_model: "fixed" });
await mustRpc(brunoToken, "create_proposal", { p_opportunity_id: dois.opportunityId, p_value_cents: 100000, p_fee_model: "fixed" });
const [umBefore] = await proposalNumbers(anaToken, um.leadId);
const [doisBefore] = await proposalNumbers(brunoToken, dois.leadId);

const calls = [
  ...Array.from({ length: BURST_WS_UM }, (_, i) =>
    independentClient(anaToken)
      .rpc("create_proposal", { p_opportunity_id: um.opportunityId, p_value_cents: 200000 + i, p_fee_model: "fixed" })
      .then((r) => ({ ws: "um", ...r })),
  ),
  ...Array.from({ length: BURST_WS_DOIS }, (_, i) =>
    independentClient(brunoToken)
      .rpc("create_proposal", { p_opportunity_id: dois.opportunityId, p_value_cents: 300000 + i, p_fee_model: "fixed" })
      .then((r) => ({ ws: "dois", ...r })),
  ),
];
const results = await Promise.all(calls);

for (const ws of ["um", "dois"]) {
  const errors = results.filter((r) => r.ws === ws && r.error).map((r) => r.error.message);
  const expected = ws === "um" ? BURST_WS_UM : BURST_WS_DOIS;
  assert(
    errors.length === 0,
    `workspace ${ws}: as ${expected} criações simultâneas terminaram sem erro${errors.length ? ` (erros: ${[...new Set(errors)].join(", ")})` : ""}`,
  );
}

const umAfter = await proposalNumbers(anaToken, um.leadId);
const doisAfter = await proposalNumbers(brunoToken, dois.leadId);

for (const [ws, before, after, burst] of [
  ["um", umBefore, umAfter, BURST_WS_UM],
  ["dois", doisBefore, doisAfter, BURST_WS_DOIS],
]) {
  const numbers = after.map((p) => p.number);
  assert(after.length === burst + 1, `workspace ${ws}: ${burst + 1} propostas no lead (1 anterior + ${burst} da rajada), veio ${after.length}`);
  assert(new Set(numbers).size === numbers.length, `workspace ${ws}: nenhum número repetido (${numbers.join(", ")})`);
  const preserved = after.find((p) => p.id === before.id);
  assert(preserved?.number === before.number, `workspace ${ws}: número já emitido ${before.number} preservado`);
  const burstSeqs = after.filter((p) => p.id !== before.id).map((p) => sequence(p.number));
  assert(
    burstSeqs.every((s) => Number.isInteger(s) && s > sequence(before.number)),
    `workspace ${ws}: todos os números da rajada são posteriores ao já emitido`,
  );
}

assert(
  sequence(doisAfter.map((p) => p.number).sort().at(-1)) <= BURST_WS_DOIS + 1,
  "workspace dois: série própria, não avançada pela rajada do workspace um",
);

if (failed) {
  console.error("Teste de concorrência da numeração de propostas FALHOU.");
  process.exit(1);
}
console.log("Teste de concorrência da numeração de propostas passou.");
