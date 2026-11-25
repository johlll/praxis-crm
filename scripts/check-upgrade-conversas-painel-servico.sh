#!/usr/bin/env bash
# Painel do caso, etapa B — valida a ATUALIZAÇÃO a partir da versão publicada (painel do caso, #359), com
# casos, conversas e andamentos gravados ANTES da migration:
#
#   1. recria o banco local só até a migration do painel do caso (20261120120000);
#   2. grava um contato com dois casos (um ganho, com andamento corrigido; um aberto), uma conversa
#      vinculada com situação do atendimento, e guarda o que a lista, o painel, a trilha do andamento, o
#      histórico dela e a exportação do titular devolvem;
#   3. aplica a migration pendente;
#   4. confere:
#      - lista, opções de caso, trilha, histórico e exportação devolvem EXATAMENTE o mesmo nas chaves e
#        seções antigas (as novas são ignoradas na comparação e conferidas à parte);
#      - nenhum caso ganhou número nem roteiro (a migration não numera nada); o caso ganho antigo continua
#        sem número, sem roteiro e com o mesmo andamento e a mesma versão;
#      - as seções novas da exportação existem e estão vazias para o titular antigo;
#      - nenhuma linha de conversas, oportunidades, trilhas ou histórico foi alterada;
#      - as chaves de idempotência gravadas antes entram no registro único compartilhado (uma linha por
#        chave, com o evento de origem) e, depois disso, a repetição exata de um pedido antigo devolve o
#        gravado e o roteiro recusa a chave de um pedido antigo (idempotency_conflict).
#
# Recria o banco local, por isso roda no fim do CI e termina na versão atual. Tudo fictício.
set -euo pipefail

PREVIOUS_VERSION="20261120120000"
DB_CONTAINER="supabase_db_praxis-crm"
ANA="20000000-0000-0000-0000-000000000001"
CARLA="20000000-0000-0000-0000-000000000003"
WS_UM="10000000-0000-0000-0000-000000000001"
CONTATO="79000000-0000-0000-0000-000000000001"
LEAD_A="79000000-0000-0000-0000-0000000000a1"
OPP_GANHA="79000000-0000-0000-0000-0000000000b1"
OPP_ABERTA="79000000-0000-0000-0000-0000000000b2"
CANAL="79000000-0000-0000-0000-0000000000c1"
K_SITUACAO="79000000-0000-4000-8000-0000000000d1"
K_ANDAMENTO="79000000-0000-4000-8000-0000000000d2"

psql_db() {
  docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"
}

snapshot() {
  # $1 = tabela de destino. Lê como cada papel (auth.uid() + role authenticated), como a tela.
  psql_db <<SQL
create table public.$1 (who text, kind text, ref uuid, body jsonb, total bigint, counts jsonb);
grant all on public.$1 to authenticated;
\o /dev/null
insert into public.$1 (who, kind, ref, body)
  select 'sistema', 'export', '$CONTATO', private.privacy_export_payload('$WS_UM', '$CONTATO');
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
insert into public.$1 (who, kind, body, total, counts)
  select 'ana', 'inbox', r.items, r.total_count, r.status_counts from public.list_conversation_inbox('$WS_UM', 1, 100) r;
insert into public.$1 (who, kind, ref, body)
  select 'ana', 'case', (e ->> 'id')::uuid, public.list_conversation_case_options((e ->> 'id')::uuid)
  from public.list_conversation_inbox('$WS_UM', 1, 100) r, jsonb_array_elements(r.items) e;
insert into public.$1 (who, kind, ref, body) values
  ('ana', 'track', '$OPP_GANHA', public.get_status_track('case_progress', '$OPP_GANHA')),
  ('ana', 'history', '$OPP_GANHA', (select items from public.list_status_track_history('case_progress', '$OPP_GANHA', null, null, 100)));
select set_config('request.jwt.claims', json_build_object('sub', '$CARLA', 'role', 'authenticated')::text, true);
insert into public.$1 (who, kind, body, total, counts)
  select 'carla', 'inbox', r.items, r.total_count, r.status_counts from public.list_conversation_inbox('$WS_UM', 1, 100) r;
insert into public.$1 (who, kind, ref, body)
  select 'carla', 'case', (e ->> 'id')::uuid, public.list_conversation_case_options((e ->> 'id')::uuid)
  from public.list_conversation_inbox('$WS_UM', 1, 100) r, jsonb_array_elements(r.items) e;
commit;
\o
SQL
}

echo "== 1. banco na versão anterior ($PREVIOUS_VERSION)"
supabase db reset --local --version "$PREVIOUS_VERSION"

echo "== 2. casos, conversa e andamento gravados pela versão anterior"
psql_db <<SQL
insert into public.contacts (id, workspace_id, type, name, created_by) values
  ('$CONTATO', '$WS_UM', 'pf', 'Contato (upgrade etapa B)', '$ANA');
insert into public.leads (id, workspace_id, contact_id, legal_area, status, created_by, assigned_to) values
  ('$LEAD_A', '$WS_UM', '$CONTATO', 'Usucapião', 'ativo', '$ANA', null);
insert into public.opportunities (id, workspace_id, lead_id, pipeline_id, stage_id, created_by)
select v.id, '$WS_UM', '$LEAD_A', p.id,
  (select s.id from public.pipeline_stages s where s.pipeline_id = p.id and not s.is_won and not s.is_lost order by s.position limit 1),
  '$ANA'
from public.pipelines p
cross join (values ('$OPP_GANHA'::uuid), ('$OPP_ABERTA'::uuid)) v(id)
where p.workspace_id = '$WS_UM' and p.is_default;

insert into public.whatsapp_channels (id, workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment, routing_key)
values ('$CANAL', '$WS_UM', 'Canal (upgrade etapa B)', '+5541900007900', '$ANA', 'ycloud', false, 'preview', 'rota-upgrade-servico');

do \$seed\$
declare v_ident uuid; v_conv uuid;
begin
  insert into public.whatsapp_identities (workspace_id, channel_id, provider, environment, phone_e164)
  values ('$WS_UM', '$CANAL', 'ycloud', 'preview', '+5541999997901') returning id into v_ident;
  insert into public.conversations (workspace_id, channel_id, identity_id, contact_id, lead_id, opportunity_id)
  values ('$WS_UM', '$CANAL', v_ident, '$CONTATO', '$LEAD_A', '$OPP_GANHA') returning id into v_conv;
  insert into public.messages (workspace_id, conversation_id, channel_id, direction, status, origin, sender_classification, content_kind, body_text, provider, provider_message_id)
  values ('$WS_UM', v_conv, '$CANAL', 'inbound', 'delivered', 'inbound', 'external', 'text', 'Mensagem sintética', 'ycloud', 'WAMID-UPG-SERVICO-1');

  -- Ganho, situação e andamento pela versão anterior, como a tela faria.
  perform set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
  perform public.win_opportunity('$OPP_GANHA', 0, 150000, 'fixed');
  perform public.set_conversation_attendance_status(v_conv, 'aguardando_cliente', 0, '{}'::uuid[], '$K_SITUACAO');
  perform public.set_opportunity_case_progress('$OPP_GANHA', 'em_analise', 0, '{}'::uuid[], '$K_ANDAMENTO');
  perform public.set_opportunity_case_progress('$OPP_GANHA', 'aguardando_documentos', 1);
end
\$seed\$;

create table public.upgrade_check_rows as
  select 'conversations' as t, md5(string_agg(x::text, '|' order by x.id)) as h from public.conversations x
  union all select 'opportunities', md5(string_agg(x::text, '|' order by x.id)) from public.opportunities x
  union all select 'status_tracks', md5(string_agg(x::text, '|' order by x.id)) from public.status_tracks x
  -- automation_decision_id vem de migration POSTERIOR (aplicador, nula nas linhas antigas): fora da comparação.
  union all select 'status_track_events', md5(string_agg((to_jsonb(x) - 'automation_decision_id')::text, '|' order by x.id)) from public.status_track_events x
  union all select 'stage_transitions', md5(string_agg(x::text, '|' order by x.id)) from public.stage_transitions x;
SQL
snapshot upgrade_check_before

echo "== 3. migration pendente"
supabase migration up --local

snapshot upgrade_check_after

echo "== 4. conferências"
psql_db <<SQL
do \$check\$
declare
  v_item_new text[] := array['case_number', 'service_type_name', 'service_step_name', 'service_step_position',
                             'service_steps_total', 'service_steps_completed'];
  v_export_new text[] := array['case_numbers', 'case_service_plans', 'case_service_history'];
  -- Seções acrescentadas por migrations POSTERIORES (aplicadas junto no migration up): fora da comparação.
  v_export_later text[] := array['case_notes', 'case_documents', 'status_track_automation_decisions'];
  v_diff integer;
  v_after jsonb;
  v_service jsonb;
begin
  -- Lista: mesmas conversas, ordem, total e contagens; o resumo do caso igual sem as chaves novas.
  select count(*) into v_diff
  from public.upgrade_check_before b
  join public.upgrade_check_after a on a.who = b.who and a.kind = 'inbox'
  where b.kind = 'inbox'
    and (a.total is distinct from b.total
      or a.counts is distinct from b.counts
      or (select coalesce(jsonb_agg(
            case when e -> 'case' is not null and jsonb_typeof(e -> 'case') = 'object'
              then jsonb_set(e, '{case}', (e -> 'case') - v_item_new) else e end order by o), '[]'::jsonb)
          from jsonb_array_elements(a.body) with ordinality x(e, o)) is distinct from b.body);
  if v_diff <> 0 then
    raise exception 'a lista mudou para % papel(is) nas chaves antigas', v_diff;
  end if;
  if (select count(*) from public.upgrade_check_before where kind = 'inbox' and who = 'ana' and jsonb_array_length(body) >= 1) <> 1 then
    raise exception 'conferência vazia: a dona deveria ver a conversa de teste';
  end if;

  -- Painel: mesmas opções e valores, sem as chaves novas de cada item.
  select count(*) into v_diff
  from public.upgrade_check_before b
  join public.upgrade_check_after a on a.who = b.who and a.kind = 'case' and a.ref = b.ref
  where b.kind = 'case'
    and jsonb_set(a.body, '{items}', (select coalesce(jsonb_agg(i - v_item_new order by o), '[]'::jsonb)
                                      from jsonb_array_elements(a.body -> 'items') with ordinality x(i, o)))
        is distinct from b.body;
  if v_diff <> 0 then
    raise exception 'as opções de caso mudaram em % conversa(s)', v_diff;
  end if;

  -- Trilha do andamento e o histórico dela: idênticos.
  select count(*) into v_diff
  from public.upgrade_check_before b
  join public.upgrade_check_after a on a.who = b.who and a.kind = b.kind and a.ref = b.ref
  where b.kind in ('track', 'history') and a.body is distinct from b.body;
  if v_diff <> 0 or (select count(*) from public.upgrade_check_after where kind in ('track', 'history')) <> 2 then
    raise exception 'a trilha do andamento ou o histórico mudaram';
  end if;

  -- Exportação: seções antigas byte a byte; as novas existem e estão vazias para o titular antigo.
  select a.body into v_after from public.upgrade_check_after a where a.kind = 'export';
  -- A chave origin_time de cada mensagem vem de migration POSTERIOR (horário de origem): fora da comparação.
  v_after := jsonb_set(v_after, '{messages}', coalesce((
    select jsonb_agg(e - 'origin_time' order by n) from jsonb_array_elements(v_after -> 'messages') with ordinality as x(e, n)
  ), '[]'::jsonb));
  if (v_after - v_export_new - v_export_later) is distinct from (select b.body from public.upgrade_check_before b where b.kind = 'export') then
    raise exception 'a exportação mudou nas seções antigas';
  end if;
  if (select count(*) from unnest(v_export_new) k where v_after -> k = '[]'::jsonb) <> 3 then
    raise exception 'as seções novas da exportação deveriam existir vazias para o titular antigo';
  end if;

  -- Nada numerado nem roteiro criado pela migration.
  if (select count(*) from public.opportunity_case_numbers) <> 0
     or (select count(*) from public.case_number_counters) <> 0
     or (select count(*) from public.case_service_plans) <> 0
     or (select count(*) from public.case_service_events) <> 0
     or (select count(*) from public.service_types) <> 0 then
    raise exception 'a migration não pode numerar casos, criar roteiro nem catálogo';
  end if;

  -- O caso ganho antigo, como a tela nova lê.
  perform set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
  v_service := public.get_case_service('$OPP_GANHA');
  if v_service -> 'case_number' <> 'null'::jsonb or v_service -> 'plan' <> 'null'::jsonb
     or v_service ->> 'status' <> 'aguardando_documentos' or (v_service ->> 'version')::int <> 2 then
    raise exception 'o caso ganho antigo deveria seguir sem número, sem roteiro, aguardando documentos, versão 2: %', v_service;
  end if;

  -- Nenhuma linha antiga alterada.
  select count(*) into v_diff from (
    select 'conversations' as t, md5(string_agg(x::text, '|' order by x.id)) as h from public.conversations x
    union all select 'opportunities', md5(string_agg(x::text, '|' order by x.id)) from public.opportunities x
    union all select 'status_tracks', md5(string_agg(x::text, '|' order by x.id)) from public.status_tracks x
    union all select 'status_track_events', md5(string_agg((to_jsonb(x) - 'automation_decision_id')::text, '|' order by x.id)) from public.status_track_events x
    union all select 'stage_transitions', md5(string_agg(x::text, '|' order by x.id)) from public.stage_transitions x
  ) d join public.upgrade_check_rows r using (t)
  where d.h is distinct from r.h;
  if v_diff <> 0 then
    raise exception 'a atualização alterou % tabela(s) de negócio', v_diff;
  end if;
end
\$check\$;

-- Chaves gravadas antes: copiadas para o registro único, e valendo entre os históricos daqui em diante.
do \$chave\$
declare
  v_tipo uuid;
  v_conv uuid := (select id from public.conversations where opportunity_id = '$OPP_GANHA');
  v_ok boolean := false;
begin
  if (select string_agg(k.idempotency_key::text || '=' || k.source, ',' order by k.idempotency_key)
      from public.status_track_idempotency_keys k
      join public.status_track_events e on e.id = k.event_id and e.idempotency_key = k.idempotency_key and e.workspace_id = k.workspace_id
      where k.workspace_id = '$WS_UM') is distinct from '$K_SITUACAO=status_track_events,$K_ANDAMENTO=status_track_events'
     or (select count(*) from public.status_track_idempotency_keys) <> (select count(*) from public.status_track_events where idempotency_key is not null) then
    raise exception 'as chaves gravadas antes deveriam estar no registro único, uma linha por chave, com o evento de origem';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
  if public.set_conversation_attendance_status(v_conv, 'aguardando_cliente', 0, '{}'::uuid[], '$K_SITUACAO') ->> 'replayed' <> 'true' then
    raise exception 'a repetição exata de um pedido antigo deveria devolver o gravado';
  end if;
  v_tipo := (public.create_service_type('$WS_UM', 'Tipo (upgrade etapa B)', array['Um', 'Dois']) ->> 'id')::uuid;
  begin
    perform public.apply_case_service_plan('$OPP_GANHA', v_tipo, 2, 1, '$K_ANDAMENTO');
  exception when others then
    v_ok := sqlerrm = 'idempotency_conflict';
  end;
  if not v_ok then
    raise exception 'o roteiro deveria recusar a chave de um pedido antigo do andamento';
  end if;
end
\$chave\$;

drop table public.upgrade_check_before;
drop table public.upgrade_check_after;
drop table public.upgrade_check_rows;
SQL

echo "OK: lista, painel, andamento, histórico e exportação iguais aos de antes; nada numerado nem aplicado; nada alterado; chaves antigas no registro único"
