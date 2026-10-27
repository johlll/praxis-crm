-- pgTAP — B3.2d-2a: finalização SEM efeito no domínio (ignored/unsupported).
--
-- Prova: `whatsapp_inbox_dispose(inboxId, token, disposição)` só marca a
-- entrada como processed com o token ATUAL e a lease VIGENTE, pelas mesmas
-- regras de complete/fail/release (trava da linha, terminais primeiro,
-- um único clock_timestamp() decide a lease). Grava só um código de
-- disposição de uma lista fechada, nunca conteúdo, e nenhuma auditoria com
-- conteúdo. Repetir devolve already_processed sem mudar nada; a disposição
-- é imutável. Lease vencida, token antigo, inventado, ausente ou de outra
-- entrada (outro workspace ou canal) → claim_lost sem mudar nada. Outro
-- ambiente → not_found. Só service_role executa; a tabela segue sem
-- privilégio direto.
--
-- Uma sessão só: a concorrência REAL está em
-- scripts/b3-2d2a-inbox-dispose-concurrency-check.sh.
--
-- Escrito ANTES da implementação, contra a main 10e617f. Tudo fictício.
-- Leituras e escritas das colunas novas passam por funções que capturam o
-- erro: contra a main, o arquivo roda até o fim.

begin;
select plan(43);

\set ana      '20000000-0000-0000-0000-000000000001'
\set bruno    '20000000-0000-0000-0000-000000000002'
\set ws_um    '10000000-0000-0000-0000-000000000001'
\set ws_dois  '10000000-0000-0000-0000-000000000002'
\set ch_a     '36000000-0000-0000-0000-000000000001'
\set ch_b     '36000000-0000-0000-0000-000000000002'
\set ch_prod  '36000000-0000-0000-0000-000000000003'
\set inventado '7d1e2f3a-4b5c-4d6e-8f70-819a2b3c4d5e'
\set cifra    'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB'
\set corpo1   'Q29ycG8gZmljdGljaW8gMQ=='

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

-- Token de um claim novo, ou o uuid zero se ele falhar.
create function pg_temp.claim_token(p_id uuid) returns uuid language plpgsql as $f$
declare
  v jsonb;
begin
  execute format('select public.whatsapp_inbox_claim(%L::uuid, 60)', p_id) into v;
  return coalesce((v ->> 'claim_token')::uuid, '00000000-0000-0000-0000-000000000000');
exception when others then
  return '00000000-0000-0000-0000-000000000000';
end
$f$;

-- dispose / complete / fail / release: o outcome, ou 'ERRO:<mensagem>'.
create function pg_temp.fin(p_fn text, p_id uuid, p_token uuid, p_code text default null) returns text language plpgsql as $f$
declare
  v jsonb;
begin
  if p_fn = 'complete' then
    execute format('select public.whatsapp_inbox_complete(%L::uuid, %L::uuid)', p_id, p_token) into v;
  elsif p_fn = 'dispose' then
    execute format('select public.whatsapp_inbox_dispose(%L::uuid, %L::uuid, %L)', p_id, p_token, p_code) into v;
  else
    execute format('select public.whatsapp_inbox_%s(%L::uuid, %L::uuid, %L)', p_fn, p_id, p_token, p_code) into v;
  end if;
  return coalesce(v ->> 'outcome', 'NULL');
exception when others then
  return 'ERRO:' || sqlerrm;
end
$f$;

create function pg_temp.dispose_keys(p_id uuid, p_token uuid, p_code text) returns text language plpgsql as $f$
declare
  v jsonb;
begin
  execute format('select public.whatsapp_inbox_dispose(%L::uuid, %L::uuid, %L)', p_id, p_token, p_code) into v;
  return (select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(v) k);
exception when others then
  return 'ERRO:' || sqlerrm;
end
$f$;

create function pg_temp.put(p_channel uuid, p_ws uuid, p_routing text, p_event text) returns uuid language sql as $f$
  select (public.whatsapp_inbox_store(
    p_channel, p_ws, 'simulated', p_routing, p_event, 'other.event', repeat('a', 64), '1',
    'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gMQ==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600
  ) ->> 'inbox_id')::uuid
$f$;

-- Retrato de tudo o que uma finalização poderia mudar numa entrada.
create function pg_temp.snap(p_id uuid) returns text language plpgsql as $f$
declare
  v text;
begin
  execute format($q$select concat_ws('|', state, claim_count, coalesce(claim_token::text, '-'), coalesce(claimed_at::text, '-'),
           coalesce(lease_until::text, '-'), coalesce(processed_at::text, '-'), coalesce(failed_at::text, '-'),
           coalesce(error_code, '-'), coalesce(last_release_code, '-'), coalesce(disposition, '-'))
         from public.whatsapp_webhook_inbox where id = %L::uuid$q$, p_id) into v;
  return coalesce(v, 'NULL');
exception when others then
  return 'ERRO:' || sqlerrm;
end
$f$;

-- state|disposição|processed_at presente|token presente
create function pg_temp.st(p_id uuid) returns text language plpgsql as $f$
declare
  v text;
begin
  execute format($q$select state || '|' || coalesce(disposition, '-') || '|' || (processed_at is not null)::text || '|' || (claim_token is not null)::text
         from public.whatsapp_webhook_inbox where id = %L::uuid$q$, p_id) into v;
  return coalesce(v, 'NULL');
exception when others then
  return 'ERRO:' || sqlerrm;
end
$f$;

create function pg_temp.exec(p_sql text) returns void language plpgsql as $f$
begin
  execute p_sql;
exception when others then
  null;
end
$f$;

-- SQLSTATE de uma escrita direta, ou 'ok'.
create function pg_temp.sqlstate_of(p_sql text) returns text language plpgsql as $f$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ':' || sqlerrm;
end
$f$;

select pg_temp.hdr('preview') as h_prev \gset
select pg_temp.hdr('production') as h_prod \gset

-- ---------------------------------------------------------------------
-- Cenário: dois canais em Preview (dois workspaces) e um em Production.
-- ---------------------------------------------------------------------

set local role service_role;
select set_config('request.jwt.claims', '', true);
select set_config('request.headers', :'h_prev', true);
select whatsapp_create_simulated_channel(:'ch_a'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'A', 'b3d2a-a', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_b'::uuid, :'ws_dois'::uuid, :'bruno'::uuid, 'B', 'b3d2a-b', '1', :'cifra', '1') is not null as ok \gset
select pg_temp.put(:'ch_a', :'ws_um', 'b3d2a-a', 'evt-ok') as e_ok \gset
select pg_temp.put(:'ch_a', :'ws_um', 'b3d2a-a', 'evt-old') as e_old \gset
select pg_temp.put(:'ch_a', :'ws_um', 'b3d2a-a', 'evt-venc') as e_venc \gset
select pg_temp.put(:'ch_a', :'ws_um', 'b3d2a-a', 'evt-fronteira') as e_fr \gset
select pg_temp.put(:'ch_a', :'ws_um', 'b3d2a-a', 'evt-cod') as e_cod \gset
select pg_temp.put(:'ch_a', :'ws_um', 'b3d2a-a', 'evt-falha') as e_falha \gset
select pg_temp.put(:'ch_a', :'ws_um', 'b3d2a-a', 'evt-compl') as e_compl \gset
select pg_temp.put(:'ch_b', :'ws_dois', 'b3d2a-b', 'evt-b') as e_b \gset
select pg_temp.put(:'ch_a', :'ws_um', 'b3d2a-a', 'evt-chk') as e_chk \gset
select pg_temp.claim_token(:'e_chk') as t_chk \gset
select set_config('request.headers', :'h_prod', true);
select whatsapp_create_simulated_channel(:'ch_prod'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Prod', 'b3d2a-prod', '1', :'cifra', '1') is not null as ok \gset
select pg_temp.put(:'ch_prod', :'ws_um', 'b3d2a-prod', 'evt-prod') as e_prod \gset
select pg_temp.claim_token(:'e_prod') as t_prod \gset
select set_config('request.headers', :'h_prev', true);
reset role;

-- ---------------------------------------------------------------------
-- 1) Estrutura: coluna da disposição, lista fechada, imutável
-- ---------------------------------------------------------------------

select is(
  (select coalesce(data_type || '|' || is_nullable, 'ausente') from information_schema.columns
   where table_schema = 'public' and table_name = 'whatsapp_webhook_inbox' and column_name = 'disposition'),
  'text|YES', 'disposition: texto opcional (só entradas finalizadas sem efeito no domínio)'
);
select is(
  pg_temp.sqlstate_of(format($$update public.whatsapp_webhook_inbox set disposition = 'ignored_history' where id = %L::uuid$$, :'e_ok')),
  'P0001:inbox_disposition_immutable', 'a disposição só nasce na transição processing → processed: entrada pendente não recebe'
);
select is(
  left(pg_temp.sqlstate_of(format($$update public.whatsapp_webhook_inbox set state = 'processed', processed_at = now(), claim_token = null, claimed_at = null, lease_until = null,
    disposition = 'Ignorado: +5511999990000' where id = %L::uuid$$, :'e_chk')), 5),
  '23514', 'restrição: a disposição é só um código da lista fechada, nunca texto'
);
select is(
  (select count(*)::int from unnest(array['anon', 'authenticated', 'service_role']) r
   where has_table_privilege(r, 'public.whatsapp_webhook_inbox', 'select')
      or has_table_privilege(r, 'public.whatsapp_webhook_inbox', 'insert')
      or has_table_privilege(r, 'public.whatsapp_webhook_inbox', 'update')
      or has_table_privilege(r, 'public.whatsapp_webhook_inbox', 'delete')),
  0, 'a tabela segue sem privilégio direto, nem para service_role'
);

-- ---------------------------------------------------------------------
-- 2) Função: argumentos exatos, SECURITY DEFINER, só service_role
-- ---------------------------------------------------------------------

select is(
  (select string_agg(p.proname || '(' || array_to_string(p.proargnames, ',') || ')', ' ')
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'whatsapp_inbox_dispose'),
  'whatsapp_inbox_dispose(p_inbox_id,p_claim_token,p_disposition)',
  'dispose recebe só o id da inbox, o token e o código da disposição: nada de workspace, canal, ambiente, provedor ou routing key'
);
select is(
  (select count(*)::int from pg_proc p
   where p.oid = to_regprocedure('public.whatsapp_inbox_dispose(uuid, uuid, text)')
     and has_function_privilege('service_role', p.oid, 'execute')
     and p.prosecdef
     and exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg where cfg like 'search_path=%')),
  1, 'dispose: service_role, SECURITY DEFINER, search_path travado'
);
select is(
  (select count(*)::int from pg_proc p
   where p.oid = to_regprocedure('public.whatsapp_inbox_dispose(uuid, uuid, text)')
     and (has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute')
          or has_function_privilege('public', p.oid, 'execute'))),
  0, 'dispose não é executável por PUBLIC, anon ou authenticated'
);

-- ---------------------------------------------------------------------
-- 3) Token atual + lease vigente: processed com a disposição, uma vez só
-- ---------------------------------------------------------------------

set local role service_role;
select pg_temp.claim_token(:'e_ok') as t_ok \gset
select is(pg_temp.fin('dispose', :'e_ok', :'t_ok', 'Evento ignorado +5511999990000'), 'ERRO:invalid_disposition', 'disposição com texto bruto: recusa sem repetir o texto');
select is(
  pg_temp.fin('dispose', :'e_ok', :'t_ok', 'domain_effect_not_implemented') || ' ' || pg_temp.fin('dispose', :'e_ok', :'t_ok', '') || ' ' || pg_temp.fin('dispose', :'e_ok', :'t_ok', null),
  'ERRO:invalid_disposition ERRO:invalid_disposition ERRO:invalid_disposition', 'disposição fora da lista fechada, vazia ou ausente: recusa'
);
reset role;
select is(pg_temp.st(:'e_ok'), 'processing|-|false|true', 'as recusas não mexeram na entrada');
set local role service_role;
select is(pg_temp.fin('dispose', :'e_ok', :'t_ok', 'ignored_history'), 'completed', 'token atual e lease vigente: completed');
reset role;
select is(pg_temp.st(:'e_ok'), 'processed|ignored_history|true|false', 'processed com a disposição e o horário; token e lease limpos');
select pg_temp.snap(:'e_ok') as s_ok \gset
set local role service_role;
select is(
  pg_temp.fin('dispose', :'e_ok', :'t_ok', 'ignored_history') || ' ' || pg_temp.fin('dispose', :'e_ok', :'t_ok', 'unsupported_event'),
  'already_processed already_processed', 'repetir (mesma ou outra disposição): already_processed'
);
select is(
  pg_temp.fin('complete', :'e_ok', :'t_ok') || ' ' || pg_temp.fin('fail', :'e_ok', :'t_ok', 'qualquer_codigo') || ' ' || pg_temp.fin('release', :'e_ok', :'t_ok', 'qualquer_codigo'),
  'already_processed already_processed already_processed', 'depois da disposição, nada mais finaliza a entrada'
);
reset role;
select is(pg_temp.snap(:'e_ok'), :'s_ok', 'a repetição não mudou nada: a disposição e o horário são os da primeira vez');
select is(
  pg_temp.sqlstate_of(format($$update public.whatsapp_webhook_inbox set disposition = 'unsupported_event' where id = %L::uuid$$, :'e_ok'))
    || ' ' || pg_temp.sqlstate_of(format($$update public.whatsapp_webhook_inbox set disposition = null where id = %L::uuid$$, :'e_ok')),
  'P0001:inbox_disposition_immutable P0001:inbox_disposition_immutable', 'a disposição é imutável (nem troca nem apaga), nem por escrita direta'
);
set local role service_role;
select is(pg_temp.dispose_keys(:'e_ok', :'t_ok', 'ignored_history'), 'outcome', 'dispose devolve só o resultado');

select pg_temp.claim_token(:'e_cod') as t_cod \gset
select is(
  pg_temp.fin('dispose', :'e_cod', :'t_cod', 'ignored_group_message'),
  'completed', 'ignored_group_message aceito'
);
select pg_temp.claim_token(:'e_compl') as t_compl \gset
select is(pg_temp.fin('complete', :'e_compl', :'t_compl'), 'completed', 'complete continua sem disposição');
reset role;
select is(
  pg_temp.st(:'e_cod') || ' ' || pg_temp.st(:'e_compl'),
  'processed|ignored_group_message|true|false processed|-|true|false', 'cada disposição gravada como pedida; complete deixa a disposição vazia'
);
select is(
  (select count(*)::int from public.audit_logs where resource_id in (:'e_ok'::uuid, :'e_cod'::uuid)),
  0, 'a disposição não gera auditoria (nenhum conteúdo, telefone ou routing key sai da inbox)'
);
set local role service_role;

-- ---------------------------------------------------------------------
-- 4) Token errado: antigo, inventado, ausente, de outra entrada (outro
--    workspace e canal) → claim_lost, sem mudar nada
-- ---------------------------------------------------------------------

select pg_temp.claim_token(:'e_old') as t_old1 \gset
reset role;
select pg_temp.exec(format($$update public.whatsapp_webhook_inbox set claimed_at = clock_timestamp() - interval '2 minutes', lease_until = clock_timestamp() - interval '1 second' where id = %L::uuid$$, :'e_old'));
set local role service_role;
select pg_temp.claim_token(:'e_old') as t_old2 \gset
select pg_temp.claim_token(:'e_b') as t_b \gset
reset role;
select pg_temp.snap(:'e_old') as s_old \gset
select pg_temp.snap(:'e_b') as s_b \gset
set local role service_role;
select is(pg_temp.fin('dispose', :'e_old', :'t_old1', 'unsupported_event'), 'claim_lost', 'token substituído por um novo claim: claim_lost');
select is(
  pg_temp.fin('dispose', :'e_old', :'inventado', 'unsupported_event') || ' ' || pg_temp.fin('dispose', :'e_old', null, 'unsupported_event'),
  'claim_lost claim_lost', 'token inventado ou ausente: claim_lost'
);
select is(
  pg_temp.fin('dispose', :'e_b', :'t_old2', 'unsupported_event') || ' ' || pg_temp.fin('dispose', :'e_old', :'t_b', 'unsupported_event'),
  'claim_lost claim_lost', 'token de outra entrada, de outro workspace e canal: claim_lost nos dois sentidos'
);
reset role;
select is(pg_temp.snap(:'e_old') || ' ' || pg_temp.snap(:'e_b'), :'s_old' || ' ' || :'s_b', 'tokens errados não mudaram nenhuma das duas entradas');
set local role service_role;
select is(pg_temp.fin('dispose', :'e_old', :'t_old2', 'unsupported_event'), 'completed', 'só o token atual finaliza');
select is(pg_temp.fin('dispose', :'e_old', :'t_old1', 'unsupported_event'), 'already_processed', 'o token antigo, depois, só vê already_processed');

-- ---------------------------------------------------------------------
-- 5) Lease vencida sem novo claim: claim_lost, nada muda; fronteira
-- ---------------------------------------------------------------------

select pg_temp.claim_token(:'e_venc') as t_venc \gset
select pg_temp.claim_token(:'e_fr') as t_fr \gset
reset role;
select pg_temp.exec(format($$update public.whatsapp_webhook_inbox set claimed_at = clock_timestamp() - interval '2 minutes', lease_until = clock_timestamp() - interval '1 second' where id = %L::uuid$$, :'e_venc'));
select pg_temp.exec(format($$update public.whatsapp_webhook_inbox set claimed_at = clock_timestamp() - interval '2 minutes', lease_until = clock_timestamp() where id = %L::uuid$$, :'e_fr'));
select pg_temp.snap(:'e_venc') as s_venc \gset
select pg_temp.snap(:'e_fr') as s_fr \gset
set local role service_role;
select is(pg_temp.fin('dispose', :'e_venc', :'t_venc', 'unsupported_event'), 'claim_lost', 'lease vencida, sem novo claim: dispose com o token atual é claim_lost');
select is(pg_temp.fin('dispose', :'e_fr', :'t_fr', 'unsupported_event'), 'claim_lost', 'lease terminando no instante atual já conta como vencida');
reset role;
select is(pg_temp.snap(:'e_venc') || ' ' || pg_temp.snap(:'e_fr'), :'s_venc' || ' ' || :'s_fr', 'lease vencida: estado, token, horários e disposição intactos');
set local role service_role;
select pg_temp.claim_token(:'e_venc') as t_venc2 \gset
select is(
  (:'t_venc2' <> :'t_venc')::text || ' ' || pg_temp.fin('dispose', :'e_venc', :'t_venc2', 'unsupported_event'),
  'true completed', 'só um novo claim devolve um dono; o token novo finaliza'
);

-- ---------------------------------------------------------------------
-- 6) Terminais, outro ambiente e entrada inexistente
-- ---------------------------------------------------------------------

select pg_temp.claim_token(:'e_falha') as t_falha \gset
select is(pg_temp.fin('fail', :'e_falha', :'t_falha', 'payload_invalid'), 'failed', 'preparo: falha terminal');
select is(pg_temp.fin('dispose', :'e_falha', :'t_falha', 'unsupported_event'), 'terminal_failed', 'falha terminal não vira processed por disposição');
reset role;
select is(pg_temp.st(:'e_falha'), 'failed|-|false|false', 'a falha terminal segue sem disposição');
set local role service_role;
select is(pg_temp.fin('dispose', :'e_prod', :'t_prod', 'unsupported_event'), 'not_found', 'entrada de Production com ambiente Preview: not_found, mesmo com o token certo');
select set_config('request.headers', :'h_prod', true);
select is(pg_temp.fin('dispose', :'e_b', :'t_b', 'unsupported_event'), 'not_found', 'entrada de Preview com ambiente Production: not_found');
select is(pg_temp.fin('dispose', :'e_prod', :'t_prod', 'ignored_non_whatsapp_product'), 'completed', 'Production finaliza a própria entrada');
select set_config('request.headers', :'h_prev', true);
select is(pg_temp.fin('dispose', :'inventado', :'t_b', 'unsupported_event'), 'not_found', 'entrada inexistente: not_found');
select set_config('request.headers', '', true);
select alike(pg_temp.fin('dispose', :'e_b', :'t_b', 'unsupported_event'), 'ERRO:whatsapp_environment_required%', 'sem ambiente assinado: recusa');
select set_config('request.headers', :'h_prev', true);
reset role;
select is(pg_temp.snap(:'e_b'), :'s_b', 'as recusas de ambiente não mudaram a entrada de Preview');

-- ---------------------------------------------------------------------
-- 7) authenticated e anon não finalizam nada
-- ---------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select is((pg_temp.fin('dispose', :'e_b', :'t_b', 'unsupported_event') like 'ERRO:%')::text, 'true', 'authenticated não executa dispose');
reset role;
set local role anon;
select is((pg_temp.fin('dispose', :'e_b', :'t_b', 'unsupported_event') like 'ERRO:%')::text, 'true', 'anon não executa dispose');
reset role;
select is(pg_temp.snap(:'e_b'), :'s_b', 'as tentativas sem service_role não mudaram nada');

select * from finish();
rollback;
