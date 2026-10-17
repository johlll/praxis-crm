-- pgTAP — B2: consulta de UM canal para o encerramento pelo operador
-- (`get_calendar_channel_for_stop`). Só leitura, só service_role, ambiente
-- assinado conferido, nenhum segredo devolvido. Todos os registros são
-- criados por este teste.

begin;
select plan(12);

\set dono '20000000-0000-0000-0000-000000000001'

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
select (create_workspace_with_owner('Teste B2 parar canal', 'teste-b2-parar-canal')).id as ws \gset
reset role;

select pg_temp.hdr('production') as h_prod \gset
select pg_temp.hdr('preview') as h_prev \gset

-- Conexão e canal de Preview.
select set_config('request.headers', :'h_prev', true);
select (connect_calendar_identity(:'ws'::uuid, :'dono'::uuid, 'sub-p', 'cliente-a', 'conta@exemplo.test', array['s'],
  'refresh-prev', 'acesso-prev', now() + interval '1 hour', 'v1') ->> 'connectionId') as conn_prev \gset
select begin_calendar_channel(:'conn_prev'::uuid, 'agenda-prev@x', :'dono'::uuid, 'canal-prev', repeat('a', 64));

-- Conexão e canal de Production.
select set_config('request.headers', :'h_prod', true);
select (connect_calendar_identity(:'ws'::uuid, :'dono'::uuid, 'sub-q', 'cliente-a', 'outra@exemplo.test', array['s'],
  'refresh-prod', 'acesso-prod', now() + interval '1 hour', 'v1') ->> 'connectionId') as conn_prod \gset
select begin_calendar_channel(:'conn_prod'::uuid, 'agenda-prod@x', :'dono'::uuid, 'canal-prod', repeat('b', 64));

-- 1) Grants
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select throws_ok($$ select get_calendar_channel_for_stop('canal-prev') $$, '42501', null, 'authenticated NÃO consulta');
reset role;
set local role anon;
select throws_ok($$ select get_calendar_channel_for_stop('canal-prev') $$, '42501', null, 'anon NÃO consulta');
reset role;

-- 2) Ambiente
select set_config('request.headers', '{}', true);
select throws_ok($$ select get_calendar_channel_for_stop('canal-prev') $$, 'P0001', null, 'sem ambiente assinado: recusa');
select set_config('request.headers', :'h_prev', true);
select throws_ok($$ select get_calendar_channel_for_stop('canal-prod') $$, 'P0001', 'calendar_environment_mismatch',
  'canal de Production pedido do Preview: recusa');
select throws_ok($$ select get_calendar_channel_for_stop('nao-existe') $$, 'P0001', 'channel_not_found', 'canal inexistente: recusa');

-- 3) Registro resolvido no servidor, sem segredo
select get_calendar_channel_for_stop('canal-prev') as r \gset
select is((:'r'::jsonb) ->> 'connectionId', :'conn_prev', 'conexão vem do registro');
select is((:'r'::jsonb) ->> 'userId', :'dono', 'dono vem do registro');
select is((:'r'::jsonb) ->> 'workspaceId', :'ws', 'workspace vem do registro');
select is((:'r'::jsonb) ->> 'calendarId', 'agenda-prev@x', 'agenda vem do registro');
select is((:'r'::jsonb) ->> 'status', 'creating', 'estado atual do canal');
select ok(:'r' !~ '(aaaa|refresh-|acesso-|conta@)', 'nenhum hash de segredo, token ou e-mail na resposta');

-- 4) Inconsistência entre canal e conexão
update public.calendar_watch_channels set workspace_id = (select id from public.workspaces where id <> :'ws'::uuid limit 1)
where channel_id = 'canal-prev';
select throws_ok($$ select get_calendar_channel_for_stop('canal-prev') $$, 'P0001', 'channel_inconsistent',
  'canal e conexão de workspaces diferentes: recusa');

select * from finish();
rollback;
