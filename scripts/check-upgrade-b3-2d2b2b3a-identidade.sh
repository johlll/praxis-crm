#!/usr/bin/env bash
# B3.2d-2b2b3a — valida a ATUALIZAÇÃO para o efeito de identidade alterada
# e troca de número a partir da versão anterior, com dados gravados ANTES
# da migration:
#
#   1. recria o banco local só até a migration da B3.2d-2b2b2;
#   2. usa a A7 como sempre (simulador, envio, status), cria um canal da B3
#      com uma saída observada (identidade e conversa da 2b2b1), um status
#      aplicado (2b2b2) e guarda uma entrada de troca de número na inbox —
#      e guarda o que as leituras da A7 devolvem e as linhas inteiras de
#      identidades, conversas e mensagens;
#   3. aplica a migration pendente;
#   4. confere:
#      - leituras da A7, linhas e contagens idênticas (a migration não
#        altera dados);
#      - a entrada gravada antes aplica: a MESMA identidade troca de
#        telefone, a conversa acompanha, nenhuma identidade nova, nada
#        comercial; a guarda continua barrando a troca fora do efeito;
#      - o simulador, o envio e o status da A7 continuam funcionando.
#
# Roda por último no CI: termina com o banco local na versão atual. Tudo
# fictício.
set -euo pipefail

PREVIOUS_VERSION="20261030140000"
DB_CONTAINER="supabase_db_praxis-crm"
ANA="20000000-0000-0000-0000-000000000001"
WS_UM="10000000-0000-0000-0000-000000000001"
CANAL_B3="39400000-0000-0000-0000-000000000001"
TELEFONE="+5511900009301"
TELEFONE_NOVO="+5511900009302"

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
select (create_whatsapp_channel('$WS_UM'::uuid, 'Simulador (upgrade 2b2b3a)', 'b3d2b2b3a-up', '+55 11 0000-0304')).id as canal \gset
select simulate_inbound_whatsapp_message('b3d2b2b3a-up', '5511900009311', '+5511900009311', 'wamid.up5.1', now() - interval '2 minutes', 'Mensagem fictícia antiga', 'Pessoa Antiga') as r1 \gset
select register_contact_consent((:'r1'::jsonb ->> 'contact_id')::uuid, 'whatsapp', 'consentimento', 'Atendimento (upgrade)', null, null, 'whatsapp_atendimento');
select send_message((:'r1'::jsonb ->> 'conversation_id')::uuid, 'Resposta fictícia do CRM', '99999999-9999-9999-9999-999999999995'::uuid) as env1 \gset
select apply_message_status_event('b3d2b2b3a-up', :'env1'::jsonb ->> 'wa_message_id', 'delivered', now() - interval '1 minute') is not null as ok \gset
reset role;
commit;

begin;
$SERVICE_SQL
set local role service_role;
select whatsapp_create_simulated_channel('$CANAL_B3'::uuid, '$WS_UM'::uuid, '$ANA'::uuid, 'B3 (upgrade 2b2b3a)', 'b3d2b2b3a-up-b3', '1',
  'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB', '1') is not null as ok \gset
select whatsapp_inbox_store('$CANAL_B3'::uuid, '$WS_UM'::uuid, 'simulated', 'b3d2b2b3a-up-b3', 'evt-up-eco', 'whatsapp.smb.message.echoes',
  repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gMQ==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id' as eco \gset
select whatsapp_inbox_claim(:'eco'::uuid, 300) ->> 'claim_token' as eco_token \gset
select whatsapp_effect_outbound_observed(:'eco'::uuid, :'eco_token'::uuid, 'pm-up-id-1', null, 'text', 'Mensagem fictícia observada antes da atualização', now(),
  '$TELEFONE', null, null, null) ->> 'outcome' as eco_outcome \gset
select whatsapp_inbox_store('$CANAL_B3'::uuid, '$WS_UM'::uuid, 'simulated', 'b3d2b2b3a-up-b3', 'evt-up-st', 'whatsapp.message.updated',
  repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gMg==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id' as st \gset
select whatsapp_inbox_claim(:'st'::uuid, 300) ->> 'claim_token' as st_token \gset
select whatsapp_effect_message_status(:'st'::uuid, :'st_token'::uuid, 'pm-up-id-1', null, null, 'delivered', null, now(),
  '$TELEFONE', null, null, null, null, null, null, null) ->> 'outcome' as st_outcome \gset
select whatsapp_inbox_store('$CANAL_B3'::uuid, '$WS_UM'::uuid, 'simulated', 'b3d2b2b3a-up-b3', 'evt-up-id', 'whatsapp.inbound_message.received',
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

create table public.upgrade_b3d2b2b3a_leituras as select * from leituras;
create table public.upgrade_b3d2b2b3a_linhas as
select 'i:' || x.id as chave, md5(x::text) as linha from public.whatsapp_identities x
union all select 'c:' || x.id, md5(x::text) from public.conversations x
union all select 'm:' || x.id, md5(x::text) from public.messages x;
create table public.upgrade_b3d2b2b3a_estado as
select (:'r1'::jsonb ->> 'conversation_id') as conv_a7, :'entrada'::text as entrada, :'eco_outcome' || '/' || :'st_outcome' as antes;
create table public.upgrade_b3d2b2b3a_contagens as
select 'contacts' as tabela, count(*) as n from public.contacts
union all select 'contact_phones', count(*) from public.contact_phones
union all select 'contact_identifiers', count(*) from public.contact_identifiers
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
select conv_a7, entrada, antes from public.upgrade_b3d2b2b3a_estado \gset
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
  from public.upgrade_b3d2b2b3a_leituras a join leituras_depois d using (chave)
  where a.valor is distinct from d.valor;
  if v_bad <> 0 or (select count(*) from leituras_depois) <> 3 then
    raise exception 'leituras da A7 mudaram na atualização (% diferentes)', v_bad;
  end if;

  select count(*) into v_bad
  from public.upgrade_b3d2b2b3a_linhas l
  where l.linha is distinct from case split_part(l.chave, ':', 1)
    when 'i' then (select md5(x::text) from public.whatsapp_identities x where x.id = split_part(l.chave, ':', 2)::uuid)
    when 'c' then (select md5(x::text) from public.conversations x where x.id = split_part(l.chave, ':', 2)::uuid)
    when 'm' then (select md5(x::text) from public.messages x where x.id = split_part(l.chave, ':', 2)::uuid)
  end;
  if v_bad <> 0 then
    raise exception '% linha(s) de identidade, conversa ou mensagem mudaram na migration', v_bad;
  end if;

  select count(*) into v_bad
  from public.upgrade_b3d2b2b3a_contagens c
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
  end;
  if v_bad <> 0 then
    raise exception '% contagem(ns) mudaram na migration', v_bad;
  end if;
end;
\$check\$;

-- A entrada gravada antes da migration aplica: a mesma identidade troca de número.
select i.id as identidade from public.whatsapp_identities i where i.channel_id = '$CANAL_B3'::uuid and i.phone_e164 = '$TELEFONE' \gset
begin;
$SERVICE_SQL
set local role service_role;
select whatsapp_inbox_claim(:'entrada'::uuid, 300) ->> 'claim_token' as token \gset
select whatsapp_effect_identity_change(:'entrada'::uuid, :'token'::uuid, 'phone_number', now(), '$TELEFONE', null, null, '$TELEFONE_NOVO', null, null, null) as efeito \gset
reset role;
commit;
select set_config('upgrade_check.efeito', :'efeito', false);
select set_config('upgrade_check.entrada', :'entrada', false);
select set_config('upgrade_check.identidade', :'identidade', false);
select set_config('upgrade_check.antes', :'antes', false);

do \$check\$
declare
  v_efeito jsonb := current_setting('upgrade_check.efeito')::jsonb;
  v_identity uuid := current_setting('upgrade_check.identidade')::uuid;
begin
  if current_setting('upgrade_check.antes') <> 'applied/applied' then
    raise exception 'a saída observada ou o status de antes da atualização não aplicou: %', current_setting('upgrade_check.antes');
  end if;
  if v_efeito ->> 'outcome' <> 'applied' or (v_efeito ->> 'identity_id')::uuid <> v_identity then
    raise exception 'a troca de número gravada antes da atualização não aplicou na mesma identidade: %', v_efeito;
  end if;
  if (select i.phone_e164 || '/' || c.wa_id || '/' || w.state from public.whatsapp_identities i
      join public.conversations c on c.identity_id = i.id, public.whatsapp_webhook_inbox w
      where i.id = v_identity and w.id = current_setting('upgrade_check.entrada')::uuid)
     is distinct from '$TELEFONE_NOVO/$TELEFONE_NOVO/processed' then
    raise exception 'identidade, conversa ou inbox com estado inesperado depois da troca';
  end if;
  if (select count(*) from public.whatsapp_identities) <> (select n from public.upgrade_b3d2b2b3a_contagens where tabela = 'whatsapp_identities')
     or (select count(*) from public.conversations) <> (select n from public.upgrade_b3d2b2b3a_contagens where tabela = 'conversations')
     or (select count(*) from public.contacts) <> (select n from public.upgrade_b3d2b2b3a_contagens where tabela = 'contacts')
     or (select count(*) from public.contact_phones) <> (select n from public.upgrade_b3d2b2b3a_contagens where tabela = 'contact_phones')
     or (select count(*) from public.leads) <> (select n from public.upgrade_b3d2b2b3a_contagens where tabela = 'leads') then
    raise exception 'a troca de número não deveria criar identidade, conversa ou registro comercial';
  end if;
  begin
    update public.whatsapp_identities set phone_e164 = '+5511900009399' where id = v_identity;
    raise exception 'a guarda das identidades deixou trocar o telefone fora do efeito';
  exception when raise_exception then
    if sqlerrm <> 'identity_immutable' then
      raise;
    end if;
  end;
end;
\$check\$;

-- A7 continua funcionando depois.
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
select simulate_inbound_whatsapp_message('b3d2b2b3a-up', '5511900009312', '+5511900009312', 'wamid.up5.2', now(), 'Depois da atualização', 'Pessoa Nova') ->> 'message_id' as r2 \gset
select send_message(:'conv_a7'::uuid, 'Envio depois da atualização', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaae'::uuid) as env2 \gset
select apply_message_status_event('b3d2b2b3a-up', :'env2'::jsonb ->> 'wa_message_id', 'read', now()) ->> 'status' as st2 \gset
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

drop table public.upgrade_b3d2b2b3a_leituras;
drop table public.upgrade_b3d2b2b3a_linhas;
drop table public.upgrade_b3d2b2b3a_estado;
drop table public.upgrade_b3d2b2b3a_contagens;
SQL

echo "OK: atualização preservou a A7 e as etapas anteriores; a troca de número gravada antes aplicou na mesma identidade, sem nada comercial."
