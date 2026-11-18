-- pgTAP — Conversas + IA, PR 2: leitura da caixa de entrada (list_conversation_inbox).
--
-- Prova: superfície (só authenticated, nada de público), autenticação e papel, filtro
-- pela situação do atendimento (inclusive "nao_informado" para dado legado, sem
-- inferência), contagens por situação sobre TODO o conjunto alcançável (não só a página),
-- paginação com total estável, busca por contato/telefone/área sem tratar % _ \ do
-- usuário como curinga, alcance IGUAL ao da list_conversations em cada papel, isolamento
-- entre escritórios, leitura que não escreve nada e list_conversations inalterada.
--
-- Fixtures do seed: ana=owner, carla=lawyer, elisa=viewer no Escritório Um; bruno=owner e
-- carla=sales no Escritório Dois; daniel sem membership. Aqui: bruno=sales e
-- daniel=manager no Escritório Um. Todos os dados são sintéticos.

begin;
select plan(52);

\set ana    '20000000-0000-0000-0000-000000000001'
\set bruno  '20000000-0000-0000-0000-000000000002'
\set carla  '20000000-0000-0000-0000-000000000003'
\set daniel '20000000-0000-0000-0000-000000000004'
\set elisa  '20000000-0000-0000-0000-000000000005'
\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'

insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws_um'::uuid, :'bruno'::uuid, 'sales', 'active'),
  (:'ws_um'::uuid, :'daniel'::uuid, 'manager', 'active');

create function pg_temp.login(p_user uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$f$;

create function pg_temp.n(p_sql text) returns bigint language plpgsql security definer as $f$
declare v bigint;
begin
  execute p_sql into v;
  return v;
end;
$f$;

-- Ids (ordenados) de uma página/lista, para comparar conjuntos.
create function pg_temp.ids(p_items jsonb) returns text[] language sql immutable as $f$
  select coalesce(array_agg(e ->> 'id' order by e ->> 'id'), '{}') from jsonb_array_elements(p_items) e
$f$;

-- ---------------------------------------------------------------------
-- Dados de apoio
-- ---------------------------------------------------------------------

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select (create_contact(:'ws_um'::uuid, 'pf', 'Maria Santos Inbox', null, null, null)).id as ca \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Carlos Mendes Inbox', null, null, null)).id as cb \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Fernanda 100%_Lima Inbox', null, null, null)).id as cc \gset
select create_lead(:'ws_um'::uuid, (:'ca')::uuid, 'Usucapião', 'Da Ana', '{}'::text[], 'media', :'ana'::uuid) as la \gset
select create_lead(:'ws_um'::uuid, (:'cb')::uuid, 'Inventário', 'Da Carla', '{}'::text[], 'media', :'carla'::uuid) as lb \gset
select create_lead(:'ws_um'::uuid, (:'cc')::uuid, 'Imobiliário', 'Sem responsável', '{}'::text[], 'media', null) as lc \gset
select pg_temp.login(:'bruno'::uuid);
select (create_contact(:'ws_dois'::uuid, 'pf', 'Contato Z Inbox', null, null, null)).id as cz \gset
select create_lead(:'ws_dois'::uuid, (:'cz')::uuid, 'Cível', 'Z', '{}'::text[], 'media', :'bruno'::uuid) as lz \gset
reset role;

insert into public.whatsapp_channels (workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment, routing_key) values
  (:'ws_um'::uuid, 'Canal inbox', '+5541900005600', :'ana'::uuid, 'ycloud', false, 'preview', 'rota-56-um')
  returning id as canal \gset
insert into public.whatsapp_channels (workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment, routing_key) values
  (:'ws_dois'::uuid, 'Canal inbox dois', '+5541900005601', :'bruno'::uuid, 'ycloud', false, 'preview', 'rota-56-dois')
  returning id as canal2 \gset

create function pg_temp.conv(p_ws uuid, p_channel uuid, p_phone text, p_contact uuid, p_lead uuid) returns uuid
language plpgsql as $f$
declare v_ident uuid; v_conv uuid;
begin
  insert into public.whatsapp_identities (workspace_id, channel_id, provider, environment, phone_e164)
  values (p_ws, p_channel, 'ycloud', 'preview', p_phone) returning id into v_ident;
  insert into public.conversations (workspace_id, channel_id, identity_id, contact_id, lead_id)
  values (p_ws, p_channel, v_ident, p_contact, p_lead) returning id into v_conv;
  return v_conv;
end;
$f$;

-- Mensagem com horário explícito (ordem da lista = última mensagem).
create function pg_temp.msg(p_ws uuid, p_conv uuid, p_channel uuid, p_ref text, p_at timestamptz, p_kind text default 'text') returns uuid
language plpgsql as $f$
declare v uuid;
begin
  insert into public.messages (workspace_id, conversation_id, channel_id, direction, status, origin, sender_classification, content_kind, body_text, provider, provider_message_id, created_at)
  values (p_ws, p_conv, p_channel, 'inbound', 'delivered', 'inbound', 'external', p_kind,
    case when p_kind = 'text' then 'Mensagem sintética ' || p_ref end, 'ycloud', 'WAMID-56-' || p_ref, p_at)
  returning id into v;
  return v;
end;
$f$;

select pg_temp.conv(:'ws_um'::uuid, (:'canal')::uuid, '+5541999996601', (:'ca')::uuid, (:'la')::uuid) as conv_a \gset
select pg_temp.conv(:'ws_um'::uuid, (:'canal')::uuid, '+5541999996602', (:'cb')::uuid, (:'lb')::uuid) as conv_b \gset
select pg_temp.conv(:'ws_um'::uuid, (:'canal')::uuid, '+5541999996603', (:'cc')::uuid, (:'lc')::uuid) as conv_c \gset
select pg_temp.conv(:'ws_um'::uuid, (:'canal')::uuid, '+5541999996604', null, null) as conv_d \gset
select pg_temp.conv(:'ws_um'::uuid, (:'canal')::uuid, '+5541999996605', (:'ca')::uuid, (:'la')::uuid) as conv_e \gset
select pg_temp.conv(:'ws_dois'::uuid, (:'canal2')::uuid, '+5541999996606', (:'cz')::uuid, (:'lz')::uuid) as conv_z \gset

select pg_temp.msg(:'ws_um'::uuid, (:'conv_a')::uuid, (:'canal')::uuid, 'a', now() - interval '1 minute') as m_a \gset
select pg_temp.msg(:'ws_um'::uuid, (:'conv_b')::uuid, (:'canal')::uuid, 'b', now() - interval '2 minutes') as m_b \gset
-- A última mensagem da conversa C é um documento (sem texto): a prévia não pode virar "sem mensagens".
select pg_temp.msg(:'ws_um'::uuid, (:'conv_c')::uuid, (:'canal')::uuid, 'c', now() - interval '3 minutes', 'document') as m_c \gset
select pg_temp.msg(:'ws_um'::uuid, (:'conv_d')::uuid, (:'canal')::uuid, 'd', now() - interval '4 minutes') as m_d \gset
select pg_temp.msg(:'ws_um'::uuid, (:'conv_e')::uuid, (:'canal')::uuid, 'e', now() - interval '5 minutes') as m_e \gset
select pg_temp.msg(:'ws_dois'::uuid, (:'conv_z')::uuid, (:'canal2')::uuid, 'z', now() - interval '1 minute') as m_z \gset

select count(*) as logs_antes from public.audit_logs \gset
select count(*) as trilhas_antes from public.status_tracks \gset

-- =====================================================================
-- 1) Superfície
-- =====================================================================

select ok(to_regprocedure('public.list_conversation_inbox(uuid,integer,integer,text,text)') is not null, 'a função existe');
select ok(
  (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""']
   from pg_proc p where p.oid = 'public.list_conversation_inbox(uuid,integer,integer,text,text)'::regprocedure),
  'SECURITY DEFINER, STABLE e search_path vazio');
select ok(has_function_privilege('authenticated', 'public.list_conversation_inbox(uuid,integer,integer,text,text)', 'execute'), 'authenticated executa');
select ok(not exists (
  select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
  where p.oid = 'public.list_conversation_inbox(uuid,integer,integer,text,text)'::regprocedure and a.grantee = 0),
  'nada concedido a PUBLIC');

-- =====================================================================
-- 2) Autenticação, papel e entrada inválida
-- =====================================================================

set local role authenticated;
select set_config('request.jwt.claims', '', true);
select throws_ok(format('select * from public.list_conversation_inbox(%L::uuid)', :'ws_um'), 'P0001', 'authentication_required', 'sem autenticação, recusa');

select pg_temp.login(:'daniel'::uuid);
select throws_ok(format('select * from public.list_conversation_inbox(%L::uuid)', :'ws_dois'), 'P0001', 'insufficient_permission', 'sem membership no escritório, recusa');

select pg_temp.login(:'ana'::uuid);
select throws_ok(format('select * from public.list_conversation_inbox(%L::uuid, 1, 20, ''inventado'')', :'ws_um'), 'P0001', 'invalid_status', 'situação desconhecida é recusada');
select throws_ok(format('select * from public.list_conversation_inbox(%L::uuid, 1, 20, ''all'')', :'ws_um'), 'P0001', 'invalid_status', '"all" não é situação (é a ausência de filtro)');

-- =====================================================================
-- 3) Dado legado: tudo "nao_informado", sem inferir "novo"
-- =====================================================================

select is((select total_count from public.list_conversation_inbox(:'ws_um'::uuid)), 5::bigint, 'dono vê as 5 conversas do escritório');
select is((select status_counts from public.list_conversation_inbox(:'ws_um'::uuid)),
  '{"all": 5, "nao_informado": 5, "novo": 0, "aguardando_escritorio": 0, "aguardando_cliente": 0, "encerrado": 0}'::jsonb,
  'sem nenhum registro, todas são "nao_informado" (nada vira "novo")');
select is((select total_count from public.list_conversation_inbox(:'ws_um'::uuid, 1, 20, 'novo')), 0::bigint, 'o filtro "novo" não pega dado legado');
select is((select total_count from public.list_conversation_inbox(:'ws_um'::uuid, 1, 20, 'nao_informado')), 5::bigint, 'o filtro "nao_informado" pega todo o legado');
select is(pg_temp.n('select count(*) from public.status_tracks'), (:'trilhas_antes')::bigint, 'ler não criou nenhum registro de trilha');

-- =====================================================================
-- 4) Situações definidas e filtro
-- =====================================================================

select set_conversation_attendance_status((:'conv_a')::uuid, 'aguardando_escritorio', 0);
select set_conversation_attendance_status((:'conv_b')::uuid, 'novo', 0);
select set_conversation_attendance_status((:'conv_e')::uuid, 'aguardando_escritorio', 0);

select is((select status_counts from public.list_conversation_inbox(:'ws_um'::uuid)),
  '{"all": 5, "nao_informado": 2, "novo": 1, "aguardando_escritorio": 2, "aguardando_cliente": 0, "encerrado": 0}'::jsonb,
  'contagens por situação corretas');
select is((select total_count from public.list_conversation_inbox(:'ws_um'::uuid, 1, 20, 'aguardando_escritorio')), 2::bigint, 'filtro aguardando_escritorio: total 2');
select is((select pg_temp.ids(items) from public.list_conversation_inbox(:'ws_um'::uuid, 1, 20, 'aguardando_escritorio')),
  (select array_agg(x order by x) from unnest(array[:'conv_a', :'conv_e']) x), 'filtro aguardando_escritorio: as conversas certas');
select is((select pg_temp.ids(items) from public.list_conversation_inbox(:'ws_um'::uuid, 1, 20, 'nao_informado')),
  (select array_agg(x order by x) from unnest(array[:'conv_c', :'conv_d']) x), '"nao_informado" = só as sem registro');
select is((select total_count from public.list_conversation_inbox(:'ws_um'::uuid, 1, 20, 'encerrado')), 0::bigint, 'filtro sem resultado: total 0');
select is((select jsonb_array_length(items) from public.list_conversation_inbox(:'ws_um'::uuid, 1, 20, 'encerrado')), 0, 'filtro sem resultado: nenhum item');
select is((select status_counts ->> 'all' from public.list_conversation_inbox(:'ws_um'::uuid, 1, 20, 'encerrado')), '5',
  'as contagens ignoram o filtro de situação (as abas continuam mostrando o todo)');
select is((select (items -> 0 ->> 'attendance_status') from public.list_conversation_inbox(:'ws_um'::uuid, 1, 20, 'novo')), 'novo', 'o item traz a situação');

-- Prévia: a última mensagem da conversa C é um documento, sem texto.
select is((select e ->> 'last_message_content_kind' from public.list_conversation_inbox(:'ws_um'::uuid) i, jsonb_array_elements(i.items) e where e ->> 'id' = :'conv_c'),
  'document', 'o item traz o tipo da última mensagem');
select ok((select e -> 'last_message_text' = 'null'::jsonb from public.list_conversation_inbox(:'ws_um'::uuid) i, jsonb_array_elements(i.items) e where e ->> 'id' = :'conv_c'),
  'documento sem texto: o texto da prévia é nulo (a tela mostra o tipo, não "sem mensagens")');
select is((select e ->> 'wa_id' from public.list_conversation_inbox(:'ws_um'::uuid) i, jsonb_array_elements(i.items) e where e ->> 'id' = :'conv_d'),
  '+5541999996604', 'conversa sem contato mostra o telefone da identidade');

-- =====================================================================
-- 5) Paginação com total estável
-- =====================================================================

select is((select total_count from public.list_conversation_inbox(:'ws_um'::uuid, 1, 2)), 5::bigint, 'página 1 de tamanho 2: total 5');
select is((select total_count from public.list_conversation_inbox(:'ws_um'::uuid, 3, 2)), 5::bigint, 'página 3 de tamanho 2: mesmo total');
select is((select jsonb_array_length(items) from public.list_conversation_inbox(:'ws_um'::uuid, 3, 2)), 1, 'a última página tem o resto');
select is(
  (select array_agg(x order by x) from (
    select e ->> 'id' x from public.list_conversation_inbox(:'ws_um'::uuid, 1, 2) i, jsonb_array_elements(i.items) e
    union all select e ->> 'id' from public.list_conversation_inbox(:'ws_um'::uuid, 2, 2) i, jsonb_array_elements(i.items) e
    union all select e ->> 'id' from public.list_conversation_inbox(:'ws_um'::uuid, 3, 2) i, jsonb_array_elements(i.items) e) s),
  (select array_agg(x order by x) from unnest(array[:'conv_a', :'conv_b', :'conv_c', :'conv_d', :'conv_e']) x),
  'as páginas cobrem todas as conversas, sem repetir nem pular');
select is((select jsonb_array_length(items) from public.list_conversation_inbox(:'ws_um'::uuid, 99, 2)), 0, 'página além da última: nenhum item');
select is((select total_count from public.list_conversation_inbox(:'ws_um'::uuid, 99, 2)), 5::bigint, 'página além da última: o total continua correto (a tela pode voltar à última)');
select is((select e ->> 'id' from public.list_conversation_inbox(:'ws_um'::uuid, 1, 1) i, jsonb_array_elements(i.items) e), :'conv_a', 'a mais recente primeiro');

-- =====================================================================
-- 6) Busca
-- =====================================================================

select is((select pg_temp.ids(items) from public.list_conversation_inbox(:'ws_um'::uuid, 1, 20, null, 'maria')),
  (select array_agg(x order by x) from unnest(array[:'conv_a', :'conv_e']) x), 'busca por nome, sem diferenciar maiúsculas');
select is((select pg_temp.ids(items) from public.list_conversation_inbox(:'ws_um'::uuid, 1, 20, null, '996604')),
  array[:'conv_d'], 'busca por trecho do telefone');
select is((select pg_temp.ids(items) from public.list_conversation_inbox(:'ws_um'::uuid, 1, 20, null, 'inventário')),
  array[:'conv_b'], 'busca pela área do caso');
select is((select total_count from public.list_conversation_inbox(:'ws_um'::uuid, 1, 20, null, 'nada disto existe')), 0::bigint, 'busca sem resultado');
select is((select pg_temp.ids(items) from public.list_conversation_inbox(:'ws_um'::uuid, 1, 20, null, '%')),
  array[:'conv_c'], 'o % do usuário NÃO é curinga (só acha o nome que tem % de verdade)');
select is((select pg_temp.ids(items) from public.list_conversation_inbox(:'ws_um'::uuid, 1, 20, null, '_')),
  array[:'conv_c'], 'o _ do usuário NÃO é curinga');
select is((select status_counts ->> 'all' from public.list_conversation_inbox(:'ws_um'::uuid, 1, 20, null, 'maria')), '2', 'as contagens respeitam a busca');
select is((select (status_counts ->> 'aguardando_escritorio')::int from public.list_conversation_inbox(:'ws_um'::uuid, 1, 20, 'novo', 'maria')), 2, 'busca + filtro: a contagem da aba não some por causa do filtro');
select is((select total_count from public.list_conversation_inbox(:'ws_um'::uuid, 1, 20, 'novo', 'maria')), 0::bigint, 'busca + filtro combinados');

-- =====================================================================
-- 7) Alcance por papel = o da list_conversations
-- =====================================================================

select is((select pg_temp.ids(items) from public.list_conversation_inbox(:'ws_um'::uuid, 1, 100)),
  (select pg_temp.ids(items) from public.list_conversations(:'ws_um'::uuid, 1, 100)), 'owner: mesmo conjunto da list_conversations');
select pg_temp.login(:'carla'::uuid);
select is((select pg_temp.ids(items) from public.list_conversation_inbox(:'ws_um'::uuid, 1, 100)),
  (select pg_temp.ids(items) from public.list_conversations(:'ws_um'::uuid, 1, 100)), 'lawyer: mesmo conjunto da list_conversations');
select ok((select total_count from public.list_conversation_inbox(:'ws_um'::uuid, 1, 100)) < 5, 'o advogado alcança menos que o dono (não vê conversa do lead de outro responsável)');
select ok((select status_counts ->> 'all' = total_count::text from public.list_conversation_inbox(:'ws_um'::uuid, 1, 100)),
  'as contagens do advogado cobrem só o que ele alcança');
select pg_temp.login(:'bruno'::uuid);
select is((select pg_temp.ids(items) from public.list_conversation_inbox(:'ws_um'::uuid, 1, 100)),
  (select pg_temp.ids(items) from public.list_conversations(:'ws_um'::uuid, 1, 100)), 'sales: mesmo conjunto da list_conversations');
select pg_temp.login(:'elisa'::uuid);
select is((select pg_temp.ids(items) from public.list_conversation_inbox(:'ws_um'::uuid, 1, 100)),
  (select pg_temp.ids(items) from public.list_conversations(:'ws_um'::uuid, 1, 100)), 'viewer: mesmo conjunto da list_conversations (leitura permitida)');
select pg_temp.login(:'daniel'::uuid);
select is((select pg_temp.ids(items) from public.list_conversation_inbox(:'ws_um'::uuid, 1, 100)),
  (select pg_temp.ids(items) from public.list_conversations(:'ws_um'::uuid, 1, 100)), 'manager: mesmo conjunto da list_conversations');

-- =====================================================================
-- 8) Isolamento, leitura sem efeito e list_conversations intacta
-- =====================================================================

select pg_temp.login(:'bruno'::uuid);
select is((select pg_temp.ids(items) from public.list_conversation_inbox(:'ws_dois'::uuid, 1, 100)), array[:'conv_z'], 'outro escritório: só a própria conversa');
select pg_temp.login(:'ana'::uuid);
select ok(not (select :'conv_z' = any (pg_temp.ids(items)) from public.list_conversation_inbox(:'ws_um'::uuid, 1, 100)), 'a conversa de outro escritório nunca aparece');
select ok(not (select (items -> 0) ? 'attendance_status' from public.list_conversations(:'ws_um'::uuid, 1, 1)), 'list_conversations continua sem a chave nova (leitura antiga intacta)');
reset role;
select is(pg_temp.n('select count(*) from public.audit_logs'), (:'logs_antes')::bigint + 3, 'ler não escreveu auditoria (só as 3 correções de preparação)');
select is(pg_temp.n('select count(*) from public.status_tracks'), (:'trilhas_antes')::bigint + 3, 'ler não criou trilha (só as 3 de preparação)');

select * from finish();
rollback;
