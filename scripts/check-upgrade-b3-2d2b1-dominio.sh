#!/usr/bin/env bash
# B3.2d-2b1 — valida a ATUALIZAÇÃO do domínio do WhatsApp a partir da
# versão anterior, com dados reais da A7 gravados ANTES da migration:
#
#   1. recria o banco local só até a última migration da B3.2d-2a;
#   2. usa a A7 como sempre: canal do simulador, duas conversas recebidas
#      (uma de contato novo, outra de um segundo número), consentimento,
#      envio pelo CRM e status — e guarda o que as leituras devolvem;
#   3. aplica as migrations pendentes (modelo do domínio + backfill);
#   4. confere:
#      - as leituras da A7 devolvem exatamente o mesmo de antes;
#      - nenhum contato, lead, oportunidade, atividade, conversa ou
#        mensagem foi criado ou apagado pela migration;
#      - cada conversa ganhou a identidade do próprio telefone, no canal
#        dela, sem BSUID;
#      - recebidas ficam inbound/unresolved, enviadas pelo CRM crm/internal,
#        todas como texto; nenhuma vira chatbot;
#      - rodar o backfill de novo não muda nada;
#      - o simulador e o envio continuam funcionando depois.
#
# Roda por último no CI, depois do outro teste de atualização: termina com
# o banco local na versão atual. Tudo fictício.
set -euo pipefail

PREVIOUS_VERSION="20261027120000"
DB_CONTAINER="supabase_db_praxis-crm"
ANA="20000000-0000-0000-0000-000000000001"
WS_UM="10000000-0000-0000-0000-000000000001"

psql_db() {
  docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"
}

echo "== 1. banco na versão anterior ($PREVIOUS_VERSION)"
supabase db reset --local --version "$PREVIOUS_VERSION"

echo "== 2. A7 em uso antes da migration"
psql_db <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
select (create_whatsapp_channel('$WS_UM'::uuid, 'Simulador (upgrade)', 'b3d2b1-up', '+55 11 0000-0201')).id as canal \gset
select simulate_inbound_whatsapp_message('b3d2b1-up', '5511900005001', '+5511900005001', 'wamid.up.1', now() - interval '3 minutes', 'Primeira mensagem fictícia', 'Pessoa Um') as r1 \gset
select simulate_inbound_whatsapp_message('b3d2b1-up', '5511900005001', '+5511900005001', 'wamid.up.2', now() - interval '2 minutes', 'Segunda mensagem fictícia', 'Pessoa Um') as r2 \gset
select simulate_inbound_whatsapp_message('b3d2b1-up', '5511900005002', '+5511900005002', 'wamid.up.3', now() - interval '1 minute', 'Outro número fictício', 'Pessoa Dois') as r3 \gset
select register_contact_consent((:'r1'::jsonb ->> 'contact_id')::uuid, 'whatsapp', 'consentimento', 'Atendimento (upgrade)', null, null, 'whatsapp_atendimento');
select send_message((:'r1'::jsonb ->> 'conversation_id')::uuid, 'Resposta fictícia do CRM', '99999999-9999-9999-9999-999999999999'::uuid) as env1 \gset
reset role;
select wa_message_id as wamid_env1 from public.messages where id = (:'env1'::jsonb ->> 'message_id')::uuid \gset
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
select apply_message_status_event('b3d2b1-up', :'wamid_env1', 'delivered', now());

create temporary table leituras on commit preserve rows as
select 'list_conversations' as chave, (select to_jsonb(lc) from list_conversations('$WS_UM'::uuid) lc limit 1) as valor
union all
select 'messages:' || c.id, (select to_jsonb(lm) from list_conversation_messages(c.id, null, 30, null) lm limit 1)
from (select (:'r1'::jsonb ->> 'conversation_id')::uuid as id union all select (:'r3'::jsonb ->> 'conversation_id')::uuid) c
union all
select 'page1:' || c.id, (select to_jsonb(lm) from list_conversation_messages(c.id, null, 1, null) lm limit 1)
from (select (:'r1'::jsonb ->> 'conversation_id')::uuid as id) c
union all
select 'conversation:' || c.id, get_conversation(c.id)
from (select (:'r1'::jsonb ->> 'conversation_id')::uuid as id union all select (:'r3'::jsonb ->> 'conversation_id')::uuid) c;
reset role;
commit;

create table public.upgrade_b3d2b1_leituras as select * from leituras;
create table public.upgrade_b3d2b1_contagens as
select 'contacts' as tabela, count(*) as n from public.contacts
union all select 'leads', count(*) from public.leads
union all select 'opportunities', count(*) from public.opportunities
union all select 'activities', count(*) from public.activities
union all select 'conversations', count(*) from public.conversations
union all select 'messages', count(*) from public.messages
union all select 'message_status_events', count(*) from public.message_status_events;
SQL

echo "== 3. migrations pendentes"
supabase migration up --local

echo "== 4. conferências"
psql_db <<SQL
-- Leituras da A7: exatamente as mesmas de antes.
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
create temporary table leituras_depois on commit drop as
select s.chave,
  case
    when s.chave = 'list_conversations' then (select to_jsonb(lc) from list_conversations('$WS_UM'::uuid) lc limit 1)
    when s.chave like 'messages:%' then (select to_jsonb(lm) from list_conversation_messages(split_part(s.chave, ':', 2)::uuid, null, 30, null) lm limit 1)
    when s.chave like 'page1:%' then (select to_jsonb(lm) from list_conversation_messages(split_part(s.chave, ':', 2)::uuid, null, 1, null) lm limit 1)
    else get_conversation(split_part(s.chave, ':', 2)::uuid)
  end as valor
from public.upgrade_b3d2b1_leituras s;
reset role;
do \$check\$
declare
  v_diff integer;
begin
  select count(*) into v_diff
  from public.upgrade_b3d2b1_leituras a join leituras_depois d using (chave)
  where a.valor is distinct from d.valor;
  if v_diff <> 0 or (select count(*) from leituras_depois) <> 6 then
    raise exception 'leituras da A7 mudaram na atualização (% diferentes)', v_diff;
  end if;
end;
\$check\$;
commit;

do \$check\$
declare
  v_bad integer;
  v_result jsonb;
begin
  -- Nada criado nem apagado pela migration.
  select count(*) into v_bad
  from public.upgrade_b3d2b1_contagens c
  where c.n <> case c.tabela
    when 'contacts' then (select count(*) from public.contacts)
    when 'leads' then (select count(*) from public.leads)
    when 'opportunities' then (select count(*) from public.opportunities)
    when 'activities' then (select count(*) from public.activities)
    when 'conversations' then (select count(*) from public.conversations)
    when 'messages' then (select count(*) from public.messages)
    when 'message_status_events' then (select count(*) from public.message_status_events)
  end;
  if v_bad <> 0 then
    raise exception '% contagem(ns) do domínio mudaram na migration', v_bad;
  end if;

  -- Cada conversa: identidade do próprio telefone, no canal dela, sem BSUID.
  select count(*) into v_bad
  from public.conversations c
  left join public.whatsapp_identities i on i.id = c.identity_id
  where i.id is null or i.phone_e164 is distinct from c.wa_id or i.channel_id <> c.channel_id
     or i.workspace_id <> c.workspace_id or i.bsuid_blind_index is not null;
  if v_bad <> 0 then
    raise exception '% conversa(s) sem a identidade certa depois do backfill', v_bad;
  end if;

  -- Classificação determinística, nunca chatbot.
  select count(*) into v_bad
  from public.messages m
  where m.content_kind <> 'text'
     or (m.direction = 'inbound' and (m.origin, m.sender_classification) <> ('inbound', 'unresolved'))
     or (m.direction = 'outbound' and (m.origin, m.sender_classification) <> ('crm', 'internal'))
     or m.origin = 'chatbot' or m.origin_correlation_kind is not null or m.provider is not null;
  if v_bad <> 0 then
    raise exception '% mensagem(ns) com classificação inesperada depois do backfill', v_bad;
  end if;
  if (select count(*) from public.messages) = 0 or (select count(*) from public.messages where direction = 'outbound') = 0 then
    raise exception 'o cenário deveria ter mensagens recebidas e enviadas';
  end if;

  -- Backfill de novo: nada muda.
  v_result := private.whatsapp_domain_backfill();
  if v_result <> '{"identities_created": 0, "messages_classified": 0, "conversations_linked": 0}'::jsonb then
    raise exception 'o backfill não é idempotente: %', v_result;
  end if;
end;
\$check\$;

-- A7 continua funcionando depois: nova recebida e novo envio pelo CRM
-- numa conversa antiga (que já tem consentimento).
select split_part(chave, ':', 2) as conv_r1 from public.upgrade_b3d2b1_leituras where chave like 'page1:%' \gset
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
select simulate_inbound_whatsapp_message('b3d2b1-up', '5511900005003', '+5511900005003', 'wamid.up.4', now(), 'Depois da atualização', 'Pessoa Três') as r4 \gset
select send_message(:'conv_r1'::uuid, 'Envio depois da atualização', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid) ->> 'message_id' as env2 \gset
reset role;
commit;
select set_config('upgrade_check.env2', :'env2', false);

do \$check\$
begin
  if (select count(*) from public.conversations c join public.whatsapp_identities i on i.id = c.identity_id where c.wa_id = '+5511900005003') <> 1 then
    raise exception 'conversa nova do simulador depois da atualização sem identidade';
  end if;
  if (select origin || '/' || sender_classification from public.messages where wa_message_id = 'wamid.up.4') <> 'inbound/unresolved' then
    raise exception 'mensagem nova do simulador com classificação inesperada';
  end if;
  if (select origin || '/' || sender_classification || '/' || content_kind from public.messages where id = current_setting('upgrade_check.env2')::uuid) <> 'crm/internal/text' then
    raise exception 'envio da A7 depois da atualização com classificação inesperada';
  end if;
end;
\$check\$;

drop table public.upgrade_b3d2b1_leituras;
drop table public.upgrade_b3d2b1_contagens;
SQL

echo "OK: atualização preservou a A7, criou as identidades e classificou as mensagens antigas sem inferência."
