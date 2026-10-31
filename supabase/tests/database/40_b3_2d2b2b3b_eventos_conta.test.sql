-- pgTAP — B3.2d-2b2b3b: eventos operacionais da CONTA e do NÚMERO
-- (NormalizedAccountEvent).
--
-- public.whatsapp_effect_account_event, numa transação só e sob a trava da
-- inbox e do canal:
--  - inbox no ambiente autenticado, em processing, com o token do claim e a
--    lease vigente, conferida de novo depois das travas de linha; workspace,
--    canal, ambiente, provedor e id do evento vêm da linha da inbox, nunca
--    do chamador;
--  - reserva o efeito `account` no ledger;
--  - valida o destino: scope phone_number exige a routing key exatamente
--    igual à do canal e a referência da conta igual à do canal; scope
--    business_account exige a referência da conta (nunca deduzida da routing
--    key); canal sem referência confiável → account_reference_unverified;
--  - grava o evento operacional (sem telefone, routing key, referência da
--    conta, payload, BSUID ou cifra) e atualiza last_event_at;
--  - SÓ whatsapp.phone_number.deleted e whatsapp.business_account.deleted
--    desconectam (active/paused → disconnected, send_enabled=false,
--    provider_status_event_at, auditoria sanitizada); evento igual ou
--    anterior a provider_status_event_at é stale_event; disabled nunca é
--    reativado nem rebaixado; os demais tipos só são registrados;
--  - canal paused/disconnected/disabled não bloqueia o efeito;
--  - qualquer falha desfaz tudo.
--
-- Escrito ANTES da implementação, contra a main ff13405. Tudo fictício:
-- nenhum telefone, conta ou identidade real. As chamadas passam por funções
-- que capturam o erro: contra a main, o arquivo roda até o fim.

begin;
select plan(65);

\set ana     '20000000-0000-0000-0000-000000000001'
\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'
\set inventado '7d1e2f3a-4b5c-4d6e-8f70-819a2b3c4d5f'
\set cifra   'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB'
\set t1000   '2026-10-30 10:00:00+00'
\set t1050   '2026-10-30 10:50:00+00'
\set t1100   '2026-10-30 11:00:00+00'
\set t1200   '2026-10-30 12:00:00+00'
\set t1300   '2026-10-30 13:00:00+00'
\set t1400   '2026-10-30 14:00:00+00'

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

-- Texto de uma consulta, ou 'ERRO:<sqlstate>:<mensagem>'.
create function pg_temp.txt(p_sql text) returns text language plpgsql as $f$
declare
  v text;
begin
  execute p_sql into v;
  return coalesce(v, 'NULL');
exception when others then
  return 'ERRO:' || sqlstate || ':' || sqlerrm;
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

-- Escrita direta: 'ok' ou o sqlstate.
create function pg_temp.st(p_sql text) returns text language plpgsql as $f$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end
$f$;

select pg_temp.hdr('preview') as h_prev \gset
select pg_temp.hdr('production') as h_prod \gset
select set_config('request.headers', :'h_prev', true);

-- Canal da B3 com a referência técnica da conta (inserção direta: a criação
-- real do canal YCloud ainda não existe). 'ok' ou o erro.
create function pg_temp.mk(p_id text, p_ref text, p_routing text, p_status text default 'active', p_send boolean default true,
  p_pse timestamptz default null, p_last timestamptz default null, p_ws text default '10000000-0000-0000-0000-000000000001',
  p_env text default 'preview', p_provider text default 'ycloud') returns text language plpgsql as $f$
begin
  insert into public.whatsapp_channels (id, workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment,
    routing_key, status, send_enabled, status_changed_at, provider_account_ref, provider_status_event_at, last_event_at)
  values (p_id::uuid, p_ws::uuid, 'Canal fictício', '1', '20000000-0000-0000-0000-000000000001', p_provider::public.whatsapp_provider,
    p_provider = 'simulated', p_env::public.whatsapp_environment, p_routing, p_status, p_send, '2026-01-01 00:00:00+00', p_ref, p_pse, p_last);
  return 'ok';
exception when others then
  return 'ERRO:' || sqlerrm;
end
$f$;

create function pg_temp.cid(n integer) returns text language sql as $f$
  select '3e300000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0')
$f$;

create function pg_temp.rk(p_ch text) returns text language sql as $f$
  select routing_key from public.whatsapp_channels where id = p_ch::uuid
$f$;

-- Entrada da inbox (cifra fictícia) no canal e, se pedido, o claim: 'id|token'.
create function pg_temp.ent(p_ch text, p_evt text, p_type text, p_claim boolean default true) returns text language plpgsql as $f$
declare
  v_ch public.whatsapp_channels;
  v_id text;
  v_token text;
begin
  select * into v_ch from public.whatsapp_channels where id = p_ch::uuid;
  execute 'set local role service_role';
  v_id := public.whatsapp_inbox_store(v_ch.id, v_ch.workspace_id, v_ch.provider, v_ch.routing_key, p_evt, p_type,
    repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8=', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id';
  if p_claim then
    v_token := public.whatsapp_inbox_claim(v_id::uuid, 300) ->> 'claim_token';
  end if;
  execute 'reset role';
  return v_id || '|' || coalesce(v_token, '-');
exception when others then
  return 'ERRO:' || sqlerrm;
end
$f$;

-- Chamada crua do efeito como service_role: o jsonb, ou {"erro": ...}.
create function pg_temp.ac(p_entry text, p_scope text, p_type text, p_ref text, p_rk text, p_at text, p_code text,
  p_token text default null) returns jsonb language plpgsql as $f$
declare
  v jsonb;
begin
  execute 'set local role service_role';
  execute format(
    'select public.whatsapp_effect_account_event(%L::uuid, %L::uuid, %L, %L, %L, %L, %L::timestamptz, %L)',
    split_part(p_entry, '|', 1), coalesce(p_token, nullif(split_part(p_entry, '|', 2), '-')),
    p_scope, p_type, p_ref, p_rk, p_at, p_code) into v;
  execute 'reset role';
  return coalesce(v, 'null'::jsonb);
exception when others then
  return jsonb_build_object('erro', sqlerrm);
end
$f$;

-- Resultado em texto: o outcome, ou ERRO:<mensagem>.
create function pg_temp.oc(p jsonb) returns text language sql as $f$
  select coalesce(p ->> 'outcome', 'ERRO:' || coalesce(p ->> 'erro', p::text))
$f$;

-- Entrada nova + efeito de uma vez. O escopo phone_number leva a routing key
-- do canal; business_account, nenhuma.
create function pg_temp.go(p_ch text, p_evt text, p_type text, p_scope text, p_ref text, p_at text, p_code text default null)
  returns text language sql as $f$
  select pg_temp.oc(pg_temp.ac(pg_temp.ent(p_ch, p_evt, p_type), p_scope, p_type, p_ref,
    case when p_scope = 'phone_number' then pg_temp.rk(p_ch) end, p_at, p_code))
$f$;

create function pg_temp.ts(p timestamptz) returns text language sql as $f$
  select coalesce(to_char(p at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'), '-')
$f$;

-- Canal: status|send_enabled|provider_status_event_at|last_event_at|status_changed_at (novo = mudou nesta transação).
create function pg_temp.chs(p_ch text) returns text language plpgsql as $f$
declare
  v text;
begin
  execute format($q$select concat_ws('|', status, send_enabled::text, pg_temp.ts(provider_status_event_at), pg_temp.ts(last_event_at),
      case when status_changed_at >= transaction_timestamp() then 'novo' else 'antigo' end)
    from public.whatsapp_channels where id = %L::uuid$q$, p_ch) into v;
  return coalesce(v, 'NULL');
exception when others then
  return 'ERRO:' || sqlerrm;
end
$f$;

-- Linha inteira do canal, em hash: prova que nada mudou.
create function pg_temp.chrow(p_ch text) returns text language sql as $f$
  select coalesce((select md5(c::text) from public.whatsapp_channels c where c.id = p_ch::uuid), 'NULL')
$f$;

-- Resultados dos eventos gravados do canal, na ordem do horário.
create function pg_temp.evs(p_ch text) returns text language plpgsql as $f$
declare
  v text;
begin
  execute format($q$select coalesce(string_agg(result, ',' order by occurred_at, provider_event_id), '-')
    from public.whatsapp_channel_events where channel_id = %L::uuid$q$, p_ch) into v;
  return v;
exception when others then
  return 'ERRO:' || sqlerrm;
end
$f$;

create function pg_temp.nev() returns text language plpgsql as $f$
declare
  v text;
begin
  execute 'select count(*)::text from public.whatsapp_channel_events' into v;
  return v;
exception when others then
  return 'ERRO:' || sqlerrm;
end
$f$;

create function pg_temp.lgr(p_ch text) returns text language sql as $f$
  select count(*)::text from public.whatsapp_effect_ledger where channel_id = p_ch::uuid
$f$;

-- Auditorias de desconexão do canal.
create function pg_temp.aud(p_ch text) returns text language sql as $f$
  select count(*)::text from public.audit_logs where resource_id = p_ch::uuid and action = 'whatsapp.channel.disconnected'
$f$;

-- Estado da entrada: state|token.
create function pg_temp.inb(p_entry text) returns text language plpgsql as $f$
declare
  v text;
begin
  select state || '|' || coalesce(claim_token::text, '-') into v from public.whatsapp_webhook_inbox where id = split_part(p_entry, '|', 1)::uuid;
  return coalesce(v, 'NULL');
exception when others then
  return 'ERRO';
end
$f$;

create function pg_temp.dom() returns text language sql as $f$
  select concat_ws('|',
    (select count(*) from public.whatsapp_identities), (select count(*) from public.conversations),
    (select count(*) from public.messages), (select count(*) from public.contacts),
    (select count(*) from public.leads), (select count(*) from public.opportunities),
    (select count(*) from public.activities), (select count(*) from public.audit_logs),
    (select count(*) from public.whatsapp_effect_ledger), (select count(*) from public.whatsapp_webhook_inbox))
$f$;

-- Registros comerciais e de conversa (linhas inteiras): prova que nada mudou.
create function pg_temp.com() returns text language sql as $f$
  select md5(concat_ws('#',
    (select string_agg(x::text, ',' order by x::text) from public.contacts x),
    (select string_agg(x::text, ',' order by x::text) from public.contact_phones x),
    (select string_agg(x::text, ',' order by x::text) from public.contact_identifiers x),
    (select string_agg(x::text, ',' order by x::text) from public.leads x),
    (select string_agg(x::text, ',' order by x::text) from public.opportunities x),
    (select string_agg(x::text, ',' order by x::text) from public.activities x),
    (select string_agg(x::text, ',' order by x::text) from public.conversations x),
    (select string_agg(x::text, ',' order by x::text) from public.messages x),
    (select string_agg(x::text, ',' order by x::text) from public.whatsapp_identities x)))
$f$;

-- Inserção direta de um evento operacional com o contexto da inbox e
-- sobrescritas: o sqlstate, ou 'ok'.
create function pg_temp.ie(p_inbox text, p_over jsonb default '{}') returns text language plpgsql as $f$
declare
  i public.whatsapp_webhook_inbox;
begin
  select * into i from public.whatsapp_webhook_inbox where id = split_part(p_inbox, '|', 1)::uuid;
  insert into public.whatsapp_channel_events (inbox_id, workspace_id, channel_id, environment, provider, provider_event_id,
    provider_type, scope, code, occurred_at, result)
  values (i.id,
    coalesce((p_over ->> 'workspace_id')::uuid, i.workspace_id),
    coalesce((p_over ->> 'channel_id')::uuid, i.channel_id),
    coalesce((p_over ->> 'environment')::public.whatsapp_environment, i.environment),
    coalesce((p_over ->> 'provider')::public.whatsapp_provider, i.provider),
    coalesce(p_over ->> 'provider_event_id', i.provider_event_id),
    coalesce(p_over ->> 'provider_type', 'whatsapp.phone_number.quality_updated'),
    coalesce(p_over ->> 'scope', 'phone_number'),
    case when p_over ? 'code' then p_over ->> 'code' else 'GREEN' end,
    '2026-10-30 12:00:00+00',
    coalesce(p_over ->> 'result', 'recorded'));
  return 'ok';
exception when others then
  return sqlstate;
end
$f$;

create function pg_temp.mkst(p_id text, p_ref text, p_routing text, p_env text default 'preview') returns text language plpgsql as $f$
begin
  insert into public.whatsapp_channels (id, workspace_id, label, phone_number_id, display_phone_number, created_by, provider, is_simulator,
    environment, routing_key, provider_account_ref)
  values (p_id::uuid, '10000000-0000-0000-0000-000000000001', 'x',
    case when p_env = 'legacy' then 'legado-' || p_id end, '1', '20000000-0000-0000-0000-000000000001',
    (case when p_env = 'legacy' then 'simulated' else 'ycloud' end)::public.whatsapp_provider, p_env = 'legacy',
    case when p_env = 'legacy' then null else p_env::public.whatsapp_environment end, p_routing, p_ref);
  return 'ok';
exception when others then
  return sqlstate;
end
$f$;

-- ---------------------------------------------------------------------
-- Canais de partida (todos fictícios, ws_um, Preview, YCloud)
-- ---------------------------------------------------------------------

select pg_temp.mk(pg_temp.cid(1), 'WABA-A1', 'WABA-A1:+5511900050001') as r \gset
select pg_temp.mk(pg_temp.cid(2), 'WABA-A1', 'WABA-A1:+5511900050002') as r \gset
select pg_temp.mk(pg_temp.cid(3), null, 'WABA-A1:+5511900050003') as r \gset
select pg_temp.mk(pg_temp.cid(4), 'WABA-B2', 'WABA-B2:+5511900050004') as r \gset
select pg_temp.mk(pg_temp.cid(5), 'REF-NUNCA-EXPOR', 'rota-sem-a-conta') as r \gset
select pg_temp.mk(pg_temp.cid(6), 'WABA-C3', 'WABA-C3:+5511900050006', 'active', true, '2026-10-30 12:00:00+00', '2026-10-30 12:30:00+00') as r \gset
select pg_temp.mk(pg_temp.cid(7), 'WABA-D4', 'WABA-D4:+5511900050007', 'active', true, null, null, :'ws_dois') as r \gset
select pg_temp.mk(pg_temp.cid(8), 'WABA-E5', 'WABA-E5:+5511900050008') as r \gset
select pg_temp.mk(pg_temp.cid(9), 'WABA-F6', 'WABA-F6:+5511900050009') as r \gset

-- ---------------------------------------------------------------------
-- 1) Estrutura, permissões e proteção da identidade do canal
-- ---------------------------------------------------------------------

select is(
  pg_temp.txt($$select pg_get_function_identity_arguments('public.whatsapp_effect_account_event'::regproc)$$),
  'p_inbox_id uuid, p_claim_token uuid, p_scope text, p_provider_type text, p_provider_account_ref text, p_routing_key text, p_occurred_at timestamp with time zone, p_code text',
  'assinatura: inbox, token e só os dados do evento da conta — nenhum workspace, canal, ambiente, provedor, id do evento nem telefone do escritório'
);
select is(
  pg_temp.txt($$select (p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""'))::text
    from pg_proc p where p.oid = 'public.whatsapp_effect_account_event'::regproc$$),
  'true', 'SECURITY DEFINER com search_path vazio'
);
select is(
  pg_temp.txt($$select has_function_privilege('service_role', 'public.whatsapp_effect_account_event'::regproc, 'execute')::text || ' '
    || has_function_privilege('authenticated', 'public.whatsapp_effect_account_event'::regproc, 'execute')::text || ' '
    || has_function_privilege('anon', 'public.whatsapp_effect_account_event'::regproc, 'execute')::text$$),
  'true false false', 'EXECUTE só para service_role'
);
select is(
  pg_temp.txt($$select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns
    where table_schema = 'public' and table_name = 'whatsapp_channel_events'$$),
  'id,inbox_id,workspace_id,channel_id,environment,provider,provider_event_id,provider_type,scope,code,occurred_at,result,created_at',
  'whatsapp_channel_events guarda só o necessário: nenhum telefone, routing key, referência da conta, payload, texto, BSUID, segredo ou cifra'
);
select is(
  pg_temp.txt($$select concat_ws(' ', c.relrowsecurity::text, c.relforcerowsecurity::text,
      has_table_privilege('service_role', c.oid, 'select')::text, has_table_privilege('service_role', c.oid, 'insert')::text,
      has_table_privilege('service_role', c.oid, 'update')::text, has_table_privilege('service_role', c.oid, 'delete')::text,
      has_table_privilege('authenticated', c.oid, 'select')::text, has_table_privilege('anon', c.oid, 'select')::text)
    from pg_class c where c.oid = 'public.whatsapp_channel_events'::regclass$$),
  'true true false false false false false false',
  'tabela deny-all: RLS ligada e forçada; nenhum privilégio para service_role, authenticated ou anon'
);
set local role service_role;
select is(
  pg_temp.txt($$select count(*) from public.whatsapp_channel_events$$) like 'ERRO:42501%',
  true, 'service_role não lê a tabela diretamente'
);
reset role;
select is(
  pg_temp.txt($$select count(*)::text || ' ' || bool_and((qual = 'false' or with_check = 'false'))::text from pg_policies
    where schemaname = 'public' and tablename = 'whatsapp_channel_events' and roles = '{authenticated}'$$),
  '4 true', 'quatro políticas, todas negando authenticated'
);
select is(
  pg_temp.txt($$select string_agg(pg_get_constraintdef(oid), ' ; ' order by conname) from pg_constraint
    where conrelid = 'public.whatsapp_channel_events'::regclass and contype = 'f'
      and conname in ('whatsapp_channel_events_channel_identity_fkey', 'whatsapp_channel_events_inbox_fkey')$$),
  'FOREIGN KEY (workspace_id, channel_id, environment, provider) REFERENCES whatsapp_channels(workspace_id, id, environment, provider) ON DELETE RESTRICT ; '
  || 'FOREIGN KEY (inbox_id, workspace_id, channel_id, environment, provider, provider_event_id) REFERENCES whatsapp_webhook_inbox(id, workspace_id, channel_id, environment, provider, provider_event_id)',
  'FKs compostas: o canal (workspace, ambiente e provedor) e a inbox inteira (workspace, canal, ambiente, provedor e id do evento), sem cascata'
);
select is(
  pg_temp.txt($$select count(*)::text from pg_constraint where conrelid = 'public.whatsapp_channel_events'::regclass
    and contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (inbox_id)'$$),
  '1', 'um evento operacional por entrada da inbox'
);

select pg_temp.ent(pg_temp.cid(1), 'evt-ck', 'whatsapp.phone_number.quality_updated', false) as e_ck \gset
select is(
  concat_ws(' ',
    pg_temp.ie(:'e_ck', '{"provider_type": "WhatsApp.Phone_Number.Quality"}'),
    pg_temp.ie(:'e_ck', '{"provider_type": "whatsapp phone"}'),
    pg_temp.ie(:'e_ck', jsonb_build_object('provider_type', 'whatsapp.phone_number.' || repeat('a', 107))),
    pg_temp.ie(:'e_ck', '{"scope": "account"}'),
    pg_temp.ie(:'e_ck', '{"result": "disconnected"}'),
    pg_temp.ie(:'e_ck', '{"code": ""}'),
    pg_temp.ie(:'e_ck', jsonb_build_object('code', repeat('c', 65))),
    pg_temp.ie(:'e_ck', jsonb_build_object('code', 'ab' || chr(9) || 'cd')),
    pg_temp.ie(:'e_ck', jsonb_build_object('code', 'ab' || chr(10) || 'cd')),
    pg_temp.ie(:'e_ck', jsonb_build_object('code', 'ab' || chr(127) || 'cd')),
    pg_temp.ie(:'e_ck')),
  '23514 23514 23514 23514 23514 23514 23514 23514 23514 23514 ok',
  'provider_type, scope, result e code com limites e sem caractere de controle (no próprio banco); o evento válido é aceito'
);
select pg_temp.ent(pg_temp.cid(1), 'evt-fk', 'whatsapp.phone_number.quality_updated', false) as e_fk \gset
select is(
  concat_ws(' ',
    pg_temp.ie(:'e_fk', jsonb_build_object('workspace_id', :'ws_dois')),
    pg_temp.ie(:'e_fk', jsonb_build_object('channel_id', pg_temp.cid(2))),
    pg_temp.ie(:'e_fk', '{"environment": "production"}'),
    pg_temp.ie(:'e_fk', '{"provider": "simulated"}'),
    pg_temp.ie(:'e_fk', '{"provider_event_id": "outro-evento"}'),
    pg_temp.ie(pg_temp.ent(pg_temp.cid(1), 'evt-fk-2', 'whatsapp.phone_number.quality_updated', false), jsonb_build_object('channel_id', pg_temp.cid(2)))),
  '23503 23503 23503 23503 23503 23503',
  'o evento só entra com a inbox do MESMO workspace, canal, ambiente, provedor e id de evento (nunca só inbox_id)'
);
select pg_temp.ent(pg_temp.cid(9), 'evt-del', 'whatsapp.phone_number.quality_updated', false) as e_del \gset
select pg_temp.ie(:'e_del') as r \gset
select is(
  pg_temp.st(format($$delete from public.whatsapp_webhook_inbox where id = %L$$, split_part(:'e_del', '|', 1))) || ' '
  || pg_temp.st(format($$delete from public.whatsapp_channels where id = %L$$, pg_temp.cid(9))),
  '23503 23503', 'a inbox e o canal de um evento operacional não podem ser removidos (nunca deixam referência solta)'
);

select is(
  pg_temp.txt($$select string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '-'), ',' order by column_name)
    from information_schema.columns where table_schema = 'public' and table_name = 'whatsapp_channels'
      and column_name in ('provider_account_ref', 'last_event_at', 'provider_status_event_at')$$),
  'last_event_at:timestamp with time zone:YES:-,provider_account_ref:text:YES:-,provider_status_event_at:timestamp with time zone:YES:-',
  'whatsapp_channels ganha a referência da conta e as duas datas operacionais, anuláveis e sem valor padrão'
);
select is(
  concat_ws(' ',
    pg_temp.up(format($$update public.whatsapp_channels set provider_account_ref = 'WABA-Z9' where id = %L$$, pg_temp.cid(1))),
    pg_temp.up(format($$update public.whatsapp_channels set provider_account_ref = null where id = %L$$, pg_temp.cid(1))),
    pg_temp.up(format($$update public.whatsapp_channels set provider_account_ref = 'WABA-A1' where id = %L$$, pg_temp.cid(3))),
    pg_temp.up(format($$update public.whatsapp_channels set label = 'Outro nome' where id = %L$$, pg_temp.cid(1)))),
  'channel_identity_immutable channel_identity_immutable channel_identity_immutable ok',
  'a referência da conta é imutável depois da criação (trocar, apagar ou preencher depois); o resto do canal continua editável'
);
select is(
  concat_ws(' ',
    pg_temp.mkst(pg_temp.cid(21), 'WABA com espaço', 'rota-21'),
    pg_temp.mkst(pg_temp.cid(22), repeat('a', 65), 'rota-22'),
    pg_temp.mkst(pg_temp.cid(23), '', 'rota-23'),
    pg_temp.mkst(pg_temp.cid(24), '-comeca-com-hifen', 'rota-24'),
    pg_temp.mkst(pg_temp.cid(25), 'WABA-LEGADA', 'rota-25', 'legacy'),
    pg_temp.mkst(pg_temp.cid(26), 'WABA-OK.1_2-x', 'rota-26'),
    pg_temp.mkst(pg_temp.cid(27), null, 'rota-27')),
  '23514 23514 23514 23514 23514 ok ok',
  'a referência tem formato neutro (até 64 caracteres, sem espaço nem controle) e nunca fica num canal legado da A7; sem referência continua permitido'
);
select is(
  concat_ws(' ',
    pg_temp.up(format($$update public.whatsapp_channels set last_event_at = last_event_at - interval '1 second' where id = %L$$, pg_temp.cid(6))),
    pg_temp.up(format($$update public.whatsapp_channels set last_event_at = null where id = %L$$, pg_temp.cid(6))),
    pg_temp.up(format($$update public.whatsapp_channels set provider_status_event_at = provider_status_event_at - interval '1 second' where id = %L$$, pg_temp.cid(6))),
    pg_temp.up(format($$update public.whatsapp_channels set provider_status_event_at = null where id = %L$$, pg_temp.cid(6))),
    pg_temp.up(format($$update public.whatsapp_channels set last_event_at = last_event_at + interval '1 second', provider_status_event_at = provider_status_event_at where id = %L$$, pg_temp.cid(6))),
    pg_temp.up(format($$update public.whatsapp_channels set last_event_at = '2026-10-30 10:00:00+00', provider_status_event_at = '2026-10-30 10:00:00+00' where id = %L$$, pg_temp.cid(8)))),
  'channel_clock_regression channel_clock_regression channel_clock_regression channel_clock_regression ok ok',
  'last_event_at e provider_status_event_at nunca regridem nem voltam a nulo (nem por escrita direta); avançar e preencher pela primeira vez é permitido'
);
set local role service_role;
select is(
  (select concat_ws(' ', (position('"routing_key"' in t) > 0)::text, (position('REF-NUNCA-EXPOR' in t) = 0)::text, (position('provider_account_ref' in t) = 0)::text,
    (position('last_event_at' in t) = 0)::text, (position('provider_status_event_at' in t) = 0)::text)
   from (select pg_temp.txt(format($$select (whatsapp_get_channel_state(%L::uuid, %L::uuid, %L::uuid))::text$$, pg_temp.cid(5), :'ws_um', :'ana')) as t) x),
  'true true true true true',
  'a leitura segura do canal não expõe a referência da conta nem as datas operacionais'
);
reset role;

-- ---------------------------------------------------------------------
-- 2) Claim: estado, token, lease e ambiente
-- ---------------------------------------------------------------------

select pg_temp.mk(pg_temp.cid(10), 'WABA-A1', 'WABA-A1:+5511900050010') as r \gset
select pg_temp.ent(pg_temp.cid(10), 'evt-pend', 'whatsapp.phone_number.quality_updated', false) as e_pend \gset
select pg_temp.ent(pg_temp.cid(10), 'evt-tok', 'whatsapp.phone_number.quality_updated') as e_tok \gset
select pg_temp.ent(pg_temp.cid(10), 'evt-lease', 'whatsapp.phone_number.quality_updated') as e_lease \gset
select pg_temp.up(format($$update public.whatsapp_webhook_inbox set claimed_at = clock_timestamp() - interval '10 minutes', lease_until = clock_timestamp() - interval '1 second'
  where id = %L::uuid$$, split_part(:'e_lease', '|', 1))) as r \gset
select coalesce(pg_temp.rk(pg_temp.cid(10)), 'sem-canal') as rk10 \gset
select pg_temp.dom() || ' ' || pg_temp.nev() as snap0 \gset
select pg_temp.chrow(pg_temp.cid(10)) as row10 \gset

select is(
  pg_temp.oc(pg_temp.ac(:'e_pend', 'phone_number', 'whatsapp.phone_number.quality_updated', 'WABA-A1', :'rk10', :'t1200', 'GREEN')),
  'claim_lost', 'entrada sem claim (pending): claim_lost'
);
select is(
  pg_temp.oc(pg_temp.ac(:'e_tok', 'phone_number', 'whatsapp.phone_number.quality_updated', 'WABA-A1', :'rk10', :'t1200', 'GREEN', :'inventado')) || ' '
  || pg_temp.oc(pg_temp.ac(split_part(:'e_tok', '|', 1) || '|-', 'phone_number', 'whatsapp.phone_number.quality_updated', 'WABA-A1', :'rk10', :'t1200', 'GREEN')),
  'claim_lost claim_lost', 'token inventado ou ausente: claim_lost'
);
select is(
  pg_temp.oc(pg_temp.ac(:'e_lease', 'phone_number', 'whatsapp.phone_number.quality_updated', 'WABA-A1', :'rk10', :'t1200', 'GREEN')),
  'claim_lost', 'lease vencida: claim_lost'
);
select set_config('request.headers', :'h_prod', true);
select is(
  pg_temp.oc(pg_temp.ac(:'e_tok', 'phone_number', 'whatsapp.phone_number.quality_updated', 'WABA-A1', :'rk10', :'t1200', 'GREEN')),
  'not_found', 'autenticado em outro ambiente (Production): not_found'
);
select set_config('request.headers', '', true);
select is(
  pg_temp.oc(pg_temp.ac(:'e_tok', 'phone_number', 'whatsapp.phone_number.quality_updated', 'WABA-A1', :'rk10', :'t1200', 'GREEN')),
  'ERRO:whatsapp_environment_required', 'sem ambiente autenticado: recusado'
);
select set_config('request.headers', :'h_prev', true);
select is(
  pg_temp.oc(pg_temp.ac(:'inventado' || '|' || :'inventado', 'phone_number', 'whatsapp.phone_number.quality_updated', 'WABA-A1', :'rk10', :'t1200', 'GREEN'))
  || ' ' || pg_temp.oc(pg_temp.ac(null, 'phone_number', 'whatsapp.phone_number.quality_updated', 'WABA-A1', :'rk10', :'t1200', 'GREEN')),
  'not_found not_found', 'inbox inexistente ou nula: not_found'
);
select is(
  pg_temp.dom() || ' ' || pg_temp.nev() || ' ' || pg_temp.chrow(pg_temp.cid(10)) || ' ' || pg_temp.inb(:'e_tok') || ' ' || pg_temp.inb(:'e_pend'),
  :'snap0' || ' ' || :'row10' || ' processing|' || split_part(:'e_tok', '|', 2) || ' pending|-',
  'nenhuma recusa escreveu nada nem mexeu no canal ou na inbox'
);

select pg_temp.ent(pg_temp.cid(10), 'evt-proc', 'whatsapp.phone_number.quality_updated') as e_proc \gset
select pg_temp.ent(pg_temp.cid(10), 'evt-fail', 'whatsapp.phone_number.quality_updated') as e_fail \gset
select pg_temp.up(format($$update public.whatsapp_webhook_inbox set state = 'processed', processed_at = now(), claim_token = null, claimed_at = null, lease_until = null
  where id = %L::uuid$$, split_part(:'e_proc', '|', 1))) as r \gset
select pg_temp.up(format($$update public.whatsapp_webhook_inbox set state = 'failed', failed_at = now(), error_code = 'teste', claim_token = null, claimed_at = null, lease_until = null
  where id = %L::uuid$$, split_part(:'e_fail', '|', 1))) as r \gset
select is(
  pg_temp.oc(pg_temp.ac(:'e_proc', 'phone_number', 'whatsapp.phone_number.quality_updated', 'WABA-A1', :'rk10', :'t1200', 'GREEN', :'inventado')) || ' '
  || pg_temp.oc(pg_temp.ac(:'e_fail', 'phone_number', 'whatsapp.phone_number.quality_updated', 'WABA-A1', :'rk10', :'t1200', 'GREEN', :'inventado')),
  'already_processed terminal_failed', 'entrada já processada: already_processed; entrada falha: terminal_failed (sem mudar nada)'
);

-- ---------------------------------------------------------------------
-- 3) Validação fechada, antes de qualquer trava ou escrita
-- ---------------------------------------------------------------------

select pg_temp.dom() || ' ' || pg_temp.nev() as snap0b \gset

select is(
  (select string_agg(pg_temp.oc(pg_temp.ac(:'e_tok', v.scope, v.typ, v.ref, v.rk, v.at, v.code)), ',' order by v.n)
   from (values
     (1, null::text, 'whatsapp.phone_number.quality_updated'::text, 'WABA-A1'::text, 'WABA-A1:+5511900050010'::text, '2026-10-30 12:00:00+00'::text, 'GREEN'::text),
     (2, 'account', 'whatsapp.phone_number.quality_updated', 'WABA-A1', 'WABA-A1:+5511900050010', '2026-10-30 12:00:00+00', 'GREEN'),
     (3, 'PHONE_NUMBER', 'whatsapp.phone_number.quality_updated', 'WABA-A1', 'WABA-A1:+5511900050010', '2026-10-30 12:00:00+00', 'GREEN'),
     (4, 'phone_number', null, 'WABA-A1', 'WABA-A1:+5511900050010', '2026-10-30 12:00:00+00', 'GREEN'),
     (5, 'phone_number', 'WhatsApp.Phone_Number.Quality_Updated', 'WABA-A1', 'WABA-A1:+5511900050010', '2026-10-30 12:00:00+00', 'GREEN'),
     (6, 'phone_number', 'whatsapp.phone_number.quality updated', 'WABA-A1', 'WABA-A1:+5511900050010', '2026-10-30 12:00:00+00', 'GREEN'),
     (7, 'phone_number', 'whatsapp.phone_number.' || repeat('a', 107), 'WABA-A1', 'WABA-A1:+5511900050010', '2026-10-30 12:00:00+00', 'GREEN'),
     (8, 'phone_number', 'whatsapp.phone_number.quality' || chr(9) || 'updated', 'WABA-A1', 'WABA-A1:+5511900050010', '2026-10-30 12:00:00+00', 'GREEN'),
     (9, 'phone_number', 'whatsapp.template.updated', 'WABA-A1', 'WABA-A1:+5511900050010', '2026-10-30 12:00:00+00', 'GREEN'),
     (10, 'phone_number', 'whatsapp.phone_number.quality_updated', null, 'WABA-A1:+5511900050010', '2026-10-30 12:00:00+00', 'GREEN'),
     (11, 'phone_number', 'whatsapp.phone_number.quality_updated', 'WABA A1', 'WABA-A1:+5511900050010', '2026-10-30 12:00:00+00', 'GREEN'),
     (12, 'phone_number', 'whatsapp.phone_number.quality_updated', '-WABA', 'WABA-A1:+5511900050010', '2026-10-30 12:00:00+00', 'GREEN'),
     (13, 'phone_number', 'whatsapp.phone_number.quality_updated', repeat('a', 65), 'WABA-A1:+5511900050010', '2026-10-30 12:00:00+00', 'GREEN'),
     (14, 'phone_number', 'whatsapp.phone_number.quality_updated', '', 'WABA-A1:+5511900050010', '2026-10-30 12:00:00+00', 'GREEN'),
     (15, 'phone_number', 'whatsapp.phone_number.quality_updated', 'WABA' || chr(10) || 'A1', 'WABA-A1:+5511900050010', '2026-10-30 12:00:00+00', 'GREEN'),
     (16, 'phone_number', 'whatsapp.phone_number.quality_updated', 'WABA-A1', 'WABA-A1:+5511900050010', null, 'GREEN'),
     (17, 'phone_number', 'whatsapp.phone_number.quality_updated', 'WABA-A1', 'WABA-A1:+5511900050010', 'infinity', 'GREEN'),
     (18, 'phone_number', 'whatsapp.phone_number.quality_updated', 'WABA-A1', 'WABA-A1:+5511900050010', '2026-10-30 12:00:00+00', ''),
     (19, 'phone_number', 'whatsapp.phone_number.quality_updated', 'WABA-A1', 'WABA-A1:+5511900050010', '2026-10-30 12:00:00+00', repeat('c', 65)),
     (20, 'phone_number', 'whatsapp.phone_number.quality_updated', 'WABA-A1', 'WABA-A1:+5511900050010', '2026-10-30 12:00:00+00', 'GR' || chr(9) || 'EEN'),
     (21, 'phone_number', 'whatsapp.phone_number.quality_updated', 'WABA-A1', 'WABA-A1:+5511900050010', '2026-10-30 12:00:00+00', 'GR' || chr(10) || 'EEN'),
     (22, 'phone_number', 'whatsapp.phone_number.quality_updated', 'WABA-A1', 'WABA-A1:+5511900050010', '2026-10-30 12:00:00+00', 'GR' || chr(127) || 'EEN'),
     (23, 'phone_number', 'whatsapp.phone_number.quality_updated', 'WABA-A1', null, '2026-10-30 12:00:00+00', 'GREEN'),
     (24, 'phone_number', 'whatsapp.phone_number.quality_updated', 'WABA-A1', '', '2026-10-30 12:00:00+00', 'GREEN'),
     (25, 'phone_number', 'whatsapp.phone_number.quality_updated', 'WABA-A1', repeat('r', 129), '2026-10-30 12:00:00+00', 'GREEN'),
     (26, 'phone_number', 'whatsapp.phone_number.quality_updated', 'WABA-A1', 'WABA-A1:+55' || chr(9) || '11900050010', '2026-10-30 12:00:00+00', 'GREEN'),
     (27, 'business_account', 'whatsapp.business_account.updated', 'WABA-A1', 'WABA-A1:+5511900050010', '2026-10-30 12:00:00+00', 'GREEN'),
     (28, 'business_account', 'whatsapp.phone_number.deleted', 'WABA-A1', null, '2026-10-30 12:00:00+00', null),
     (29, 'phone_number', 'whatsapp.business_account.deleted', 'WABA-A1', 'WABA-A1:+5511900050010', '2026-10-30 12:00:00+00', null),
     (30, 'phone_number', 'whatsapp.phone_number.name_updated', 'WABA-A1', 'WABA-A1:+5511900050010', '2026-10-30 12:00:00+00', 'GREEN')
   ) v(n, scope, typ, ref, rk, at, code)),
  (select string_agg('ERRO:invalid_account_event', ',') from generate_series(1, 30)),
  'entrada fora do contrato (escopo, tipo, conta, roteamento, data, code; tipo diferente do gravado na inbox): invalid_account_event, sem vazar valor'
);
select is(
  pg_temp.dom() || ' ' || pg_temp.nev() || ' ' || pg_temp.chrow(pg_temp.cid(10)) || ' ' || pg_temp.inb(:'e_tok'),
  :'snap0b' || ' ' || :'row10' || ' processing|' || split_part(:'e_tok', '|', 2),
  'entrada inválida: nada escrito, claim intacto'
);

-- Tipo e escopo de lados trocados, com o MESMO tipo gravado na inbox: só o
-- prefixo do tipo barra. Sem ele, a exclusão do NÚMERO com o escopo da conta
-- passaria só pela conferência da conta (sem routing key) e desconectaria o
-- canal; e a exclusão da CONTA com o escopo do número, idem.
select pg_temp.ent(pg_temp.cid(10), 'evt-x1', 'whatsapp.phone_number.deleted') as e_x1 \gset
select pg_temp.ent(pg_temp.cid(10), 'evt-x2', 'whatsapp.business_account.deleted') as e_x2 \gset
select pg_temp.dom() || ' ' || pg_temp.nev() as snap0c \gset
select pg_temp.oc(pg_temp.ac(:'e_x1', 'business_account', 'whatsapp.phone_number.deleted', 'WABA-A1', null, :'t1200', null)) as ox1 \gset
select pg_temp.oc(pg_temp.ac(:'e_x2', 'phone_number', 'whatsapp.business_account.deleted', 'WABA-A1', :'rk10', :'t1200', null)) as ox2 \gset
select is(
  :'ox1' || ' ' || :'ox2' || ' ' || (pg_temp.dom() || ' ' || pg_temp.nev() = :'snap0c')::text || ' ' || pg_temp.chs(pg_temp.cid(10)),
  'ERRO:invalid_account_event ERRO:invalid_account_event true active|true|-|-|antigo',
  'exclusão do número com o escopo da conta (ou a da conta com o escopo do número): invalid_account_event, o canal não é desconectado'
);

-- ---------------------------------------------------------------------
-- 4) Validação do destino: roteamento e conta, nada gravado na divergência
-- ---------------------------------------------------------------------

select pg_temp.mk(pg_temp.cid(11), 'WABA-A1', 'WABA-A1:+5511900050011') as r \gset
select pg_temp.mk(pg_temp.cid(12), null, 'WABA-A1:+5511900050012') as r \gset
select pg_temp.ent(pg_temp.cid(11), 'evt-d11', 'whatsapp.phone_number.deleted') as e_d11 \gset
select pg_temp.ent(pg_temp.cid(11), 'evt-b11', 'whatsapp.business_account.deleted') as e_b11 \gset
select pg_temp.ent(pg_temp.cid(12), 'evt-d12', 'whatsapp.phone_number.deleted') as e_d12 \gset
select pg_temp.ent(pg_temp.cid(12), 'evt-b12', 'whatsapp.business_account.deleted') as e_b12 \gset
select coalesce(pg_temp.rk(pg_temp.cid(11)), 'sem-canal') as rk11 \gset
select coalesce(pg_temp.rk(pg_temp.cid(12)), 'sem-canal') as rk12 \gset
select pg_temp.dom() || ' ' || pg_temp.nev() as snap1 \gset
select pg_temp.chrow(pg_temp.cid(11)) || pg_temp.chrow(pg_temp.cid(12)) as row11 \gset

select is(
  concat_ws(',',
    pg_temp.oc(pg_temp.ac(:'e_d11', 'phone_number', 'whatsapp.phone_number.deleted', 'WABA-A1', 'WABA-A1:+5511900059999', :'t1200', null)),
    pg_temp.oc(pg_temp.ac(:'e_d11', 'phone_number', 'whatsapp.phone_number.deleted', 'WABA-A1', lower(:'rk11'), :'t1200', null)),
    pg_temp.oc(pg_temp.ac(:'e_d11', 'phone_number', 'whatsapp.phone_number.deleted', 'WABA-A1', :'rk11' || ' ', :'t1200', null)),
    pg_temp.oc(pg_temp.ac(:'e_d11', 'phone_number', 'whatsapp.phone_number.deleted', 'WABA-X9', :'rk11', :'t1200', null)),
    pg_temp.oc(pg_temp.ac(:'e_d11', 'phone_number', 'whatsapp.phone_number.deleted', 'waba-a1', :'rk11', :'t1200', null)),
    pg_temp.oc(pg_temp.ac(:'e_d11', 'phone_number', 'whatsapp.phone_number.deleted', 'WABA-X9', 'WABA-A1:+5511900059999', :'t1200', null)),
    pg_temp.oc(pg_temp.ac(:'e_b11', 'business_account', 'whatsapp.business_account.deleted', 'WABA-X9', null, :'t1200', null)),
    pg_temp.oc(pg_temp.ac(:'e_d12', 'phone_number', 'whatsapp.phone_number.deleted', 'WABA-A1', :'rk12', :'t1200', null)),
    pg_temp.oc(pg_temp.ac(:'e_b12', 'business_account', 'whatsapp.business_account.deleted', 'WABA-A1', null, :'t1200', null)),
    pg_temp.oc(pg_temp.ac(:'e_d12', 'phone_number', 'whatsapp.phone_number.deleted', 'WABA-A1', 'WABA-A1:+5511900059999', :'t1200', null))),
  'routing_mismatch,routing_mismatch,routing_mismatch,account_reference_mismatch,account_reference_mismatch,routing_mismatch,account_reference_mismatch,'
  || 'account_reference_unverified,account_reference_unverified,routing_mismatch',
  'routing key exata (maiúsculas e espaço contam), conta igual à do canal, routing antes da conta; canal sem referência: unverified nos dois escopos — a conta nunca é deduzida da routing key'
);
select is(
  pg_temp.dom() || ' ' || pg_temp.nev() || ' ' || pg_temp.chrow(pg_temp.cid(11)) || pg_temp.chrow(pg_temp.cid(12)),
  :'snap1' || ' ' || :'row11',
  'divergência de roteamento ou de conta: nada gravado (nenhum evento, ledger, auditoria ou mudança no canal)'
);
select is(
  pg_temp.inb(:'e_d11') || ' ' || pg_temp.inb(:'e_b11') || ' ' || pg_temp.inb(:'e_d12') || ' ' || pg_temp.inb(:'e_b12'),
  'processing|' || split_part(:'e_d11', '|', 2) || ' processing|' || split_part(:'e_b11', '|', 2) || ' processing|' || split_part(:'e_d12', '|', 2)
  || ' processing|' || split_part(:'e_b12', '|', 2),
  'as entradas continuam em processing com o mesmo claim (a B3.2d-2b3 decide fail ou release)'
);
select is(
  pg_temp.oc(pg_temp.ac(:'e_d11', 'phone_number', 'whatsapp.phone_number.deleted', 'WABA-A1', :'rk11', :'t1200', null)) || ' ' || pg_temp.chs(pg_temp.cid(11)),
  'applied disconnected|false|2026-10-30T12:00:00|2026-10-30T12:00:00|novo',
  'depois da divergência a mesma entrada, agora com a conta certa, aplica (a reserva do ledger tinha sido desfeita)'
);

-- ---------------------------------------------------------------------
-- 5) Exclusão: os dois únicos tipos que desconectam o canal
-- ---------------------------------------------------------------------

select pg_temp.mk(pg_temp.cid(30), 'WABA-A1', 'WABA-A1:+5511900050030') as r \gset
select pg_temp.mk(pg_temp.cid(31), 'WABA-A1', 'WABA-A1:+5511900050031') as r \gset
select pg_temp.mk(pg_temp.cid(32), 'WABA-A1', 'WABA-A1:+5511900050032', 'paused', false) as r \gset
select pg_temp.mk(pg_temp.cid(33), 'WABA-A1', 'WABA-A1:+5511900050033', 'disconnected', false, :'t1000', :'t1000') as r \gset
select pg_temp.mk(pg_temp.cid(34), 'WABA-A1', 'WABA-A1:+5511900050034') as r \gset
select pg_temp.mk(pg_temp.cid(35), 'WABA-A1', 'WABA-A1:+5511900050035', 'active', true, :'t1300', :'t1300') as r \gset
select pg_temp.mk(pg_temp.cid(36), 'WABA-A1', 'WABA-A1:+5511900050036') as r \gset
select pg_temp.mk(pg_temp.cid(37), 'WABA-A1', 'WABA-A1:+5511900050037') as r \gset
select pg_temp.mk(pg_temp.cid(38), 'WABA-G7', 'WABA-G7:+5511900050038') as r \gset
select pg_temp.mk(pg_temp.cid(39), 'WABA-G7', 'WABA-G7:+5511900050039') as r \gset
select pg_temp.com() as com0 \gset

-- phone_number.deleted num canal ativo.
select pg_temp.ent(pg_temp.cid(30), 'evt-a', 'whatsapp.phone_number.deleted') as e_a \gset
select pg_temp.oc(pg_temp.ac(:'e_a', 'phone_number', 'whatsapp.phone_number.deleted', 'WABA-A1', pg_temp.rk(pg_temp.cid(30)), :'t1200', null)) as o_a \gset
select is(
  :'o_a' || ' ' || pg_temp.chs(pg_temp.cid(30)) || ' ' || pg_temp.evs(pg_temp.cid(30)) || ' ' || pg_temp.lgr(pg_temp.cid(30)) || ' ' || pg_temp.aud(pg_temp.cid(30)),
  'applied disconnected|false|2026-10-30T12:00:00|2026-10-30T12:00:00|novo applied 1 1',
  'phone_number.deleted em canal ativo: disconnected, send_enabled=false, provider_status_event_at e last_event_at = horário do provedor, status_changed_at = horário do CRM; um evento, um ledger, uma auditoria'
);
select is(
  pg_temp.txt(format($$select concat_ws(' ', l.effect, i.state, coalesce(i.claim_token::text, '-'), (i.processed_at >= transaction_timestamp())::text,
      (c.status_changed_at <> c.provider_status_event_at)::text)
    from public.whatsapp_effect_ledger l join public.whatsapp_webhook_inbox i on i.id = l.inbox_id
    join public.whatsapp_channels c on c.id = l.channel_id where l.channel_id = %L$$, pg_temp.cid(30))),
  'account processed - true true',
  'ledger com o efeito account; a inbox termina processed na mesma transação, sem claim; o relógio do CRM não é o do provedor'
);

-- business_account.deleted num canal ativo; o código não decide nada.
select pg_temp.go(pg_temp.cid(31), 'evt-b', 'whatsapp.business_account.deleted', 'business_account', 'WABA-A1', :'t1200', 'USER_REQUEST') as o_b \gset
select is(
  :'o_b' || ' ' || pg_temp.chs(pg_temp.cid(31)) || ' ' || pg_temp.evs(pg_temp.cid(31)) || ' ' || pg_temp.lgr(pg_temp.cid(31)) || ' ' || pg_temp.aud(pg_temp.cid(31)),
  'applied disconnected|false|2026-10-30T12:00:00|2026-10-30T12:00:00|novo applied 1 1',
  'business_account.deleted em canal ativo: o mesmo resultado, com a conta conferida (sem routing key)'
);

-- Canal pausado: pausa não bloqueia; vira disconnected.
select pg_temp.go(pg_temp.cid(32), 'evt-c', 'whatsapp.phone_number.deleted', 'phone_number', 'WABA-A1', :'t1200') as o_c \gset
select is(
  :'o_c' || ' ' || pg_temp.chs(pg_temp.cid(32)) || ' ' || pg_temp.evs(pg_temp.cid(32)) || ' ' || pg_temp.aud(pg_temp.cid(32)),
  'applied disconnected|false|2026-10-30T12:00:00|2026-10-30T12:00:00|novo applied 1',
  'canal pausado: a exclusão desconecta (paused → disconnected)'
);

-- Canal já desconectado: nada de transição nova.
select pg_temp.go(pg_temp.cid(33), 'evt-d', 'whatsapp.phone_number.deleted', 'phone_number', 'WABA-A1', :'t1200') as o_d \gset
select is(
  :'o_d' || ' ' || pg_temp.chs(pg_temp.cid(33)) || ' ' || pg_temp.evs(pg_temp.cid(33)) || ' ' || pg_temp.aud(pg_temp.cid(33)),
  'recorded disconnected|false|2026-10-30T10:00:00|2026-10-30T12:00:00|antigo recorded 0',
  'canal já desconectado: segue disconnected e sem envio, o evento é registrado, nenhuma transição nem auditoria nova (provider_status_event_at fica)'
);

-- Canal desativado (disabled): nunca reativado nem rebaixado.
select pg_temp.ent(pg_temp.cid(34), 'evt-e', 'whatsapp.phone_number.deleted') as e_e \gset
update public.whatsapp_channels set status = 'disabled', send_enabled = false where id = pg_temp.cid(34)::uuid;
select pg_temp.oc(pg_temp.ac(:'e_e', 'phone_number', 'whatsapp.phone_number.deleted', 'WABA-A1', pg_temp.rk(pg_temp.cid(34)), :'t1200', null)) as o_e \gset
select is(
  :'o_e' || ' ' || pg_temp.chs(pg_temp.cid(34)) || ' ' || pg_temp.evs(pg_temp.cid(34)) || ' ' || pg_temp.aud(pg_temp.cid(34)) || ' ' || pg_temp.inb(:'e_e'),
  'recorded disabled|false|-|2026-10-30T12:00:00|antigo recorded 0 processed|-',
  'canal desativado: segue disabled (nunca reativado nem trocado por disconnected), o evento da entrada legítima é registrado como observado'
);

-- Evento antigo ou igual a provider_status_event_at: stale_event.
select pg_temp.go(pg_temp.cid(35), 'evt-f1', 'whatsapp.phone_number.deleted', 'phone_number', 'WABA-A1', :'t1200') as o_f1 \gset
select pg_temp.go(pg_temp.cid(35), 'evt-f2', 'whatsapp.phone_number.deleted', 'phone_number', 'WABA-A1', :'t1300') as o_f2 \gset
select is(
  :'o_f1' || ',' || :'o_f2' || ' ' || pg_temp.chs(pg_temp.cid(35)) || ' ' || pg_temp.evs(pg_temp.cid(35)) || ' ' || pg_temp.lgr(pg_temp.cid(35)) || ' ' || pg_temp.aud(pg_temp.cid(35)),
  'stale_event,stale_event active|true|2026-10-30T13:00:00|2026-10-30T13:00:00|antigo stale_event,stale_event 2 0',
  'exclusão anterior ou igual ao último evento de estado: stale_event, registrada, sem mudar o canal nem auditar; last_event_at não regride'
);

-- Sequência: aplicada, mais nova (registrada), mais antiga (stale).
select pg_temp.go(pg_temp.cid(36), 'evt-g1', 'whatsapp.phone_number.deleted', 'phone_number', 'WABA-A1', :'t1200') as o_g1 \gset
select pg_temp.go(pg_temp.cid(36), 'evt-g2', 'whatsapp.phone_number.deleted', 'phone_number', 'WABA-A1', :'t1400') as o_g2 \gset
select pg_temp.go(pg_temp.cid(36), 'evt-g3', 'whatsapp.phone_number.deleted', 'phone_number', 'WABA-A1', :'t1100') as o_g3 \gset
select is(
  :'o_g1' || ',' || :'o_g2' || ',' || :'o_g3' || ' ' || pg_temp.chs(pg_temp.cid(36)) || ' ' || pg_temp.evs(pg_temp.cid(36)) || ' ' || pg_temp.aud(pg_temp.cid(36)),
  'applied,recorded,stale_event disconnected|false|2026-10-30T12:00:00|2026-10-30T14:00:00|novo stale_event,applied,recorded 1',
  'três exclusões: aplicada, mais nova só registrada, mais antiga stale; uma única transição auditada; provider_status_event_at é o da que decidiu'
);

-- Um evento antigo nunca regride o estado, mesmo depois de o canal voltar a active (reconexão futura).
select pg_temp.go(pg_temp.cid(37), 'evt-h1', 'whatsapp.phone_number.deleted', 'phone_number', 'WABA-A1', :'t1200') as o_h1 \gset
update public.whatsapp_channels set status = 'active' where id = pg_temp.cid(37)::uuid;
select pg_temp.go(pg_temp.cid(37), 'evt-h2', 'whatsapp.phone_number.deleted', 'phone_number', 'WABA-A1', :'t1100') as o_h2 \gset
select pg_temp.chs(pg_temp.cid(37)) as s_h2 \gset
select pg_temp.go(pg_temp.cid(37), 'evt-h3', 'whatsapp.phone_number.deleted', 'phone_number', 'WABA-A1', :'t1300') as o_h3 \gset
select is(
  :'o_h1' || ',' || :'o_h2' || ',' || :'o_h3' || ' ' || :'s_h2' || ' ' || pg_temp.chs(pg_temp.cid(37)) || ' ' || pg_temp.aud(pg_temp.cid(37)),
  'applied,stale_event,applied active|false|2026-10-30T12:00:00|2026-10-30T12:00:00|novo disconnected|false|2026-10-30T13:00:00|2026-10-30T13:00:00|novo 2',
  'canal religado: o evento antigo é stale (continua active); um evento mais novo volta a desconectar (nova transição, nova auditoria)'
);

-- Só o canal da inbox muda, mesmo com a mesma conta em outro canal.
select pg_temp.go(pg_temp.cid(38), 'evt-i', 'whatsapp.business_account.deleted', 'business_account', 'WABA-G7', :'t1200') as o_i \gset
select is(
  :'o_i' || ' ' || pg_temp.chs(pg_temp.cid(38)) || ' ' || pg_temp.chs(pg_temp.cid(39)) || ' ' || pg_temp.evs(pg_temp.cid(39)),
  'applied disconnected|false|2026-10-30T12:00:00|2026-10-30T12:00:00|novo active|true|-|-|antigo -',
  'o efeito age no canal da própria inbox: outro canal da mesma conta não é tocado'
);

-- ---------------------------------------------------------------------
-- 6) Os demais tipos só são registrados
-- ---------------------------------------------------------------------

select pg_temp.mk(pg_temp.cid(40), 'WABA-A1', 'WABA-A1:+5511900050040') as r \gset
select pg_temp.mk(pg_temp.cid(41), 'WABA-A1', 'WABA-A1:+5511900050041', 'paused', false) as r \gset
select pg_temp.mk(pg_temp.cid(42), 'WABA-A1', 'WABA-A1:+5511900050042', 'disconnected', false) as r \gset
select pg_temp.mk(pg_temp.cid(43), 'WABA-A1', 'WABA-A1:+5511900050043') as r \gset
select pg_temp.go(pg_temp.cid(40), 'evt-o1', 'whatsapp.business_account.updated', 'business_account', 'WABA-A1', :'t1100', 'VERIFIED_NAME') as o1 \gset
select pg_temp.go(pg_temp.cid(40), 'evt-o2', 'whatsapp.business_account.reviewed', 'business_account', 'WABA-A1', :'t1200', 'REJECTED') as o2 \gset
select pg_temp.go(pg_temp.cid(40), 'evt-o3', 'whatsapp.phone_number.name_updated', 'phone_number', 'WABA-A1', :'t1300', 'DECLINED') as o3 \gset
select is(
  :'o1' || ',' || :'o2' || ',' || :'o3' || ' ' || pg_temp.chs(pg_temp.cid(40)),
  'recorded,recorded,recorded active|true|-|2026-10-30T13:00:00|antigo',
  'eventos observados: registrados sem mudar status, envio nem provider_status_event_at; last_event_at avança'
);
select pg_temp.go(pg_temp.cid(40), 'evt-o4', 'whatsapp.phone_number.quality_updated', 'phone_number', 'WABA-A1', :'t1000', 'RED') as o4 \gset
select pg_temp.go(pg_temp.cid(40), 'evt-o5', 'whatsapp.phone_number.business_username_updated', 'phone_number', 'WABA-A1', :'t1400', 'BLOCKED') as o5 \gset
select pg_temp.go(pg_temp.cid(40), 'evt-o6', 'whatsapp.phone_number.something_new', 'phone_number', 'WABA-A1', :'t1050', 'DISCONNECTED') as o6 \gset
select is(
  :'o4' || ',' || :'o5' || ',' || :'o6' || ' ' || pg_temp.chs(pg_temp.cid(40)) || ' ' || pg_temp.evs(pg_temp.cid(40)) || ' ' || pg_temp.lgr(pg_temp.cid(40)) || ' ' || pg_temp.aud(pg_temp.cid(40)),
  'recorded,recorded,recorded active|true|-|2026-10-30T14:00:00|antigo recorded,recorded,recorded,recorded,recorded,recorded 6 0',
  'qualidade vermelha, nome recusado, usuário bloqueado ou código "DISCONNECTED" não mudam o canal (o código é opaco); tipo novo é registrado; um evento antigo não regride last_event_at'
);
select pg_temp.go(pg_temp.cid(41), 'evt-p1', 'whatsapp.phone_number.quality_updated', 'phone_number', 'WABA-A1', :'t1200', 'GREEN') as p1 \gset
select pg_temp.go(pg_temp.cid(42), 'evt-p2', 'whatsapp.business_account.updated', 'business_account', 'WABA-A1', :'t1200', 'APPROVED') as p2 \gset
select pg_temp.ent(pg_temp.cid(43), 'evt-p3', 'whatsapp.phone_number.name_updated') as e_p3 \gset
update public.whatsapp_channels set status = 'disabled', send_enabled = false where id = pg_temp.cid(43)::uuid;
select pg_temp.oc(pg_temp.ac(:'e_p3', 'phone_number', 'whatsapp.phone_number.name_updated', 'WABA-A1', pg_temp.rk(pg_temp.cid(43)), :'t1200', 'APPROVED')) as p3 \gset
select is(
  :'p1' || ',' || :'p2' || ',' || :'p3' || ' ' || pg_temp.chs(pg_temp.cid(41)) || ' ' || pg_temp.chs(pg_temp.cid(42)) || ' ' || pg_temp.chs(pg_temp.cid(43)),
  'recorded,recorded,recorded paused|false|-|2026-10-30T12:00:00|antigo disconnected|false|-|2026-10-30T12:00:00|antigo disabled|false|-|2026-10-30T12:00:00|antigo',
  'canal pausado, desconectado ou desativado: o evento observado é registrado e o estado continua exatamente o mesmo (nada reativa)'
);

-- ---------------------------------------------------------------------
-- 7) O que fica gravado: só o operacional, sem dado pessoal
-- ---------------------------------------------------------------------

select is(
  pg_temp.txt(format($$select concat_ws('|', workspace_id, channel_id, environment, provider, provider_event_id, provider_type, scope, coalesce(code, '-'), result)
    from public.whatsapp_channel_events where channel_id = %L$$, pg_temp.cid(31))),
  :'ws_um' || '|' || pg_temp.cid(31) || '|preview|ycloud|evt-b|whatsapp.business_account.deleted|business_account|USER_REQUEST|applied',
  'o evento grava o contexto da própria inbox (workspace, canal, ambiente, provedor, id do evento) e o código sanitizado'
);
select is(
  pg_temp.txt($$select (count(*) > 0)::text || ' ' || bool_and(position('WABA' in t) = 0 and position('+55' in t) = 0 and position('Q29y' in t) = 0
      and position('payload' in t) = 0 and position('rota' in t) = 0)::text
    from (select row_to_json(e)::text as t from public.whatsapp_channel_events e) x$$),
  'true true', 'nenhuma linha operacional guarda telefone, routing key, referência da conta, cifra ou payload'
);
select is(
  pg_temp.txt($$select string_agg(k, ',' order by k) from (select distinct jsonb_object_keys(metadata) as k from public.audit_logs
    where action = 'whatsapp.channel.disconnected') x$$),
  'environment,from_status,provider,provider_type,scope,send_enabled_before,source,to_status',
  'a auditoria da desconexão só tem estados e tipos técnicos'
);
select is(
  pg_temp.txt($$select concat_ws(' ', (count(*) > 0)::text, bool_and(actor_user_id is null)::text, bool_and(resource_type = 'whatsapp_channel')::text,
      bool_and(metadata ->> 'source' = 'whatsapp_webhook')::text,
      bool_and(position('WABA' in metadata::text) = 0 and position('+55' in metadata::text) = 0 and position('USER_REQUEST' in metadata::text) = 0
        and position('Q29y' in metadata::text) = 0)::text)
    from public.audit_logs where action = 'whatsapp.channel.disconnected'$$),
  'true true true true true',
  'auditoria com ator nulo e origem whatsapp_webhook, sem conta, routing key, telefone, código nem cifra'
);
select pg_temp.mk(pg_temp.cid(44), 'WABA-A1', 'WABA-A1:+5511900050044') as r \gset
select pg_temp.mk(pg_temp.cid(45), 'WABA-A1', 'WABA-A1:+5511900050045') as r \gset
select pg_temp.ac(pg_temp.ent(pg_temp.cid(44), 'evt-r1', 'whatsapp.phone_number.deleted'), 'phone_number', 'whatsapp.phone_number.deleted', 'WABA-A1',
  pg_temp.rk(pg_temp.cid(44)), :'t1200', 'ANY') as raw1 \gset
select pg_temp.ac(pg_temp.ent(pg_temp.cid(45), 'evt-r2', 'whatsapp.phone_number.deleted'), 'phone_number', 'whatsapp.phone_number.deleted', 'WABA-X9',
  pg_temp.rk(pg_temp.cid(45)), :'t1200', 'ANY') as raw2 \gset
select is(
  :'raw1'::jsonb::text || ' ' || :'raw2'::jsonb::text,
  '{"outcome": "applied"} {"outcome": "account_reference_mismatch"}',
  'a resposta só tem o outcome: nenhum telefone, routing key, conta, código, id ou credencial'
);

-- ---------------------------------------------------------------------
-- 8) Idempotência: reentrega, duplicata e efeito em conflito
-- ---------------------------------------------------------------------

select is(
  pg_temp.oc(pg_temp.ac(:'e_a', 'phone_number', 'whatsapp.phone_number.deleted', 'WABA-A1', pg_temp.rk(pg_temp.cid(30)), :'t1200', null))
  || ' ' || pg_temp.evs(pg_temp.cid(30)) || ' ' || pg_temp.lgr(pg_temp.cid(30)) || ' ' || pg_temp.aud(pg_temp.cid(30)),
  'already_processed applied 1 1',
  'reentrega da mesma entrada: already_processed, nada repetido (um evento, um ledger, uma auditoria)'
);
select pg_temp.mk(pg_temp.cid(46), 'WABA-A1', 'WABA-A1:+5511900050046') as r \gset
select pg_temp.ent(pg_temp.cid(46), 'evt-dup', 'whatsapp.phone_number.deleted') as e_dup \gset
select pg_temp.up(format($$select private.whatsapp_effect_ledger_reserve(%L::uuid, 'account')$$, split_part(:'e_dup', '|', 1))) as r \gset
select pg_temp.chrow(pg_temp.cid(46)) as row46 \gset
select is(
  pg_temp.oc(pg_temp.ac(:'e_dup', 'phone_number', 'whatsapp.phone_number.deleted', 'WABA-A1', pg_temp.rk(pg_temp.cid(46)), :'t1200', null))
  || ' ' || split_part(pg_temp.inb(:'e_dup'), '|', 1) || ' ' || pg_temp.evs(pg_temp.cid(46)) || ' ' || pg_temp.lgr(pg_temp.cid(46)) || ' ' || pg_temp.aud(pg_temp.cid(46))
  || ' ' || (pg_temp.chrow(pg_temp.cid(46)) = :'row46')::text,
  'duplicate processed - 1 0 true',
  'efeito já reservado para esta entrada: duplicate, a entrada é finalizada e nada se repete'
);
select pg_temp.mk(pg_temp.cid(47), 'WABA-A1', 'WABA-A1:+5511900050047') as r \gset
select pg_temp.ent(pg_temp.cid(47), 'evt-conf', 'whatsapp.phone_number.deleted') as e_conf \gset
select pg_temp.up(format($$select private.whatsapp_effect_ledger_reserve(%L::uuid, 'message.status')$$, split_part(:'e_conf', '|', 1))) as r \gset
select pg_temp.chrow(pg_temp.cid(47)) as row47 \gset
select is(
  pg_temp.oc(pg_temp.ac(:'e_conf', 'phone_number', 'whatsapp.phone_number.deleted', 'WABA-A1', pg_temp.rk(pg_temp.cid(47)), :'t1200', null))
  || ' ' || split_part(pg_temp.inb(:'e_conf'), '|', 1) || ' ' || pg_temp.evs(pg_temp.cid(47)) || ' ' || pg_temp.lgr(pg_temp.cid(47)) || ' ' || pg_temp.aud(pg_temp.cid(47))
  || ' ' || (pg_temp.chrow(pg_temp.cid(47)) = :'row47')::text,
  'effect_conflict processing - 1 0 true',
  'a chave estável já tem outro efeito: effect_conflict, nada gravado, entrada em processing'
);

-- ---------------------------------------------------------------------
-- 9) Atomicidade: falha depois do ledger ou do evento desfaz tudo
-- ---------------------------------------------------------------------

select pg_temp.mk(pg_temp.cid(48), 'WABA-A1', 'WABA-A1:+5511900050048') as r \gset
select pg_temp.mk(pg_temp.cid(49), 'WABA-A1', 'WABA-A1:+5511900050049') as r \gset
select pg_temp.up($q$create function public.b3d2b2b3b_falha() returns trigger language plpgsql as $f$ begin raise exception 'falha_simulada'; end $f$$q$) as r \gset
select pg_temp.up('create trigger b3d2b2b3b_falha_ev before insert on public.whatsapp_channel_events for each row execute function public.b3d2b2b3b_falha()') as r \gset
select pg_temp.ent(pg_temp.cid(48), 'evt-rb1', 'whatsapp.phone_number.deleted') as e_rb1 \gset
select pg_temp.chrow(pg_temp.cid(48)) as row48 \gset
select is(
  pg_temp.oc(pg_temp.ac(:'e_rb1', 'phone_number', 'whatsapp.phone_number.deleted', 'WABA-A1', pg_temp.rk(pg_temp.cid(48)), :'t1200', null))
  || ' ' || (pg_temp.chrow(pg_temp.cid(48)) = :'row48')::text || ' ' || pg_temp.lgr(pg_temp.cid(48)) || ' ' || pg_temp.evs(pg_temp.cid(48))
  || ' ' || pg_temp.aud(pg_temp.cid(48)) || ' ' || pg_temp.inb(:'e_rb1'),
  'ERRO:falha_simulada true 0 - 0 processing|' || split_part(:'e_rb1', '|', 2),
  'falha ao gravar o evento (depois do ledger): nada sobrevive — nem ledger, nem evento, nem auditoria, nem mudança no canal; a entrada segue em processing'
);
select pg_temp.up('drop trigger b3d2b2b3b_falha_ev on public.whatsapp_channel_events') as r \gset
select is(
  pg_temp.oc(pg_temp.ac(:'e_rb1', 'phone_number', 'whatsapp.phone_number.deleted', 'WABA-A1', pg_temp.rk(pg_temp.cid(48)), :'t1200', null))
  || ' ' || pg_temp.chs(pg_temp.cid(48)) || ' ' || pg_temp.lgr(pg_temp.cid(48)),
  'applied disconnected|false|2026-10-30T12:00:00|2026-10-30T12:00:00|novo 1',
  'sem a falha, a mesma entrada aplica'
);
select pg_temp.up('create trigger b3d2b2b3b_falha_ch before update on public.whatsapp_channels for each row when (new.status = ''disconnected'') execute function public.b3d2b2b3b_falha()') as r \gset
select pg_temp.ent(pg_temp.cid(49), 'evt-rb2', 'whatsapp.phone_number.deleted') as e_rb2 \gset
select pg_temp.chrow(pg_temp.cid(49)) as row49 \gset
select is(
  pg_temp.oc(pg_temp.ac(:'e_rb2', 'phone_number', 'whatsapp.phone_number.deleted', 'WABA-A1', pg_temp.rk(pg_temp.cid(49)), :'t1200', null))
  || ' ' || (pg_temp.chrow(pg_temp.cid(49)) = :'row49')::text || ' ' || pg_temp.lgr(pg_temp.cid(49)) || ' ' || pg_temp.evs(pg_temp.cid(49))
  || ' ' || pg_temp.aud(pg_temp.cid(49)) || ' ' || pg_temp.inb(:'e_rb2'),
  'ERRO:falha_simulada true 0 - 0 processing|' || split_part(:'e_rb2', '|', 2),
  'falha ao desconectar o canal (depois do ledger e do evento): nada sobrevive, nem o evento já gravado'
);
select pg_temp.up('drop trigger b3d2b2b3b_falha_ch on public.whatsapp_channels') as r \gset
select pg_temp.up('drop function public.b3d2b2b3b_falha()') as r \gset
select is(
  pg_temp.oc(pg_temp.ac(:'e_rb2', 'phone_number', 'whatsapp.phone_number.deleted', 'WABA-A1', pg_temp.rk(pg_temp.cid(49)), :'t1200', null))
  || ' ' || pg_temp.chs(pg_temp.cid(49)) || ' ' || pg_temp.evs(pg_temp.cid(49)) || ' ' || pg_temp.aud(pg_temp.cid(49)),
  'applied disconnected|false|2026-10-30T12:00:00|2026-10-30T12:00:00|novo applied 1',
  'sem a falha, a mesma entrada aplica (um evento, uma auditoria)'
);

-- ---------------------------------------------------------------------
-- 10) Isolamento: ambiente, permissões e nada comercial
-- ---------------------------------------------------------------------

select is(
  pg_temp.com(), :'com0',
  'nenhum evento da conta criou ou alterou contato, telefone, identificador, identidade, conversa, mensagem, lead, oportunidade ou atividade'
);

select pg_temp.mk(pg_temp.cid(50), 'WABA-P1', 'WABA-P1:+5511900050050', 'active', true, null, null, :'ws_um', 'production') as r \gset
select set_config('request.headers', :'h_prod', true);
select pg_temp.ent(pg_temp.cid(50), 'evt-prod', 'whatsapp.phone_number.deleted') as e_prod \gset
select set_config('request.headers', :'h_prev', true);
select pg_temp.oc(pg_temp.ac(:'e_prod', 'phone_number', 'whatsapp.phone_number.deleted', 'WABA-P1', pg_temp.rk(pg_temp.cid(50)), :'t1200', null)) as o_prod1 \gset
select pg_temp.chs(pg_temp.cid(50)) as s_prod1 \gset
select set_config('request.headers', :'h_prod', true);
select pg_temp.oc(pg_temp.ac(:'e_prod', 'phone_number', 'whatsapp.phone_number.deleted', 'WABA-P1', pg_temp.rk(pg_temp.cid(50)), :'t1200', null)) as o_prod2 \gset
select pg_temp.chs(pg_temp.cid(50)) as s_prod2 \gset
select set_config('request.headers', :'h_prev', true);
select is(
  :'o_prod1' || ' ' || :'s_prod1' || ' ' || :'o_prod2' || ' ' || :'s_prod2',
  'not_found active|true|-|-|antigo applied disconnected|false|2026-10-30T12:00:00|2026-10-30T12:00:00|novo',
  'ambiente oposto: a entrada de Production não é alcançada com o ambiente Preview (nada muda); com o ambiente certo aplica só no canal de Production'
);

set local role authenticated;
select pg_temp.txt(format($$select public.whatsapp_effect_account_event(%L::uuid, %L::uuid, 'phone_number', 'whatsapp.phone_number.deleted', 'WABA-A1', 'k', now(), null)$$,
  :'inventado', :'inventado')) as x_auth \gset
reset role;
set local role anon;
select pg_temp.txt(format($$select public.whatsapp_effect_account_event(%L::uuid, %L::uuid, 'phone_number', 'whatsapp.phone_number.deleted', 'WABA-A1', 'k', now(), null)$$,
  :'inventado', :'inventado')) as x_anon \gset
reset role;
select is(
  (:'x_auth' like 'ERRO:42501%')::text || ' ' || (:'x_anon' like 'ERRO:42501%')::text,
  'true true', 'authenticated e anon não executam o efeito (permission denied)'
);

-- A7 intacta: o canal legado continua sem os campos novos e o simulador funciona.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select (create_whatsapp_channel(:'ws_um'::uuid, 'Simulador (2b2b3b)', 'b3d2b2b3b-leg', '+55 11 0000-0305')).id as canal_legado \gset
select simulate_inbound_whatsapp_message('b3d2b2b3b-leg', '5511900009911', '+5511900009911', 'wamid.b3d2b2b3b.1', now(), 'Mensagem fictícia', 'Pessoa Fictícia') ->> 'message_id' as msg_legada \gset
reset role;
select set_config('request.jwt.claims', '', true);
select is(
  pg_temp.txt(format($$select concat_ws('|', (provider_account_ref is null)::text, (last_event_at is null)::text, (provider_status_event_at is null)::text,
      coalesce(environment::text, 'sem-ambiente'), provider::text) from public.whatsapp_channels where id = %L$$, :'canal_legado')),
  'true|true|true|sem-ambiente|simulated',
  'canal legado da A7: sem referência nem datas operacionais, como antes'
);
select isnt(:'msg_legada'::text, null::text, 'o simulador da A7 continua recebendo mensagem');

-- ---------------------------------------------------------------------
-- 11) Contrato no corpo da função
-- ---------------------------------------------------------------------

-- A lease é conferida de novo, com o relógio de agora, logo depois da ÚLTIMA
-- trava (inbox, canal e workspace) e antes da primeira escrita (a reserva do
-- ledger). Sem comentários e com o espaço normalizado.
select is(
  pg_temp.txt($q$
    with f as (
      select regexp_replace(lower(regexp_replace(p.prosrc, '--[^\n]*', '', 'g')), '\s+', ' ', 'g') as s
      from pg_proc p where p.oid = 'public.whatsapp_effect_account_event'::regproc
    ), k as (
      select 'v_now := clock_timestamp(); if v_row.lease_until is null or v_row.lease_until <= v_now then return jsonb_build_object(''outcome'', ''claim_lost''); end if;' as chk_text,
             'begin select r.outcome, r.ledger_id into v_reserve from private.whatsapp_effect_ledger_reserve(v_row.id, ''account'') r;' as next_text
    ), l as (
      select f.s, k.chk_text, k.next_text,
             regexp_instr(f.s, '\m(for (update|share|key share|no key update)|pg_advisory_xact_lock)\M', 1,
                          regexp_count(f.s, '\m(for (update|share|key share|no key update)|pg_advisory_xact_lock)\M')) as last_lock
      from f, k
    ), c as (
      select s, chk_text, next_text, last_lock,
             last_lock + strpos(substr(s, last_lock), ';') - 1 as end_lock,
             strpos(s, chk_text) as chk,
             regexp_instr(s, '\m(update public\.|insert into|delete from|set_config\(|whatsapp_effect_ledger_reserve)') as first_write
      from l
    )
    select concat_ws(' ',
      (chk > 0 and btrim(substr(s, end_lock + 1, chk - end_lock - 1)) = '')::text,
      (chk > 0 and first_write > chk)::text,
      (chk > 0 and starts_with(btrim(substr(s, chk + length(chk_text))), next_text))::text)
    from c
  $q$),
  'true true true',
  'a lease é conferida de novo, com relógio novo, logo depois da última trava e antes da primeira escrita (a reserva do ledger)'
);
-- Travas: inbox, canal (FOR UPDATE) e workspace (chave protegida), nessa ordem,
-- todas antes da conferência tardia.
select is(
  pg_temp.txt($q$
    with f as (
      select regexp_replace(lower(regexp_replace(p.prosrc, '--[^\n]*', '', 'g')), '\s+', ' ', 'g') as s
      from pg_proc p where p.oid = 'public.whatsapp_effect_account_event'::regproc
    ), k as (
      select 'from public.whatsapp_webhook_inbox i where i.id = p_inbox_id and i.environment = v_env for update' as t_inbox,
             'from public.whatsapp_channels c where c.id = v_row.channel_id and c.workspace_id = v_row.workspace_id and c.environment = v_row.environment and c.provider = v_row.provider for update' as t_channel,
             'from public.workspaces w where w.id = v_row.workspace_id for key share' as t_ws,
             'v_now := clock_timestamp(); if v_row.lease_until' as t_chk
    )
    select concat_ws(' ',
      (strpos(s, t_inbox) > 0 and strpos(s, t_channel) > 0 and strpos(s, t_ws) > 0)::text,
      (strpos(s, t_inbox) < strpos(s, t_channel) and strpos(s, t_channel) < strpos(s, t_ws) and strpos(s, t_ws) < strpos(s, t_chk))::text)
    from f, k
  $q$),
  'true true',
  'o canal é travado com FOR UPDATE e o workspace com FOR KEY SHARE, depois da inbox e antes da conferência tardia'
);
-- O domínio não interpreta a routing key da YCloud, não deduz a conta dela e
-- não toca dado comercial; canal paused/disconnected/disabled não bloqueia.
select is(
  pg_temp.txt($q$
    with f as (
      select regexp_replace(lower(regexp_replace(p.prosrc, '--[^\n]*', '', 'g')), '\s+', ' ', 'g') as s
      from pg_proc p where p.oid = 'public.whatsapp_effect_account_event'::regproc
    )
    select concat_ws(' ',
      (s !~ '(split_part|string_to_array|regexp_(split|match|replace)|strpos|position\(|substr\(|substring\(|like )')::text,
      (s !~ '(contacts|contact_phones|contact_identifiers|leads|opportunities|activities|conversations|messages|whatsapp_identities)')::text,
      (s !~ '(channel_paused|channel_disconnected|channel_disabled|business_phone|phone_e164)')::text)
    from f
  $q$),
  'true true true',
  'a função não divide a routing key, não toca dado comercial nem telefone, e não bloqueia por estado do canal'
);

select * from finish();
rollback;
