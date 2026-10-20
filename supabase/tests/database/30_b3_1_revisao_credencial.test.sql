-- pgTAP — B3.1, revisão da PR #42, ponto 1: leitura de credencial com
-- contexto confiável do canal, e resolução própria do webhook.
--
-- Prova: a leitura antiga "só UUID + propósito" não existe mais; a leitura
-- exige canal, workspace, provedor e routing key, todos conferidos contra a
-- linha do canal no ambiente autenticado; canal de outro workspace no
-- MESMO ambiente, provedor ou routing key divergentes, outro ambiente e o
-- canal legado da A7 são recusados. O webhook resolve canal + segredo do
-- webhook numa consulta, por (provedor, routing key), só no ambiente
-- autenticado, nunca devolve a chave de API e ignora canal desativado.
-- Escrito ANTES da correção, contra o HEAD 3bdb181. Nenhuma chave real.

begin;
select plan(36);

\set ana      '20000000-0000-0000-0000-000000000001'
\set bruno    '20000000-0000-0000-0000-000000000002'
\set ws_um    '10000000-0000-0000-0000-000000000001'
\set ws_dois  '10000000-0000-0000-0000-000000000002'
\set ch_um    '32000000-0000-0000-0000-000000000001'
\set ch_dois  '32000000-0000-0000-0000-000000000002'
\set ch_prod  '32000000-0000-0000-0000-000000000003'
\set ch_yc    '32000000-0000-0000-0000-000000000004'
\set ch_off   '32000000-0000-0000-0000-000000000005'
\set ch_a7    '32000000-0000-0000-0000-000000000006'
\set cifra    'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB'

select repeat('QkJC', 14) as cifra_api \gset
select repeat('Q0ND', 14) as cifra_wh \gset

insert into public.whatsapp_environment_keys (environment, signing_key) values
  ('production', 'chave-whatsapp-producao-de-teste-0123456789'),
  ('preview', 'chave-whatsapp-preview-de-teste-0123456789ab');

create function pg_temp.hdr(p_env text) returns text language sql as $f$
  select json_build_object(
    'x-praxis-whatsapp-env',
    'v1.' || p_env || '.' || e.x || '.' || private.whatsapp_environment_signature(
      p_env, e.x, (select signing_key from public.whatsapp_environment_keys where environment = p_env::public.whatsapp_environment)
    )
  )::text
  from (select extract(epoch from now())::bigint + 300 as x) e
$f$;

-- Executa uma consulta e devolve quantas linhas ela traz, ou -1 se ela
-- falhar (função inexistente, recusa). Mantém a transação utilizável e a
-- contagem de testes estável, inclusive contra o HEAD antigo.
create function pg_temp.try_count(p_sql text) returns int language plpgsql as $f$
declare
  n int;
begin
  execute 'select count(*)::int from (' || p_sql || ') q' into n;
  return n;
exception when others then
  return -1;
end
$f$;

-- Primeira coluna da primeira linha como texto, ou 'ERRO' se falhar.
create function pg_temp.try_text(p_sql text) returns text language plpgsql as $f$
declare
  v text;
begin
  execute p_sql into v;
  return v;
exception when others then
  return 'ERRO';
end
$f$;

select pg_temp.hdr('preview') as h_prev \gset
select pg_temp.hdr('production') as h_prod \gset

-- ---------------------------------------------------------------------
-- Cenário: dois workspaces no mesmo ambiente (Preview), um canal em
-- Production, um canal YCloud com chave de API e segredo de webhook, um
-- canal desativado e um canal legado da A7.
-- ---------------------------------------------------------------------

set local role service_role;
select set_config('request.jwt.claims', '', true);
select set_config('request.headers', :'h_prev', true);
select whatsapp_create_simulated_channel(:'ch_um'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Um', 'b3r-um', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_dois'::uuid, :'ws_dois'::uuid, :'bruno'::uuid, 'Dois', 'b3r-dois', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_off'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Off', 'b3r-off', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_pause_channel(:'ch_dois'::uuid, :'ws_dois'::uuid, :'bruno'::uuid) is not null as ok \gset
select set_config('request.headers', :'h_prod', true);
select whatsapp_create_simulated_channel(:'ch_prod'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Prod', 'b3r-prod', '1', :'cifra', '1') is not null as ok \gset
reset role;

insert into public.whatsapp_channels (id, workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment, routing_key)
values (:'ch_yc'::uuid, :'ws_um'::uuid, 'YCloud', '1', :'ana'::uuid, 'ycloud', false, 'preview', 'b3r-yc');
insert into public.whatsapp_channel_credentials (channel_id, workspace_id, environment, provider, purpose, ciphertext, key_version) values
  (:'ch_yc'::uuid, :'ws_um'::uuid, 'preview', 'ycloud', 'api_key', :'cifra_api', '1'),
  (:'ch_yc'::uuid, :'ws_um'::uuid, 'preview', 'ycloud', 'webhook_secret', :'cifra_wh', '1');
update public.whatsapp_channels set status = 'disabled' where id = :'ch_off'::uuid;
insert into public.whatsapp_channels (id, workspace_id, label, phone_number_id, display_phone_number, created_by)
values (:'ch_a7'::uuid, :'ws_um'::uuid, 'A7', 'b3r-legado', '1', :'ana'::uuid);

-- ---------------------------------------------------------------------
-- 1) Estrutura e privilégios
-- ---------------------------------------------------------------------

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'whatsapp_get_channel_credential' and p.pronargs = 2),
  0, 'a leitura "só UUID + propósito" não existe mais'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'whatsapp_get_channel_credential'
     and p.proargnames[1:5] = array['p_channel_id', 'p_workspace_id', 'p_provider', 'p_routing_key', 'p_purpose']),
  1, 'a leitura exige canal, workspace, provedor, routing key e propósito'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'whatsapp_resolve_webhook_channel'
     and p.proargnames[1:2] = array['p_provider', 'p_routing_key'] and p.pronargs = 2),
  1, 'o webhook tem resolução própria por (provedor, routing key)'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('whatsapp_get_channel_credential', 'whatsapp_resolve_webhook_channel')
     and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
  0, 'nenhuma das duas é executável por anon ou authenticated'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('whatsapp_get_channel_credential', 'whatsapp_resolve_webhook_channel')
     and has_function_privilege('service_role', p.oid, 'execute')
     and p.prosecdef
     and exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg where cfg like 'search_path=%')),
  2, 'as duas: service_role, SECURITY DEFINER e search_path travado'
);

-- ---------------------------------------------------------------------
-- 2) Leitura com contexto confiável (Preview)
-- ---------------------------------------------------------------------

set local role service_role;
select set_config('request.headers', :'h_prev', true);

select is(
  pg_temp.try_count(format($q$ select * from public.whatsapp_get_channel_credential(%L::uuid, %L::uuid, 'simulated', 'b3r-um', 'webhook_secret') $q$, :'ch_um', :'ws_um')),
  1, 'contexto completo e coerente: lê a credencial'
);
select is(
  pg_temp.try_text(format($q$ select workspace_id::text || '|' || channel_id::text || '|' || routing_key
     from public.whatsapp_get_channel_credential(%L::uuid, %L::uuid, 'simulated', 'b3r-um', 'webhook_secret') $q$, :'ch_um', :'ws_um')),
  :'ws_um' || '|' || :'ch_um' || '|b3r-um',
  'a linha devolvida é do workspace, canal e routing key pedidos'
);
select throws_ok(
  format($q$ select * from public.whatsapp_get_channel_credential(%L::uuid, %L::uuid, 'simulated', 'b3r-dois', 'webhook_secret') $q$, :'ch_dois', :'ws_um'),
  'P0001', 'channel_not_found', 'UUID de canal de OUTRO workspace no mesmo ambiente: recusado'
);
select throws_ok(
  format($q$ select * from public.whatsapp_get_channel_credential(%L::uuid, %L::uuid, 'simulated', 'b3r-um', 'webhook_secret') $q$, :'ch_dois', :'ws_dois'),
  'P0001', 'channel_not_found', 'canal certo do outro workspace, routing key de outro canal: recusado'
);
select throws_ok(
  format($q$ select * from public.whatsapp_get_channel_credential(%L::uuid, %L::uuid, 'ycloud', 'b3r-um', 'webhook_secret') $q$, :'ch_um', :'ws_um'),
  'P0001', 'channel_not_found', 'provedor divergente (canal simulado lido como YCloud): recusado'
);
select throws_ok(
  format($q$ select * from public.whatsapp_get_channel_credential(%L::uuid, %L::uuid, 'simulated', 'b3r-yc', 'api_key') $q$, :'ch_yc', :'ws_um'),
  'P0001', 'channel_not_found', 'provedor divergente (canal YCloud lido como simulado): recusado'
);
select throws_ok(
  format($q$ select * from public.whatsapp_get_channel_credential(%L::uuid, %L::uuid, 'simulated', 'b3r-outra', 'webhook_secret') $q$, :'ch_um', :'ws_um'),
  'P0001', 'channel_not_found', 'routing key divergente: recusada'
);
select throws_ok(
  format($q$ select * from public.whatsapp_get_channel_credential(%L::uuid, null, 'simulated', 'b3r-um', 'webhook_secret') $q$, :'ch_um'),
  'P0001', 'channel_not_found', 'sem workspace: recusado'
);
select throws_ok(
  format($q$ select * from public.whatsapp_get_channel_credential(%L::uuid, %L::uuid, 'simulated', 'b3r-legado', 'webhook_secret') $q$, :'ch_a7', :'ws_um'),
  'P0001', 'channel_not_found', 'canal legado da A7: recusado'
);
select is(
  pg_temp.try_text(format($q$ select purpose::text || '|' || ciphertext
     from public.whatsapp_get_channel_credential(%L::uuid, %L::uuid, 'ycloud', 'b3r-yc', 'api_key') $q$, :'ch_yc', :'ws_um')),
  'api_key|' || :'cifra_api',
  'canal YCloud com contexto coerente: lê só o propósito pedido'
);

select set_config('request.headers', :'h_prod', true);
select throws_ok(
  format($q$ select * from public.whatsapp_get_channel_credential(%L::uuid, %L::uuid, 'simulated', 'b3r-um', 'webhook_secret') $q$, :'ch_um', :'ws_um'),
  'P0001', 'channel_not_found', 'Production não lê credencial de canal de Preview'
);
select is(
  pg_temp.try_count(format($q$ select * from public.whatsapp_get_channel_credential(%L::uuid, %L::uuid, 'simulated', 'b3r-prod', 'webhook_secret') $q$, :'ch_prod', :'ws_um')),
  1, 'Production lê o próprio canal'
);

select set_config('request.headers', '{}', true);
select throws_ok(
  format($q$ select * from public.whatsapp_get_channel_credential(%L::uuid, %L::uuid, 'simulated', 'b3r-um', 'webhook_secret') $q$, :'ch_um', :'ws_um'),
  'P0001', 'whatsapp_environment_required', 'sem ambiente autenticado: recusado'
);

-- ---------------------------------------------------------------------
-- 3) Webhook: canal + segredo do webhook por (provedor, routing key)
-- ---------------------------------------------------------------------

select set_config('request.headers', :'h_prev', true);

select is(
  pg_temp.try_count($q$ select * from public.whatsapp_resolve_webhook_channel('simulated', 'b3r-um') $q$),
  1, 'webhook resolve o canal pela routing key'
);
select is(
  pg_temp.try_text($q$ select workspace_id::text || '|' || channel_id::text || '|' || environment::text || '|' || provider::text || '|' || routing_key
     from public.whatsapp_resolve_webhook_channel('simulated', 'b3r-um') $q$),
  :'ws_um' || '|' || :'ch_um' || '|preview|simulated|b3r-um',
  'a resolução devolve o contexto completo do canal'
);
select is(
  pg_temp.try_count($q$ select * from public.whatsapp_resolve_webhook_channel('ycloud', 'b3r-yc') $q$),
  1, 'canal com chave de API e segredo de webhook: uma linha só'
);
select is(
  pg_temp.try_text($q$ select ciphertext from public.whatsapp_resolve_webhook_channel('ycloud', 'b3r-yc') $q$),
  :'cifra_wh',
  'o webhook recebe só o segredo do webhook, nunca a chave de API'
);
select is(
  pg_temp.try_count($q$ select * from public.whatsapp_resolve_webhook_channel('ycloud', 'b3r-um') $q$),
  0, 'provedor divergente: nada'
);
select is(
  pg_temp.try_count($q$ select * from public.whatsapp_resolve_webhook_channel('simulated', 'b3r-yc') $q$),
  0, 'routing key de canal de outro provedor: nada'
);
select is(
  pg_temp.try_count($q$ select * from public.whatsapp_resolve_webhook_channel('simulated', 'b3r-prod') $q$),
  0, 'Preview não resolve canal de Production'
);
select is(
  pg_temp.try_count($q$ select * from public.whatsapp_resolve_webhook_channel('simulated', 'b3r-legado') $q$),
  0, 'canal legado da A7: nada'
);
select is(
  pg_temp.try_count($q$ select * from public.whatsapp_resolve_webhook_channel('simulated', 'b3r-off') $q$),
  0, 'canal desativado: nada'
);
select is(
  pg_temp.try_text($q$ select status from public.whatsapp_resolve_webhook_channel('simulated', 'b3r-dois') $q$),
  'paused', 'canal pausado continua resolvido, com o estado para quem decide'
);
select is(
  pg_temp.try_count($q$ select * from public.whatsapp_resolve_webhook_channel('simulated', null) $q$),
  0, 'sem routing key: nada'
);

select set_config('request.headers', :'h_prod', true);
select is(
  pg_temp.try_count($q$ select * from public.whatsapp_resolve_webhook_channel('simulated', 'b3r-prod') $q$),
  1, 'Production resolve o próprio canal'
);
select is(
  pg_temp.try_count($q$ select * from public.whatsapp_resolve_webhook_channel('simulated', 'b3r-um') $q$),
  0, 'Production não resolve canal de Preview'
);

select set_config('request.headers', '{}', true);
select throws_ok(
  $q$ select * from public.whatsapp_resolve_webhook_channel('simulated', 'b3r-um') $q$,
  'P0001', 'whatsapp_environment_required', 'webhook sem ambiente autenticado: recusado'
);
reset role;

-- ---------------------------------------------------------------------
-- 4) anon e authenticated não alcançam nenhuma das duas
-- ---------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select set_config('request.headers', :'h_prev', true);
select is(
  pg_temp.try_count(format($q$ select * from public.whatsapp_get_channel_credential(%L::uuid, %L::uuid, 'simulated', 'b3r-um', 'webhook_secret') $q$, :'ch_um', :'ws_um')),
  -1, 'owner autenticado não lê credencial nem com contexto e cabeçalho válidos'
);
select is(
  pg_temp.try_count($q$ select * from public.whatsapp_resolve_webhook_channel('simulated', 'b3r-um') $q$),
  -1, 'owner autenticado não chama a resolução do webhook'
);
reset role;
select set_config('request.jwt.claims', '', true);

set local role anon;
select is(
  pg_temp.try_count($q$ select * from public.whatsapp_resolve_webhook_channel('simulated', 'b3r-um') $q$),
  -1, 'anon não chama a resolução do webhook'
);
reset role;

-- ---------------------------------------------------------------------
-- 5) Nada de segredo na auditoria
-- ---------------------------------------------------------------------

select ok(
  not exists (
    select 1 from public.audit_logs
    where action like 'whatsapp.%'
      and (position(:'cifra' in metadata::text) > 0 or position(:'cifra_api' in metadata::text) > 0
           or position(:'cifra_wh' in metadata::text) > 0)
  ),
  'auditoria nunca leva texto cifrado'
);

select * from finish();
rollback;
