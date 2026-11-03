-- pgTAP — B3.2e: reserva atômica da republicação da inbox do WhatsApp.
--
-- O reconciliador não processa conteúdo nem chama efeitos: encontra entradas
-- elegíveis, reserva cada uma com um token próprio, republica o mesmo evento
-- interno e registra só o resultado técnico. Aqui, o lado do banco:
--  - elegibilidade (pending, processing com lease vencida; nunca processed,
--    failed, expurgada, retenção vencida, lease vigente, outro ambiente,
--    reservada por outro);
--  - reserva: token, horário, vencimento, contador; só devolve inbox_id e o
--    token; expira; token antigo nunca confirma nem libera a reserva nova;
--  - confirmação e falha: não mudam o state nem o claim;
--  - canal não ativo: nunca tentada passa; channel_* espera mudança real;
--  - backoff limitado (1, 5, 15, 60 minutos, teto de 6 horas), sem virar failed;
--  - batimento técnico sem dado pessoal, sem texto livre.
--
-- Escrito ANTES da implementação, contra a main ea1fafd. Tudo fictício. As
-- chamadas passam por funções que capturam o erro: o arquivo roda até o fim.

begin;
select plan(126);

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

select pg_temp.hdr('preview') as h_prev \gset
select pg_temp.hdr('production') as h_prod \gset
select set_config('request.headers', :'h_prev', true);

-- Texto de uma consulta, ou 'ERRO:<mensagem>'.
create function pg_temp.txt(p_sql text) returns text language plpgsql as $f$
declare
  v text;
begin
  execute p_sql into v;
  return coalesce(v, 'NULL');
exception when others then
  return 'ERRO:' || sqlerrm;
end
$f$;

-- Escrita direta (como dono do banco): 'ok' ou a mensagem do erro.
create function pg_temp.up(p_sql text) returns text language plpgsql as $f$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlerrm;
end
$f$;

create function pg_temp.cid(n integer) returns text language sql as $f$
  select '3e410000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0')
$f$;

create function pg_temp.mk(n integer, p_env text default 'preview') returns text language plpgsql as $f$
begin
  insert into public.whatsapp_channels (id, workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment,
    routing_key, status, send_enabled, status_changed_at, provider_account_ref)
  values (pg_temp.cid(n)::uuid, '10000000-0000-0000-0000-000000000001', 'Canal fictício', '1', '20000000-0000-0000-0000-000000000001', 'ycloud',
    false, p_env::public.whatsapp_environment, 'WABA-41:+551190000' || lpad(n::text, 4, '0'), 'active', true, '2026-01-01 00:00:00+00', 'WABA-41');
  return 'ok';
exception when others then
  return 'ERRO:' || sqlerrm;
end
$f$;

-- Muda o estado do canal e o relógio do CRM; p_age = há quanto tempo mudou.
create function pg_temp.chan(n integer, p_status text, p_age interval default '10 minutes') returns text language plpgsql as $f$
begin
  update public.whatsapp_channels
  set status = p_status, send_enabled = (p_status = 'active'), status_changed_at = clock_timestamp() - p_age
  where id = pg_temp.cid(n)::uuid;
  return 'ok';
exception when others then
  return 'ERRO:' || sqlerrm;
end
$f$;

-- Tira de cena tudo o que ainda poderia ser candidato (o lote é do ambiente
-- inteiro): cada grupo de testes começa sem nenhuma entrada elegível.
create function pg_temp.fresh() returns void language plpgsql as $f$
begin
  update public.whatsapp_webhook_inbox
  set state = 'processed', processed_at = clock_timestamp(), claim_token = null, claimed_at = null, lease_until = null
  where state in ('pending', 'processing');
end
$f$;

-- Entrada nova, recebida há p_age. Devolve o id.
create function pg_temp.ent(n integer, p_evt text, p_age interval default '10 minutes', p_type text default 'whatsapp.inbound_message.received')
  returns text language plpgsql as $f$
declare
  v_ch public.whatsapp_channels;
  v_id text;
begin
  select * into v_ch from public.whatsapp_channels where id = pg_temp.cid(n)::uuid;
  execute 'set local role service_role';
  v_id := public.whatsapp_inbox_store(v_ch.id, v_ch.workspace_id, v_ch.provider, v_ch.routing_key, p_evt, p_type,
    repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8=', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id';
  execute 'reset role';
  update public.whatsapp_webhook_inbox
  set received_at = clock_timestamp() - p_age, retain_until = clock_timestamp() + interval '1 hour'
  where id = v_id::uuid;
  return v_id;
end
$f$;

create function pg_temp.claim(p_id text) returns text language plpgsql as $f$
declare
  v text;
begin
  execute 'set local role service_role';
  v := public.whatsapp_inbox_claim(p_id::uuid, 300) ->> 'claim_token';
  execute 'reset role';
  return v;
end
$f$;

-- Claim + release pelo consumidor com o código, há p_age.
create function pg_temp.rel(p_id text, p_code text, p_age interval default '10 minutes') returns text language plpgsql as $f$
declare
  v_token text := pg_temp.claim(p_id);
  v text;
begin
  execute 'set local role service_role';
  v := public.whatsapp_inbox_release(p_id::uuid, v_token::uuid, p_code) ->> 'outcome';
  execute 'reset role';
  update public.whatsapp_webhook_inbox set last_released_at = clock_timestamp() - p_age where id = p_id::uuid;
  return v;
end
$f$;

-- A RPC de reserva como service_role: o jsonb, ou {"erro": ...}.
create function pg_temp.res(p_limit integer default 25, p_secs integer default 120) returns jsonb language plpgsql as $f$
declare
  v jsonb;
begin
  execute 'set local role service_role';
  execute format('select public.whatsapp_inbox_reconcile_reserve(%L, %L)', p_limit, p_secs) into v;
  execute 'reset role';
  return coalesce(v, 'null'::jsonb);
exception when others then
  return jsonb_build_object('erro', sqlerrm);
end
$f$;

-- Ids reservados, em ordem, separados por vírgula; 'nada' se vazio.
create function pg_temp.ids(p jsonb) returns text language sql as $f$
  select coalesce(p ->> 'erro', (select coalesce(string_agg(e ->> 'inbox_id', ',' order by ord), 'nada')
    from jsonb_array_elements(p -> 'entries') with ordinality as t(e, ord)))
$f$;

-- O token de uma entrada numa resposta.
create function pg_temp.tk(p jsonb, p_id text) returns text language sql as $f$
  select e ->> 'reservation_token' from jsonb_array_elements(p -> 'entries') e where e ->> 'inbox_id' = p_id
$f$;

create function pg_temp.confirm(p_id text, p_token text) returns text language plpgsql as $f$
declare
  v jsonb;
begin
  execute 'set local role service_role';
  execute format('select public.whatsapp_inbox_reconcile_confirm(%L::uuid, %L::uuid)', p_id, p_token) into v;
  execute 'reset role';
  return coalesce(v ->> 'outcome', v::text);
exception when others then
  return 'ERRO:' || sqlerrm;
end
$f$;

create function pg_temp.pfail(p_id text, p_token text, p_code text default 'inbox_event_publish_failed') returns text language plpgsql as $f$
declare
  v jsonb;
begin
  execute 'set local role service_role';
  execute format('select public.whatsapp_inbox_reconcile_fail(%L::uuid, %L::uuid, %L)', p_id, p_token, p_code) into v;
  execute 'reset role';
  return coalesce(v ->> 'outcome', v::text);
exception when others then
  return 'ERRO:' || sqlerrm;
end
$f$;

-- As colunas que NÃO são técnicas da reconciliação, em hash: nada mais muda.
create function pg_temp.core(p_id text) returns text language sql as $f$
  select md5((to_jsonb(i) - array['reconcile_token', 'reconcile_reserved_at', 'reconcile_reserved_until', 'reconcile_attempts',
    'last_republished_at', 'last_republish_error_code', 'reconcile_next_at'])::text)
  from public.whatsapp_webhook_inbox i where i.id = p_id::uuid
$f$;

-- Colunas técnicas da entrada: reservada|tentativas|republicada|erro|espera.
create function pg_temp.tech(p_id text) returns text language plpgsql as $f$
declare
  v text;
begin
  execute format($q$select concat_ws('|',
      case when reconcile_token is null then 'livre' else 'reservada' end,
      reconcile_attempts,
      case when last_republished_at is null then 'nunca' else 'republicada' end,
      coalesce(last_republish_error_code, '-'),
      case when reconcile_next_at is null then 'sem-espera'
           else (round(extract(epoch from reconcile_next_at - clock_timestamp()) / 60))::text || 'min' end)
    from public.whatsapp_webhook_inbox where id = %L::uuid$q$, p_id) into v;
  return v;
exception when others then
  return 'ERRO:' || sqlerrm;
end
$f$;

select pg_temp.mk(1) as m \gset
select pg_temp.mk(2) as m \gset
select pg_temp.mk(3) as m \gset
select pg_temp.mk(4) as m \gset
select pg_temp.mk(5) as m \gset
select pg_temp.mk(6) as m \gset
select pg_temp.mk(7) as m \gset
select pg_temp.mk(8) as m \gset
select set_config('request.headers', :'h_prod', true);
select pg_temp.mk(9, 'production') as m \gset
select set_config('request.headers', :'h_prev', true);

-- ---------------------------------------------------------------------
-- 1. Superfície
-- ---------------------------------------------------------------------

select is(
  pg_temp.txt($q$
    select string_agg(column_name, ',' order by column_name) from information_schema.columns
    where table_schema = 'public' and table_name = 'whatsapp_webhook_inbox'
      and column_name in ('reconcile_token', 'reconcile_reserved_at', 'reconcile_reserved_until', 'reconcile_attempts',
        'last_republished_at', 'last_republish_error_code', 'reconcile_next_at')
  $q$),
  'last_republish_error_code,last_republished_at,reconcile_attempts,reconcile_next_at,reconcile_reserved_at,reconcile_reserved_until,reconcile_token',
  'a inbox tem as colunas técnicas da reconciliação'
);

select is(
  pg_temp.txt($q$
    select string_agg(p.proname || ':' || (
      has_function_privilege('service_role', p.oid, 'execute')::text || '/' ||
      has_function_privilege('authenticated', p.oid, 'execute')::text || '/' ||
      has_function_privilege('anon', p.oid, 'execute')::text), ' ' order by p.proname)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('whatsapp_inbox_reconcile_reserve', 'whatsapp_inbox_reconcile_confirm', 'whatsapp_inbox_reconcile_fail', 'whatsapp_reconciler_record_run')
  $q$),
  'whatsapp_inbox_reconcile_confirm:true/false/false whatsapp_inbox_reconcile_fail:true/false/false whatsapp_inbox_reconcile_reserve:true/false/false whatsapp_reconciler_record_run:true/false/false',
  'as quatro funções só para service_role'
);

select is(
  pg_temp.txt($q$
    select string_agg(p.proname || ':' || p.prosecdef::text || ':' || array_to_string(p.proconfig, ';'), ' ' order by p.proname)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('whatsapp_inbox_reconcile_reserve', 'whatsapp_inbox_reconcile_confirm', 'whatsapp_inbox_reconcile_fail', 'whatsapp_reconciler_record_run')
  $q$),
  'whatsapp_inbox_reconcile_confirm:true:search_path="" whatsapp_inbox_reconcile_fail:true:search_path="" whatsapp_inbox_reconcile_reserve:true:search_path="" whatsapp_reconciler_record_run:true:search_path=""',
  'SECURITY DEFINER com search_path vazio'
);

select is(
  pg_temp.txt($q$
    select concat_ws(' ', has_table_privilege('service_role', 'public.whatsapp_webhook_inbox', 'select')::text,
      has_table_privilege('service_role', 'public.whatsapp_reconciler_runs', 'select')::text,
      has_table_privilege('authenticated', 'public.whatsapp_reconciler_runs', 'select')::text,
      (select relrowsecurity::text || '/' || relforcerowsecurity::text from pg_class where oid = 'public.whatsapp_reconciler_runs'::regclass))
  $q$),
  'false false false true/true',
  'nem a inbox nem o batimento têm acesso direto; o batimento tem RLS forçada'
);

select is(
  pg_temp.txt($q$
    select string_agg(column_name || ':' || data_type, ',' order by ordinal_position) from information_schema.columns
    where table_schema = 'public' and table_name = 'whatsapp_reconciler_runs'
  $q$),
  'id:uuid,environment:USER-DEFINED,origin:text,started_at:timestamp with time zone,finished_at:timestamp with time zone,outcome:text,candidates:integer,reserved:integer,published:integer,skipped:integer,failures:integer',
  'o batimento tem só ambiente, origem, horários, desfecho e contagens: nenhuma coluna para dado pessoal, token ou erro'
);

-- ---------------------------------------------------------------------
-- 2. Elegibilidade
-- ---------------------------------------------------------------------

select pg_temp.fresh();
select pg_temp.ent(1, 'evt-p1') as e1 \gset
select pg_temp.core(:'e1') as core1 \gset
select pg_temp.res() as r1 \gset

select is(pg_temp.ids(:'r1'::jsonb), :'e1', 'pending nunca tentada é reservada');
select is(
  (select string_agg(k, ',' order by k) from jsonb_object_keys(:'r1'::jsonb) k),
  'candidates,entries',
  'a resposta só tem a contagem de candidatas e as entradas'
);
select is(
  (select string_agg(k, ',' order by k) from jsonb_object_keys((:'r1'::jsonb -> 'entries') -> 0) k),
  'inbox_id,reconcile_attempt,reservation_token',
  'cada entrada sai só com o id, o token e a tentativa: nenhuma cifra, hash, canal ou workspace'
);
select is(
  pg_temp.txt(format($q$
    select concat_ws('|', reconcile_token::text = %L, reconcile_reserved_at is not null, reconcile_reserved_until > reconcile_reserved_at,
      extract(epoch from reconcile_reserved_until - reconcile_reserved_at)::int, reconcile_attempts)
    from public.whatsapp_webhook_inbox where id = %L::uuid
  $q$, pg_temp.tk(:'r1'::jsonb, :'e1'), :'e1')),
  't|t|t|120|1',
  'a reserva grava o token devolvido, o horário, o vencimento pedido e conta a tentativa'
);
select is(pg_temp.core(:'e1'), :'core1', 'a reserva não muda nada além das colunas técnicas (state, claim, cifra)');

-- Lease vencida × vigente.
select pg_temp.fresh();
select pg_temp.ent(1, 'evt-p2') as e2 \gset
select pg_temp.claim(:'e2') as c2 \gset
select pg_temp.up(format($q$update public.whatsapp_webhook_inbox set claimed_at = clock_timestamp() - interval '10 minutes', lease_until = clock_timestamp() - interval '1 second' where id = %L$q$, :'e2')) as m \gset
select pg_temp.core(:'e2') as core2 \gset
select is(pg_temp.ids(pg_temp.res()), :'e2', 'processing com a lease vencida é reservada');
select is(pg_temp.core(:'e2'), :'core2', 'a reserva não toca no claim da entrada em processing');

select pg_temp.fresh();
select pg_temp.ent(1, 'evt-p3') as e3 \gset
select pg_temp.claim(:'e3') as c3 \gset
select is(pg_temp.ids(pg_temp.res()), 'nada', 'processing com a lease vigente não é reservada');
select is((pg_temp.res() ->> 'candidates'), '0', '...e nem conta como candidata');

-- Terminais, expurgada, retenção vencida.
select pg_temp.fresh();
select pg_temp.ent(1, 'evt-p4') as e4 \gset
select pg_temp.up(format($q$update public.whatsapp_webhook_inbox set state = 'processed', processed_at = clock_timestamp() where id = %L$q$, :'e4')) as m \gset
select is(pg_temp.ids(pg_temp.res()), 'nada', 'processed não é reservada');

select pg_temp.fresh();
select pg_temp.ent(1, 'evt-p5') as e5 \gset
select pg_temp.up(format($q$update public.whatsapp_webhook_inbox set state = 'failed', failed_at = clock_timestamp(), error_code = 'payload_invalid' where id = %L$q$, :'e5')) as m \gset
select is(pg_temp.ids(pg_temp.res()), 'nada', 'failed não é reservada');

select pg_temp.fresh();
select pg_temp.ent(1, 'evt-p6') as e6 \gset
select pg_temp.up(format($q$update public.whatsapp_webhook_inbox set key_version = null, nonce = null, ciphertext = null, auth_tag = null, purged_at = clock_timestamp() where id = %L$q$, :'e6')) as m \gset
select is(pg_temp.ids(pg_temp.res()), 'nada', 'entrada expurgada (tombstone pendente) não é reservada');

select pg_temp.fresh();
select pg_temp.ent(1, 'evt-p7') as e7 \gset
select pg_temp.up(format($q$update public.whatsapp_webhook_inbox set retain_until = clock_timestamp() - interval '1 second' where id = %L$q$, :'e7')) as m \gset
select is(pg_temp.ids(pg_temp.res()), 'nada', 'retenção vencida não é reservada, mesmo sem o expurgo ter passado');

-- Outro ambiente.
select pg_temp.fresh();
select set_config('request.headers', :'h_prod', true);
select pg_temp.ent(9, 'evt-prod-1') as e8 \gset
select set_config('request.headers', :'h_prev', true);
select is(pg_temp.ids(pg_temp.res()), 'nada', 'uma entrada de outro ambiente não aparece');
select set_config('request.headers', :'h_prod', true);
select is(pg_temp.ids(pg_temp.res()), :'e8', 'ela aparece só no próprio ambiente');
select set_config('request.headers', :'h_prev', true);

select pg_temp.fresh();
select pg_temp.ent(1, 'evt-p8') as e9 \gset
select pg_temp.res() as r9 \gset
select set_config('request.headers', :'h_prod', true);
select is(pg_temp.confirm(:'e9', pg_temp.tk(:'r9'::jsonb, :'e9')), 'not_found', 'outro ambiente não confirma a reserva');
select is(pg_temp.pfail(:'e9', pg_temp.tk(:'r9'::jsonb, :'e9')), 'not_found', 'outro ambiente não registra falha na reserva');
select set_config('request.headers', '{}', true);
select is(pg_temp.res() ->> 'erro', 'whatsapp_environment_required', 'sem o ambiente assinado, nada é reservado');
select is(pg_temp.confirm(:'e9', pg_temp.tk(:'r9'::jsonb, :'e9')), 'ERRO:whatsapp_environment_required', 'sem o ambiente assinado, nada é confirmado');
select set_config('request.headers', :'h_prev', true);
select is(pg_temp.tech(:'e9'), 'reservada|1|nunca|-|sem-espera', 'a reserva continua intacta depois das tentativas de outro ambiente');

-- Janela de 1 minuto para o publicador da rota.
select pg_temp.fresh();
select pg_temp.ent(1, 'evt-p9', interval '10 seconds') as e10 \gset
select is(pg_temp.ids(pg_temp.res()), 'nada', 'recebida há menos de 1 minuto ainda não é reservada (a rota está publicando)');

-- ---------------------------------------------------------------------
-- 3. Reserva, vencimento, token antigo
-- ---------------------------------------------------------------------

select pg_temp.fresh();
select pg_temp.ent(1, 'evt-r1') as r_e \gset
select pg_temp.res() as r_a \gset
select pg_temp.tk(:'r_a'::jsonb, :'r_e') as tok_a \gset
select is(pg_temp.ids(pg_temp.res()), 'nada', 'reserva vigente: outro reconciliador não a recebe');

select pg_temp.up(format($q$update public.whatsapp_webhook_inbox set reconcile_reserved_at = clock_timestamp() - interval '5 minutes', reconcile_reserved_until = clock_timestamp() - interval '1 second' where id = %L$q$, :'r_e')) as m \gset
select is(pg_temp.confirm(:'r_e', :'tok_a'), 'reservation_lost', 'reserva vencida, mesmo sem nova dona: o token não confirma mais');
select is(pg_temp.pfail(:'r_e', :'tok_a'), 'reservation_lost', 'reserva vencida: o token não registra falha');
select is(pg_temp.tech(:'r_e'), 'reservada|1|nunca|-|sem-espera', 'nada mudou com o token vencido');

select pg_temp.res() as r_b \gset
select pg_temp.tk(:'r_b'::jsonb, :'r_e') as tok_b \gset
select isnt(:'tok_b'::text, :'tok_a'::text, 'reserva vencida é adquirida de novo com um token NOVO');
select is(pg_temp.tech(:'r_e'), 'reservada|2|nunca|-|sem-espera', 'a nova reserva conta mais uma tentativa');
select is(pg_temp.confirm(:'r_e', :'tok_a'), 'reservation_lost', 'o token antigo não confirma a reserva nova');
select is(pg_temp.pfail(:'r_e', :'tok_a'), 'reservation_lost', 'o token antigo não libera a reserva nova');
select is(pg_temp.tech(:'r_e'), 'reservada|2|nunca|-|sem-espera', 'a reserva nova continua intacta');
select is(pg_temp.confirm(:'r_e', 'a0000000-0000-4000-8000-000000000000'), 'reservation_lost', 'token inventado não confirma');
select is(pg_temp.confirm('a0000000-0000-4000-8000-000000000001', :'tok_b'), 'not_found', 'entrada inexistente: not_found');
select is(pg_temp.txt(format($q$select public.whatsapp_inbox_reconcile_confirm(%L::uuid, null) ->> 'outcome'$q$, :'r_e')), 'reservation_lost', 'token nulo não confirma');

-- Confirmação.
select pg_temp.core(:'r_e') as core_r \gset
select is(pg_temp.confirm(:'r_e', :'tok_b'), 'confirmed', 'o token vigente confirma a publicação');
select is(pg_temp.core(:'r_e'), :'core_r', 'a confirmação não muda o state nem o claim: não marca processed nem inventa execução');
select is(pg_temp.tech(:'r_e'), 'livre|2|republicada|-|5min', 'a confirmação limpa a reserva, grava a republicação e agenda pelo backoff');
select is(pg_temp.confirm(:'r_e', :'tok_b'), 'reservation_lost', 'repetir a confirmação não muda nada');
select is(pg_temp.ids(pg_temp.res()), 'nada', 'intervalo mínimo: logo depois da republicação ela não é elegível');
select pg_temp.up(format($q$update public.whatsapp_webhook_inbox set reconcile_next_at = clock_timestamp() - interval '1 second' where id = %L$q$, :'r_e')) as m \gset
select is(pg_temp.ids(pg_temp.res()), :'r_e', 'passado o intervalo, volta a ser elegível (o consumidor não a concluiu)');

-- Falha da publicação.
select pg_temp.fresh();
select pg_temp.ent(1, 'evt-r2') as f_e \gset
select pg_temp.res() as f_r \gset
select pg_temp.core(:'f_e') as core_f \gset
select is(pg_temp.pfail(:'f_e', pg_temp.tk(:'f_r'::jsonb, :'f_e'), 'erro com +5511999990000'), 'ERRO:invalid_error_code', 'falha só aceita código fixo: texto livre é recusado');
select is(pg_temp.tech(:'f_e'), 'reservada|1|nunca|-|sem-espera', 'a recusa do código não muda nada');
select is(pg_temp.pfail(:'f_e', pg_temp.tk(:'f_r'::jsonb, :'f_e')), 'failed', 'falha da publicação com o token vigente');
select is(pg_temp.core(:'f_e'), :'core_f', 'a falha não muda o state nem o claim: a entrada não se perde');
select is(pg_temp.tech(:'f_e'), 'livre|1|nunca|inbox_event_publish_failed|1min', 'a falha grava só o código fixo e agenda pelo backoff');
select is(pg_temp.ids(pg_temp.res()), 'nada', 'a falha respeita o backoff antes de nova tentativa');
select pg_temp.up(format($q$update public.whatsapp_webhook_inbox set reconcile_next_at = clock_timestamp() - interval '1 second' where id = %L$q$, :'f_e')) as m \gset
select pg_temp.res() as f_r2 \gset
select is(pg_temp.confirm(:'f_e', pg_temp.tk(:'f_r2'::jsonb, :'f_e')), 'confirmed', 'a nova tentativa publica');
select is(pg_temp.tech(:'f_e'), 'livre|2|republicada|-|5min', 'a publicação aceita limpa o código de falha');

-- Processada entre a reserva e a confirmação.
select pg_temp.fresh();
select pg_temp.ent(1, 'evt-r3') as d_e \gset
select pg_temp.res() as d_r \gset
select pg_temp.claim(:'d_e') as d_c \gset
select pg_temp.txt(format($q$select public.whatsapp_inbox_complete(%L::uuid, %L::uuid) ->> 'outcome'$q$, :'d_e', :'d_c')) as m \gset
select pg_temp.core(:'d_e') as core_d \gset
select is(pg_temp.confirm(:'d_e', pg_temp.tk(:'d_r'::jsonb, :'d_e')), 'confirmed', 'a entrada processada entre a reserva e a confirmação ainda confirma tecnicamente');
select is(pg_temp.core(:'d_e'), :'core_d', '...sem reabrir nem mudar nada do processamento');
select is(pg_temp.txt(format($q$select state from public.whatsapp_webhook_inbox where id = %L$q$, :'d_e')), 'processed', 'o estado continua processed');

-- Expurgo com reserva vigente.
select pg_temp.fresh();
select pg_temp.ent(1, 'evt-r4') as g_e \gset
select pg_temp.res() as g_r \gset
select pg_temp.up(format($q$update public.whatsapp_webhook_inbox set key_version = null, nonce = null, ciphertext = null, auth_tag = null, purged_at = clock_timestamp() where id = %L$q$, :'g_e')) as m \gset
select is(pg_temp.tech(:'g_e'), 'livre|1|nunca|-|sem-espera', 'o expurgo apaga a reserva: um tombstone não guarda token');
select is(pg_temp.confirm(:'g_e', pg_temp.tk(:'g_r'::jsonb, :'g_e')), 'reservation_lost', 'o token de antes do expurgo não confirma');

-- Parâmetros e lote.
select is(pg_temp.res(26) ->> 'erro', 'invalid_limit', 'lote acima de 25 é recusado');
select is(pg_temp.res(0) ->> 'erro', 'invalid_limit', 'lote zero é recusado');
select is(pg_temp.res(25, 29) ->> 'erro', 'invalid_reservation', 'vencimento curto demais é recusado');
select is(pg_temp.res(25, 301) ->> 'erro', 'invalid_reservation', 'vencimento longo demais é recusado');

select pg_temp.fresh();
select count(pg_temp.ent(2, 'evt-l' || g, make_interval(mins => 100 - g))) as m from generate_series(1, 30) g \gset
select pg_temp.res() as l_r \gset
select is(jsonb_array_length(:'l_r'::jsonb -> 'entries')::text || '/' || (:'l_r'::jsonb ->> 'candidates'), '25/30', 'lote máximo de 25, e as candidatas contadas de verdade (30)');
select is(
  pg_temp.txt(format($q$select bool_and(i.provider_event_id ~ '^evt-l([1-9]|1[0-9]|2[0-5])$')::text from public.whatsapp_webhook_inbox i
    where i.id in (select (e ->> 'inbox_id')::uuid from jsonb_array_elements(%L::jsonb -> 'entries') e)$q$, :'l_r')),
  'true',
  'as mais antigas primeiro'
);
select is(jsonb_array_length(pg_temp.res() -> 'entries')::text, '5', 'a rodada seguinte recebe só as 5 restantes');

-- ---------------------------------------------------------------------
-- 4. Canal não ativo, sem loop
-- ---------------------------------------------------------------------

-- Nunca tentada passa em qualquer estado do canal (é o caminho do account).
select pg_temp.fresh();
select pg_temp.ent(3, 'evt-c1') as c_a \gset
select pg_temp.chan(3, 'paused') as m \gset
select is(pg_temp.ids(pg_temp.res()), :'c_a', 'nunca tentada em canal paused é publicada');
select pg_temp.fresh();
select pg_temp.ent(4, 'evt-c2') as c_b \gset
select pg_temp.chan(4, 'disconnected') as m \gset
select is(pg_temp.ids(pg_temp.res()), :'c_b', 'nunca tentada em canal disconnected é publicada');
select pg_temp.fresh();
select pg_temp.ent(5, 'evt-c3') as c_c \gset
select pg_temp.chan(5, 'disabled') as m \gset
select is(pg_temp.ids(pg_temp.res()), :'c_c', 'nunca tentada em canal disabled é publicada');

-- O account nesse canal chega ao efeito, com a reserva ainda vigente.
select pg_temp.fresh();
select pg_temp.chan(4, 'active') as m \gset
select pg_temp.ent(4, 'evt-c4', interval '10 minutes', 'whatsapp.phone_number.deleted') as c_d \gset
select pg_temp.chan(4, 'paused') as m \gset
select pg_temp.res() as c_d_r \gset
select pg_temp.claim(:'c_d') as c_d_t \gset
select is(
  pg_temp.txt(format($q$select public.whatsapp_effect_account_event(%L::uuid, %L::uuid, 'phone_number', 'whatsapp.phone_number.deleted', 'WABA-41', %L, clock_timestamp(), null) ->> 'outcome'$q$,
    :'c_d', :'c_d_t', (select routing_key from public.whatsapp_channels where id = pg_temp.cid(4)::uuid))),
  'applied',
  'account em canal paused, reservado pelo reconciliador, chega ao efeito e desconecta'
);

-- Mensagem comum: o consumidor libera com channel_* e ela espera.
select pg_temp.fresh();
select pg_temp.chan(6, 'active') as m \gset
select pg_temp.ent(6, 'evt-c5') as w1 \gset
select pg_temp.chan(6, 'paused', interval '1 hour') as m \gset
select pg_temp.res() as w1_r \gset
select pg_temp.confirm(:'w1', pg_temp.tk(:'w1_r'::jsonb, :'w1')) as m \gset
select pg_temp.rel(:'w1', 'channel_paused') as m \gset
select pg_temp.up(format($q$update public.whatsapp_webhook_inbox set reconcile_next_at = clock_timestamp() - interval '1 second' where id = %L$q$, :'w1')) as m \gset
select is(pg_temp.ids(pg_temp.res()), 'nada', 'channel_paused com o canal ainda pausado: não é republicada, mesmo com o backoff vencido');
select is(pg_temp.ids(pg_temp.res()), 'nada', '...nem no ciclo seguinte: sem loop');
select is(pg_temp.res() ->> 'candidates', '0', '...e não conta como candidata');

-- O canal muda de verdade.
select pg_temp.chan(6, 'active', interval '1 minute') as m \gset
select pg_temp.up(format($q$update public.whatsapp_webhook_inbox set reconcile_next_at = clock_timestamp() + interval '6 hours', reconcile_reserved_at = clock_timestamp() - interval '20 minutes' where id = %L$q$, :'w1')) as m \gset
select pg_temp.res() as w2_r \gset
select is(pg_temp.ids(:'w2_r'::jsonb), :'w1', 'status_changed_at posterior ao release: elegível de novo, sem esperar o backoff longo');

-- Se o Inngest descartar a republicação (id repetido em 24 h), ela não para.
select pg_temp.confirm(:'w1', pg_temp.tk(:'w2_r'::jsonb, :'w1')) as m \gset
select is(pg_temp.ids(pg_temp.res()), 'nada', 'depois da republicação pós-mudança: volta a respeitar o backoff');
select pg_temp.up(format($q$update public.whatsapp_webhook_inbox set reconcile_next_at = clock_timestamp() - interval '1 second' where id = %L$q$, :'w1')) as m \gset
select pg_temp.res() as w3_r \gset
select is(pg_temp.ids(:'w3_r'::jsonb), :'w1', 'vencido o backoff, tenta de novo: o consumidor ainda não a tratou');

-- Falha de publicação depois da mudança respeita o backoff.
select pg_temp.pfail(:'w1', pg_temp.tk(:'w3_r'::jsonb, :'w1')) as m \gset
select is(pg_temp.ids(pg_temp.res()), 'nada', 'a falha de publicação depois da mudança do canal também respeita o backoff');

-- channel_disconnected e channel_disabled.
select pg_temp.fresh();
select pg_temp.chan(7, 'active') as m \gset
select pg_temp.ent(7, 'evt-c6') as w4 \gset
select pg_temp.chan(7, 'disconnected', interval '1 hour') as m \gset
select pg_temp.rel(:'w4', 'channel_disconnected') as m \gset
select is(pg_temp.ids(pg_temp.res()), 'nada', 'channel_disconnected com o canal desconectado espera');
select pg_temp.fresh();
select pg_temp.chan(7, 'active') as m \gset
select pg_temp.ent(7, 'evt-c7') as w5 \gset
select pg_temp.chan(7, 'disabled', interval '1 hour') as m \gset
select pg_temp.rel(:'w5', 'channel_disabled') as m \gset
select is(pg_temp.ids(pg_temp.res()), 'nada', 'channel_disabled com o canal desativado espera');

-- Corrida: o canal mudou entre o claim e o release do consumidor. O relógio do
-- canal é anterior ao release, mas o estado atual já não é o do código.
select pg_temp.fresh();
select pg_temp.chan(8, 'active', interval '30 minutes') as m \gset
select pg_temp.ent(8, 'evt-c8', interval '40 minutes') as w6 \gset
select pg_temp.rel(:'w6', 'channel_paused', interval '10 minutes') as m \gset
select is(pg_temp.ids(pg_temp.res()), :'w6', 'corrida claim/release: canal já ativo, código channel_paused antigo — elegível, nunca presa');

-- Retenção prevalece sobre a mudança do canal.
select pg_temp.fresh();
select pg_temp.chan(6, 'active') as m \gset
select pg_temp.ent(6, 'evt-c9') as w7 \gset
select pg_temp.chan(6, 'paused', interval '1 hour') as m \gset
select pg_temp.rel(:'w7', 'channel_paused') as m \gset
select pg_temp.chan(6, 'active', interval '1 minute') as m \gset
select pg_temp.up(format($q$update public.whatsapp_webhook_inbox set retain_until = clock_timestamp() - interval '1 second' where id = %L$q$, :'w7')) as m \gset
select is(pg_temp.ids(pg_temp.res()), 'nada', 'a retenção prevalece sobre a mudança do canal');

-- ---------------------------------------------------------------------
-- 5. Backoff
-- ---------------------------------------------------------------------

select is(
  pg_temp.txt($q$
    select string_agg((extract(epoch from private.whatsapp_inbox_reconcile_backoff(n)) / 60)::int::text, ',' order by n) from generate_series(1, 8) n
  $q$),
  '1,5,15,60,360,360,360,360',
  'backoff: 1, 5, 15 e 60 minutos, com teto de 6 horas'
);
select is(
  pg_temp.txt($q$select (extract(epoch from private.whatsapp_inbox_reconcile_backoff(2147483647)) / 3600)::int::text$q$),
  '6',
  'o teto vale para qualquer contador'
);

select pg_temp.fresh();
select pg_temp.ent(1, 'evt-b1') as b1 \gset
select pg_temp.rel(:'b1', 'message_not_found', interval '10 seconds') as m \gset
select is(pg_temp.ids(pg_temp.res()), 'nada', 'recuperável liberado há menos de 1 minuto ainda não volta: nada de loop apertado');
select pg_temp.up(format($q$update public.whatsapp_webhook_inbox set last_released_at = clock_timestamp() - interval '2 minutes' where id = %L$q$, :'b1')) as m \gset
select pg_temp.res() as b1_r \gset
select is(pg_temp.ids(:'b1_r'::jsonb), :'b1', 'depois do intervalo mínimo, o recuperável volta');
select pg_temp.confirm(:'b1', pg_temp.tk(:'b1_r'::jsonb, :'b1')) as m \gset
select is(pg_temp.tech(:'b1'), 'livre|1|republicada|-|1min', 'primeira republicação: espera de 1 minuto');
select is(pg_temp.ids(pg_temp.res()), 'nada', 'o backoff segura a próxima tentativa');

-- Recuperáveis sem mudança de canal, muitas tentativas: nunca viram failed.
select pg_temp.fresh();
select pg_temp.ent(1, 'evt-b2') as b2 \gset
select pg_temp.rel(:'b2', 'identity_not_found') as m \gset
select pg_temp.up(format($q$update public.whatsapp_webhook_inbox set reconcile_attempts = 1000 where id = %L$q$, :'b2')) as m \gset
select pg_temp.res() as b2_r \gset
select pg_temp.confirm(:'b2', pg_temp.tk(:'b2_r'::jsonb, :'b2')) as m \gset
select is(pg_temp.tech(:'b2'), 'livre|1001|republicada|-|360min', 'mil tentativas: o teto de 6 horas é respeitado');
select is(pg_temp.txt(format($q$select state from public.whatsapp_webhook_inbox where id = %L$q$, :'b2')), 'pending', 'e a entrada continua pending: tentativas nunca a transformam em failed');
select is(
  pg_temp.up(format($q$update public.whatsapp_webhook_inbox set reconcile_attempts = 1 where id = %L$q$, :'b2')),
  'inbox_reconcile_attempts_decreased',
  'o contador de tentativas nunca diminui'
);

-- ---------------------------------------------------------------------
-- 6. Batimento
-- ---------------------------------------------------------------------

select is(
  pg_temp.txt($q$
    select public.whatsapp_reconciler_record_run('inngest', clock_timestamp() - interval '5 seconds', 'partial', 7, 5, 4, 2, 1) ->> 'outcome'
  $q$),
  'recorded',
  'o batimento é gravado'
);
select is(
  pg_temp.txt($q$
    select concat_ws('|', environment, origin, outcome, candidates, reserved, published, skipped, failures, finished_at >= started_at)
    from public.whatsapp_reconciler_runs order by finished_at desc limit 1
  $q$),
  'preview|inngest|partial|7|5|4|2|1|t',
  'com o ambiente assinado (não informado pelo chamador), o desfecho e as contagens verdadeiras'
);
select is(
  pg_temp.txt($q$select public.whatsapp_reconciler_record_run('inngest', clock_timestamp(), 'sucesso +5511999990000', 0, 0, 0, 0, 0) ->> 'outcome'$q$),
  'ERRO:invalid_reconciler_run',
  'desfecho fora da lista é recusado'
);
select is(
  pg_temp.txt($q$select public.whatsapp_reconciler_record_run('outra', clock_timestamp(), 'ok', 0, 0, 0, 0, 0) ->> 'outcome'$q$),
  'ERRO:invalid_reconciler_run',
  'origem fora da lista é recusada'
);
select is(
  pg_temp.txt($q$select public.whatsapp_reconciler_record_run('manual_test', clock_timestamp(), 'ok', -1, 0, 0, 0, 0) ->> 'outcome'$q$),
  'ERRO:invalid_reconciler_run',
  'contagem negativa é recusada'
);
select is(
  pg_temp.txt($q$select string_agg(t::text, ',' order by a) from unnest((select proargtypes::oid[] from pg_proc where proname = 'whatsapp_reconciler_record_run')) with ordinality as x(oid, a), lateral (select typname as t from pg_type where oid = x.oid) y$q$),
  'text,timestamptz,text,int4,int4,int4,int4,int4',
  'a função só recebe origem, início, desfecho e contagens'
);
select pg_temp.up($q$insert into public.whatsapp_reconciler_runs (environment, origin, started_at, finished_at, outcome, candidates, reserved, published, skipped, failures)
  values ('preview', 'inngest', clock_timestamp() - interval '40 days', clock_timestamp() - interval '40 days', 'ok', 0, 0, 0, 0, 0)$q$) as m \gset
select pg_temp.txt($q$select public.whatsapp_reconciler_record_run('inngest', clock_timestamp(), 'ok', 0, 0, 0, 0, 0) ->> 'outcome'$q$) as m \gset
select is(
  pg_temp.txt($q$select count(*)::text from public.whatsapp_reconciler_runs where finished_at < clock_timestamp() - interval '30 days'$q$),
  '0',
  'batimentos com mais de 30 dias são apagados: a tabela não cresce sem limite'
);

-- ---------------------------------------------------------------------
-- 7. Estrutura
-- ---------------------------------------------------------------------

select is(
  pg_temp.txt($q$
    with f as (
      select regexp_replace(lower(regexp_replace(p.prosrc, '--[^\n]*', '', 'g')), '\s+', ' ', 'g') as s
      from pg_proc p where p.oid = 'public.whatsapp_inbox_reconcile_reserve'::regproc
    )
    select concat_ws(' ', (s ~ 'for update of i skip locked')::text, (s ~ 'clock_timestamp\(\)')::text, (s !~ '\mnow\(\)')::text) from f
  $q$),
  'true true true',
  'a reserva trava com SKIP LOCKED e usa o relógio do banco no momento da chamada'
);
select is(
  pg_temp.txt($q$
    select string_agg(p.proname || ':' || (regexp_replace(lower(regexp_replace(p.prosrc, '--[^\n]*', '', 'g')), '\s+', ' ', 'g')
      !~ '(\mstate\s*=\s*''|claim_token\s*=|lease_until\s*=|claimed_at\s*=|processed_at|failed_at|ciphertext|body_sha256|workspace_id|routing_key)')::text, ' ' order by p.proname)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('whatsapp_inbox_reconcile_confirm', 'whatsapp_inbox_reconcile_fail')
  $q$),
  'whatsapp_inbox_reconcile_confirm:true whatsapp_inbox_reconcile_fail:true',
  'confirmar e falhar não escrevem state nem claim, e não leem cifra, hash ou canal'
);
select is(
  pg_temp.txt($q$select (private.whatsapp_inbox_safe_row(i) ?| array['reconcile_token', 'reconcile_reserved_until'])::text from public.whatsapp_webhook_inbox i limit 1$q$),
  'false',
  'a listagem segura da inbox nunca devolve o token da reserva'
);
select is(
  pg_temp.up(format($q$update public.whatsapp_webhook_inbox set reconcile_token = gen_random_uuid() where id = %L$q$, :'b2')),
  'new row for relation "whatsapp_webhook_inbox" violates check constraint "whatsapp_webhook_inbox_reconcile_reservation_coherent"',
  'token sem vencimento é recusado pela constraint'
);
select is(
  pg_temp.up(format($q$update public.whatsapp_webhook_inbox set last_republish_error_code = 'Falha com +5511999990000' where id = %L$q$, :'b2')),
  'new row for relation "whatsapp_webhook_inbox" violates check constraint "whatsapp_webhook_inbox_republish_error_code_check"',
  'o código de falha só aceita a lista fechada, também por escrita direta'
);

-- ---------------------------------------------------------------------
-- 8. O batimento usa o ambiente assinado (depois da 1ª rodada de mutações)
-- ---------------------------------------------------------------------

select set_config('request.headers', :'h_prod', true);
select pg_temp.txt($q$select public.whatsapp_reconciler_record_run('manual_test', clock_timestamp(), 'partial', 1, 1, 0, 0, 1) ->> 'outcome'$q$) as m \gset
select is(
  pg_temp.txt($q$select environment::text from public.whatsapp_reconciler_runs where origin = 'manual_test' and outcome = 'partial' and failures = 1 order by finished_at desc limit 1$q$),
  'production',
  'o batimento grava o ambiente assinado da requisição, nunca um fixo'
);
select set_config('request.headers', '{}', true);
select is(
  pg_temp.txt($q$select public.whatsapp_reconciler_record_run('inngest', clock_timestamp(), 'ok', 0, 0, 0, 0, 0) ->> 'outcome'$q$),
  'ERRO:whatsapp_environment_required',
  'sem o ambiente assinado, nenhum batimento é gravado'
);
select set_config('request.headers', :'h_prev', true);

-- ---------------------------------------------------------------------
-- 9. A tentativa devolvida pela reserva (id do evento, §28.8)
-- ---------------------------------------------------------------------

-- A tentativa de uma entrada numa resposta.
create function pg_temp.att(p jsonb, p_id text) returns text language sql as $f$
  select coalesce(p ->> 'erro', (select e ->> 'reconcile_attempt' from jsonb_array_elements(p -> 'entries') e where e ->> 'inbox_id' = p_id))
$f$;
-- O contador gravado na linha.
create function pg_temp.col(p_id text) returns text language sql as $f$
  select pg_temp.txt(format($q$select reconcile_attempts from public.whatsapp_webhook_inbox where id = %L::uuid$q$, p_id))
$f$;
-- Encurta a espera do backoff: a entrada volta a ser elegível.
create function pg_temp.due(p_id text) returns text language sql as $f$
  select pg_temp.up(format($q$update public.whatsapp_webhook_inbox set reconcile_next_at = clock_timestamp() - interval '1 minute' where id = %L::uuid$q$, p_id))
$f$;
-- A reserva vence: o worker caiu.
create function pg_temp.expire(p_id text) returns text language sql as $f$
  select pg_temp.up(format($q$update public.whatsapp_webhook_inbox set reconcile_reserved_at = clock_timestamp() - interval '5 minutes', reconcile_reserved_until = clock_timestamp() - interval '1 second' where id = %L::uuid$q$, p_id))
$f$;

select pg_temp.fresh();
select pg_temp.ent(1, 'evt-t1') as t1 \gset
select is(pg_temp.col(:'t1'), '0', 'nunca reservada: nenhuma tentativa');
select pg_temp.res() as t1_a \gset
select is(pg_temp.att(:'t1_a'::jsonb, :'t1'), '1', 'a primeira reserva devolve a tentativa 1');
select is(jsonb_typeof((:'t1_a'::jsonb -> 'entries') -> 0 -> 'reconcile_attempt'), 'number', 'a tentativa sai como número, não como texto');
select is(pg_temp.col(:'t1'), '1', 'o número devolvido é o gravado na linha');

-- A mesma reserva: nada muda enquanto ela existir.
select is(pg_temp.ids(pg_temp.res()), 'nada', 'com a reserva vigente, a entrada não é reservada de novo');
select is(pg_temp.col(:'t1'), '1', 'uma nova rodada, com a reserva vigente, não muda a tentativa');
select is(pg_temp.confirm(:'t1', pg_temp.tk(:'t1_a'::jsonb, :'t1')), 'confirmed', 'a publicação da tentativa 1 é confirmada');
select is(pg_temp.col(:'t1'), '1', 'a confirmação não muda a tentativa');

-- Reserva nova depois da confirmação.
select is(pg_temp.due(:'t1'), 'ok', 'o backoff vence');
select pg_temp.res() as t1_b \gset
select is(pg_temp.att(:'t1_b'::jsonb, :'t1'), '2', 'a reserva seguinte, depois de confirmada a anterior, é a tentativa 2');
select isnt(pg_temp.tk(:'t1_b'::jsonb, :'t1'), pg_temp.tk(:'t1_a'::jsonb, :'t1'), 'reserva nova, token novo');

-- Reserva nova depois da falha.
select is(pg_temp.pfail(:'t1', pg_temp.tk(:'t1_b'::jsonb, :'t1')), 'failed', 'a publicação da tentativa 2 falha');
select is(pg_temp.col(:'t1'), '2', 'a falha técnica não muda a tentativa');
select is(pg_temp.due(:'t1'), 'ok', 'o backoff vence de novo');
select pg_temp.res() as t1_c \gset
select is(pg_temp.att(:'t1_c'::jsonb, :'t1'), '3', 'depois da falha, a reserva seguinte é a tentativa 3: nunca reutiliza a anterior');

-- Reserva nova depois da queda do worker.
select is(pg_temp.expire(:'t1'), 'ok', 'o worker cai e a reserva vence');
select pg_temp.res() as t1_d \gset
select is(pg_temp.att(:'t1_d'::jsonb, :'t1'), '4', 'depois da queda, a reserva seguinte é a tentativa 4');
select is(pg_temp.col(:'t1'), '4', 'e a linha acompanha');

-- Cada entrada do lote com o próprio contador.
select pg_temp.fresh();
select pg_temp.ent(1, 'evt-t2', '30 minutes') as t2 \gset
select pg_temp.ent(1, 'evt-t3', '20 minutes') as t3 \gset
select pg_temp.ent(1, 'evt-t4', '10 minutes') as t4 \gset
select pg_temp.up(format($q$update public.whatsapp_webhook_inbox set reconcile_attempts = 41 where id = %L$q$, :'t2')) as m \gset
select pg_temp.up(format($q$update public.whatsapp_webhook_inbox set reconcile_attempts = 9 where id = %L$q$, :'t3')) as m \gset
select pg_temp.res() as t_lote \gset
select is(
  concat_ws(',', pg_temp.att(:'t_lote'::jsonb, :'t2'), pg_temp.att(:'t_lote'::jsonb, :'t3'), pg_temp.att(:'t_lote'::jsonb, :'t4')),
  '42,10,1',
  'no mesmo lote, cada entrada recebe o próprio contador já incrementado'
);

-- Limites do inteiro.
select pg_temp.fresh();
select pg_temp.ent(1, 'evt-t5') as t5 \gset
select pg_temp.up(format($q$update public.whatsapp_webhook_inbox set reconcile_attempts = 2147483646 where id = %L$q$, :'t5')) as m \gset
select pg_temp.res() as t5_a \gset
select is(pg_temp.att(:'t5_a'::jsonb, :'t5'), '2147483647', 'a última tentativa possível ainda sai certa');
select is(pg_temp.expire(:'t5'), 'ok', 'e vence');
select is(pg_temp.ids(pg_temp.res()), 'integer out of range', 'acabou o inteiro: a reserva falha em vez de repetir um id');
select is(pg_temp.col(:'t5'), '2147483647', 'e nada muda na linha');

-- A tentativa só sai da reserva.
select is(
  pg_temp.txt($q$select string_agg(column_name::text, ',') from information_schema.columns where table_schema = 'public' and table_name = 'whatsapp_reconciler_runs' and column_name ilike '%attempt%'$q$),
  'NULL',
  'o batimento não tem coluna de tentativa'
);

select * from finish();
rollback;
