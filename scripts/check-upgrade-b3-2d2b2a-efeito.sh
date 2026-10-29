#!/usr/bin/env bash
# B3.2d-2b2a — valida a ATUALIZAÇÃO para o efeito de mensagem recebida a
# partir da versão anterior, com dados gravados ANTES da migration:
#
#   1. recria o banco local só até a última migration da B3.2d-2b1;
#   2. usa a A7 como sempre (simulador, envio, status), cria um canal da B3
#      com uma conversa já existente para um telefone e guarda uma entrada
#      na inbox — e guarda o que as leituras da A7 devolvem;
#   3. aplica a migration pendente;
#   4. confere:
#      - as leituras da A7 devolvem exatamente o mesmo de antes;
#      - nenhum contato, lead, oportunidade, atividade, conversa, mensagem,
#        identidade ou ledger foi criado ou apagado pela migration;
#      - a entrada gravada antes aplica: reutiliza a identidade e a
#        conversa já existentes, sem criar contato ou lead (a conversa já
#        existia) e finaliza a inbox;
#      - o simulador e o envio da A7 continuam funcionando depois.
#
# Roda por último no CI: termina com o banco local na versão atual. Tudo
# fictício.
set -euo pipefail

PREVIOUS_VERSION="20261028120100"
DB_CONTAINER="supabase_db_praxis-crm"
ANA="20000000-0000-0000-0000-000000000001"
WS_UM="10000000-0000-0000-0000-000000000001"
CANAL_B3="39100000-0000-0000-0000-000000000001"
TELEFONE="+5511900008001"

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
select (create_whatsapp_channel('$WS_UM'::uuid, 'Simulador (upgrade 2b2a)', 'b3d2b2a-up', '+55 11 0000-0301')).id as canal \gset
select simulate_inbound_whatsapp_message('b3d2b2a-up', '5511900008101', '+5511900008101', 'wamid.up2.1', now() - interval '2 minutes', 'Mensagem fictícia antiga', 'Pessoa Antiga') as r1 \gset
select register_contact_consent((:'r1'::jsonb ->> 'contact_id')::uuid, 'whatsapp', 'consentimento', 'Atendimento (upgrade)', null, null, 'whatsapp_atendimento');
select send_message((:'r1'::jsonb ->> 'conversation_id')::uuid, 'Resposta fictícia do CRM', '99999999-9999-9999-9999-999999999998'::uuid) as env1 \gset
reset role;
commit;

begin;
$SERVICE_SQL
set local role service_role;
select whatsapp_create_simulated_channel('$CANAL_B3'::uuid, '$WS_UM'::uuid, '$ANA'::uuid, 'B3 (upgrade 2b2a)', 'b3d2b2a-up-b3', '1',
  'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB', '1') is not null as ok \gset
select whatsapp_inbox_store('$CANAL_B3'::uuid, '$WS_UM'::uuid, 'simulated', 'b3d2b2a-up-b3', 'evt-up-1', 'whatsapp.inbound_message.received',
  repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gMQ==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id' as entrada \gset
reset role;
-- Conversa já existente no canal da B3 (a identidade nasce do telefone).
insert into public.conversations (workspace_id, channel_id, wa_id) values ('$WS_UM'::uuid, '$CANAL_B3'::uuid, '$TELEFONE');
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

create table public.upgrade_b3d2b2a_leituras as select * from leituras;
create table public.upgrade_b3d2b2a_estado as
select (:'r1'::jsonb ->> 'conversation_id') as conv_a7, :'entrada'::text as entrada;
create table public.upgrade_b3d2b2a_contagens as
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
select conv_a7, entrada from public.upgrade_b3d2b2a_estado \gset
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
  from public.upgrade_b3d2b2a_leituras a join leituras_depois d using (chave)
  where a.valor is distinct from d.valor;
  if v_bad <> 0 or (select count(*) from leituras_depois) <> 3 then
    raise exception 'leituras da A7 mudaram na atualização (% diferentes)', v_bad;
  end if;

  select count(*) into v_bad
  from public.upgrade_b3d2b2a_contagens c
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

-- A entrada gravada antes da migration aplica sobre a conversa existente.
begin;
$SERVICE_SQL
set local role service_role;
select whatsapp_inbox_claim(:'entrada'::uuid, 300) ->> 'claim_token' as token \gset
select whatsapp_effect_inbound_message(:'entrada'::uuid, :'token'::uuid, 'pm-up-1', 'text', 'Mensagem fictícia depois da atualização', now(),
  '$TELEFONE', null, null, null, null) as efeito \gset
reset role;
commit;
select set_config('upgrade_check.efeito', :'efeito', false);
select set_config('upgrade_check.entrada', :'entrada', false);

do \$check\$
declare
  v_efeito jsonb := current_setting('upgrade_check.efeito')::jsonb;
  v_conv uuid;
begin
  select c.id into v_conv from public.conversations c join public.whatsapp_identities i on i.id = c.identity_id
  where c.channel_id = '$CANAL_B3'::uuid and i.phone_e164 = '$TELEFONE';
  if v_efeito ->> 'outcome' <> 'applied' or (v_efeito ->> 'conversation_id')::uuid <> v_conv then
    raise exception 'o efeito não reutilizou a conversa existente: %', v_efeito;
  end if;
  if (v_efeito ->> 'contact_created')::boolean or (v_efeito ->> 'lead_created')::boolean then
    raise exception 'conversa já existente não deveria criar contato nem lead';
  end if;
  if (select count(*) from public.whatsapp_identities where channel_id = '$CANAL_B3'::uuid) <> 1
     or (select count(*) from public.conversations where channel_id = '$CANAL_B3'::uuid) <> 1 then
    raise exception 'o efeito criou identidade ou conversa a mais';
  end if;
  if (select origin || '/' || sender_classification || '/' || state from public.messages m, public.whatsapp_webhook_inbox w
      where m.provider_message_id = 'pm-up-1' and w.id = current_setting('upgrade_check.entrada')::uuid) <> 'inbound/external/processed' then
    raise exception 'mensagem ou inbox com estado inesperado depois do efeito';
  end if;
end;
\$check\$;

-- A7 continua funcionando depois.
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
select simulate_inbound_whatsapp_message('b3d2b2a-up', '5511900008102', '+5511900008102', 'wamid.up2.2', now(), 'Depois da atualização', 'Pessoa Nova') ->> 'message_id' as r2 \gset
select send_message(:'conv_a7'::uuid, 'Envio depois da atualização', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab'::uuid) ->> 'message_id' as env2 \gset
reset role;
commit;

drop table public.upgrade_b3d2b2a_leituras;
drop table public.upgrade_b3d2b2a_estado;
drop table public.upgrade_b3d2b2a_contagens;
SQL

echo "OK: atualização preservou a A7 e o efeito novo aplicou sobre a conversa existente."
