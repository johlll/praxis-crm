-- pgTAP — B3.2c (revisão da PR #70): localizador público OPACO do canal.
--
-- Prova: `whatsapp_channels.webhook_route_id` é um UUID aleatório próprio
-- do canal (não é o id do canal), obrigatório, único e imutável; a
-- resolução `whatsapp_resolve_webhook_route(provedor, webhook_route_id)`
-- exige o ambiente assinado do WhatsApp, devolve internamente o canal e a
-- routing key real, nunca credencial ou segredo; canal desativado, de outro
-- ambiente, de outro provedor ou inexistente não é encontrado; o id do
-- canal não localiza nada; só service_role executa.
--
-- Escrito ANTES da implementação, contra o HEAD 68c5f47. Nenhum dado real.

begin;
select plan(26);

\set ana      '20000000-0000-0000-0000-000000000001'
\set ws_um    '10000000-0000-0000-0000-000000000001'
\set ch_ativo '35000000-0000-0000-0000-000000000001'
\set ch_pausa '35000000-0000-0000-0000-000000000002'
\set ch_desc  '35000000-0000-0000-0000-000000000003'
\set ch_off   '35000000-0000-0000-0000-000000000004'
\set ch_prod  '35000000-0000-0000-0000-000000000005'
\set cifra    'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB'

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

-- Resultado de uma consulta como texto, ou 'ERRO:<mensagem>'. Mantém a
-- transação utilizável e a contagem estável contra o HEAD sem a coluna.
create function pg_temp.run(p_sql text) returns text language plpgsql as $f$
declare
  v text;
begin
  execute p_sql into v;
  return coalesce(v, 'NULL');
exception when others then
  return 'ERRO:' || sqlerrm;
end
$f$;

select pg_temp.hdr('preview') as h_prev \gset
select pg_temp.hdr('production') as h_prod \gset

-- Cenário: em Preview, canais ativo, pausado, desconectado e desativado; em
-- Production, um canal.
set local role service_role;
select set_config('request.jwt.claims', '', true);
select set_config('request.headers', :'h_prev', true);
select whatsapp_create_simulated_channel(:'ch_ativo'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Ativo', 'b3r-ativo', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_pausa'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Pausa', 'b3r-pausa', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_desc'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Desc', 'b3r-desc', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_off'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Off', 'b3r-off', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_pause_channel(:'ch_pausa'::uuid, :'ws_um'::uuid, :'ana'::uuid) is not null as ok \gset
select set_config('request.headers', :'h_prod', true);
select whatsapp_create_simulated_channel(:'ch_prod'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Prod', 'b3r-prod', '1', :'cifra', '1') is not null as ok \gset
reset role;
update public.whatsapp_channels set status = 'disconnected', send_enabled = false where id = :'ch_desc'::uuid;
update public.whatsapp_channels set status = 'disabled', send_enabled = false where id = :'ch_off'::uuid;

select pg_temp.run(format($$select webhook_route_id::text from public.whatsapp_channels where id = %L::uuid$$, :'ch_ativo')) as r_ativo \gset
select pg_temp.run(format($$select webhook_route_id::text from public.whatsapp_channels where id = %L::uuid$$, :'ch_pausa')) as r_pausa \gset
select pg_temp.run(format($$select webhook_route_id::text from public.whatsapp_channels where id = %L::uuid$$, :'ch_desc')) as r_desc \gset
select pg_temp.run(format($$select webhook_route_id::text from public.whatsapp_channels where id = %L::uuid$$, :'ch_off')) as r_off \gset
select pg_temp.run(format($$select webhook_route_id::text from public.whatsapp_channels where id = %L::uuid$$, :'ch_prod')) as r_prod \gset

-- Resolução como texto: canal|workspace|ambiente|provedor|routing key|estado.
create function pg_temp.route(p_provider text, p_route text) returns text language sql as $f$
  select pg_temp.run(format(
    $q$select coalesce(string_agg(channel_id || '|' || workspace_id || '|' || environment || '|' || provider || '|' || routing_key || '|' || status, ';'), 'VAZIO')
       from public.whatsapp_resolve_webhook_route(%L::public.whatsapp_provider, %L::uuid)$q$,
    p_provider, p_route))
$f$;

-- ---------------------------------------------------------------------
-- 1) Coluna: UUID obrigatório, único, aleatório, imutável
-- ---------------------------------------------------------------------

select is(
  (select data_type || '|' || is_nullable from information_schema.columns
   where table_schema = 'public' and table_name = 'whatsapp_channels' and column_name = 'webhook_route_id'),
  'uuid|NO', 'webhook_route_id existe, é uuid e é obrigatório'
);
select is(
  (select count(*)::int from pg_index i
   where i.indrelid = 'public.whatsapp_channels'::regclass and i.indisunique and i.indnatts = 1
     and (select a.attname from pg_attribute a where a.attrelid = i.indrelid and a.attnum = i.indkey[0]) = 'webhook_route_id'),
  1, 'webhook_route_id é único'
);
select is(
  pg_temp.run($$select count(*)::text from public.whatsapp_channels where webhook_route_id is null$$),
  '0', 'nenhum canal (inclusive os já existentes) fica sem localizador'
);
select is(
  pg_temp.run(format($$select (webhook_route_id <> id)::text from public.whatsapp_channels where id = %L::uuid$$, :'ch_ativo')),
  'true', 'o localizador não é o id do canal'
);
select is(
  pg_temp.run($$select count(distinct webhook_route_id)::text from public.whatsapp_channels where id::text like '35000000-%'$$),
  '5', 'cada canal tem o seu localizador'
);
select is(
  pg_temp.run(format($$select (webhook_route_id::text !~ 'b3r') ::text from public.whatsapp_channels where id = %L::uuid$$, :'ch_ativo')),
  'true', 'o localizador não contém a routing key'
);
select is(
  pg_temp.run(format($$select substr(webhook_route_id::text, 15, 1) from public.whatsapp_channels where id = %L::uuid$$, :'ch_ativo')),
  '4', 'o localizador é um UUID aleatório (versão 4)'
);
select throws_ok(
  format($$update public.whatsapp_channels set webhook_route_id = gen_random_uuid() where id = %L::uuid$$, :'ch_ativo'),
  'P0001', 'channel_identity_immutable', 'o localizador não muda depois de criado (a URL cadastrada no provedor fica estável)'
);

-- ---------------------------------------------------------------------
-- 2) Função: só service_role, sem segredo no retorno
-- ---------------------------------------------------------------------

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'whatsapp_resolve_webhook_route'
     and has_function_privilege('service_role', p.oid, 'execute') and p.prosecdef
     and exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg where cfg like 'search_path=%')),
  1, 'whatsapp_resolve_webhook_route: service_role, SECURITY DEFINER, search_path travado'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'whatsapp_resolve_webhook_route'
     and (has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute')
          or has_function_privilege('public', p.oid, 'execute'))),
  0, 'nem PUBLIC, nem anon, nem authenticated executam a resolução'
);
select is(
  (select string_agg(a, ',' order by a) from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
     unnest(p.proargnames) a
   where n.nspname = 'public' and p.proname = 'whatsapp_resolve_webhook_route'),
  'channel_id,environment,p_provider,p_webhook_route_id,provider,routing_key,status,workspace_id',
  'argumentos (provedor, localizador) e retorno sem credencial, texto cifrado, versão de chave ou segredo'
);

-- ---------------------------------------------------------------------
-- 3) Resolução pelo localizador opaco
-- ---------------------------------------------------------------------

set local role service_role;
select set_config('request.headers', '', true);
select alike(pg_temp.route('simulated', :'r_ativo'), 'ERRO:whatsapp_environment_required%', 'sem ambiente assinado: recusa');

select set_config('request.headers', :'h_prev', true);
select is(
  pg_temp.route('simulated', :'r_ativo'),
  :'ch_ativo' || '|' || :'ws_um' || '|preview|simulated|b3r-ativo|active',
  'canal ativo: devolve canal, workspace, ambiente, provedor, routing key real e estado'
);
select is(pg_temp.route('simulated', :'r_pausa'), :'ch_pausa' || '|' || :'ws_um' || '|preview|simulated|b3r-pausa|paused', 'canal pausado: encontrado, com o estado');
select is(pg_temp.route('simulated', :'r_desc'), :'ch_desc' || '|' || :'ws_um' || '|preview|simulated|b3r-desc|disconnected', 'canal desconectado: encontrado, com o estado');
select is(pg_temp.route('simulated', :'r_off'), 'VAZIO', 'canal desativado: não encontrado');
select is(pg_temp.route('simulated', '36000000-0000-4000-8000-000000000000'), 'VAZIO', 'localizador inexistente: não encontrado');
select is(pg_temp.route('ycloud', :'r_ativo'), 'VAZIO', 'provedor divergente: não encontrado');
select is(pg_temp.route('simulated', :'ch_ativo'), 'VAZIO', 'o id do canal não serve de localizador');
select is(pg_temp.route('simulated', :'r_prod'), 'VAZIO', 'localizador de Production com ambiente Preview: não encontrado');
select is(pg_temp.route('simulated', null), 'VAZIO', 'localizador nulo: não encontrado');

select set_config('request.headers', :'h_prod', true);
select is(pg_temp.route('simulated', :'r_ativo'), 'VAZIO', 'localizador de Preview com ambiente Production: não encontrado');
select is(pg_temp.route('simulated', :'r_prod'), :'ch_prod' || '|' || :'ws_um' || '|production|simulated|b3r-prod|active', 'Production encontra o próprio canal');
reset role;

-- ---------------------------------------------------------------------
-- 4) authenticated e anon não alcançam
-- ---------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select set_config('request.headers', :'h_prev', true);
select alike(pg_temp.route('simulated', :'r_ativo'), 'ERRO:%', 'authenticated não resolve');
select is(
  pg_temp.run(format($$select count(*)::text from public.whatsapp_channels where id = %L::uuid$$, :'ch_ativo')),
  '0', 'authenticated não lê o canal da B3 (nem o localizador) por SELECT direto'
);
reset role;

set local role anon;
select alike(pg_temp.route('simulated', :'r_ativo'), 'ERRO:%', 'anon não resolve');
reset role;

select * from finish();
rollback;
