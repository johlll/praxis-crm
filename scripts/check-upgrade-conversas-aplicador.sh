#!/usr/bin/env bash
# Conversas + IA — valida a ATUALIZAÇÃO para o aplicador determinístico a partir da versão anterior
# (horário de origem, 20261124120000), com trilhas, roteiro e chaves gravados ANTES da migration:
#
#   1. recria o banco local na versão anterior;
#   2. usa as trilhas como sempre: correção manual da situação do atendimento (com evidência e chave),
#      andamento e roteiro de um caso ganho (com chave), e guarda as linhas inteiras dos históricos, das
#      trilhas, do registro de chaves e a exportação do titular;
#   3. aplica a migration pendente;
#   4. confere:
#      - nenhuma linha antiga mudou (os históricos só ganharam automation_decision_id NULO; autoria
#        'user' com o mesmo usuário) e nada foi criado ou apagado;
#      - a exportação é a mesma, com a seção nova vazia;
#      - o portão nasce fechado: o aplicador recusa tudo (automation_disabled) sem gravar;
#      - a correção manual continua funcionando e continua exigindo usuário;
#      - com o portão aberto só dentro de uma transação desfeita, uma chave gravada ANTES pela correção
#        manual não vale no aplicador (registro único compartilhado).
#
# Tudo fictício. Termina com o banco local na versão atual e o portão fechado.
set -euo pipefail

PREVIOUS_VERSION="20261124120000"
DB_CONTAINER="supabase_db_praxis-crm"
ANA="20000000-0000-0000-0000-000000000001"
WS_UM="10000000-0000-0000-0000-000000000001"
CHAVE_ANTIGA="62e00000-0000-4000-8000-000000000001"
CHAVE_ROTEIRO="62e00000-0000-4000-8000-000000000002"

psql_db() {
  docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"
}

echo "== 1. banco na versão anterior ($PREVIOUS_VERSION)"
supabase db reset --local --version "$PREVIOUS_VERSION"

echo "== 2. trilhas, roteiro e chaves em uso antes da migration"
psql_db <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
select (create_contact('$WS_UM'::uuid, 'pf', 'Titular atualização aplicador', null, null, null)).id as contato \gset
select create_lead('$WS_UM'::uuid, :'contato'::uuid, 'Imobiliário', null, '{}'::text[], 'media', '$ANA'::uuid) as lead \gset
select create_opportunity(:'lead'::uuid) as opp \gset
select win_opportunity(:'opp'::uuid, 0, 100000, 'fixed');
select (create_service_type('$WS_UM'::uuid, 'Tipo atualização aplicador', array['Um', 'Dois'])) ->> 'id' as tipo \gset
select apply_case_service_plan(:'opp'::uuid, :'tipo'::uuid, 0, 1, '$CHAVE_ROTEIRO'::uuid);
select set_opportunity_case_progress(:'opp'::uuid, 'em_analise', 1, '{}'::uuid[], null);
reset role;
commit;

insert into public.whatsapp_channels (workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment, routing_key)
  values ('$WS_UM', 'Canal atualização aplicador', '+5541900006280', '$ANA', 'ycloud', false, 'preview', 'rota-up-aplicador') returning id as canal \gset
insert into public.whatsapp_identities (workspace_id, channel_id, provider, environment, phone_e164)
  values ('$WS_UM', :'canal', 'ycloud', 'preview', '+5541999996281') returning id as ident \gset
insert into public.conversations (workspace_id, channel_id, identity_id, contact_id, lead_id)
  values ('$WS_UM', :'canal', :'ident', :'contato', :'lead') returning id as conv \gset
insert into public.messages (workspace_id, conversation_id, channel_id, direction, status, origin, sender_classification, content_kind, body_text, provider, provider_message_id)
  values ('$WS_UM', :'conv', :'canal', 'inbound', 'delivered', 'inbound', 'external', 'text', 'Mensagem fictícia antiga', 'ycloud', 'pm-up-aplicador-1') returning id as msg \gset

begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
select set_conversation_attendance_status(:'conv'::uuid, 'aguardando_escritorio', 0, array[:'msg'::uuid], '$CHAVE_ANTIGA'::uuid);
reset role;
commit;

create table public.upgrade_ap_rows as
  select 'evento:' || id as k, to_jsonb(e) as linha from public.status_track_events e
  union all select 'roteiro:' || id, to_jsonb(e) from public.case_service_events e
  union all select 'trilha:' || id, to_jsonb(t) from public.status_tracks t
  union all select 'chave:' || workspace_id || ':' || idempotency_key, to_jsonb(k) from public.status_track_idempotency_keys k
  union all select 'evidencia:' || event_id || ':' || message_id, to_jsonb(v) from public.status_track_event_evidence v;
create table public.upgrade_ap_values (k text primary key, v text);
insert into public.upgrade_ap_values values
  ('conv', :'conv'), ('contato', :'contato'), ('opp', :'opp'), ('msg', :'msg'),
  ('export', private.privacy_export_payload('$WS_UM', :'contato')::text);
SQL

echo "== 3. migration pendente"
supabase migration up --local

echo "== 4. conferências"
psql_db <<SQL
select v as conv from public.upgrade_ap_values where k = 'conv' \gset
select v as contato from public.upgrade_ap_values where k = 'contato' \gset
select v as msg from public.upgrade_ap_values where k = 'msg' \gset

do \$check\$
declare
  v_changed integer;
  v_after jsonb;
  v_rows integer;
begin
  -- Nenhuma linha antiga mudou; os históricos só ganharam a coluna nova, nula.
  select count(*) into v_changed
  from public.upgrade_ap_rows r
  left join lateral (
    select case split_part(r.k, ':', 1)
      when 'evento' then (select to_jsonb(e) - 'automation_decision_id' from public.status_track_events e where e.id = split_part(r.k, ':', 2)::uuid)
      when 'roteiro' then (select to_jsonb(e) - 'automation_decision_id' from public.case_service_events e where e.id = split_part(r.k, ':', 2)::uuid)
      when 'trilha' then (select to_jsonb(t) from public.status_tracks t where t.id = split_part(r.k, ':', 2)::uuid)
      when 'chave' then (select to_jsonb(kk) from public.status_track_idempotency_keys kk
                         where kk.workspace_id = split_part(r.k, ':', 2)::uuid and kk.idempotency_key = split_part(r.k, ':', 3)::uuid)
      else (select to_jsonb(v) from public.status_track_event_evidence v
            where v.event_id = split_part(r.k, ':', 2)::uuid and v.message_id = split_part(r.k, ':', 3)::uuid)
    end as agora
  ) x on true
  where x.agora is distinct from r.linha;
  if v_changed <> 0 then
    raise exception '% linha(s) antigas mudaram', v_changed;
  end if;
  if exists (select 1 from public.status_track_events where automation_decision_id is not null or actor_kind <> 'user' or actor_user_id is null)
     or exists (select 1 from public.case_service_events where automation_decision_id is not null or actor_kind <> 'user' or actor_user_id is null) then
    raise exception 'evento antigo com autoria diferente de usuário';
  end if;
  select (select count(*) from public.status_track_events) + (select count(*) from public.case_service_events)
       + (select count(*) from public.status_tracks) + (select count(*) from public.status_track_idempotency_keys)
       + (select count(*) from public.status_track_event_evidence) into v_rows;
  if v_rows <> (select count(*) from public.upgrade_ap_rows) then
    raise exception 'a migration criou ou apagou linhas nos históricos';
  end if;
  if (select count(*) from public.upgrade_ap_rows where k like 'evento:%') < 2 or (select count(*) from public.upgrade_ap_rows where k like 'roteiro:%') < 1 then
    raise exception 'conferência vazia: deveria haver eventos antigos das trilhas e do roteiro';
  end if;
  if (select count(*) from public.status_track_automation_decisions) <> 0 then
    raise exception 'a migration não pode criar decisão';
  end if;
  if (select enabled from public.status_track_automation_gate) then
    raise exception 'o portão deveria nascer fechado';
  end if;

  -- Exportação igual, com a seção nova vazia.
  v_after := private.privacy_export_payload('$WS_UM', (select v from public.upgrade_ap_values where k = 'contato')::uuid);
  if (v_after - 'status_track_automation_decisions') is distinct from (select v::jsonb from public.upgrade_ap_values where k = 'export') then
    raise exception 'a exportação mudou nas seções antigas';
  end if;
  if v_after -> 'status_track_automation_decisions' is distinct from '[]'::jsonb then
    raise exception 'a seção nova deveria existir vazia';
  end if;
end;
\$check\$;

-- Portão fechado: o aplicador recusa tudo, sem gravar.
begin;
set local role service_role;
do \$closed\$
begin
  perform public.apply_status_track_automation('$WS_UM', (select v from public.upgrade_ap_values where k = 'conv')::uuid, 'set_status', 'attendance', null, 'aguardando_cliente', null, 1,
    array[gen_random_uuid()], gen_random_uuid(), null);
  raise exception 'o aplicador deveria recusar com o portão fechado';
exception when others then
  if sqlerrm <> 'automation_disabled' then
    raise;
  end if;
end;
\$closed\$;
reset role;
commit;

-- A correção manual continua funcionando e continua exigindo usuário.
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
select set_conversation_attendance_status(:'conv'::uuid, 'aguardando_cliente', 1, '{}'::uuid[], gen_random_uuid()) ->> 'version' as v_manual \gset
reset role;
commit;
do \$manual\$
begin
  if not exists (select 1 from public.status_track_events e join public.status_tracks t on t.id = e.track_id
                 where t.conversation_id = (select v from public.upgrade_ap_values where k = 'conv')::uuid and e.to_version = 2 and e.actor_kind = 'user' and e.actor_user_id = '$ANA') then
    raise exception 'a correção manual depois da migration deveria gravar autoria de usuário';
  end if;
end;
\$manual\$;

-- Chave gravada ANTES pela correção manual não vale no aplicador (portão aberto só nesta transação).
begin;
update public.status_track_automation_gate set enabled = true, enabled_at = now(), activation_ref = 'teste-atualizacao-local';
set local role service_role;
do \$key\$
begin
  perform public.apply_status_track_automation('$WS_UM', (select v from public.upgrade_ap_values where k = 'conv')::uuid, 'set_status', 'attendance', null, 'aguardando_escritorio', null, 2,
    array[(select v from public.upgrade_ap_values where k = 'msg')::uuid], '$CHAVE_ANTIGA'::uuid, null);
  raise exception 'a chave antiga deveria dar idempotency_conflict';
exception when others then
  if sqlerrm <> 'idempotency_conflict' then
    raise;
  end if;
end;
\$key\$;
reset role;
rollback;

drop table public.upgrade_ap_rows;
drop table public.upgrade_ap_values;
SQL

echo "OK: a atualização preservou trilhas, roteiro, chaves e exportação; o aplicador nasce fechado e não aceita chave antiga."
