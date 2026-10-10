-- pgTAP — B2, etapa 4a: estado da autorização OAuth (uso único, prazo,
-- ambiente, sessão e navegador) e conexão pela identidade da conta
-- (refresh token ausente, outra conta, outro cliente). Todos os registros
-- são criados por este teste.

begin;
select plan(34);

\set dono   '20000000-0000-0000-0000-000000000001'
\set adv    '20000000-0000-0000-0000-000000000002'
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

create function pg_temp.h(p text) returns text language sql as $f$ select encode(extensions.digest(p, 'sha256'), 'hex') $f$;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select (create_workspace_with_owner('Teste B2 4a', 'teste-b2-4a')).id as ws \gset
reset role;
insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws'::uuid, :'adv', 'lawyer', 'active'),
  (:'ws'::uuid, :'leitor', 'viewer', 'active');

select pg_temp.hdr('production') as h_prod \gset
select pg_temp.hdr('preview') as h_prev \gset
select set_config('request.headers', :'h_prev', true);

-- ---------------------------------------------------------------------
-- 1) Tabela e grants
-- ---------------------------------------------------------------------

select ok(
  (select c.relrowsecurity and c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'calendar_oauth_states'),
  'RLS habilitada E forçada no estado OAuth'
);
select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'calendar_oauth_states' and grantee in ('anon', 'authenticated')),
  0, 'nenhum GRANT de tabela para anon/authenticated'
);
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select throws_ok(format($i$ select begin_calendar_oauth(%L::uuid, %L::uuid, repeat('a', 64), repeat('b', 64), repeat('c', 64), 'x', 'v1') $i$, :'ws', :'dono'),
  '42501', null, 'authenticated NÃO inicia autorização direto');
select throws_ok(format($i$ select consume_calendar_oauth(repeat('a', 64), %L::uuid, %L::uuid, repeat('b', 64)) $i$, :'dono', :'ws'),
  '42501', null, 'authenticated NÃO consome autorização');
select throws_ok(format($i$ select connect_calendar_identity(%L::uuid, %L::uuid, 's', 'c', 'a@b.co', array['x'], 'r', 'a', now(), 'v1') $i$, :'ws', :'dono'),
  '42501', null, 'authenticated NÃO grava conexão direto');
reset role;

-- ---------------------------------------------------------------------
-- 2) Estado: início
-- ---------------------------------------------------------------------

-- (Capturado antes: BETWEEN avaliaria a função duas vezes.)
select begin_calendar_oauth(:'ws'::uuid, :'dono'::uuid, pg_temp.h('state-1'), pg_temp.h('navegador-1'), pg_temp.h('nonce-1'), 'verificador-cifrado', 'v1') as vence \gset
select ok(:'vence'::timestamptz between now() + interval '9 minutes' and now() + interval '11 minutes', 'vale 10 minutos');
select is(
  (select count(*)::int from public.calendar_oauth_states where state_hash = pg_temp.h('state-1') and environment = 'preview'),
  1, 'gravado com o ambiente autenticado'
);
select is(
  (select count(*)::int from public.calendar_oauth_states s
   where s.state_hash = 'state-1' or s.browser_hash = 'navegador-1' or s.nonce_hash = 'nonce-1'),
  0, 'só hashes: o state, o cookie e o nonce em claro nunca chegam ao banco'
);
select throws_ok(format($i$ select begin_calendar_oauth(%L::uuid, %L::uuid, 'curto', %L, %L, 'v', 'v1') $i$, :'ws', :'dono', pg_temp.h('b'), pg_temp.h('n')),
  'P0001', 'invalid_oauth_state', 'hash fora do formato é recusado');
select throws_ok(format($i$ select begin_calendar_oauth(%L::uuid, %L::uuid, %L, %L, %L, 'v', 'v1') $i$, :'ws', :'leitor', pg_temp.h('s9'), pg_temp.h('b'), pg_temp.h('n')),
  'P0001', 'insufficient_permission', 'viewer não conecta agenda');
select set_config('request.headers', '', true);
select throws_ok(format($i$ select begin_calendar_oauth(%L::uuid, %L::uuid, %L, %L, %L, 'v', 'v1') $i$, :'ws', :'dono', pg_temp.h('s8'), pg_temp.h('b'), pg_temp.h('n')),
  'P0001', 'environment_required', 'sem ambiente autenticado, nada');
select set_config('request.headers', :'h_prev', true);

-- No máximo 5 em aberto por usuário e ambiente.
select begin_calendar_oauth(:'ws'::uuid, :'dono'::uuid, pg_temp.h('extra-' || g), pg_temp.h('b'), pg_temp.h('n'), 'v', 'v1') from generate_series(1, 6) g;
select is((select count(*)::int from public.calendar_oauth_states where user_id = :'dono'::uuid), 5, 'no máximo 5 autorizações em aberto');

-- ---------------------------------------------------------------------
-- 3) Estado: retorno (uso único; prazo, ambiente, sessão e navegador)
-- ---------------------------------------------------------------------

select begin_calendar_oauth(:'ws'::uuid, :'dono'::uuid, pg_temp.h('ok'), pg_temp.h('nav'), pg_temp.h('nonce'), 'verificador-cifrado', 'v1');
select is(
  consume_calendar_oauth(pg_temp.h('ok'), :'dono'::uuid, :'ws'::uuid, pg_temp.h('nav')),
  jsonb_build_object('status', 'ok', 'nonceHash', pg_temp.h('nonce'), 'verifierCiphertext', 'verificador-cifrado', 'keyVersion', 'v1'),
  'retorno válido devolve o nonce (hash) e o verificador cifrado'
);
select is(consume_calendar_oauth(pg_temp.h('ok'), :'dono'::uuid, :'ws'::uuid, pg_temp.h('nav')) ->> 'status', 'not_found', 'uso ÚNICO');

select begin_calendar_oauth(:'ws'::uuid, :'dono'::uuid, pg_temp.h('outro-user'), pg_temp.h('nav'), pg_temp.h('n'), 'v', 'v1');
select is(consume_calendar_oauth(pg_temp.h('outro-user'), :'adv'::uuid, :'ws'::uuid, pg_temp.h('nav')) ->> 'status', 'session_mismatch',
  'outro usuário (troca de sessão): recusado');
select is(consume_calendar_oauth(pg_temp.h('outro-user'), :'dono'::uuid, :'ws'::uuid, pg_temp.h('nav')) ->> 'status', 'not_found',
  'e a tentativa recusada já consumiu o state');

select begin_calendar_oauth(:'ws'::uuid, :'dono'::uuid, pg_temp.h('outro-ws'), pg_temp.h('nav'), pg_temp.h('n'), 'v', 'v1');
select is(consume_calendar_oauth(pg_temp.h('outro-ws'), :'dono'::uuid, gen_random_uuid(), pg_temp.h('nav')) ->> 'status', 'session_mismatch',
  'outro workspace: recusado');

select begin_calendar_oauth(:'ws'::uuid, :'dono'::uuid, pg_temp.h('nav-errado'), pg_temp.h('nav'), pg_temp.h('n'), 'v', 'v1');
select is(consume_calendar_oauth(pg_temp.h('nav-errado'), :'dono'::uuid, :'ws'::uuid, pg_temp.h('outro-navegador')) ->> 'status', 'browser_mismatch',
  'outro navegador (cookie diferente): recusado');
select begin_calendar_oauth(:'ws'::uuid, :'dono'::uuid, pg_temp.h('sem-cookie'), pg_temp.h('nav'), pg_temp.h('n'), 'v', 'v1');
select is(consume_calendar_oauth(pg_temp.h('sem-cookie'), :'dono'::uuid, :'ws'::uuid, '') ->> 'status', 'browser_mismatch',
  'sem o cookie: recusado');

select begin_calendar_oauth(:'ws'::uuid, :'dono'::uuid, pg_temp.h('vencido'), pg_temp.h('nav'), pg_temp.h('n'), 'v', 'v1');
update public.calendar_oauth_states set expires_at = now() - interval '1 second' where state_hash = pg_temp.h('vencido');
select is(consume_calendar_oauth(pg_temp.h('vencido'), :'dono'::uuid, :'ws'::uuid, pg_temp.h('nav')) ->> 'status', 'expired', 'vencido: recusado');

select begin_calendar_oauth(:'ws'::uuid, :'dono'::uuid, pg_temp.h('do-preview'), pg_temp.h('nav'), pg_temp.h('n'), 'v', 'v1');
select set_config('request.headers', :'h_prod', true);
select is(consume_calendar_oauth(pg_temp.h('do-preview'), :'dono'::uuid, :'ws'::uuid, pg_temp.h('nav')) ->> 'status', 'wrong_environment',
  'iniciado no Preview, retorno em Production: recusado');
select set_config('request.headers', :'h_prev', true);

-- ---------------------------------------------------------------------
-- 4) Conexão pela identidade
-- ---------------------------------------------------------------------

select throws_ok(format($i$ select connect_calendar_identity(%L::uuid, %L::uuid, 'sub-1', 'cliente-a', 'conta@exemplo.test', array['s'], '', 'acesso', now(), 'v1') $i$, :'ws', :'dono'),
  'P0001', 'refresh_token_missing', 'conexão NOVA sem refresh token: recusada');

select (connect_calendar_identity(:'ws'::uuid, :'dono'::uuid, 'sub-1', 'cliente-a', 'Conta@Exemplo.test', array['s'], 'refresh-1', 'acesso-1', now() + interval '1 hour', 'v1') ->> 'connectionId') as conn \gset
select is(
  (select jsonb_build_object('s', google_subject, 'c', oauth_client_id, 'e', google_account_email, 'r', refresh_token_ciphertext)
   from public.calendar_connections where id = (:'conn')::uuid),
  jsonb_build_object('s', 'sub-1', 'c', 'cliente-a', 'e', 'conta@exemplo.test', 'r', 'refresh-1'),
  'conexão nova guarda identidade, cliente e o refresh token'
);
update public.calendar_connections set calendar_id = 'agenda@x', calendar_summary = 'Agenda' where id = (:'conn')::uuid;

select is(
  connect_calendar_identity(:'ws'::uuid, :'dono'::uuid, 'sub-1', 'cliente-a', 'conta@exemplo.test', array['s'], '', 'acesso-2', now() + interval '1 hour', 'v1'),
  jsonb_build_object('connectionId', (:'conn')::uuid, 'refreshKept', true),
  'reautorização da MESMA conta e cliente sem refresh token: mantém o existente'
);
select is(
  (select jsonb_build_object('r', refresh_token_ciphertext, 'a', access_token_ciphertext, 'cal', calendar_id) from public.calendar_connections where id = (:'conn')::uuid),
  jsonb_build_object('r', 'refresh-1', 'a', 'acesso-2', 'cal', 'agenda@x'),
  'o refresh token não foi apagado e a agenda escolhida continua'
);
select throws_ok(format($i$ select connect_calendar_identity(%L::uuid, %L::uuid, 'sub-1', 'cliente-b', 'conta@exemplo.test', array['s'], '', 'a', now(), 'v1') $i$, :'ws', :'dono'),
  'P0001', 'refresh_token_missing', 'outro cliente OAuth sem refresh token: recusado');
select throws_ok(format($i$ select connect_calendar_identity(%L::uuid, %L::uuid, 'sub-1', 'cliente-a', 'conta@exemplo.test', array['s'], '', 'a', now(), 'v2') $i$, :'ws', :'dono'),
  'P0001', 'refresh_token_missing', 'outra versão de chave sem refresh token: recusado');
update public.calendar_connections set status = 'needs_reauth' where id = (:'conn')::uuid;
select throws_ok(format($i$ select connect_calendar_identity(%L::uuid, %L::uuid, 'sub-1', 'cliente-a', 'conta@exemplo.test', array['s'], '', 'a', now(), 'v1') $i$, :'ws', :'dono'),
  'P0001', 'refresh_token_missing', 'conexão a reautorizar sem refresh token novo: recusado');
select is(
  (connect_calendar_identity(:'ws'::uuid, :'dono'::uuid, 'sub-1', 'cliente-a', 'conta@exemplo.test', array['s'], 'refresh-2', 'acesso-3', now(), 'v1') ->> 'refreshKept')::boolean,
  false, 'com refresh token novo, a reautorização volta a ativa'
);

select throws_ok(format($i$ select connect_calendar_identity(%L::uuid, %L::uuid, 'sub-OUTRA', 'cliente-a', 'outra@exemplo.test', array['s'], 'refresh-x', 'a', now(), 'v1') $i$, :'ws', :'dono'),
  'P0001', 'calendar_account_mismatch', 'OUTRA conta sobre a conexão existente: recusada');
select is((select refresh_token_ciphertext from public.calendar_connections where id = (:'conn')::uuid), 'refresh-2',
  'e o token existente ficou intacto (nunca se mistura conta)');

select throws_ok(format($i$ select connect_calendar_identity(%L::uuid, %L::uuid, 'sub-1', 'cliente-a', 'conta@exemplo.test', array['s'], 'r', 'a', now(), 'v1') $i$, :'ws', :'adv'),
  'P0001', 'calendar_account_in_use', 'a mesma conta Google por OUTRA pessoa do workspace: recusada');

select throws_ok(format($i$ select connect_calendar_account(%L::uuid, %L::uuid, 'conta@exemplo.test', array['s'], 'r-velho', 'a', now(), 'v1') $i$, :'ws', :'dono'),
  'P0001', 'identity_connect_required', 'a função antiga nunca sobrescreve conexão já identificada');

select is(
  (select count(*)::int from public.audit_logs
   where workspace_id = :'ws'::uuid and action = 'calendar.connection.connected'
     and metadata::text !~ '(sub-1|conta@|refresh-|acesso-)' and metadata ? 'refresh_kept'),
  3, 'auditoria das conexões sem token, e-mail ou identificador da conta'
);

select * from finish();
rollback;
