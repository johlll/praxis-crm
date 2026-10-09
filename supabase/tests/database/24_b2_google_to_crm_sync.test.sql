-- pgTAP — B2, etapa 3: sincronização Google → CRM (estado e trava, token
-- só no fim, aplicação com base/versão/alcance, canais e webhook,
-- reautorização e desconexão). Todos os registros são criados por este
-- teste (workspace, atividades, conexões e vínculos próprios de QA).

begin;
select plan(63);

\set dono   '20000000-0000-0000-0000-000000000001'
\set adv    '20000000-0000-0000-0000-000000000002'
\set adv2   '20000000-0000-0000-0000-000000000003'
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
select (create_workspace_with_owner('Teste B2 entrada', 'teste-b2-entrada')).id as ws \gset
reset role;

insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws'::uuid, :'adv', 'lawyer', 'active'),
  (:'ws'::uuid, :'adv2', 'lawyer', 'active'),
  (:'ws'::uuid, :'leitor', 'viewer', 'active');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select (create_contact(:'ws'::uuid, 'pf', 'Cliente B2 entrada', null, null, null)).id as contact \gset
select create_lead(:'ws'::uuid, (:'contact')::uuid, 'Trabalhista', 'Lead B2 entrada', '{}'::text[], 'media', :'adv'::uuid) as lead \gset
select create_activity(
  p_lead_id := (:'lead')::uuid, p_type := 'meeting'::activity_type, p_title := 'Reunião B2 entrada',
  p_due_date := (current_date + 5), p_due_time := '15:00'::time
) as reuniao \gset
select create_activity(
  p_lead_id := (:'lead')::uuid, p_type := 'meeting'::activity_type, p_title := 'Reunião do advogado',
  p_due_date := (current_date + 6), p_due_time := '10:00'::time
) as reuniao_adv \gset
reset role;

select pg_temp.hdr('production') as h_prod \gset
select pg_temp.hdr('preview') as h_prev \gset

select set_config('request.headers', :'h_prod', true);
select connect_calendar_account(:'ws'::uuid, :'dono'::uuid, 'dono@v.test', array['escopo'], 'refresh-cifrado', 'access-cifrado', now() + interval '1 hour', '1') as conn \gset
select set_calendar_connection_calendar(:'conn'::uuid, :'dono'::uuid, 'cal-a@x', 'Agenda A');
select create_calendar_event_link(:'conn'::uuid, :'reuniao'::uuid, :'dono'::uuid, 'evento-1') as link \gset
update public.calendar_event_links
set base_etag = '"1"', base_title = 'Reunião B2 entrada', meet_status = 'success', meet_url = 'https://meet.simulated/e1',
    base_has_meet = true, duration_minutes = 60
where id = (:'link')::uuid;

select connect_calendar_account(:'ws'::uuid, :'adv'::uuid, 'adv@v.test', array['escopo'], 'refresh-adv', 'access-adv', now() + interval '1 hour', '1') as conn_adv \gset
select set_calendar_connection_calendar(:'conn_adv'::uuid, :'adv'::uuid, 'cal-adv@x', 'Agenda do advogado');
select create_calendar_event_link(:'conn_adv'::uuid, :'reuniao_adv'::uuid, :'adv'::uuid, 'evento-adv') as link_adv \gset
update public.calendar_event_links set base_etag = '"a1"' where id = (:'link_adv')::uuid;

-- ---------------------------------------------------------------------
-- 1) Tabelas e grants
-- ---------------------------------------------------------------------

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('calendar_sync_state', 'calendar_watch_channels')
     and c.relrowsecurity and c.relforcerowsecurity),
  2, 'RLS habilitada E forçada em calendar_sync_state e calendar_watch_channels'
);
select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('calendar_sync_state', 'calendar_watch_channels')
     and grantee in ('anon', 'authenticated')),
  0, 'nenhum GRANT de tabela para anon/authenticated'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select claim_calendar_sync(%L::uuid, 'cal-a@x', %L::uuid) $i$, :'conn', :'dono'),
  '42501', null, 'authenticated NÃO executa claim_calendar_sync'
);
select throws_ok(
  format($i$ select apply_google_inbound_change(%L::uuid, %L::uuid, '"1"', 1, '', null, '[]'::jsonb, '{}'::jsonb) $i$, :'link', :'dono'),
  '42501', null, 'authenticated NÃO executa apply_google_inbound_change'
);
select throws_ok(
  $i$ select record_calendar_notification('c', repeat('a', 64), null, 'exists', 1, null) $i$,
  '42501', null, 'authenticated NÃO executa record_calendar_notification'
);
select throws_ok(
  $i$ select list_calendar_maintenance() $i$,
  '42501', null, 'authenticated NÃO executa list_calendar_maintenance'
);
select throws_ok(
  format($i$ select begin_calendar_channel(%L::uuid, 'cal-a@x', %L::uuid, 'c', repeat('a', 64)) $i$, :'conn', :'dono'),
  '42501', null, 'authenticated NÃO executa begin_calendar_channel'
);
reset role;

-- ---------------------------------------------------------------------
-- 2) Ambiente e alvos
-- ---------------------------------------------------------------------

select set_config('request.headers', '', true);
select throws_ok(
  format($i$ select claim_calendar_sync(%L::uuid, 'cal-a@x', %L::uuid) $i$, :'conn', :'dono'),
  'P0001', 'environment_required', 'sem ambiente autenticado nada sincroniza'
);

select set_config('request.headers', :'h_prod', true);
select is(
  (select count(*)::int from jsonb_array_elements(list_calendar_maintenance() -> 'targets') t
   where t ->> 'connectionId' = :'conn' and t ->> 'calendarId' = 'cal-a@x'),
  1, 'a agenda com vínculo ativo é alvo da manutenção'
);
select is(
  (list_calendar_maintenance())::text ~ '(refresh-cifrado|access-cifrado|token_hash)',
  false, 'a manutenção nunca recebe tokens nem hashes'
);
select set_config('request.headers', :'h_prev', true);
select is(
  jsonb_array_length(list_calendar_maintenance() -> 'targets'),
  0, 'o preview não enxerga alvos de production'
);
select throws_ok(
  format($i$ select list_calendar_links_for_sync(%L::uuid, 'cal-a@x', %L::uuid) $i$, :'conn', :'dono'),
  'P0001', 'calendar_environment_mismatch', 'o preview não lê os vínculos de production'
);
select set_config('request.headers', :'h_prod', true);

-- ---------------------------------------------------------------------
-- 3) Trava e token
-- ---------------------------------------------------------------------

select throws_ok(
  format($i$ select claim_calendar_sync(%L::uuid, 'cal-a@x', %L::uuid) $i$, :'conn', :'adv'),
  'P0001', 'connection_not_found', 'só o dono da conexão sincroniza'
);
select (claim_calendar_sync(:'conn'::uuid, 'cal-a@x', :'dono'::uuid) ->> 'leaseId') as lease1 \gset
select ok(:'lease1' is not null, 'o dono pega a trava');
select is(claim_calendar_sync(:'conn'::uuid, 'cal-a@x', :'dono'::uuid), null::jsonb, 'com a trava tomada, outra execução não começa');

select throws_ok(
  format($i$ select finish_calendar_sync(%L::uuid, %L::uuid, 'success', null, true, '') $i$, :'lease1', :'dono'),
  'P0001', 'sync_token_required', 'sucesso sem token novo é recusado'
);
select is(finish_calendar_sync(:'lease1'::uuid, :'dono'::uuid, 'success', 'tok-1', true, ''), true, 'todas as páginas: grava o token');
select is(
  (select jsonb_build_object('t', sync_token, 'f', full_sync_at is not null, 'l', lease_id is null)
   from public.calendar_sync_state where connection_id = (:'conn')::uuid and calendar_id = 'cal-a@x'),
  jsonb_build_object('t', 'tok-1', 'f', true, 'l', true),
  'token, sync completo e trava liberada'
);
select is(finish_calendar_sync(:'lease1'::uuid, :'dono'::uuid, 'success', 'tok-velho', false, ''), false,
  'trava já liberada (ou tomada por outra): nada é gravado');

select (claim_calendar_sync(:'conn'::uuid, 'cal-a@x', :'dono'::uuid) ->> 'leaseId') as lease2 \gset
select finish_calendar_sync(:'lease2'::uuid, :'dono'::uuid, 'failed', null, false, 'provider_503');
select is(
  (select jsonb_build_object('t', sync_token, 'e', last_error) from public.calendar_sync_state
   where connection_id = (:'conn')::uuid and calendar_id = 'cal-a@x'),
  jsonb_build_object('t', 'tok-1', 'e', 'provider_503'),
  'falha no meio mantém o token anterior'
);

select (claim_calendar_sync(:'conn'::uuid, 'cal-a@x', :'dono'::uuid) ->> 'leaseId') as lease3 \gset
select is(reset_calendar_sync_token(:'lease3'::uuid, :'dono'::uuid), true, '410: o token é descartado');
select is(
  (select sync_token from public.calendar_sync_state where connection_id = (:'conn')::uuid and calendar_id = 'cal-a@x'),
  null::text, 'e não volta a ser usado'
);
select is(
  (select count(*)::int from public.activities where id = (:'reuniao')::uuid),
  1, '410 não apaga atividade'
);
select finish_calendar_sync(:'lease3'::uuid, :'dono'::uuid, 'success', 'tok-2', true, '');

-- Acesso perdido: pendência explícita; com a listagem de volta, o vínculo volta.
select (claim_calendar_sync(:'conn'::uuid, 'cal-a@x', :'dono'::uuid) ->> 'leaseId') as lease4 \gset
select finish_calendar_sync(:'lease4'::uuid, :'dono'::uuid, 'access_lost', null, false, 'calendar_access_lost');
select is(
  (select jsonb_build_object('s', status::text, 'y', sync_state, 'e', sync_error) from public.calendar_event_links where id = (:'link')::uuid),
  jsonb_build_object('s', 'needs_attention', 'y', 'pending', 'e', 'calendar_access_lost'),
  'acesso perdido vira pendência explícita (não "apagado")'
);
select (claim_calendar_sync(:'conn'::uuid, 'cal-a@x', :'dono'::uuid) ->> 'leaseId') as lease5 \gset
select finish_calendar_sync(:'lease5'::uuid, :'dono'::uuid, 'success', 'tok-3', false, '');
select is(
  (select status::text from public.calendar_event_links where id = (:'link')::uuid),
  'linked', 'listagem bem-sucedida prova o acesso: o vínculo volta'
);

-- Dica do webhook: apagada só se veio ANTES da execução começar.
update public.calendar_sync_state set dirty_at = now() - interval '1 minute'
where connection_id = (:'conn')::uuid and calendar_id = 'cal-a@x';
select (claim_calendar_sync(:'conn'::uuid, 'cal-a@x', :'dono'::uuid) ->> 'leaseId') as lease6 \gset
select finish_calendar_sync(:'lease6'::uuid, :'dono'::uuid, 'success', 'tok-4', false, '');
select is(
  (select dirty_at from public.calendar_sync_state where connection_id = (:'conn')::uuid and calendar_id = 'cal-a@x'),
  null::timestamptz, 'dica anterior à execução é consumida'
);
select (claim_calendar_sync(:'conn'::uuid, 'cal-a@x', :'dono'::uuid) ->> 'leaseId') as lease7 \gset
update public.calendar_sync_state set dirty_at = now() + interval '1 minute'
where connection_id = (:'conn')::uuid and calendar_id = 'cal-a@x';
select finish_calendar_sync(:'lease7'::uuid, :'dono'::uuid, 'success', 'tok-5', false, '');
select ok(
  (select dirty_at is not null from public.calendar_sync_state where connection_id = (:'conn')::uuid and calendar_id = 'cal-a@x'),
  'dica que chegou DURANTE a execução é preservada'
);

-- ---------------------------------------------------------------------
-- 4) Vínculos para a sincronização e aplicação da mudança do Google
-- ---------------------------------------------------------------------

select is(
  (select jsonb_build_object('e', l ->> 'baseEtag', 'v', (l -> 'activity' ->> 'lockVersion') is not null)
   from jsonb_array_elements(list_calendar_links_for_sync(:'conn'::uuid, 'cal-a@x', :'dono'::uuid)) l),
  jsonb_build_object('e', '"1"', 'v', true),
  'os vínculos da agenda vêm com a base e a versão da atividade'
);

select lock_version as v0 from public.activities where id = (:'reuniao')::uuid \gset

select is(
  apply_google_inbound_change(:'link'::uuid, :'dono'::uuid, '"base-errada"', :'v0'::bigint, 'X', null, '[]'::jsonb, '{"etag":"\"2\""}'::jsonb) ->> 'status',
  'stale_link', 'base diferente da lida: nada aplicado'
);
select is(
  apply_google_inbound_change(:'link'::uuid, :'dono'::uuid, '"1"', (:'v0'::bigint) - 1, 'X', null, '[]'::jsonb, '{"etag":"\"2\""}'::jsonb) ->> 'status',
  'stale_activity', 'atividade mudou desde a leitura: nada aplicado'
);
select is(
  (select title from public.activities where id = (:'reuniao')::uuid),
  'Reunião B2 entrada', 'e a atividade continua como estava'
);

select throws_ok(
  format($i$ select apply_google_inbound_change(%L::uuid, %L::uuid, '"1"', %s, 'X', null, '[]'::jsonb, '{"etag":"\"2\""}'::jsonb) $i$, :'link', :'adv', :'v0'),
  'P0001', 'connection_not_found', 'só o dono da conexão aplica o que veio da agenda dele'
);
select set_config('request.headers', :'h_prev', true);
select throws_ok(
  format($i$ select apply_google_inbound_change(%L::uuid, %L::uuid, '"1"', %s, 'X', null, '[]'::jsonb, '{"etag":"\"2\""}'::jsonb) $i$, :'link', :'dono', :'v0'),
  'P0001', 'calendar_environment_mismatch', 'o preview não aplica mudança em vínculo de production'
);
select set_config('request.headers', :'h_prod', true);

select apply_google_inbound_change(
  :'link'::uuid, :'dono'::uuid, '"1"', :'v0'::bigint, 'Título do Google', null,
  '[{"field":"title","crmValue":"Título do CRM","googleValue":"Título do Google"}]'::jsonb,
  jsonb_build_object('etag', '"2"', 'title', 'Título do Google', 'start', '2026-11-10T14:00:00Z', 'end', '2026-11-10T15:00:00Z',
    'cancelled', false, 'hasMeet', false, 'meetStatus', null, 'meetUrl', null, 'durationMinutes', 60,
    'linkStatus', 'linked', 'changed', jsonb_build_array('title', 'meet'))
) as aplicado \gset
select is(:'aplicado'::jsonb ->> 'status', 'applied', 'mudança do Google aplicada');
select is(
  (select jsonb_build_object('t', title, 'v', lock_version) from public.activities where id = (:'reuniao')::uuid),
  jsonb_build_object('t', 'Título do Google', 'v', (:'v0')::bigint + 1),
  'a atividade recebe o valor do Google, com versão nova'
);
select is(
  (select jsonb_build_object('e', base_etag, 't', base_title, 'm', meet_status, 'u', meet_url, 'v', base_crm_version)
   from public.calendar_event_links where id = (:'link')::uuid),
  jsonb_build_object('e', '"2"', 't', 'Título do Google', 'm', null, 'u', null, 'v', (:'v0')::bigint + 1),
  'a base avança na MESMA transação (Meet removido no Google é removido aqui)'
);
select is(
  (select crm_value #>> '{}' from public.calendar_sync_conflicts where link_id = (:'link')::uuid and field = 'title'),
  'Título do CRM', 'o valor do CRM que perdeu fica gravado'
);
select is(
  (select count(*)::int from public.audit_logs
   where workspace_id = :'ws'::uuid and action like 'calendar.inbound.%' and metadata::text ~* '(Título|Reunião|evento-1)'),
  0, 'a auditoria guarda só nomes de campo, nunca valores nem ids de evento'
);

-- Cancelado no Google: o vínculo muda, a atividade NÃO é apagada.
select apply_google_inbound_change(
  :'link'::uuid, :'dono'::uuid, '"2"', (:'v0'::bigint) + 1, '', null, '[]'::jsonb,
  jsonb_build_object('etag', '"3"', 'title', 'Título do Google', 'cancelled', true, 'hasMeet', false,
    'durationMinutes', 60, 'linkStatus', 'cancelled_in_google', 'changed', jsonb_build_array('cancellation'))
);
select is(
  (select jsonb_build_object('s', l.status::text, 'a', (select count(*) from public.activities a where a.id = l.activity_id))
   from public.calendar_event_links l where l.id = (:'link')::uuid),
  jsonb_build_object('s', 'cancelled_in_google', 'a', 1),
  'cancelado no Google: vínculo marcado, atividade mantida'
);

-- O dono da conexão perde o alcance ao lead: nada é aplicado.
update public.leads set assigned_to = :'adv2'::uuid where id = (:'lead')::uuid;
select lock_version as va from public.activities where id = (:'reuniao_adv')::uuid \gset
select is(
  apply_google_inbound_change(:'link_adv'::uuid, :'adv'::uuid, '"a1"', :'va'::bigint, 'Não deve chegar', null, '[]'::jsonb,
    '{"etag":"\"a2\"","title":"Não deve chegar","linkStatus":"linked"}'::jsonb) ->> 'status',
  'not_authorized', 'sem alcance do dono à atividade: recusado'
);
select is(
  (select jsonb_build_object('t', a.title, 's', l.status::text, 'e', l.sync_error, 'b', l.base_etag)
   from public.calendar_event_links l join public.activities a on a.id = l.activity_id where l.id = (:'link_adv')::uuid),
  jsonb_build_object('t', 'Reunião do advogado', 's', 'needs_attention', 'e', 'owner_lost_access', 'b', '"a1"'),
  'atividade intocada; vínculo para atenção; base não avança'
);
update public.leads set assigned_to = :'adv'::uuid where id = (:'lead')::uuid;

-- ---------------------------------------------------------------------
-- 5) Canais e webhook
-- ---------------------------------------------------------------------

select encode(sha256('segredo-1'::bytea), 'hex') as h1 \gset
select encode(sha256('segredo-2'::bytea), 'hex') as h2 \gset

select begin_calendar_channel(:'conn'::uuid, 'cal-a@x', :'dono'::uuid, 'canal-1', :'h1');
select is(
  (select status from public.calendar_watch_channels where channel_id = 'canal-1'),
  'creating', 'a linha do canal nasce ANTES da chamada ao Google'
);
select throws_ok(
  format($i$ select begin_calendar_channel(%L::uuid, 'cal-a@x', %L::uuid, 'canal-x', %L) $i$, :'conn', :'dono', 'segredo-em-claro'),
  '23514', null, 'só o hash do segredo é aceito (nunca o segredo)'
);

select is(record_calendar_notification('canal-inexistente', :'h1', 'res-1', 'sync', 1, null), 'rejected', 'canal desconhecido: rejeitado');
select is(record_calendar_notification('canal-1', :'h2', 'res-1', 'sync', 1, null), 'rejected', 'segredo errado: rejeitado');
select set_config('request.headers', :'h_prev', true);
select is(record_calendar_notification('canal-1', :'h1', 'res-1', 'sync', 1, null), 'rejected', 'canal de production pelo preview: rejeitado');
select set_config('request.headers', :'h_prod', true);

select is(record_calendar_notification('canal-1', :'h1', 'res-1', 'sync', 1, now() + interval '7 days'), 'accepted',
  'primeira mensagem do canal: aceita');
select is(
  (select jsonb_build_object('r', resource_id, 's', sync_received_at is not null, 'x', expires_at is not null)
   from public.calendar_watch_channels where channel_id = 'canal-1'),
  jsonb_build_object('r', 'res-1', 's', true, 'x', true),
  'a primeira mensagem revela o recurso e a validade (resposta do watch perdida)'
);
select is(record_calendar_notification('canal-1', :'h1', 'outro-recurso', 'exists', 2, null), 'rejected', 'recurso diferente: rejeitado');

select activate_calendar_channel('canal-1', :'dono'::uuid, 'res-1', now() + interval '7 days', now() + interval '5 days', false);
select begin_calendar_channel(:'conn'::uuid, 'cal-a@x', :'dono'::uuid, 'canal-2', :'h2');
select activate_calendar_channel('canal-2', :'dono'::uuid, 'res-1', now() + interval '7 days', now() - interval '1 minute', false);
select is(
  (select jsonb_object_agg(channel_id, status) from public.calendar_watch_channels where channel_id in ('canal-1', 'canal-2')),
  jsonb_build_object('canal-1', 'retiring', 'canal-2', 'active'),
  'o canal novo ativo manda o anterior para retiring (sobreposição, sem parar ainda)'
);

select is(claim_calendar_channel_renewal('canal-2', :'dono'::uuid), true, 'renovação vencida: uma execução pega a trava');
select is(claim_calendar_channel_renewal('canal-2', :'dono'::uuid), false, 'a segunda execução simultânea não renova');
select throws_ok(
  $i$ select claim_calendar_channel_renewal('canal-2', '20000000-0000-0000-0000-000000000002'::uuid) $i$,
  'P0001', 'channel_not_found', 'canal de outro usuário: recusado'
);

update public.calendar_sync_state set dirty_at = null where connection_id = (:'conn')::uuid and calendar_id = 'cal-a@x';
select is(record_calendar_notification('canal-2', :'h2', 'res-1', 'exists', 2, null), 'accepted', 'notificação de mudança aceita');
select ok(
  (select dirty_at is not null from public.calendar_sync_state where connection_id = (:'conn')::uuid and calendar_id = 'cal-a@x'),
  'a notificação só marca a agenda para sincronizar'
);

select stop_calendar_channel('canal-1', :'dono'::uuid, 'replaced');
select is(record_calendar_notification('canal-1', :'h1', 'res-1', 'exists', 3, null), 'ignored', 'canal encerrado: ignorado');

-- ---------------------------------------------------------------------
-- 6) Reautorização e desconexão
-- ---------------------------------------------------------------------

select mark_calendar_connection_needs_reauth(:'conn_adv'::uuid, :'adv'::uuid, 'refresh_token_invalid');
select is(
  (select status::text from public.calendar_connections where id = (:'conn_adv')::uuid),
  'needs_reauth', 'refresh token inválido: conexão a reautorizar'
);
select throws_ok(
  format($i$ select claim_calendar_sync(%L::uuid, 'cal-adv@x', %L::uuid) $i$, :'conn_adv', :'adv'),
  'P0001', 'connection_not_active', 'conexão a reautorizar não sincroniza'
);

select is(
  (select count(*)::int from jsonb_array_elements(list_own_calendar_channels(:'conn'::uuid, :'dono'::uuid))),
  1, 'canais vivos da própria conexão (para encerrar no Google antes de desconectar)'
);
select throws_ok(
  format($i$ select list_own_calendar_channels(%L::uuid, %L::uuid) $i$, :'conn', :'adv'),
  'P0001', 'connection_not_found', 'só o dono lista os canais da conexão'
);

select disconnect_calendar_connection(:'conn'::uuid, :'dono'::uuid);
select is(
  (select count(*)::int from public.calendar_watch_channels where connection_id = (:'conn')::uuid and status <> 'stopped'),
  0, 'desconectar encerra os canais'
);
select is(
  (select sync_token from public.calendar_sync_state where connection_id = (:'conn')::uuid and calendar_id = 'cal-a@x'),
  null::text, 'e descarta o estado de sincronização'
);
select is(
  (select count(*)::int from public.activities where id = (:'reuniao')::uuid),
  1, 'sem apagar a atividade'
);

select * from finish();
rollback;
