#!/usr/bin/env node
// A7 — teste de concorrência REAL contra o Supabase local do CI (depois de
// `supabase start` + `supabase db reset --local`, com o seed aplicado).
//
// pgTAP roda numa única conexão/transação por arquivo — não expressa
// concorrência de verdade sem uma extensão adicional (dblink, indisponível
// no projeto hospedado e que exigiria uma migration só para viabilizar um
// teste). Aqui, duas chamadas HTTP via @supabase/supabase-js disparadas
// com Promise.all são duas transações Postgres genuinamente concorrentes
// (cada requisição do PostgREST abre a sua) — a forma mais fiel disponível
// de testar os dois cenários pedidos:
//   1) o MESMO evento (wa_message_id) entregue duas vezes ao mesmo tempo;
//   2) duas mensagens DIFERENTES do MESMO número novo ao mesmo tempo.
//
//   NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... \
//     node scripts/a7-concurrency-check.mjs

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!url || !anonKey) {
  console.error("Faltam NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY no ambiente.");
  process.exit(1);
}

const supabase = createClient(url, anonKey);

let failed = false;
function assert(condition, message) {
  if (condition) {
    console.log(`OK: ${message}`);
  } else {
    failed = true;
    console.error(`FALHA: ${message}`);
  }
}

const { error: signInError } = await supabase.auth.signInWithPassword({
  email: "owner-a.seed@praxis.test",
  password: "praxis-seed-nao-e-senha-real",
});
if (signInError) {
  console.error("Não foi possível entrar como o usuário do seed:", signInError.message);
  process.exit(1);
}

const WORKSPACE_ID = "10000000-0000-0000-0000-000000000001";
const PHONE_NUMBER_ID = "ci-concurrency-phone-id";

const { error: channelError } = await supabase.rpc("create_whatsapp_channel", {
  p_workspace_id: WORKSPACE_ID,
  p_label: "Canal concorrência (CI)",
  p_phone_number_id: PHONE_NUMBER_ID,
  p_display_phone_number: "+55 11 5555-0099",
});
if (channelError) {
  console.error("Não foi possível criar o canal de teste:", channelError.message);
  process.exit(1);
}

// ---------------------------------------------------------------------
// Cenário 1 — o MESMO evento entregue duas vezes, ao mesmo tempo.
// ---------------------------------------------------------------------

const sameEventArgs = {
  p_phone_number_id: PHONE_NUMBER_ID,
  p_from_wa_id_raw: "5511993334444",
  p_from_e164: "+5511993334444",
  p_wa_message_id: "wamid.ci.concurrency.same",
  p_event_timestamp: new Date().toISOString(),
  p_body_text: "Mensagem simultânea repetida",
  p_profile_name: "CI Concurrency Same",
};

const [r1, r2] = await Promise.all([
  supabase.rpc("simulate_inbound_whatsapp_message", sameEventArgs),
  supabase.rpc("simulate_inbound_whatsapp_message", sameEventArgs),
]);

assert(!r1.error && !r2.error, `duas entregas simultâneas do mesmo evento não retornam erro (r1=${r1.error?.message ?? "ok"}, r2=${r2.error?.message ?? "ok"})`);

if (!r1.error && !r2.error) {
  assert(r1.data.conversation_id === r2.data.conversation_id, "as duas respostas apontam para a MESMA conversa");
  assert(r1.data.message_id === r2.data.message_id, "as duas respostas apontam para a MESMA mensagem — nenhuma duplicou");

  const newCount = (r1.data.was_new_contact ? 1 : 0) + (r2.data.was_new_contact ? 1 : 0);
  const duplicateCount = (r1.data.duplicate_event ? 1 : 0) + (r2.data.duplicate_event ? 1 : 0);
  assert(newCount === 1, `exatamente uma das duas chamadas venceu a corrida e criou o contato (newCount=${newCount})`);
  assert(duplicateCount === 1, `exatamente uma das duas chamadas viu o evento como já existente (duplicateCount=${duplicateCount})`);

  const { data: history, error: historyError } = await supabase.rpc("list_conversation_messages", {
    p_conversation_id: r1.data.conversation_id,
    p_limit: 50,
  });
  assert(!historyError, `histórico da conversa é legível após a corrida (${historyError?.message ?? "ok"})`);
  const items = history?.[0]?.items ?? [];
  assert(items.length === 1, `exatamente 1 mensagem gravada no banco para o evento repetido simultâneo (achou ${items.length})`);
}

// ---------------------------------------------------------------------
// Cenário 2 — duas mensagens DIFERENTES do MESMO número novo, ao mesmo
// tempo: devem resultar em duas mensagens, sem duplicar o cadastro inicial.
// ---------------------------------------------------------------------

const baseArgs = {
  p_phone_number_id: PHONE_NUMBER_ID,
  p_from_wa_id_raw: "5511995556666",
  p_from_e164: "+5511995556666",
  p_event_timestamp: new Date().toISOString(),
  p_profile_name: "CI Concurrency Diff",
};

const [d1, d2] = await Promise.all([
  supabase.rpc("simulate_inbound_whatsapp_message", {
    ...baseArgs,
    p_wa_message_id: "wamid.ci.concurrency.diff.1",
    p_body_text: "Primeira mensagem simultânea",
  }),
  supabase.rpc("simulate_inbound_whatsapp_message", {
    ...baseArgs,
    p_wa_message_id: "wamid.ci.concurrency.diff.2",
    p_body_text: "Segunda mensagem simultânea",
  }),
]);

assert(!d1.error && !d2.error, `duas mensagens diferentes simultâneas não retornam erro (d1=${d1.error?.message ?? "ok"}, d2=${d2.error?.message ?? "ok"})`);

if (!d1.error && !d2.error) {
  assert(d1.data.conversation_id === d2.data.conversation_id, "as duas mensagens diferentes caem na MESMA conversa");
  assert(d1.data.contact_id === d2.data.contact_id, "o cadastro inicial (contato) NÃO foi duplicado");
  assert(d1.data.lead_id === d2.data.lead_id, "o lead automático NÃO foi duplicado");
  assert(d1.data.opportunity_id === d2.data.opportunity_id, "a oportunidade automática NÃO foi duplicada");

  const newCount = (d1.data.was_new_contact ? 1 : 0) + (d2.data.was_new_contact ? 1 : 0);
  assert(newCount === 1, `exatamente uma das duas chamadas criou o cadastro inicial (newCount=${newCount})`);

  const { data: history2, error: history2Error } = await supabase.rpc("list_conversation_messages", {
    p_conversation_id: d1.data.conversation_id,
    p_limit: 50,
  });
  assert(!history2Error, `histórico legível após a corrida (${history2Error?.message ?? "ok"})`);
  const items2 = history2?.[0]?.items ?? [];
  assert(items2.length === 2, `as DUAS mensagens diferentes foram gravadas, nenhuma perdida (achou ${items2.length})`);
}

if (failed) {
  console.error("\nTeste de concorrência da A7 FALHOU.");
  process.exit(1);
}
console.log("\nTeste de concorrência da A7: tudo OK.");
