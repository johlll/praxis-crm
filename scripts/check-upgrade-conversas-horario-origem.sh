#!/usr/bin/env bash
# Conversas + IA — valida a ATUALIZAÇÃO para o horário de origem das mensagens a partir da versão
# anterior, com mensagens gravadas ANTES da migration:
#
#   1. recria o banco local só até a migration da interface de Conversas (20261118120000);
#   2. usa a A7 como sempre (simulador, consentimento, envio, status) e a B3 (mensagem recebida e
#      eco aplicados pelos efeitos), e guarda a linha inteira de cada mensagem e o que a leitura da
#      A7 devolve;
#   3. aplica a migration pendente;
#   4. confere:
#      - as linhas das mensagens e a leitura são exatamente as de antes (a migration não altera
#        dado nenhum) e nenhuma linha foi criada ou apagada;
#      - toda mensagem anterior tem origem DESCONHECIDA (colunas nulas) e é inelegível
#        (origin_unknown): nada foi reconstruído com created_at ou outro horário;
#      - um evento reentregue DEPOIS da migration para uma mensagem anterior não a promove: a origem
#        continua desconhecida (só o evento que criou a mensagem preenche);
#      - uma mensagem nova recebida pela B3 depois da migration ganha a origem do provedor, e o envio
#        humano da A7 ganha crm_accepted; o simulador, o envio e o status da A7 seguem funcionando.
#
# Roda por último no CI: termina com o banco local na versão atual. Tudo fictício.
set -euo pipefail

PREVIOUS_VERSION="20261118120000"
DB_CONTAINER="supabase_db_praxis-crm"
ANA="20000000-0000-0000-0000-000000000001"
WS_UM="10000000-0000-0000-0000-000000000001"
CANAL_B3="39500000-0000-0000-0000-000000000001"
TELEFONE="+5511900009501"

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
select (create_whatsapp_channel('$WS_UM'::uuid, 'Simulador (upgrade horário de origem)', 'ho-up', '+55 11 0000-0505')).id as canal \gset
select simulate_inbound_whatsapp_message('ho-up', '5511900009511', '+5511900009511', 'wamid.ho.up.1', now() - interval '2 minutes', 'Mensagem fictícia antiga', 'Pessoa Antiga') as r1 \gset
select register_contact_consent((:'r1'::jsonb ->> 'contact_id')::uuid, 'whatsapp', 'consentimento', 'Atendimento (upgrade)', null, null, 'whatsapp_atendimento');
select send_message((:'r1'::jsonb ->> 'conversation_id')::uuid, 'Resposta fictícia do CRM', '99999999-9999-9999-9999-999999999995'::uuid) as env1 \gset
select apply_message_status_event('ho-up', :'env1'::jsonb ->> 'wa_message_id', 'delivered', now() - interval '1 minute') is not null as ok \gset
reset role;
commit;

begin;
$SERVICE_SQL
set local role service_role;
select whatsapp_create_simulated_channel('$CANAL_B3'::uuid, '$WS_UM'::uuid, '$ANA'::uuid, 'B3 (upgrade horário de origem)', 'ho-up-b3', '1',
  'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB', '1') is not null as ok \gset
select whatsapp_inbox_store('$CANAL_B3'::uuid, '$WS_UM'::uuid, 'simulated', 'ho-up-b3', 'evt-ho-up-in-1', 'whatsapp.inbound_message.received',
  repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gMQ==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id' as ent_in \gset
select whatsapp_inbox_claim(:'ent_in'::uuid, 300) ->> 'claim_token' as tok_in \gset
select whatsapp_effect_inbound_message(:'ent_in'::uuid, :'tok_in'::uuid, 'pm-ho-up-in-1', 'text', 'Mensagem fictícia recebida antes da atualização', now() - interval '6 hours',
  '$TELEFONE', null, null, null, null) ->> 'outcome' as out_in \gset
select whatsapp_inbox_store('$CANAL_B3'::uuid, '$WS_UM'::uuid, 'simulated', 'ho-up-b3', 'evt-ho-up-eco-1', 'whatsapp.smb.message.echoes',
  repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gMg==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id' as ent_eco \gset
select whatsapp_inbox_claim(:'ent_eco'::uuid, 300) ->> 'claim_token' as tok_eco \gset
select whatsapp_effect_outbound_observed(:'ent_eco'::uuid, :'tok_eco'::uuid, 'pm-ho-up-eco-1', 'wamid.HOUP1', 'text', 'Mensagem fictícia observada antes da atualização', now() - interval '5 hours',
  '$TELEFONE', null, null, null) ->> 'outcome' as out_eco \gset
reset role;
commit;

-- Leitura da A7 antes da migration (com todos os dados anteriores já gravados).
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
select (select jsonb_agg(to_jsonb(lc) order by to_jsonb(lc)::text) from list_conversations('$WS_UM'::uuid, 1, 100) lc)::text as lc_antes \gset
reset role;
commit;

-- Retrato das linhas inteiras das mensagens, das contagens e da leitura, antes.
create table public.upgrade_check_messages as select id, to_jsonb(m) as linha from public.messages m;
create table public.upgrade_check_counts as
select (select count(*) from public.messages) as messages, (select count(*) from public.conversations) as conversations,
       (select count(*) from public.whatsapp_effect_ledger) as ledger, (select count(*) from public.contacts) as contacts;
create table public.upgrade_check_values (chave text primary key, valor text);
insert into public.upgrade_check_values values ('lc_antes', :'lc_antes'), ('out_in', :'out_in'), ('out_eco', :'out_eco');
SQL

echo "== 3. migration pendente"
supabase migration up --local

echo "== 4. conferências"
psql_db <<SQL
-- A leitura da A7 depois da migration.
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
select (select jsonb_agg(to_jsonb(lc) order by to_jsonb(lc)::text) from list_conversations('$WS_UM'::uuid, 1, 100) lc)::text as lc_depois \gset
reset role;
commit;
insert into public.upgrade_check_values values ('lc_depois', :'lc_depois');

-- Estado logo após a migration (antes de qualquer evento novo).
create table public.upgrade_check_after_migration as
select (select count(*) from public.messages) as messages, (select count(*) from public.conversations) as conversations,
       (select count(*) from public.whatsapp_effect_ledger) as ledger, (select count(*) from public.contacts) as contacts;

-- Um evento REENTREGUE depois da migration para uma mensagem anterior não a promove.
begin;
$SERVICE_SQL
set local role service_role;
select whatsapp_inbox_store('$CANAL_B3'::uuid, '$WS_UM'::uuid, 'simulated', 'ho-up-b3', 'evt-ho-up-in-2', 'whatsapp.inbound_message.received',
  repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gMw==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id' as ent_dup \gset
select whatsapp_inbox_claim(:'ent_dup'::uuid, 300) ->> 'claim_token' as tok_dup \gset
select whatsapp_effect_inbound_message(:'ent_dup'::uuid, :'tok_dup'::uuid, 'pm-ho-up-in-1', 'text', 'Mensagem fictícia recebida antes da atualização', now() - interval '6 hours',
  '$TELEFONE', null, null, null, null) ->> 'outcome' as out_dup \gset
select whatsapp_record_message_origin_time(:'ent_dup'::uuid, now() - interval '6 hours', null) ->> 'outcome' as rec_dup \gset
reset role;
commit;
insert into public.upgrade_check_values values ('out_dup', :'out_dup'), ('rec_dup', :'rec_dup');

-- Uma mensagem NOVA da B3 depois da migration ganha a origem do provedor.
begin;
$SERVICE_SQL
set local role service_role;
select whatsapp_inbox_store('$CANAL_B3'::uuid, '$WS_UM'::uuid, 'simulated', 'ho-up-b3', 'evt-ho-up-in-3', 'whatsapp.inbound_message.received',
  repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gNA==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id' as ent_new \gset
select whatsapp_inbox_claim(:'ent_new'::uuid, 300) ->> 'claim_token' as tok_new \gset
select whatsapp_effect_inbound_message(:'ent_new'::uuid, :'tok_new'::uuid, 'pm-ho-up-in-new', 'text', 'Mensagem fictícia nova', now() - interval '1 hour',
  '$TELEFONE', null, null, null, null) ->> 'outcome' as out_new \gset
select whatsapp_record_message_origin_time(:'ent_new'::uuid, now() - interval '1 hour', null) ->> 'outcome' as rec_new \gset
reset role;
commit;
insert into public.upgrade_check_values values ('out_new', :'out_new'), ('rec_new', :'rec_new');

-- Depois da migration, a A7 segue funcionando e o envio humano ganha crm_accepted.
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
select simulate_inbound_whatsapp_message('ho-up', '5511900009512', '+5511900009512', 'wamid.ho.up.2', now(), 'Mensagem fictícia nova', 'Pessoa Nova') as r2 \gset
select register_contact_consent((:'r2'::jsonb ->> 'contact_id')::uuid, 'whatsapp', 'consentimento', 'Atendimento (upgrade)', null, null, 'whatsapp_atendimento');
select send_message((:'r2'::jsonb ->> 'conversation_id')::uuid, 'Resposta fictícia depois', '99999999-9999-9999-9999-999999999994'::uuid) as env2 \gset
select apply_message_status_event('ho-up', :'env2'::jsonb ->> 'wa_message_id', 'delivered', now()) is not null as ok \gset
reset role;
commit;

do \$check\$
declare
  v_before record;
  v_after record;
  v_changed integer;
begin
  -- A migration, sozinha, não criou nem apagou linhas.
  select * into v_before from public.upgrade_check_counts;
  select * into v_after from public.upgrade_check_after_migration;
  if v_before is distinct from v_after then
    raise exception 'a migration criou ou apagou linhas: antes %, depois %', v_before, v_after;
  end if;

  -- A leitura da A7 é exatamente a de antes.
  if (select valor from public.upgrade_check_values where chave = 'lc_antes')::jsonb
     is distinct from (select valor from public.upgrade_check_values where chave = 'lc_depois')::jsonb then
    raise exception 'list_conversations mudou depois da migration';
  end if;

  -- Cada linha anterior é exatamente a de antes (as colunas novas existem e estão nulas).
  select count(*) into v_changed
  from public.upgrade_check_messages s
  join public.messages m on m.id = s.id
  where (to_jsonb(m) - 'origin_time_at' - 'origin_time_source' - 'origin_time_issue') is distinct from s.linha;
  if v_changed <> 0 then
    raise exception '% mensagem(ns) anteriores tiveram a linha alterada', v_changed;
  end if;
  if exists (
    select 1 from public.messages m join public.upgrade_check_messages s on s.id = m.id
    where m.origin_time_at is not null or m.origin_time_source is not null or m.origin_time_issue is not null) then
    raise exception 'nenhuma mensagem anterior pode ter origem: não há backfill, e o evento reentregue não a promove';
  end if;

  -- Todas as anteriores são inelegíveis por origem desconhecida, com ou sem decisão humana.
  if exists (
    select 1 from public.messages m join public.upgrade_check_messages s on s.id = m.id
    where private.message_origin_time_evidence_verdict(m.id, null) <> 'origin_unknown'
       or private.message_origin_time_evidence_verdict(m.id, now() - interval '30 days') <> 'origin_unknown') then
    raise exception 'mensagem anterior deveria ser origin_unknown';
  end if;

  -- Os efeitos da B3 antes da migration aplicaram; depois dela, a reentrega é duplicate/unchanged e a nova, applied/recorded.
  if (select valor from public.upgrade_check_values where chave = 'out_in') <> 'applied'
     or (select valor from public.upgrade_check_values where chave = 'out_eco') <> 'applied' then
    raise exception 'os efeitos anteriores à migration deveriam ter aplicado';
  end if;
  if (select valor from public.upgrade_check_values where chave = 'out_dup') <> 'duplicate'
     or (select valor from public.upgrade_check_values where chave = 'rec_dup') <> 'unchanged' then
    raise exception 'o evento reentregue deveria ser duplicate/unchanged';
  end if;
  if (select valor from public.upgrade_check_values where chave = 'out_new') <> 'applied'
     or (select valor from public.upgrade_check_values where chave = 'rec_new') <> 'recorded' then
    raise exception 'a mensagem nova deveria ser applied/recorded';
  end if;
  if not exists (select 1 from public.messages where provider_message_id = 'pm-ho-up-in-new' and origin_time_source = 'provider_send_time' and origin_time_issue is null) then
    raise exception 'a mensagem nova da B3 deveria ter a origem do provedor';
  end if;

  -- Envio humano depois da migration: crm_accepted, e só nele (o anterior não ganha nada).
  if not exists (
    select 1 from public.messages m
    where m.origin = 'crm' and m.direction = 'outbound' and m.origin_time_source = 'crm_accepted' and m.origin_time_at = m.created_at
      and not exists (select 1 from public.upgrade_check_messages s where s.id = m.id)) then
    raise exception 'o envio humano depois da migration deveria ter crm_accepted';
  end if;
end;
\$check\$;

drop table public.upgrade_check_messages;
drop table public.upgrade_check_counts;
drop table public.upgrade_check_after_migration;
drop table public.upgrade_check_values;
SQL

echo "OK: a atualização deixou todas as mensagens anteriores intactas e com origem desconhecida; só mensagens novas ganham origem."
