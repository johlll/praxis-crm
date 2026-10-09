-- pgTAP — B2, etapa 3b: batimento e alertas do agendador, saúde da
-- sincronização, agendas para a sob demanda, reconexão que reencontra os
-- vínculos, restauração do valor do CRM num conflito e o conflito na
-- timeline do lead. Todos os registros são criados por este teste.

begin;
select plan(70);

\set dono   '20000000-0000-0000-0000-000000000001'
\set adv    '20000000-0000-0000-0000-000000000002'
\set adm    '20000000-0000-0000-0000-000000000004'
\set leitor '20000000-0000-0000-0000-000000000005'

insert into public.calendar_environment_keys (environment, signing_key) values
  ('production', 'chave-de-producao-de-teste-0123456789ab'),
  ('preview', 'chave-de-preview-de-teste-0123456789abcd');

create function pg_temp.hdr(p_env text)
returns text language sql as $f$
  select json_build_object('x-praxis-env', p_env || '.' || e.x || '.' || private.environment_signature(p_env, e.x, k.signing_key))::text
  from (select extract(epoch from now())::bigint + 600 as x) e,
       (select signing_key from public.calendar_environment_keys where environment = p_env::public.calendar_environment) k
$f$;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select (create_workspace_with_owner('Teste B2 3b', 'teste-b2-3b')).id as ws \gset
reset role;

insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws'::uuid, :'adv', 'lawyer', 'active'),
  (:'ws'::uuid, :'adm', 'admin', 'active'),
  (:'ws'::uuid, :'leitor', 'viewer', 'active');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select (create_contact(:'ws'::uuid, 'pf', 'Cliente B2 3b', null, null, null)).id as contact \gset
select create_lead(:'ws'::uuid, (:'contact')::uuid, 'Trabalhista', 'Lead B2 3b', '{}'::text[], 'media', :'adv'::uuid) as lead \gset
select create_activity(
  p_lead_id := (:'lead')::uuid, p_type := 'meeting'::activity_type, p_title := 'Título do Google',
  p_due_date := (current_date + 5), p_due_time := '15:00'::time
) as reuniao \gset
select create_activity(
  p_lead_id := (:'lead')::uuid, p_type := 'meeting'::activity_type, p_title := 'Outra reunião',
  p_due_date := (current_date + 6), p_due_time := '10:00'::time
) as reuniao2 \gset
reset role;

select pg_temp.hdr('production') as h_prod \gset
select pg_temp.hdr('preview') as h_prev \gset
select set_config('request.headers', :'h_prod', true);

select connect_calendar_account(:'ws'::uuid, :'dono'::uuid, 'dono@v.test', array['escopo'], 'refresh-cifrado', 'access-cifrado', now() + interval '1 hour', '1') as conn \gset
select set_calendar_connection_calendar(:'conn'::uuid, :'dono'::uuid, 'cal-a@x', 'Agenda A');
select create_calendar_event_link(:'conn'::uuid, :'reuniao'::uuid, :'dono'::uuid, 'evento-1') as link \gset
select create_calendar_event_link(:'conn'::uuid, :'reuniao2'::uuid, :'dono'::uuid, 'evento-2') as link2 \gset
update public.calendar_event_links set base_etag = '"7"', base_title = 'Título do Google' where id = (:'link')::uuid;

-- ---------------------------------------------------------------------
-- 1) Tabelas e grants
-- ---------------------------------------------------------------------

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('calendar_scheduler_heartbeats', 'calendar_scheduler_alerts')
     and c.relrowsecurity and c.relforcerowsecurity),
  2, 'RLS habilitada E forçada nas tabelas de batimento e alertas'
);
select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('calendar_scheduler_heartbeats', 'calendar_scheduler_alerts')
     and grantee in ('anon', 'authenticated')),
  0, 'nenhum GRANT de tabela para anon/authenticated'
);
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select throws_ok($i$ select record_calendar_scheduler_heartbeat('inngest', 'ok', '{}'::jsonb) $i$, '42501', null,
  'authenticated NÃO grava batimento');
select throws_ok($i$ select claim_calendar_scheduler_alert('scheduler_stale', 'inngest') $i$, '42501', null,
  'authenticated NÃO reserva alerta');
select throws_ok(format($i$ select restore_calendar_conflict(gen_random_uuid(), %L::uuid) $i$, :'dono'), '42501', null,
  'authenticated NÃO chama a restauração direto (só o servidor, em nome da sessão)');
select throws_ok(format($i$ select list_pending_calendar_recoveries(gen_random_uuid(), %L::uuid) $i$, :'dono'), '42501', null,
  'authenticated NÃO lista recuperações pendentes');
select throws_ok(format($i$ select finish_calendar_link_recovery(gen_random_uuid(), gen_random_uuid(), %L::uuid) $i$, :'dono'), '42501', null,
  'authenticated NÃO conclui recuperação');
reset role;

-- ---------------------------------------------------------------------
-- 2) Batimento
-- ---------------------------------------------------------------------

select set_config('request.headers', '', true);
select throws_ok($i$ select record_calendar_scheduler_heartbeat('inngest', 'ok', '{}'::jsonb) $i$, 'P0001', 'environment_required',
  'sem ambiente autenticado, nenhum batimento');
select set_config('request.headers', :'h_prod', true);

select record_calendar_scheduler_heartbeat('inngest', 'ok',
  '{"synced": 2, "titulo": "Reunião sigilosa", "aninhado": {"x": 1}, "com espaco": 3}'::jsonb);
select is(
  (select last_report from public.calendar_scheduler_heartbeats where environment = 'production' and scheduler = 'inngest'),
  '{"synced": 2}'::jsonb, 'o batimento guarda só pares nome → número (texto livre descartado)'
);
select record_calendar_scheduler_heartbeat('inngest', 'failed', '{}'::jsonb);
select is(
  (select jsonb_build_object('r', runs, 'o', last_outcome) from public.calendar_scheduler_heartbeats
   where environment = 'production' and scheduler = 'inngest'),
  jsonb_build_object('r', 2, 'o', 'failed'), 'cada rodada conta, e a que falhou fica registrada como falha'
);
select is(
  (select last_success_at = last_run_at from public.calendar_scheduler_heartbeats where environment = 'production' and scheduler = 'inngest'),
  true, 'a rodada que falhou NÃO apaga o último sucesso (executou ≠ sincronizou com sucesso)'
);
select throws_ok($i$ select record_calendar_scheduler_heartbeat('cron-qualquer', 'ok', '{}'::jsonb) $i$, 'P0001', 'invalid_scheduler',
  'agendador desconhecido é recusado');
select is(jsonb_array_length(list_calendar_scheduler_heartbeats()), 1, 'production vê o próprio batimento');
select set_config('request.headers', :'h_prev', true);
select is(jsonb_array_length(list_calendar_scheduler_heartbeats()), 0, 'preview não vê o batimento de production');
select record_calendar_scheduler_heartbeat('github', 'failed', '{"failed": 2, "synced": 0}'::jsonb);
select is(
  (select jsonb_build_object('o', last_outcome, 's', last_success_at) from public.calendar_scheduler_heartbeats
   where environment = 'preview' and scheduler = 'github'),
  jsonb_build_object('o', 'failed', 's', null),
  'rodou e falhou: execução registrada, nenhum sucesso'
);
select record_calendar_scheduler_heartbeat('github', 'partial', '{"failed": 1, "synced": 1}'::jsonb);
select is(
  (select jsonb_build_object('o', h ->> 'lastOutcome', 'tem', h ? 'lastSuccessAt', 's', h -> 'lastSuccessAt')
   from jsonb_array_elements(list_calendar_scheduler_heartbeats()) h),
  jsonb_build_object('o', 'partial', 'tem', true, 's', null),
  'parcial é aceito, não conta como sucesso, e a lista traz o último sucesso'
);
select throws_ok($i$ select record_calendar_scheduler_heartbeat('github', 'meio', '{}'::jsonb) $i$, 'P0001', 'invalid_outcome',
  'desfecho desconhecido é recusado');
select set_config('request.headers', :'h_prod', true);

-- ---------------------------------------------------------------------
-- 3) Alertas
-- ---------------------------------------------------------------------

select claim_calendar_scheduler_alert('scheduler_stale', 'inngest') as alerta \gset
select is(
  (select array_agg(r ->> 'email' order by r ->> 'email') from jsonb_array_elements(:'alerta'::jsonb -> 'recipients') r),
  (select array_agg(email order by email) from public.users where id in (:'dono'::uuid, :'adm'::uuid)),
  'destinatários: só owner/admin ativos dos workspaces com vínculo no ambiente'
);
select is(claim_calendar_scheduler_alert('scheduler_stale', 'inngest'), null::jsonb, 'dentro do intervalo mínimo, nenhum segundo alerta');
select finish_calendar_scheduler_alert((:'alerta'::jsonb ->> 'alertId')::uuid, 'failed', 'send_failed');
select isnt(claim_calendar_scheduler_alert('scheduler_stale', 'inngest'), null::jsonb, 'alerta que falhou não conta para o intervalo');
select is(
  (select count(*)::int from public.calendar_scheduler_alerts where environment = 'production' and status = 'failed' and error = 'send_failed'),
  1, 'a falha fica registrada'
);

-- ---------------------------------------------------------------------
-- 4) Saúde (Detector 2), pela sessão
-- ---------------------------------------------------------------------

select begin_calendar_channel(:'conn'::uuid, 'cal-a@x', :'dono'::uuid, 'canal-velho', repeat('a', 64));
select activate_calendar_channel('canal-velho', :'dono'::uuid, 'res-1', now() + interval '1 hour', now() - interval '1 minute', false);
update public.calendar_watch_channels set created_at = now() - interval '7 days' where channel_id = 'canal-velho';

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select is(
  (select jsonb_build_object('l', h -> 'activeLinks', 'c', h -> 'channelsLowLife', 's', jsonb_array_length(h -> 'schedulers'))
   from (select get_calendar_sync_health(:'ws'::uuid) as h) x),
  jsonb_build_object('l', 2, 'c', 1, 's', 1),
  'owner vê vínculos ativos, canal perto de vencer e batimento — só contagens e datas'
);
select set_config('request.jwt.claims', json_build_object('sub', :'adv', 'role', 'authenticated')::text, true);
select throws_ok(format($i$ select get_calendar_sync_health(%L::uuid) $i$, :'ws'), 'P0001', 'insufficient_permission',
  'advogado não vê a saúde da sincronização (calendar.manage)');
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select set_config('request.headers', '', true);
select throws_ok(format($i$ select get_calendar_sync_health(%L::uuid) $i$, :'ws'), 'P0001', 'environment_required',
  'sem ambiente autenticado, nada');
reset role;
select set_config('request.headers', :'h_prod', true);
select stop_calendar_channel('canal-velho', :'dono'::uuid, 'teste');

-- ---------------------------------------------------------------------
-- 5) Sob demanda: agendas da própria conexão
-- ---------------------------------------------------------------------

select is(
  (select array_agg(t ->> 'calendarId') from jsonb_array_elements(list_own_calendar_sync_targets(:'conn'::uuid, :'dono'::uuid)) t),
  array['cal-a@x'], 'as agendas com vínculo da própria conexão'
);
select throws_ok(format($i$ select list_own_calendar_sync_targets(%L::uuid, %L::uuid) $i$, :'conn', :'adv'), 'P0001',
  'connection_not_found', 'só o dono lista as agendas da conexão');

-- ---------------------------------------------------------------------
-- 6) Reconexão: reencontrar vínculos
-- ---------------------------------------------------------------------

select disconnect_calendar_connection(:'conn'::uuid, :'dono'::uuid);
select connect_calendar_account(:'ws'::uuid, :'dono'::uuid, 'dono@v.test', array['escopo'], 'refresh-2', 'access-2', now() + interval '1 hour', '1') as conn2 \gset
select set_calendar_connection_calendar(:'conn2'::uuid, :'dono'::uuid, 'cal-a@x', 'Agenda A');
-- A segunda reunião ganhou um vínculo NOVO depois de desconectar: o antigo não volta.
select create_calendar_event_link(:'conn2'::uuid, :'reuniao2'::uuid, :'dono'::uuid, 'evento-2-novo');

select ok(:'conn2' <> :'conn', 'reconectar depois de desconectar cria outra conexão');
select is(
  (select array_agg(r ->> 'id') from jsonb_array_elements(list_recoverable_calendar_links(:'conn2'::uuid, :'dono'::uuid)) r),
  array[:'link'], 'recuperável: só o vínculo desfeito do mesmo usuário cuja atividade não tem outro vínculo ativo'
);
select throws_ok(format($i$ select list_recoverable_calendar_links(%L::uuid, %L::uuid) $i$, :'conn2', :'adv'), 'P0001',
  'connection_not_found', 'outro usuário não lista pela conexão alheia');

-- Conexão de OUTRO usuário: os vínculos desfeitos da conexão do dono não são dela.
select connect_calendar_account(:'ws'::uuid, :'adv'::uuid, 'adv@v.test', array['escopo'], 'r', 'a', now() + interval '1 hour', '1') as conn_adv \gset
select is(jsonb_array_length(list_recoverable_calendar_links(:'conn_adv'::uuid, :'adv'::uuid)), 0,
  'vínculos de outra pessoa nunca são recuperáveis');
select is(relink_recovered_calendar_link(:'link'::uuid, :'conn_adv'::uuid, :'adv'::uuid), 'not_recoverable',
  'nem por chamada direta');

select is(relink_recovered_calendar_link(:'link'::uuid, :'conn2'::uuid, :'dono'::uuid), 'relinked', 'o dono reencontra o vínculo');
select is(
  (select jsonb_build_object('c', connection_id::text, 's', status::text, 'e', base_etag, 't', base_title)
   from public.calendar_event_links where id = (:'link')::uuid),
  jsonb_build_object('c', :'conn2', 's', 'linked', 'e', '"7"', 't', 'Título do Google'),
  'volta para a conexão nova com a BASE preservada'
);
select is(relink_recovered_calendar_link(:'link'::uuid, :'conn2'::uuid, :'dono'::uuid), 'not_recoverable', 'idempotente');
select ok((select recovery_pending_at is not null from public.calendar_event_links where id = (:'link')::uuid),
  'revinculado: a recuperação fica PENDENTE no vínculo');
-- A saída falha e reescreve o erro de sincronização: a pendência continua.
update public.calendar_event_links set sync_error = 'provider_503' where id = (:'link')::uuid;
select is(
  (select array_agg(r ->> 'id') from jsonb_array_elements(list_pending_calendar_recoveries(:'conn2'::uuid, :'dono'::uuid)) r),
  array[:'link'], 'pendente continua listada pela própria conexão, independente do erro da saída'
);
select is(jsonb_array_length(list_recoverable_calendar_links(:'conn2'::uuid, :'dono'::uuid)), 0,
  'e já não aparece como recuperável (não é revinculada de novo)');
select throws_ok(format($i$ select list_pending_calendar_recoveries(%L::uuid, %L::uuid) $i$, :'conn2', :'adv'), 'P0001',
  'connection_not_found', 'outro usuário não lista as pendências da conexão alheia');
select is(finish_calendar_link_recovery(:'link'::uuid, :'conn_adv'::uuid, :'adv'::uuid), false,
  'nem conclui pela própria conexão a recuperação de outro');
select is(finish_calendar_link_recovery(:'link'::uuid, :'conn2'::uuid, :'dono'::uuid), true, 'o dono conclui a recuperação');
select is(
  (select jsonb_build_object('p', recovery_pending_at, 'l', jsonb_array_length(list_pending_calendar_recoveries(:'conn2'::uuid, :'dono'::uuid)))
   from public.calendar_event_links where id = (:'link')::uuid),
  jsonb_build_object('p', null, 'l', 0), 'concluída: sai das pendências'
);
select is(finish_calendar_link_recovery(:'link'::uuid, :'conn2'::uuid, :'dono'::uuid), false, 'concluir de novo não faz nada');
select is(
  (select count(*)::int from public.audit_logs
   where workspace_id = :'ws'::uuid and action = 'calendar.link.recovery_completed' and metadata::text !~ 'evento-'),
  1, 'auditoria da conclusão, sem id de evento'
);
select is(relink_recovered_calendar_link(:'link2'::uuid, :'conn2'::uuid, :'dono'::uuid), 'not_recoverable',
  'atividade com outro vínculo ativo: o antigo não volta');
select is(
  (select count(*)::int from public.audit_logs
   where workspace_id = :'ws'::uuid and action = 'calendar.link.recovered' and metadata::text !~ 'evento-'),
  1, 'auditoria da recuperação, sem id de evento'
);

-- ---------------------------------------------------------------------
-- 7) Restauração do valor do CRM
-- ---------------------------------------------------------------------

insert into public.calendar_sync_conflicts (workspace_id, link_id, environment, field, crm_value, google_value, resolution, created_by)
values (:'ws'::uuid, :'link'::uuid, 'production', 'title', to_jsonb('Título do CRM'::text), to_jsonb('Título do Google'::text), 'google_prevails', :'dono'::uuid)
returning id as c_title \gset
select lock_version as v0 from public.activities where id = (:'reuniao')::uuid \gset

select is(restore_calendar_conflict(:'c_title'::uuid, :'adv'::uuid) ->> 'status', 'not_owner',
  'quem não é dono da agenda do vínculo não restaura (só o dono leva ao Google)');
select throws_ok(format($i$ select restore_calendar_conflict(%L::uuid, %L::uuid) $i$, :'c_title', :'leitor'), 'P0001',
  'conflict_not_found', 'sem activity.edit, nem a existência é revelada');
select set_config('request.headers', :'h_prev', true);
select throws_ok(format($i$ select restore_calendar_conflict(%L::uuid, %L::uuid) $i$, :'c_title', :'dono'), 'P0001',
  'calendar_environment_mismatch', 'preview não restaura conflito de production');
select set_config('request.headers', :'h_prod', true);

update public.calendar_event_links set status = 'needs_attention' where id = (:'link')::uuid;
select is(restore_calendar_conflict(:'c_title'::uuid, :'dono'::uuid) ->> 'status', 'link_inactive', 'vínculo fora de "linked": nada alterado');
update public.calendar_event_links set status = 'linked' where id = (:'link')::uuid;

select is(restore_calendar_conflict(:'c_title'::uuid, :'dono'::uuid) ->> 'status', 'restored', 'o dono restaura');
select is(
  (select jsonb_build_object('t', title, 'v', lock_version) from public.activities where id = (:'reuniao')::uuid),
  jsonb_build_object('t', 'Título do CRM', 'v', (:'v0')::bigint + 1),
  'a atividade volta ao valor do CRM, com versão nova'
);
select is(
  (select jsonb_build_object('r', restored_at is not null, 'b', restored_by::text, 'v', restored_activity_version)
   from public.calendar_sync_conflicts where id = (:'c_title')::uuid),
  jsonb_build_object('r', true, 'b', :'dono', 'v', (:'v0')::bigint + 1),
  'o conflito fica marcado como restaurado, por quem e em qual versão'
);
select is(restore_calendar_conflict(:'c_title'::uuid, :'dono'::uuid) ->> 'status', 'already_restored', 'não restaura duas vezes');

insert into public.calendar_sync_conflicts (workspace_id, link_id, environment, field, crm_value, google_value, resolution)
values (:'ws'::uuid, :'link'::uuid, 'production', 'title', to_jsonb('Antigo do CRM'::text), to_jsonb('Já não é o atual'::text), 'google_prevails')
returning id as c_old \gset
select is(restore_calendar_conflict(:'c_old'::uuid, :'dono'::uuid) ->> 'status', 'outdated',
  'a atividade mudou depois do conflito: restaurar sobrescreveria valor mais novo');
select is((select title from public.activities where id = (:'reuniao')::uuid), 'Título do CRM', 'e nada foi alterado');

select due_at as due0 from public.activities where id = (:'reuniao')::uuid \gset
insert into public.calendar_sync_conflicts (workspace_id, link_id, environment, field, crm_value, google_value, resolution)
values (:'ws'::uuid, :'link'::uuid, 'production', 'schedule',
  jsonb_build_object('start', '2026-12-01T13:00:00Z', 'end', '2026-12-01T14:00:00Z'),
  jsonb_build_object('start', :'due0'::timestamptz, 'end', :'due0'::timestamptz + interval '1 hour'), 'google_prevails')
returning id as c_sched \gset
select is(restore_calendar_conflict(:'c_sched'::uuid, :'dono'::uuid) ->> 'status', 'restored', 'horário restaurado');
select is((select due_at from public.activities where id = (:'reuniao')::uuid), '2026-12-01T13:00:00Z'::timestamptz,
  'a atividade volta ao início do CRM');

-- CRM 14h–15h perdeu para o Google, que ficou com 2 h a partir do horário atual.
update public.calendar_event_links set duration_minutes = 120, sync_state = 'in_sync', sync_error = null where id = (:'link')::uuid;
insert into public.calendar_sync_conflicts (workspace_id, link_id, environment, field, crm_value, google_value, resolution)
values (:'ws'::uuid, :'link'::uuid, 'production', 'schedule',
  jsonb_build_object('start', '2026-12-03T14:00:00Z', 'end', '2026-12-03T15:00:00Z'),
  jsonb_build_object('start', '2026-12-01T13:00:00Z', 'end', '2026-12-01T15:00:00Z'), 'google_prevails')
returning id as c_dur \gset
select is(restore_calendar_conflict(:'c_dur'::uuid, :'dono'::uuid) ->> 'status', 'restored', 'horário de 1 h restaurado sobre um de 2 h');
select is(
  (select jsonb_build_object('due', a.due_at, 'dur', l.duration_minutes, 'st', l.sync_state, 'err', l.sync_error)
   from public.activities a join public.calendar_event_links l on l.activity_id = a.id
   where a.id = (:'reuniao')::uuid and l.id = (:'link')::uuid),
  jsonb_build_object('due', '2026-12-03T14:00:00Z'::timestamptz, 'dur', 60, 'st', 'pending', 'err', 'conflict_restored'),
  'início na atividade, DURAÇÃO no vínculo, e o vínculo pendente até a saída levar ao Google'
);

-- Depois do conflito, mudou SÓ a duração (o vínculo tem 60 min, o Google tinha vencido com 2 h).
insert into public.calendar_sync_conflicts (workspace_id, link_id, environment, field, crm_value, google_value, resolution)
values (:'ws'::uuid, :'link'::uuid, 'production', 'schedule',
  jsonb_build_object('start', '2026-12-04T09:00:00Z', 'end', '2026-12-04T10:00:00Z'),
  jsonb_build_object('start', '2026-12-03T14:00:00Z', 'end', '2026-12-03T16:00:00Z'), 'google_prevails')
returning id as c_dur2 \gset
select is(restore_calendar_conflict(:'c_dur2'::uuid, :'dono'::uuid) ->> 'status', 'outdated',
  'a duração mudou depois do conflito: restaurar sobrescreveria valor mais novo');
select is(
  (select jsonb_build_object('due', a.due_at, 'dur', l.duration_minutes)
   from public.activities a join public.calendar_event_links l on l.activity_id = a.id
   where a.id = (:'reuniao')::uuid and l.id = (:'link')::uuid),
  jsonb_build_object('due', '2026-12-03T14:00:00Z'::timestamptz, 'dur', 60), 'e nada foi alterado'
);

insert into public.calendar_sync_conflicts (workspace_id, link_id, environment, field, crm_value, google_value, resolution)
values (:'ws'::uuid, :'link'::uuid, 'production', 'schedule',
  jsonb_build_object('start', '2026-12-05T09:00:00Z'),
  jsonb_build_object('start', '2026-12-03T14:00:00Z', 'end', '2026-12-03T15:00:00Z'), 'google_prevails')
returning id as c_noend \gset
select is(restore_calendar_conflict(:'c_noend'::uuid, :'dono'::uuid) ->> 'status', 'not_restorable',
  'sem o fim do valor do CRM, não há duração a restaurar: nada alterado');

insert into public.calendar_sync_conflicts (workspace_id, link_id, environment, field, crm_value, google_value, resolution)
values (:'ws'::uuid, :'link'::uuid, 'production', 'cancellation', '{"title":"x"}'::jsonb, '{"cancelled":true}'::jsonb, 'google_prevails')
returning id as c_cancel \gset
select is(restore_calendar_conflict(:'c_cancel'::uuid, :'dono'::uuid) ->> 'status', 'not_restorable', 'cancelamento não se restaura');

select is(
  (select count(*)::int from public.audit_logs
   where workspace_id = :'ws'::uuid and action = 'calendar.conflict.restored' and metadata::text !~ '(Título|Antigo|2026-12)'),
  3, 'auditoria da restauração só com o nome do campo, nunca valores'
);

-- ---------------------------------------------------------------------
-- 8) Timeline do lead
-- ---------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select (select items from get_lead_timeline(:'lead'::uuid, array['agenda'])) as tl \gset
select is(
  (select jsonb_build_object(
     'conflitos', count(*) filter (where i -> 'payload' ->> 'kind' = 'conflict'),
     'restaurados', count(*) filter (where i -> 'payload' ->> 'kind' = 'restored'))
   from jsonb_array_elements(:'tl'::jsonb) i),
  jsonb_build_object('conflitos', 7, 'restaurados', 3),
  'cada conflito e cada restauração é um fato da timeline'
);
select is(
  (select jsonb_build_object('r', i -> 'payload' -> 'restorable', 'crm', i -> 'payload' -> 'crm_value')
   from jsonb_array_elements(:'tl'::jsonb) i
   where i -> 'payload' ->> 'kind' = 'conflict' and i -> 'payload' ->> 'conflict_id' = :'c_title'),
  jsonb_build_object('r', false, 'crm', 'Título do CRM'),
  'conflito já restaurado não oferece restaurar de novo; o valor do CRM aparece'
);
select is(
  (select count(*)::int from jsonb_array_elements(:'tl'::jsonb) i where i -> 'payload' ->> 'kind' = 'restored'
     and (i ->> 'id')::uuid in (:'c_title'::uuid, :'c_sched'::uuid, :'c_dur'::uuid)),
  0, 'a restauração tem id próprio, diferente do conflito'
);
select set_config('request.headers', :'h_prev', true);
select is(
  (select jsonb_array_length(items) from get_lead_timeline(:'lead'::uuid, array['agenda'])),
  0, 'preview não mostra conflitos de production'
);
select set_config('request.headers', '', true);
select is(
  (select jsonb_array_length(items) from get_lead_timeline(:'lead'::uuid, array['agenda'])),
  0, 'sem ambiente autenticado, nenhum conflito de agenda'
);
select ok(
  (select jsonb_array_length(items) from get_lead_timeline(:'lead'::uuid, array['atividade'])) >= 2,
  'os outros fatos da timeline continuam'
);
reset role;

select * from finish();
rollback;
