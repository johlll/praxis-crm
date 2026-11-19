-- pgTAP — Conversas + IA, painel do caso: regra-base do caso de uma conversa, compartilhada pela lista
-- (list_conversation_inbox) e pelo painel (list_conversation_case_options).
--
-- Prova: a função privada não é chamável por nenhum papel de API; a ordem da regra (vínculo persistido →
-- única oportunidade do lead → única do contato → nenhum) e o "nenhum por palpite" com vários casos; o
-- alcance por papel (advogado só conta o que alcança); a lista e o painel devolvem O MESMO caso padrão e a
-- MESMA contagem para todas as conversas, em cada papel; as chaves anteriores da lista continuam; nada é
-- escrito (o vínculo persistido não muda); isolamento entre escritórios.
--
-- Fixtures do seed: ana=owner, carla=lawyer, elisa=viewer no Escritório Um; bruno=owner e carla=sales no
-- Escritório Dois; daniel sem membership. Aqui: bruno=sales e daniel=manager no Escritório Um. Dados sintéticos.

begin;
select plan(45);

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

-- ---------------------------------------------------------------------
-- Dados de apoio
-- ---------------------------------------------------------------------

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
-- P: um lead com uma oportunidade.      Q: um lead com uma oportunidade (conversa sem lead).
-- R: lead R1 (da Ana) com duas oportunidades e lead R2 (sem responsável) com uma.
select (create_contact(:'ws_um'::uuid, 'pf', 'Paula Painel', null, null, null)).id as cp \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Quintino Painel', null, null, null)).id as cq \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Rita Painel', null, null, null)).id as cr \gset
select create_lead(:'ws_um'::uuid, (:'cp')::uuid, 'Usucapião', 'P', '{}'::text[], 'media', :'ana'::uuid) as lp \gset
select create_lead(:'ws_um'::uuid, (:'cq')::uuid, 'Inventário', 'Q', '{}'::text[], 'media', :'ana'::uuid) as lq \gset
select create_lead(:'ws_um'::uuid, (:'cr')::uuid, 'Imobiliário', 'R1', '{}'::text[], 'media', :'ana'::uuid) as lr1 \gset
select create_lead(:'ws_um'::uuid, (:'cr')::uuid, 'Imobiliário', 'R2', '{}'::text[], 'media', null) as lr2 \gset
select create_opportunity((:'lp')::uuid) as op1 \gset
select create_opportunity((:'lq')::uuid) as oq \gset
select create_opportunity((:'lr1')::uuid) as or1 \gset
select create_opportunity((:'lr1')::uuid) as or2 \gset
select create_opportunity((:'lr2')::uuid) as or3 \gset
select win_opportunity((:'or2')::uuid, 0, 100000, 'fixed');
select pg_temp.login(:'bruno'::uuid);
select (create_contact(:'ws_dois'::uuid, 'pf', 'Zeca Painel', null, null, null)).id as cz \gset
select create_lead(:'ws_dois'::uuid, (:'cz')::uuid, 'Cível', 'Z', '{}'::text[], 'media', :'bruno'::uuid) as lz \gset
select create_opportunity((:'lz')::uuid) as oz \gset
reset role;

insert into public.whatsapp_channels (workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment, routing_key) values
  (:'ws_um'::uuid, 'Canal painel', '+5541900005800', :'ana'::uuid, 'ycloud', false, 'preview', 'rota-58-um')
  returning id as canal \gset
insert into public.whatsapp_channels (workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment, routing_key) values
  (:'ws_dois'::uuid, 'Canal painel dois', '+5541900005801', :'bruno'::uuid, 'ycloud', false, 'preview', 'rota-58-dois')
  returning id as canal2 \gset

create function pg_temp.conv(p_ws uuid, p_channel uuid, p_phone text, p_contact uuid, p_lead uuid, p_opp uuid default null) returns uuid
language plpgsql as $f$
declare v_ident uuid; v_conv uuid;
begin
  insert into public.whatsapp_identities (workspace_id, channel_id, provider, environment, phone_e164)
  values (p_ws, p_channel, 'ycloud', 'preview', p_phone) returning id into v_ident;
  insert into public.conversations (workspace_id, channel_id, identity_id, contact_id, lead_id, opportunity_id)
  values (p_ws, p_channel, v_ident, p_contact, p_lead, p_opp) returning id into v_conv;
  insert into public.messages (workspace_id, conversation_id, channel_id, direction, status, origin, sender_classification, content_kind, body_text, provider, provider_message_id)
  values (p_ws, v_conv, p_channel, 'inbound', 'delivered', 'inbound', 'external', 'text', 'Mensagem sintética', 'ycloud', 'WAMID-58-' || p_phone);
  return v_conv;
end;
$f$;

select pg_temp.conv(:'ws_um'::uuid, (:'canal')::uuid, '+5541999995801', (:'cp')::uuid, (:'lp')::uuid) as conv_p \gset
select pg_temp.conv(:'ws_um'::uuid, (:'canal')::uuid, '+5541999995802', (:'cq')::uuid, null) as conv_q \gset
select pg_temp.conv(:'ws_um'::uuid, (:'canal')::uuid, '+5541999995803', (:'cr')::uuid, (:'lr1')::uuid, (:'or2')::uuid) as conv_r_link \gset
select pg_temp.conv(:'ws_um'::uuid, (:'canal')::uuid, '+5541999995804', (:'cr')::uuid, (:'lr2')::uuid) as conv_r_lead \gset
select pg_temp.conv(:'ws_um'::uuid, (:'canal')::uuid, '+5541999995805', (:'cr')::uuid, (:'lr1')::uuid) as conv_r_amb \gset
select pg_temp.conv(:'ws_um'::uuid, (:'canal')::uuid, '+5541999995806', (:'cr')::uuid, null) as conv_r_semlead \gset
-- Vínculo numa oportunidade de OUTRO lead do mesmo contato (o banco aceita): o lead R2 tem um único caso,
-- mas o vínculo gravado (or2, do lead R1) vence.
select pg_temp.conv(:'ws_um'::uuid, (:'canal')::uuid, '+5541999995809', (:'cr')::uuid, (:'lr2')::uuid, (:'or2')::uuid) as conv_r_cruzado \gset
select pg_temp.conv(:'ws_um'::uuid, (:'canal')::uuid, '+5541999995807', null, null) as conv_u \gset
select pg_temp.conv(:'ws_dois'::uuid, (:'canal2')::uuid, '+5541999995808', (:'cz')::uuid, (:'lz')::uuid) as conv_z \gset

select count(*) as logs_antes from public.audit_logs \gset
select count(*) as trilhas_antes from public.status_tracks \gset
select md5(string_agg(id::text || coalesce(opportunity_id::text, '-'), ',' order by id)) as vinculos_antes from public.conversations \gset

-- Padrão do painel e da lista para uma conversa, como o papel logado enxerga.
create function pg_temp.painel(p_conv uuid) returns jsonb language sql as $f$
  select public.list_conversation_case_options(p_conv)
$f$;
create function pg_temp.item(p_ws uuid, p_conv uuid) returns jsonb language sql as $f$
  select e from public.list_conversation_inbox(p_ws, 1, 100) r, jsonb_array_elements(r.items) e where (e ->> 'id')::uuid = p_conv
$f$;
-- Quantas conversas da página têm lista e painel DIVERGENTES (caso padrão, origem ou contagem).
create function pg_temp.divergencias(p_ws uuid) returns bigint language plpgsql as $f$
declare v_n bigint := 0; e jsonb; p jsonb;
begin
  for e in select x from public.list_conversation_inbox(p_ws, 1, 100) r, jsonb_array_elements(r.items) x loop
    p := public.list_conversation_case_options((e ->> 'id')::uuid);
    if (e -> 'case' ->> 'opportunity_id') is distinct from (p ->> 'default_opportunity_id')
       or (e ->> 'case_source') is distinct from (p ->> 'default_source')
       or (e ->> 'case_count')::int is distinct from (p ->> 'case_count')::int
       or (p ->> 'case_count')::int is distinct from jsonb_array_length(p -> 'items') then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$f$;

-- =====================================================================
-- 1) Superfície
-- =====================================================================

select ok(to_regprocedure('private.conversation_case_resolution(uuid,public.membership_role,uuid)') is not null, 'a regra-base existe');
select ok(
  (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""']
   from pg_proc p where p.oid = 'private.conversation_case_resolution(uuid,public.membership_role,uuid)'::regprocedure),
  'regra-base: SECURITY DEFINER, STABLE e search_path vazio');
select ok(not has_function_privilege('authenticated', 'private.conversation_case_resolution(uuid,public.membership_role,uuid)', 'execute'), 'authenticated não chama a regra-base');
select ok(not has_function_privilege('anon', 'private.conversation_case_resolution(uuid,public.membership_role,uuid)', 'execute'), 'anon não chama a regra-base');
select ok(not has_function_privilege('service_role', 'private.conversation_case_resolution(uuid,public.membership_role,uuid)', 'execute'), 'service_role não chama a regra-base');
select ok(has_function_privilege('authenticated', 'public.list_conversation_inbox(uuid,integer,integer,text,text)', 'execute')
  and has_function_privilege('authenticated', 'public.list_conversation_case_options(uuid)', 'execute'),
  'lista e painel continuam executáveis por authenticated');
set local role authenticated;
select set_config('request.jwt.claims', '', true);
select throws_ok(format('select * from public.list_conversation_inbox(%L::uuid)', :'ws_um'), 'P0001', 'authentication_required', 'lista: sem autenticação, recusa');
select throws_ok(format('select public.list_conversation_case_options(%L::uuid)', :'conv_p'), 'P0001', 'authentication_required', 'painel: sem autenticação, recusa');
reset role;

-- =====================================================================
-- 2) Ordem da regra (dona do escritório: alcança tudo)
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);

select is(pg_temp.painel((:'conv_r_link')::uuid) ->> 'default_opportunity_id', :'or2', 'vínculo persistido vem primeiro');
select is(pg_temp.painel((:'conv_r_cruzado')::uuid) ->> 'default_opportunity_id', :'or2', 'o vínculo vence a única oportunidade do lead da conversa');
select is(pg_temp.item(:'ws_um'::uuid, (:'conv_r_cruzado')::uuid) ->> 'case_source', 'linked', 'lista: a mesma prioridade do vínculo');
select is(pg_temp.painel((:'conv_r_link')::uuid) ->> 'default_source', 'linked', 'origem: vínculo');
select is(pg_temp.painel((:'conv_r_lead')::uuid) ->> 'default_opportunity_id', :'or3', 'sem vínculo: a única oportunidade do lead da conversa');
select is(pg_temp.painel((:'conv_r_lead')::uuid) ->> 'default_source', 'lead', 'origem: lead');
select is(pg_temp.painel((:'conv_p')::uuid) ->> 'default_source', 'lead', 'lead com uma oportunidade é "lead" mesmo sendo a única do contato');
select is(pg_temp.painel((:'conv_q')::uuid) ->> 'default_opportunity_id', :'oq', 'sem lead na conversa: a única oportunidade do contato');
select is(pg_temp.painel((:'conv_q')::uuid) ->> 'default_source', 'only', 'origem: única do contato');
select ok(pg_temp.painel((:'conv_r_amb')::uuid) ->> 'default_opportunity_id' is null, 'lead com duas oportunidades e sem vínculo: nenhum por palpite');
select is((pg_temp.painel((:'conv_r_amb')::uuid) ->> 'case_count')::int, 3, 'mas a contagem diz quantos casos o contato tem');
select ok(pg_temp.painel((:'conv_r_semlead')::uuid) ->> 'default_opportunity_id' is null, 'sem lead, três casos: nenhum por palpite');
select ok(pg_temp.painel((:'conv_r_semlead')::uuid) ->> 'default_source' is null, 'sem padrão, sem origem');
select is((pg_temp.painel((:'conv_u')::uuid) ->> 'case_count')::int, 0, 'sem contato: zero casos');
select ok(pg_temp.painel((:'conv_u')::uuid) ->> 'default_opportunity_id' is null, 'sem contato: nenhum caso');
select is((pg_temp.painel((:'conv_r_link')::uuid) -> 'items' -> 0 ->> 'opportunity_id'), :'or2', 'as opções continuam na mesma ordem (o vínculo primeiro)');

-- =====================================================================
-- 3) A lista mostra o MESMO caso, com as chaves de antes
-- =====================================================================

select is(pg_temp.item(:'ws_um'::uuid, (:'conv_r_link')::uuid) -> 'case' ->> 'opportunity_id', :'or2', 'lista: o caso do vínculo');
select is(pg_temp.item(:'ws_um'::uuid, (:'conv_r_link')::uuid) -> 'case' ->> 'case_progress_status', 'nao_informado', 'lista: oportunidade ganha sem registro é "não informado"');
select is(pg_temp.item(:'ws_um'::uuid, (:'conv_r_link')::uuid) -> 'case' ->> 'status', 'won', 'lista: natureza do caso (ganha)');
select ok(pg_temp.item(:'ws_um'::uuid, (:'conv_r_amb')::uuid) -> 'case' = 'null'::jsonb, 'lista: vários casos sem vínculo → nenhum caso');
select is((pg_temp.item(:'ws_um'::uuid, (:'conv_r_amb')::uuid) ->> 'case_count')::int, 3, 'lista: "3 casos"');
select ok(
  (select bool_and(pg_temp.item(:'ws_um'::uuid, (:'conv_p')::uuid) ? k)
   from unnest(array['id','wa_id','contact_id','contact_name','lead_id','legal_area','opportunity_id','needs_link_review',
                     'last_message_at','last_message_text','last_message_direction','last_message_status',
                     'last_message_content_kind','attendance_status']) k),
  'lista: todas as chaves anteriores continuam');
select is(
  (select array_agg(k order by k) from jsonb_object_keys(pg_temp.item(:'ws_um'::uuid, (:'conv_p')::uuid) -> 'case') k),
  (select array_agg(k order by k) from jsonb_object_keys(pg_temp.painel((:'conv_p')::uuid) -> 'items' -> 0) k),
  'lista: o caso tem o mesmo formato da opção do painel');
select is(pg_temp.divergencias(:'ws_um'::uuid), 0::bigint, 'dona: lista e painel iguais em todas as conversas');

-- =====================================================================
-- 4) Alcance por papel: a regra só conta o que o papel alcança
-- =====================================================================

-- Carla (advogada) alcança só leads seus ou sem responsável: do contato R, só o lead R2 (sem responsável).
-- A Ana vê 3 casos do contato R; a Carla, na conversa do lead R2, vê 1.
select pg_temp.login(:'carla'::uuid);
select is((pg_temp.painel((:'conv_r_lead')::uuid) ->> 'case_count')::int, 1, 'advogada: conta só o caso que alcança');
select is(pg_temp.painel((:'conv_r_lead')::uuid) ->> 'default_opportunity_id', :'or3', 'advogada: o caso alcançável vira o padrão');
select is(pg_temp.item(:'ws_um'::uuid, (:'conv_r_lead')::uuid) -> 'case' ->> 'opportunity_id', :'or3', 'advogada: a lista mostra o mesmo');
select is(pg_temp.divergencias(:'ws_um'::uuid), 0::bigint, 'advogada: lista e painel iguais em todas as conversas');
select pg_temp.login(:'bruno'::uuid);
select is(pg_temp.divergencias(:'ws_um'::uuid), 0::bigint, 'atendimento (sales): lista e painel iguais');
select pg_temp.login(:'daniel'::uuid);
select is(pg_temp.divergencias(:'ws_um'::uuid), 0::bigint, 'gestor: lista e painel iguais');
select pg_temp.login(:'elisa'::uuid);
select is(pg_temp.divergencias(:'ws_um'::uuid), 0::bigint, 'visualizador: lista e painel iguais');

-- =====================================================================
-- 5) Isolamento entre escritórios
-- =====================================================================

select pg_temp.login(:'bruno'::uuid);
select is(pg_temp.item(:'ws_dois'::uuid, (:'conv_z')::uuid) -> 'case' ->> 'opportunity_id', :'oz', 'escritório dois: o caso de lá');
select ok(pg_temp.item(:'ws_dois'::uuid, (:'conv_p')::uuid) is null, 'a lista de um escritório não traz conversa do outro');
select pg_temp.login(:'ana'::uuid);
select throws_ok(format('select public.list_conversation_case_options(%L::uuid)', :'conv_z'), 'P0001', 'insufficient_permission',
  'o painel não abre conversa de outro escritório');

-- =====================================================================
-- 6) Só leitura
-- =====================================================================

reset role;
select is(pg_temp.n('select count(*) from public.audit_logs'), (:'logs_antes')::bigint, 'nenhum registro de auditoria novo');
select is(pg_temp.n('select count(*) from public.status_tracks'), (:'trilhas_antes')::bigint, 'nenhuma trilha criada');
select is((select md5(string_agg(id::text || coalesce(opportunity_id::text, '-'), ',' order by id)) from public.conversations), :'vinculos_antes',
  'o vínculo persistido das conversas não muda');

select * from finish();
rollback;
