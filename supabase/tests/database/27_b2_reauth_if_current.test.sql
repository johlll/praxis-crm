-- pgTAP — B2: conexão "a reautorizar" reconhecida fora do agendador
-- (`mark_calendar_connection_needs_reauth_if_current`). Só marca se o
-- refresh token que falhou ainda é o gravado; falha atrasada depois de uma
-- reautorização ou de uma desconexão não muda nada. Todos os registros são
-- criados por este teste.

begin;
select plan(17);

\set dono '20000000-0000-0000-0000-000000000001'
\set adv  '20000000-0000-0000-0000-000000000002'

insert into public.calendar_environment_keys (environment, signing_key) values
  ('production', 'chave-de-producao-de-teste-0123456789ab'),
  ('preview', 'chave-de-preview-de-teste-0123456789abcd');

create function pg_temp.hdr(p_env text)
returns text language sql as $f$
  select json_build_object('x-praxis-env', p_env || '.' || e.x || '.' || private.environment_signature(p_env, e.x, k.signing_key))::text
  from (select extract(epoch from now())::bigint + 600 as x) e,
       (select signing_key from public.calendar_environment_keys where environment = p_env::public.calendar_environment) k
$f$;

-- Impressão digital como a aplicação calcula: SHA-256 (hex) do texto cifrado.
create function pg_temp.fp(p text) returns text language sql as $f$ select encode(extensions.digest(p, 'sha256'), 'hex') $f$;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select (create_workspace_with_owner('Teste B2 reauth', 'teste-b2-reauth')).id as ws \gset
reset role;
insert into public.memberships (workspace_id, user_id, role, status) values (:'ws'::uuid, :'adv', 'lawyer', 'active');

select pg_temp.hdr('production') as h_prod \gset
select pg_temp.hdr('preview') as h_prev \gset
select set_config('request.headers', :'h_prev', true);

select (connect_calendar_identity(:'ws'::uuid, :'dono'::uuid, 'sub-r', 'cliente-a', 'conta@exemplo.test', array['s'],
  'refresh-velho', 'acesso-1', now() + interval '1 hour', 'v1') ->> 'connectionId') as conn \gset
select pg_temp.fp('refresh-velho') as fp_velho \gset

-- ---------------------------------------------------------------------
-- 1) Grants e isolamento
-- ---------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select throws_ok(format($i$ select mark_calendar_connection_needs_reauth_if_current(%L::uuid, %L::uuid, %L::uuid, %L, 'x') $i$, :'conn', :'ws', :'dono', :'fp_velho'),
  '42501', null, 'authenticated NÃO chama a marcação direto');
reset role;
select set_config('request.headers', :'h_prev', true);

select throws_ok(format($i$ select mark_calendar_connection_needs_reauth_if_current(%L::uuid, %L::uuid, %L::uuid, %L, 'x') $i$, :'conn', :'ws', :'adv', :'fp_velho'),
  'P0001', 'connection_not_found', 'outro usuário do workspace: recusado');
select throws_ok(format($i$ select mark_calendar_connection_needs_reauth_if_current(%L::uuid, %L::uuid, %L::uuid, %L, 'x') $i$, :'conn', gen_random_uuid(), :'dono', :'fp_velho'),
  'P0001', 'connection_not_found', 'outro workspace: recusado');
select set_config('request.headers', :'h_prod', true);
select throws_ok(format($i$ select mark_calendar_connection_needs_reauth_if_current(%L::uuid, %L::uuid, %L::uuid, %L, 'x') $i$, :'conn', :'ws', :'dono', :'fp_velho'),
  'P0001', 'calendar_environment_mismatch', 'outro ambiente: recusado');
select set_config('request.headers', :'h_prev', true);
select is((select status::text from public.calendar_connections where id = :'conn'::uuid), 'active', 'nenhuma recusa mudou a conexão');

-- ---------------------------------------------------------------------
-- 2) Credencial atual × credencial antiga
-- ---------------------------------------------------------------------

select is(mark_calendar_connection_needs_reauth_if_current(:'conn'::uuid, :'ws'::uuid, :'dono'::uuid, pg_temp.fp('outro-token'), 'refresh_token_invalid'),
  'stale', 'impressão digital de OUTRO token: nada muda');
select is((select status::text from public.calendar_connections where id = :'conn'::uuid), 'active', 'continua ativa');

select is(mark_calendar_connection_needs_reauth_if_current(:'conn'::uuid, :'ws'::uuid, :'dono'::uuid, :'fp_velho', 'refresh_token_invalid'),
  'marked', 'o token que falhou é o gravado: marca');
select is((select status::text from public.calendar_connections where id = :'conn'::uuid), 'needs_reauth', 'conexão a reautorizar');

select is(mark_calendar_connection_needs_reauth_if_current(:'conn'::uuid, :'ws'::uuid, :'dono'::uuid, :'fp_velho', 'refresh_token_invalid'),
  'already', 'a mesma falha de novo: já estava');
select is(
  (select count(*)::int from public.audit_logs
   where resource_id = :'conn'::uuid and action = 'calendar.connection.needs_reauth'
     and metadata ->> 'reason' = 'refresh_token_invalid' and metadata::text !~ '(refresh-velho|acesso-|conta@|sub-r)'),
  1, 'uma única transição auditada, sem token, e-mail ou conta');

-- ---------------------------------------------------------------------
-- 3) Falha atrasada depois da reautorização
-- ---------------------------------------------------------------------

select is(
  (connect_calendar_identity(:'ws'::uuid, :'dono'::uuid, 'sub-r', 'cliente-a', 'conta@exemplo.test', array['s'],
    'refresh-novo', 'acesso-2', now() + interval '1 hour', 'v1') ->> 'connectionId'),
  :'conn', 'reautorização da mesma conta: mesma conexão');
select is((select status::text from public.calendar_connections where id = :'conn'::uuid), 'active', 'reautorizada: ativa');
select is(mark_calendar_connection_needs_reauth_if_current(:'conn'::uuid, :'ws'::uuid, :'dono'::uuid, :'fp_velho', 'refresh_token_invalid'),
  'stale', 'falha atrasada do token VELHO: reconhecida como antiga');
select is((select status::text from public.calendar_connections where id = :'conn'::uuid), 'active', 'e a reautorização continua valendo');

-- ---------------------------------------------------------------------
-- 4) Falha atrasada depois da desconexão
-- ---------------------------------------------------------------------

select disconnect_calendar_connection(:'conn'::uuid, :'dono'::uuid);
select is(mark_calendar_connection_needs_reauth_if_current(:'conn'::uuid, :'ws'::uuid, :'dono'::uuid, pg_temp.fp('refresh-novo'), 'refresh_token_invalid'),
  'disconnected', 'desconectada: a marcação não muda nada');
select is((select status::text from public.calendar_connections where id = :'conn'::uuid), 'disconnected', 'continua desconectada');

select * from finish();
rollback;
