#!/usr/bin/env bash
# B3.2d-2b2b3b — valida a ATUALIZAÇÃO para o efeito dos eventos operacionais
# da conta e do número a partir da versão anterior, com dados gravados ANTES
# da migration:
#
#   1. recria o banco local só até a migration da B3.2d-2b2b3a;
#   2. usa a A7 como sempre (simulador, envio, status), cria um canal da B3
#      (sem referência da conta, como todo canal criado até aqui) com uma
#      saída observada, um status aplicado e uma entrada de evento da conta
#      guardada na inbox — e guarda o que as leituras da A7 devolvem, as
#      linhas inteiras de canais, identidades, conversas e mensagens e as
#      contagens;
#   3. aplica a migration pendente;
#   4. confere:
#      - leituras da A7, linhas e contagens idênticas (a migration não
#        altera dados: os canais antigos ficam sem referência nem datas
#        operacionais, e a tabela de eventos nasce vazia);
#      - a entrada gravada antes é recusada com `account_reference_unverified`
#        (canal sem referência confiável), sem gravar nada;
#      - um canal novo, criado COM a referência da conta, aplica a exclusão
#        (disconnected, sem envio, uma auditoria) sem tocar o canal antigo;
#      - a guarda do canal continua (routing key e referência imutáveis);
#      - o simulador, o envio e o status da A7 continuam funcionando.
#
# Roda por último no CI: termina com o banco local na versão atual. Tudo
# fictício.
set -euo pipefail

PREVIOUS_VERSION="20261030160000"
DB_CONTAINER="supabase_db_praxis-crm"
ANA="20000000-0000-0000-0000-000000000001"
WS_UM="10000000-0000-0000-0000-000000000001"
CANAL_B3="39500000-0000-0000-0000-000000000001"
CANAL_NOVO="39500000-0000-0000-0000-000000000002"
TELEFONE="+5511900009401"

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
select (create_whatsapp_channel('$WS_UM'::uuid, 'Simulador (upgrade 2b2b3b)', 'b3d2b2b3b-up', '+55 11 0000-0306')).id as canal \gset
select simulate_inbound_whatsapp_message('b3d2b2b3b-up', '5511900009411', '+5511900009411', 'wamid.up6.1', now() - interval '2 minutes', 'Mensagem fictícia antiga', 'Pessoa Antiga') as r1 \gset
select register_contact_consent((:'r1'::jsonb ->> 'contact_id')::uuid, 'whatsapp', 'consentimento', 'Atendimento (upgrade)', null, null, 'whatsapp_atendimento');
select send_message((:'r1'::jsonb ->> 'conversation_id')::uuid, 'Resposta fictícia do CRM', '99999999-9999-9999-9999-999999999994'::uuid) as env1 \gset
select apply_message_status_event('b3d2b2b3b-up', :'env1'::jsonb ->> 'wa_message_id', 'delivered', now() - interval '1 minute') is not null as ok \gset
reset role;
commit;

begin;
$SERVICE_SQL
set local role service_role;
select whatsapp_create_simulated_channel('$CANAL_B3'::uuid, '$WS_UM'::uuid, '$ANA'::uuid, 'B3 (upgrade 2b2b3b)', 'b3d2b2b3b-up-b3', '1',
  'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB', '1') is not null as ok \gset
select whatsapp_inbox_store('$CANAL_B3'::uuid, '$WS_UM'::uuid, 'simulated', 'b3d2b2b3b-up-b3', 'evt-up-eco', 'whatsapp.smb.message.echoes',
  repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gMQ==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id' as eco \gset
select whatsapp_inbox_claim(:'eco'::uuid, 300) ->> 'claim_token' as eco_token \gset
select whatsapp_effect_outbound_observed(:'eco'::uuid, :'eco_token'::uuid, 'pm-up-id-1', null, 'text', 'Mensagem fictícia observada antes da atualização', now(),
  '$TELEFONE', null, null, null) ->> 'outcome' as eco_outcome \gset
select whatsapp_inbox_store('$CANAL_B3'::uuid, '$WS_UM'::uuid, 'simulated', 'b3d2b2b3b-up-b3', 'evt-up-st', 'whatsapp.message.updated',
  repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gMg==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id' as st \gset
select whatsapp_inbox_claim(:'st'::uuid, 300) ->> 'claim_token' as st_token \gset
select whatsapp_effect_message_status(:'st'::uuid, :'st_token'::uuid, 'pm-up-id-1', null, null, 'delivered', null, now(),
  '$TELEFONE', null, null, null, null, null, null, null) ->> 'outcome' as st_outcome \gset
select whatsapp_inbox_store('$CANAL_B3'::uuid, '$WS_UM'::uuid, 'simulated', 'b3d2b2b3b-up-b3', 'evt-up-conta', 'whatsapp.business_account.deleted',
  repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gMw==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id' as entrada \gset
reset role;
commit;

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

create table public.upgrade_b3d2b2b3b_leituras as select * from leituras;
create table public.upgrade_b3d2b2b3b_linhas as
select 'i:' || x.id as chave, md5(x::text) as linha from public.whatsapp_identities x
union all select 'c:' || x.id, md5(x::text) from public.conversations x
union all select 'm:' || x.id, md5(x::text) from public.messages x
union all select 'h:' || x.id, md5(to_jsonb(x)::text) from public.whatsapp_channels x
union all select 'l:' || x.id, md5(x::text) from public.whatsapp_effect_ledger x
union all select 'b:' || x.id, md5(x::text) from public.whatsapp_webhook_inbox x where x.id <> :'entrada'::uuid;
create table public.upgrade_b3d2b2b3b_estado as
select (:'r1'::jsonb ->> 'conversation_id') as conv_a7, :'entrada'::text as entrada, :'eco_outcome' || '/' || :'st_outcome' as antes;
create table public.upgrade_b3d2b2b3b_contagens as
select 'contacts' as tabela, count(*) as n from public.contacts
union all select 'contact_phones', count(*) from public.contact_phones
union all select 'contact_identifiers', count(*) from public.contact_identifiers
union all select 'leads', count(*) from public.leads
union all select 'opportunities', count(*) from public.opportunities
union all select 'activities', count(*) from public.activities
union all select 'conversations', count(*) from public.conversations
union all select 'messages', count(*) from public.messages
union all select 'whatsapp_identities', count(*) from public.whatsapp_identities
union all select 'whatsapp_effect_ledger', count(*) from public.whatsapp_effect_ledger
union all select 'whatsapp_channels', count(*) from public.whatsapp_channels;
SQL

echo "== 3. migration pendente"
supabase migration up --local

echo "== 4. conferências"
psql_db <<SQL
select conv_a7, entrada, antes from public.upgrade_b3d2b2b3b_estado \gset
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
  from public.upgrade_b3d2b2b3b_leituras a join leituras_depois d using (chave)
  where a.valor is distinct from d.valor;
  if v_bad <> 0 or (select count(*) from leituras_depois) <> 3 then
    raise exception 'leituras da A7 mudaram na atualização (% diferentes)', v_bad;
  end if;

  select count(*) into v_bad
  from public.upgrade_b3d2b2b3b_linhas l
  where l.linha is distinct from case split_part(l.chave, ':', 1)
    when 'i' then (select md5(x::text) from public.whatsapp_identities x where x.id = split_part(l.chave, ':', 2)::uuid)
    when 'c' then (select md5(x::text) from public.conversations x where x.id = split_part(l.chave, ':', 2)::uuid)
    when 'm' then (select md5(x::text) from public.messages x where x.id = split_part(l.chave, ':', 2)::uuid)
    when 'h' then (select md5((to_jsonb(x) - 'provider_account_ref' - 'last_event_at' - 'provider_status_event_at')::text) from public.whatsapp_channels x where x.id = split_part(l.chave, ':', 2)::uuid)
    when 'l' then (select md5(x::text) from public.whatsapp_effect_ledger x where x.id = split_part(l.chave, ':', 2)::uuid)
    when 'b' then (select md5(x::text) from public.whatsapp_webhook_inbox x where x.id = split_part(l.chave, ':', 2)::uuid)
  end;
  if v_bad <> 0 then
    raise exception '% linha(s) de canal, identidade, conversa, mensagem, ledger ou inbox mudaram na migration', v_bad;
  end if;

  select count(*) into v_bad
  from public.upgrade_b3d2b2b3b_contagens c
  where c.n <> case c.tabela
    when 'contacts' then (select count(*) from public.contacts)
    when 'contact_phones' then (select count(*) from public.contact_phones)
    when 'contact_identifiers' then (select count(*) from public.contact_identifiers)
    when 'leads' then (select count(*) from public.leads)
    when 'opportunities' then (select count(*) from public.opportunities)
    when 'activities' then (select count(*) from public.activities)
    when 'conversations' then (select count(*) from public.conversations)
    when 'messages' then (select count(*) from public.messages)
    when 'whatsapp_identities' then (select count(*) from public.whatsapp_identities)
    when 'whatsapp_effect_ledger' then (select count(*) from public.whatsapp_effect_ledger)
    when 'whatsapp_channels' then (select count(*) from public.whatsapp_channels)
  end;
  if v_bad <> 0 then
    raise exception '% contagem(ns) mudaram na migration', v_bad;
  end if;

  -- Os canais antigos não ganharam referência nem datas; a tabela nasce vazia.
  if (select count(*) from public.whatsapp_channels
      where provider_account_ref is not null or last_event_at is not null or provider_status_event_at is not null) <> 0 then
    raise exception 'a migration não deveria preencher referência nem datas operacionais dos canais antigos';
  end if;
  if (select count(*) from public.whatsapp_channel_events) <> 0 then
    raise exception 'a tabela de eventos operacionais deveria nascer vazia';
  end if;
end;
\$check\$;

-- A entrada gravada antes da migration, num canal SEM referência confiável:
-- recusada, sem gravar nada, e o claim continua.
begin;
$SERVICE_SQL
set local role service_role;
select whatsapp_inbox_claim(:'entrada'::uuid, 300) ->> 'claim_token' as token \gset
select whatsapp_effect_account_event(:'entrada'::uuid, :'token'::uuid, 'business_account', 'whatsapp.business_account.deleted', 'WABA-UP1', null, now(), 'USER_REQUEST') ->> 'outcome' as efeito \gset
reset role;
commit;
select set_config('upgrade_check.efeito', :'efeito', false);
select set_config('upgrade_check.entrada', :'entrada', false);
select set_config('upgrade_check.antes', :'antes', false);

do \$check\$
begin
  if current_setting('upgrade_check.antes') <> 'applied/applied' then
    raise exception 'a saída observada ou o status de antes da atualização não aplicou: %', current_setting('upgrade_check.antes');
  end if;
  if current_setting('upgrade_check.efeito') <> 'account_reference_unverified' then
    raise exception 'o evento da conta num canal sem referência deveria ser account_reference_unverified: %', current_setting('upgrade_check.efeito');
  end if;
  if (select w.state from public.whatsapp_webhook_inbox w where w.id = current_setting('upgrade_check.entrada')::uuid) <> 'processing'
     or (select count(*) from public.whatsapp_channel_events) <> 0
     or (select count(*) from public.whatsapp_effect_ledger where inbox_id = current_setting('upgrade_check.entrada')::uuid) <> 0
     or (select status || send_enabled::text from public.whatsapp_channels where id = '$CANAL_B3'::uuid) <> 'activefalse' then
    raise exception 'a recusa por canal sem referência não deveria gravar nada nem mexer no canal';
  end if;
end;
\$check\$;

-- Um canal novo, criado COM a referência da conta: a exclusão desconecta só ele.
insert into public.whatsapp_channels (id, workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment,
  routing_key, status, send_enabled, status_changed_at, provider_account_ref)
values ('$CANAL_NOVO'::uuid, '$WS_UM'::uuid, 'Canal com conta (upgrade)', '1', '$ANA'::uuid, 'ycloud', false, 'preview',
  'WABA-UP1:+5511900009402', 'active', true, now(), 'WABA-UP1');
begin;
$SERVICE_SQL
set local role service_role;
select whatsapp_inbox_store('$CANAL_NOVO'::uuid, '$WS_UM'::uuid, 'ycloud', 'WABA-UP1:+5511900009402', 'evt-up-del', 'whatsapp.phone_number.deleted',
  repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gNA==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id' as entrada_nova \gset
select whatsapp_inbox_claim(:'entrada_nova'::uuid, 300) ->> 'claim_token' as token_novo \gset
select whatsapp_effect_account_event(:'entrada_nova'::uuid, :'token_novo'::uuid, 'phone_number', 'whatsapp.phone_number.deleted', 'WABA-UP1',
  'WABA-UP1:+5511900009402', '2026-10-30 12:00:00+00', null) ->> 'outcome' as efeito_novo \gset
reset role;
commit;
select set_config('upgrade_check.efeito_novo', :'efeito_novo', false);

do \$check\$
begin
  if current_setting('upgrade_check.efeito_novo') <> 'applied' then
    raise exception 'a exclusão no canal com referência deveria aplicar: %', current_setting('upgrade_check.efeito_novo');
  end if;
  if (select c.status || '|' || c.send_enabled::text || '|' || (c.provider_status_event_at = '2026-10-30 12:00:00+00')::text from public.whatsapp_channels c where c.id = '$CANAL_NOVO'::uuid)
       <> 'disconnected|false|true'
     or (select count(*) from public.audit_logs where resource_id = '$CANAL_NOVO'::uuid and action = 'whatsapp.channel.disconnected') <> 1
     or (select status from public.whatsapp_channels where id = '$CANAL_B3'::uuid) <> 'active' then
    raise exception 'só o canal novo deveria ter sido desconectado, com uma auditoria';
  end if;
  begin
    update public.whatsapp_channels set routing_key = 'outra-rota' where id = '$CANAL_NOVO'::uuid;
    raise exception 'a guarda do canal deixou trocar a routing key';
  exception when raise_exception then
    if sqlerrm <> 'channel_identity_immutable' then
      raise;
    end if;
  end;
  begin
    update public.whatsapp_channels set provider_account_ref = 'WABA-OUTRA' where id = '$CANAL_NOVO'::uuid;
    raise exception 'a guarda do canal deixou trocar a referência da conta';
  exception when raise_exception then
    if sqlerrm <> 'channel_identity_immutable' then
      raise;
    end if;
  end;
end;
\$check\$;

-- A7 continua funcionando depois.
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
select simulate_inbound_whatsapp_message('b3d2b2b3b-up', '5511900009412', '+5511900009412', 'wamid.up6.2', now(), 'Depois da atualização', 'Pessoa Nova') ->> 'message_id' as r2 \gset
select send_message(:'conv_a7'::uuid, 'Envio depois da atualização', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaf'::uuid) as env2 \gset
select apply_message_status_event('b3d2b2b3b-up', :'env2'::jsonb ->> 'wa_message_id', 'read', now()) ->> 'status' as st2 \gset
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

drop table public.upgrade_b3d2b2b3b_leituras;
drop table public.upgrade_b3d2b2b3b_linhas;
drop table public.upgrade_b3d2b2b3b_estado;
drop table public.upgrade_b3d2b2b3b_contagens;
SQL

echo "OK: atualização preservou a A7 e as etapas anteriores; a entrada de conta num canal sem referência foi recusada sem gravar nada; o canal com referência desconectou só ele, com uma auditoria."
