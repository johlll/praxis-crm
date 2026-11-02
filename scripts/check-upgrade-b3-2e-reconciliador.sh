#!/usr/bin/env bash
# B3.2e — valida a ATUALIZAÇÃO para o reconciliador da inbox a partir da versão
# anterior, com entradas gravadas ANTES da migration:
#
#   1. recria o banco local só até a migration da B3.2d-2b2b3b;
#   2. cria um canal da B3 com entradas pending (uma nunca tentada, uma liberada
#      com message_not_found, uma com channel_paused), uma em processing com a
#      lease vigente, uma com a lease vencida, uma processed e uma failed, e
#      guarda o hash de cada linha;
#   3. aplica a migration pendente;
#   4. confere:
#      - nenhuma coluna antiga mudou, e as técnicas nascem vazias (contador 0);
#      - o batimento nasce vazio;
#      - as entradas antigas passam a ser recuperáveis: a pending, a recuperável
#        e a lease vencida são reservadas; a channel_paused com o canal
#        pausado, a lease vigente, a processed e a failed não;
#      - a reserva não muda state nem claim; a confirmação também não;
#      - o claim, a finalização e a gravação continuam funcionando, inclusive
#        com a reserva vigente.
#
# Roda por último no CI: termina com o banco local na versão atual. Tudo
# fictício.
set -euo pipefail

PREVIOUS_VERSION="20261030180000"
DB_CONTAINER="supabase_db_praxis-crm"
ANA="20000000-0000-0000-0000-000000000001"
WS_UM="10000000-0000-0000-0000-000000000001"
CANAL="39600000-0000-0000-0000-000000000001"
CANAL_PAUSADO="39600000-0000-0000-0000-000000000002"

psql_db() {
  docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"
}

SERVICE_SQL="select set_config('request.headers', json_build_object('x-praxis-whatsapp-env', 'v1.preview.' || e.x || '.' || private.whatsapp_environment_signature('preview', e.x, k.signing_key))::text, false)
  from (select extract(epoch from now())::bigint + 600 as x) e,
       (select signing_key from public.whatsapp_environment_keys where environment = 'preview') k \\g /dev/null"

store() { # canal routing evento
  echo "select whatsapp_inbox_store('$1'::uuid, '$WS_UM'::uuid, 'simulated', '$2', '$3', 'whatsapp.inbound_message.received',
  repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gMQ==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id' as $4 \\gset"
}

echo "== 1. banco na versão anterior ($PREVIOUS_VERSION)"
supabase db reset --local --version "$PREVIOUS_VERSION"

echo "== 2. entradas gravadas antes da migration"
psql_db <<SQL
insert into public.whatsapp_environment_keys (environment, signing_key) values
  ('preview', 'chave-whatsapp-preview-atualizacao-0123456789')
on conflict do nothing;

begin;
$SERVICE_SQL
set local role service_role;
select whatsapp_create_simulated_channel('$CANAL'::uuid, '$WS_UM'::uuid, '$ANA'::uuid, 'B3 (upgrade 2e)', 'b3e-up-1', '1',
  'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB', '1') is not null as ok \gset
select whatsapp_create_simulated_channel('$CANAL_PAUSADO'::uuid, '$WS_UM'::uuid, '$ANA'::uuid, 'B3 pausado (upgrade 2e)', 'b3e-up-2', '1',
  'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB', '1') is not null as ok \gset
$(store "$CANAL" b3e-up-1 evt-nova nova)
$(store "$CANAL" b3e-up-1 evt-rec rec)
$(store "$CANAL_PAUSADO" b3e-up-2 evt-pausa pausa)
$(store "$CANAL" b3e-up-1 evt-viva viva)
$(store "$CANAL" b3e-up-1 evt-vencida vencida)
$(store "$CANAL" b3e-up-1 evt-feita feita)
$(store "$CANAL" b3e-up-1 evt-falha falha)
select whatsapp_inbox_claim(:'rec'::uuid, 300) ->> 'claim_token' as t \gset
select whatsapp_inbox_release(:'rec'::uuid, :'t'::uuid, 'message_not_found') is not null as ok \gset
select whatsapp_inbox_claim(:'pausa'::uuid, 300) ->> 'claim_token' as t \gset
select whatsapp_inbox_release(:'pausa'::uuid, :'t'::uuid, 'channel_paused') is not null as ok \gset
select whatsapp_inbox_claim(:'viva'::uuid, 900) ->> 'claim_token' as t \gset
select whatsapp_inbox_claim(:'vencida'::uuid, 300) ->> 'claim_token' as t \gset
select whatsapp_inbox_claim(:'feita'::uuid, 300) ->> 'claim_token' as t \gset
select whatsapp_inbox_complete(:'feita'::uuid, :'t'::uuid) is not null as ok \gset
select whatsapp_inbox_claim(:'falha'::uuid, 300) ->> 'claim_token' as t \gset
select whatsapp_inbox_fail(:'falha'::uuid, :'t'::uuid, 'payload_invalid') is not null as ok \gset
reset role;
commit;

-- O tempo passa: recebidas há 10 minutos, liberadas há 5; o canal parou antes.
update public.whatsapp_webhook_inbox set received_at = now() - interval '10 minutes' where channel_id in ('$CANAL', '$CANAL_PAUSADO');
update public.whatsapp_webhook_inbox set last_released_at = now() - interval '5 minutes' where id in (:'rec', :'pausa');
update public.whatsapp_webhook_inbox set claimed_at = now() - interval '10 minutes', lease_until = now() - interval '1 second' where id = :'vencida';
update public.whatsapp_channels set status = 'paused', send_enabled = false, status_changed_at = now() - interval '1 hour' where id = '$CANAL_PAUSADO';

create table public.upgrade_b3e_ids (nome text primary key, id uuid not null);
insert into public.upgrade_b3e_ids values ('nova', :'nova'), ('rec', :'rec'), ('pausa', :'pausa'), ('viva', :'viva'),
  ('vencida', :'vencida'), ('feita', :'feita'), ('falha', :'falha');
create table public.upgrade_b3e_linhas as
select i.id, md5(to_jsonb(i)::text) as linha from public.whatsapp_webhook_inbox i;
SQL

echo "== 3. migration pendente"
supabase migration up --local

echo "== 4. conferências"
psql_db <<SQL
do \$check\$
declare
  v text;
begin
  -- Nenhuma coluna antiga mudou.
  select string_agg(l.id::text, ',') into v
  from public.upgrade_b3e_linhas l
  join public.whatsapp_webhook_inbox i on i.id = l.id
  where md5((to_jsonb(i) - array['reconcile_token', 'reconcile_reserved_at', 'reconcile_reserved_until', 'reconcile_attempts',
    'last_republished_at', 'last_republish_error_code', 'reconcile_next_at'])::text) <> l.linha;
  if v is not null then
    raise exception 'a migration mudou linhas antigas da inbox: %', v;
  end if;

  -- As colunas técnicas nascem vazias.
  if exists (select 1 from public.whatsapp_webhook_inbox where reconcile_attempts <> 0 or reconcile_token is not null or reconcile_reserved_at is not null
      or reconcile_reserved_until is not null or last_republished_at is not null or last_republish_error_code is not null or reconcile_next_at is not null) then
    raise exception 'as colunas técnicas não nasceram vazias';
  end if;
  if exists (select 1 from public.whatsapp_reconciler_runs) then
    raise exception 'o batimento não nasceu vazio';
  end if;
end;
\$check\$;

$SERVICE_SQL
set role service_role;
select whatsapp_inbox_reconcile_reserve(25, 120) as r \gset
reset role;

create table public.upgrade_b3e_reservadas as
select e ->> 'inbox_id' as id, e ->> 'reservation_token' as token from jsonb_array_elements(:'r'::jsonb -> 'entries') e;

do \$check\$
declare
  v text;
begin
  select string_agg(n.nome, ',' order by n.nome) into v
  from public.upgrade_b3e_ids n join public.upgrade_b3e_reservadas r on r.id = n.id::text;
  if v is distinct from 'nova,rec,vencida' then
    raise exception 'elegibilidade das entradas antigas: esperava nova,rec,vencida, veio %', v;
  end if;

  select string_agg(l.id::text, ',') into v
  from public.upgrade_b3e_linhas l
  join public.whatsapp_webhook_inbox i on i.id = l.id
  where md5((to_jsonb(i) - array['reconcile_token', 'reconcile_reserved_at', 'reconcile_reserved_until', 'reconcile_attempts',
    'last_republished_at', 'last_republish_error_code', 'reconcile_next_at'])::text) <> l.linha;
  if v is not null then
    raise exception 'a reserva mudou state, claim ou cifra: %', v;
  end if;
end;
\$check\$;

select id as id_nova from public.upgrade_b3e_ids where nome = 'nova' \gset
select id as id_rec from public.upgrade_b3e_ids where nome = 'rec' \gset
select id as id_vencida from public.upgrade_b3e_ids where nome = 'vencida' \gset
select token as tok_nova from public.upgrade_b3e_reservadas where id = :'id_nova' \gset

set role service_role;
-- Com a reserva vigente: o consumidor continua conseguindo reclamar e finalizar.
select whatsapp_inbox_claim(:'id_rec'::uuid, 300) ->> 'claim_token' as t_rec \gset
select whatsapp_inbox_complete(:'id_rec'::uuid, :'t_rec'::uuid) ->> 'outcome' as o_rec \gset
select whatsapp_inbox_claim(:'id_vencida'::uuid, 300) ->> 'outcome' as o_vencida \gset
select whatsapp_inbox_reconcile_confirm(:'id_nova'::uuid, :'tok_nova'::uuid) ->> 'outcome' as o_nova \gset
-- A gravação continua funcionando.
select whatsapp_inbox_store('$CANAL'::uuid, '$WS_UM'::uuid, 'simulated', 'b3e-up-1', 'evt-depois', 'whatsapp.inbound_message.received',
  repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gMQ==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'outcome' as o_store \gset
select whatsapp_reconciler_record_run('manual_test', clock_timestamp(), 'ok', 3, 3, 1, 0, 0) ->> 'outcome' as o_run \gset
reset role;

select set_config('upgrade_check.r', :'o_rec' || '|' || :'o_vencida' || '|' || :'o_nova' || '|' || :'o_store' || '|' || :'o_run', false) \g /dev/null
do \$check\$
begin
  if current_setting('upgrade_check.r') <> 'completed|claimed|confirmed|inserted|recorded' then
    raise exception 'depois da atualização: %', current_setting('upgrade_check.r');
  end if;
end;
\$check\$;

drop table public.upgrade_b3e_ids;
drop table public.upgrade_b3e_linhas;
drop table public.upgrade_b3e_reservadas;
SQL

echo "OK: atualização preservou as entradas antigas e o reconciliador as alcança sem mudar state nem claim."
