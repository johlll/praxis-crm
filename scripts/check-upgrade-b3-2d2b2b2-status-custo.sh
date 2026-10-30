#!/usr/bin/env bash
# B3.2d-2b2b2 — valida a ATUALIZAÇÃO para o efeito de status e custo a
# partir da versão anterior, com dados gravados ANTES da migration:
#
#   1. recria o banco local só até a migration da B3.2d-2b2b1;
#   2. usa a A7 como sempre (simulador, envio, status), cria um canal da B3
#      com uma mensagem observada (2b2b1), uma mensagem com custo estimado
#      e externalId, e guarda uma entrada de status (whatsapp.message.updated)
#      na inbox — e guarda o que as leituras da A7 devolvem e a linha
#      inteira de cada mensagem;
#   3. aplica a migration pendente;
#   4. confere:
#      - as leituras da A7 e as linhas das mensagens são exatamente as de
#        antes (a migration não altera dados);
#      - nenhum contato, lead, oportunidade, atividade, conversa, mensagem,
#        identidade ou ledger foi criado ou apagado pela migration;
#      - a entrada gravada antes aplica: status delivered, custo final
#        cobrado, origem e autoria intactas, inbox processed, nada criado;
#      - o simulador, o envio e o status da A7 continuam funcionando.
#
# Roda por último no CI: termina com o banco local na versão atual. Tudo
# fictício.
set -euo pipefail

PREVIOUS_VERSION="20261030120000"
DB_CONTAINER="supabase_db_praxis-crm"
ANA="20000000-0000-0000-0000-000000000001"
WS_UM="10000000-0000-0000-0000-000000000001"
CANAL_B3="39300000-0000-0000-0000-000000000001"
TELEFONE="+5511900009201"

psql_db() {
  docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"
}

SERVICE_SQL="select set_config('request.headers', json_build_object('x-praxis-whatsapp-env', 'v1.preview.' || e.x || '.' || private.whatsapp_environment_signature('preview', e.x, k.signing_key))::text, true)
  from (select extract(epoch from now())::bigint + 600 as x) e,
       (select signing_key from public.whatsapp_environment_keys where environment = 'preview') k \\g /dev/null"

echo "== 1. banco na versão anterior ($PREVIOUS_VERSION)"
supabase db reset --local --version "$PREVIOUS_VERSION"

echo "== 2. A7 e B3 em uso antes da migration"
psql_db <<SQL
insert into public.whatsapp_environment_keys (environment, signing_key) values
  ('preview', 'chave-whatsapp-preview-atualizacao-0123456789')
on conflict do nothing;

begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
select (create_whatsapp_channel('$WS_UM'::uuid, 'Simulador (upgrade 2b2b2)', 'b3d2b2b2-up', '+55 11 0000-0303')).id as canal \gset
select simulate_inbound_whatsapp_message('b3d2b2b2-up', '5511900009211', '+5511900009211', 'wamid.up4.1', now() - interval '2 minutes', 'Mensagem fictícia antiga', 'Pessoa Antiga') as r1 \gset
select register_contact_consent((:'r1'::jsonb ->> 'contact_id')::uuid, 'whatsapp', 'consentimento', 'Atendimento (upgrade)', null, null, 'whatsapp_atendimento');
select send_message((:'r1'::jsonb ->> 'conversation_id')::uuid, 'Resposta fictícia do CRM', '99999999-9999-9999-9999-999999999996'::uuid) as env1 \gset
select apply_message_status_event('b3d2b2b2-up', :'env1'::jsonb ->> 'wa_message_id', 'delivered', now() - interval '1 minute') is not null as ok \gset
reset role;
commit;

begin;
$SERVICE_SQL
set local role service_role;
select whatsapp_create_simulated_channel('$CANAL_B3'::uuid, '$WS_UM'::uuid, '$ANA'::uuid, 'B3 (upgrade 2b2b2)', 'b3d2b2b2-up-b3', '1',
  'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB', '1') is not null as ok \gset
select whatsapp_inbox_store('$CANAL_B3'::uuid, '$WS_UM'::uuid, 'simulated', 'b3d2b2b2-up-b3', 'evt-up-eco', 'whatsapp.smb.message.echoes',
  repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gMQ==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id' as eco \gset
select whatsapp_inbox_claim(:'eco'::uuid, 300) ->> 'claim_token' as eco_token \gset
select whatsapp_effect_outbound_observed(:'eco'::uuid, :'eco_token'::uuid, 'pm-up-st-1', 'wamid.UPGRADE2B2B2', 'text', 'Mensagem fictícia observada antes da atualização', now(),
  '$TELEFONE', null, null, null) ->> 'outcome' as eco_outcome \gset
select whatsapp_inbox_store('$CANAL_B3'::uuid, '$WS_UM'::uuid, 'simulated', 'b3d2b2b2-up-b3', 'evt-up-st', 'whatsapp.message.updated',
  repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gMg==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id' as entrada \gset
reset role;
commit;

-- Mensagem com custo estimado e externalId gravados antes (formato antigo).
insert into public.messages (workspace_id, conversation_id, channel_id, direction, origin, sender_classification, content_kind, body_text,
  provider, provider_message_id, provider_external_id, status, provider_cost_amount, provider_cost_currency, provider_cost_category, provider_cost_finality)
select c.workspace_id, c.id, c.channel_id, 'outbound', 'external_api', 'unresolved', 'text', 'Mensagem fictícia de API antes da atualização',
  'simulated', 'pm-up-st-2', 'msg-bot_0123456789abcdef01234567', 'sent', 0.02, 'BRL', 'marketing', 'estimated'
from public.conversations c where c.channel_id = '$CANAL_B3'::uuid;

begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
create temporary table leituras on commit preserve rows as
select 'list_conversations' as chave, (select to_jsonb(lc) from list_conversations('$WS_UM'::uuid, 1, 100) lc limit 1) as valor
union all
select 'messages', (select jsonb_agg(to_jsonb(lm)) from list_conversation_messages((:'r1'::jsonb ->> 'conversation_id')::uuid, null, 30, null) lm)
union all
select 'conversation', get_conversation((:'r1'::jsonb ->> 'conversation_id')::uuid);
reset role;
commit;

create table public.upgrade_b3d2b2b2_leituras as select * from leituras;
create table public.upgrade_b3d2b2b2_linhas as select m.id, md5(m::text) as linha from public.messages m;
create table public.upgrade_b3d2b2b2_estado as
select (:'r1'::jsonb ->> 'conversation_id') as conv_a7, :'entrada'::text as entrada, :'eco_outcome'::text as eco_outcome;
create table public.upgrade_b3d2b2b2_contagens as
select 'contacts' as tabela, count(*) as n from public.contacts
union all select 'leads', count(*) from public.leads
union all select 'opportunities', count(*) from public.opportunities
union all select 'activities', count(*) from public.activities
union all select 'conversations', count(*) from public.conversations
union all select 'messages', count(*) from public.messages
union all select 'whatsapp_identities', count(*) from public.whatsapp_identities
union all select 'whatsapp_effect_ledger', count(*) from public.whatsapp_effect_ledger;
SQL

echo "== 3. migration pendente"
supabase migration up --local

echo "== 4. conferências"
psql_db <<SQL
select conv_a7, entrada, eco_outcome from public.upgrade_b3d2b2b2_estado \gset
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
create temporary table leituras_depois on commit preserve rows as
select 'list_conversations' as chave, (select to_jsonb(lc) from list_conversations('$WS_UM'::uuid, 1, 100) lc limit 1) as valor
union all
select 'messages', (select jsonb_agg(to_jsonb(lm)) from list_conversation_messages(:'conv_a7'::uuid, null, 30, null) lm)
union all
select 'conversation', get_conversation(:'conv_a7'::uuid);
reset role;
commit;

do \$check\$
declare
  v_bad integer;
begin
  select count(*) into v_bad
  from public.upgrade_b3d2b2b2_leituras a join leituras_depois d using (chave)
  where a.valor is distinct from d.valor;
  if v_bad <> 0 or (select count(*) from leituras_depois) <> 3 then
    raise exception 'leituras da A7 mudaram na atualização (% diferentes)', v_bad;
  end if;

  select count(*) into v_bad
  from public.upgrade_b3d2b2b2_linhas l left join public.messages m on m.id = l.id
  where m.id is null or md5(m::text) <> l.linha;
  if v_bad <> 0 then
    raise exception '% mensagem(ns) mudaram na migration', v_bad;
  end if;

  select count(*) into v_bad
  from public.upgrade_b3d2b2b2_contagens c
  where c.n <> case c.tabela
    when 'contacts' then (select count(*) from public.contacts)
    when 'leads' then (select count(*) from public.leads)
    when 'opportunities' then (select count(*) from public.opportunities)
    when 'activities' then (select count(*) from public.activities)
    when 'conversations' then (select count(*) from public.conversations)
    when 'messages' then (select count(*) from public.messages)
    when 'whatsapp_identities' then (select count(*) from public.whatsapp_identities)
    when 'whatsapp_effect_ledger' then (select count(*) from public.whatsapp_effect_ledger)
  end;
  if v_bad <> 0 then
    raise exception '% contagem(ns) mudaram na migration', v_bad;
  end if;
end;
\$check\$;

-- A entrada de status gravada antes da migration aplica sobre a mensagem
-- observada antes dela.
begin;
$SERVICE_SQL
set local role service_role;
select whatsapp_inbox_claim(:'entrada'::uuid, 300) ->> 'claim_token' as token \gset
select whatsapp_effect_message_status(:'entrada'::uuid, :'token'::uuid, 'pm-up-st-1', 'wamid.UPGRADE2B2B2', null, 'delivered', null, now(),
  '$TELEFONE', null, null, null, 0.0315, 'BRL', 'marketing', 'final') as efeito \gset
reset role;
commit;
select set_config('upgrade_check.efeito', :'efeito', false);
select set_config('upgrade_check.entrada', :'entrada', false);
select set_config('upgrade_check.eco', :'eco_outcome', false);

do \$check\$
declare
  v_efeito jsonb := current_setting('upgrade_check.efeito')::jsonb;
begin
  if current_setting('upgrade_check.eco') <> 'applied' then
    raise exception 'a saída observada de antes da atualização não aplicou: %', current_setting('upgrade_check.eco');
  end if;
  if v_efeito ->> 'outcome' <> 'applied' then
    raise exception 'o status gravado antes da atualização não aplicou: %', v_efeito;
  end if;
  if (select status || '/' || provider_cost_finality || '/' || provider_cost_billable_amount || '/' || origin || '/' || sender_classification || '/' || (sent_by is null) || '/' || w.state
      from public.messages m, public.whatsapp_webhook_inbox w
      where m.id = (v_efeito ->> 'message_id')::uuid and m.provider_message_id = 'pm-up-st-1' and w.id = current_setting('upgrade_check.entrada')::uuid)
     is distinct from 'delivered/final/0.031500/business_app/internal/true/processed' then
    raise exception 'mensagem ou inbox com estado inesperado depois do status';
  end if;
  if (select count(*) from public.contacts) <> (select n from public.upgrade_b3d2b2b2_contagens where tabela = 'contacts')
     or (select count(*) from public.leads) <> (select n from public.upgrade_b3d2b2b2_contagens where tabela = 'leads')
     or (select count(*) from public.messages) <> (select n from public.upgrade_b3d2b2b2_contagens where tabela = 'messages')
     or (select count(*) from public.whatsapp_identities) <> (select n from public.upgrade_b3d2b2b2_contagens where tabela = 'whatsapp_identities') then
    raise exception 'o status não deveria criar contato, lead, mensagem ou identidade';
  end if;
  if (select provider_external_id || '/' || origin || '/' || provider_cost_amount from public.messages where provider_message_id = 'pm-up-st-2')
     is distinct from 'msg-bot_0123456789abcdef01234567/external_api/0.020000' then
    raise exception 'a mensagem de API gravada antes mudou';
  end if;
end;
\$check\$;

-- A7 continua funcionando depois.
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
select simulate_inbound_whatsapp_message('b3d2b2b2-up', '5511900009212', '+5511900009212', 'wamid.up4.2', now(), 'Depois da atualização', 'Pessoa Nova') ->> 'message_id' as r2 \gset
select send_message(:'conv_a7'::uuid, 'Envio depois da atualização', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaad'::uuid) as env2 \gset
select apply_message_status_event('b3d2b2b2-up', :'env2'::jsonb ->> 'wa_message_id', 'read', now()) ->> 'status' as st2 \gset
reset role;
commit;
select set_config('upgrade_check.st2', :'st2', false);
do \$check\$
begin
  if current_setting('upgrade_check.st2') <> 'read' then
    raise exception 'o status da A7 não aplicou depois da atualização: %', current_setting('upgrade_check.st2');
  end if;
end;
\$check\$;

drop table public.upgrade_b3d2b2b2_leituras;
drop table public.upgrade_b3d2b2b2_linhas;
drop table public.upgrade_b3d2b2b2_estado;
drop table public.upgrade_b3d2b2b2_contagens;
SQL

echo "OK: atualização preservou a A7 e os dados anteriores; o status gravado antes aplicou sem nada comercial."
