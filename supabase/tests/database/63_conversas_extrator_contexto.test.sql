-- pgTAP — Conversas + IA: contexto do EXTRATOR (get_status_automation_context).
--
-- Prova: só o processamento interno (service_role) e só com o portão do aplicador aberto; outro escritório é
-- inexistente; só mensagens da própria conversa, em ordem, com autor calculado pelo banco, texto cortado e
-- elegibilidade temporal por trilha (decisão humana); caso só quando inequívoco e ganho (com roteiro), senão o
-- motivo; nenhum horário, telefone, nome, papel ou permissão; nada é gravado.
--
-- Fixtures do seed: ana=owner no Escritório Um; bruno=owner no Escritório Dois. Dados sintéticos.

begin;
select plan(34);

\set ana    '20000000-0000-0000-0000-000000000001'
\set bruno  '20000000-0000-0000-0000-000000000002'
\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'

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

-- Mensagem sintética (mesmo auxiliar do pgTAP 62): cliente | arquivo | escritorio | chatbot | desconhecida.
create function pg_temp.m(p_conv uuid, p_kind text, p_origin timestamptz) returns uuid language plpgsql security definer as $f$
declare
  c public.conversations;
  v uuid;
  v_pm text := 'pm-63-' || gen_random_uuid();
begin
  select * into c from public.conversations where id = p_conv;
  if p_kind = 'escritorio' then
    insert into public.messages (workspace_id, conversation_id, channel_id, direction, status, origin, sender_classification,
      content_kind, body_text, provider, provider_message_id, sent_by, client_dedupe_key, origin_correlation_kind, origin_correlation_ref, created_at)
    values (c.workspace_id, c.id, c.channel_id, 'outbound', 'sent', 'crm', 'internal', 'text', 'Mensagem fictícia do escritório',
      'ycloud', v_pm, '20000000-0000-0000-0000-000000000001', gen_random_uuid(), 'crm_outbox', v_pm, p_origin)
    returning id into v;
    return v;
  end if;
  insert into public.messages (workspace_id, conversation_id, channel_id, direction, status, origin, sender_classification,
    content_kind, body_text, provider, provider_message_id, origin_correlation_kind, origin_correlation_ref, created_at)
  values (c.workspace_id, c.id, c.channel_id,
    (case when p_kind = 'chatbot' then 'outbound' else 'inbound' end)::public.message_direction,
    (case when p_kind = 'chatbot' then 'sent' else 'delivered' end)::public.message_status,
    (case p_kind when 'chatbot' then 'chatbot' else 'inbound' end)::public.whatsapp_message_origin,
    case p_kind when 'chatbot' then 'automation' else 'external' end::public.whatsapp_sender_classification,
    case when p_kind = 'arquivo' then 'document' else 'text' end,
    case when p_kind = 'arquivo' then null else 'Mensagem fictícia do cliente' end,
    'ycloud', v_pm,
    case when p_kind = 'chatbot' then 'chatbot_request' end, case when p_kind = 'chatbot' then v_pm end,
    coalesce(p_origin, clock_timestamp()) + interval '20 seconds')
  returning id into v;
  if p_kind <> 'desconhecida' and p_origin is not null then
    perform set_config('praxis.message_origin_writer', 'on', true);
    update public.messages set origin_time_at = p_origin, origin_time_source = 'provider_send_time' where id = v;
    perform set_config('praxis.message_origin_writer', '', true);
  end if;
  return v;
end;
$f$;

create function pg_temp.conv(p_ws uuid, p_canal uuid, p_phone text, p_contact uuid, p_lead uuid, p_opp uuid, p_review boolean default false)
returns uuid language plpgsql security definer as $f$
declare v_ident uuid; v uuid;
begin
  insert into public.whatsapp_identities (workspace_id, channel_id, provider, environment, phone_e164)
    values (p_ws, p_canal, 'ycloud', 'preview', p_phone) returning id into v_ident;
  insert into public.conversations (workspace_id, channel_id, identity_id, contact_id, lead_id, opportunity_id, needs_link_review)
    values (p_ws, p_canal, v_ident, p_contact, p_lead, p_opp, p_review) returning id into v;
  return v;
end;
$f$;

-- O contexto, como o processamento interno: o jsonb ou {"erro": mensagem}.
create function pg_temp.ctx(p_ws uuid, p_conv uuid, p_limit int default 30) returns jsonb language plpgsql as $f$
declare v jsonb;
begin
  execute 'set local role service_role';
  select public.get_status_automation_context(p_ws, p_conv, p_limit) into v;
  execute 'reset role';
  return v;
exception when others then
  execute 'reset role';
  return jsonb_build_object('erro', sqlerrm);
end;
$f$;
create function pg_temp.u(p_user uuid, p_sql text) returns jsonb language plpgsql as $f$
declare v jsonb;
begin
  execute 'set local role authenticated';
  perform pg_temp.login(p_user);
  execute p_sql into v;
  execute 'reset role';
  return v;
exception when others then
  execute 'reset role';
  return jsonb_build_object('erro', sqlerrm);
end;
$f$;

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select (create_contact(:'ws_um'::uuid, 'pf', 'Xavier Contexto', null, null, null)).id as cx \gset
select create_lead(:'ws_um'::uuid, (:'cx')::uuid, 'Imobiliário', 'X', '{}'::text[], 'media', :'ana'::uuid) as lx \gset
select create_opportunity((:'lx')::uuid) as ox \gset
select win_opportunity((:'ox')::uuid, 0, 100000, 'fixed');
select (create_contact(:'ws_um'::uuid, 'pf', 'Yara Contexto', null, null, null)).id as cy \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Wilma Contexto', null, null, null)).id as cw \gset
select create_lead(:'ws_um'::uuid, (:'cw')::uuid, 'Trabalhista', 'W', '{}'::text[], 'media', :'ana'::uuid) as lw \gset
select create_opportunity((:'lw')::uuid) as ow \gset
select pg_temp.login(:'bruno'::uuid);
select (create_contact(:'ws_dois'::uuid, 'pf', 'Zeca Contexto', null, null, null)).id as cz \gset
select create_lead(:'ws_dois'::uuid, (:'cz')::uuid, 'Cível', 'Z', '{}'::text[], 'media', :'bruno'::uuid) as lz \gset
reset role;

insert into public.whatsapp_channels (workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment, routing_key)
  values (:'ws_um'::uuid, 'Canal contexto', '+5541900006300', :'ana'::uuid, 'ycloud', false, 'preview', 'rota-63-um') returning id as canal \gset
insert into public.whatsapp_channels (workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment, routing_key)
  values (:'ws_dois'::uuid, 'Canal contexto 2', '+5541900006399', :'bruno'::uuid, 'ycloud', false, 'preview', 'rota-63-dois') returning id as canal2 \gset
select pg_temp.conv(:'ws_um'::uuid, :'canal'::uuid, '+5541999996301', :'cx'::uuid, :'lx'::uuid, null) as kx \gset
select pg_temp.conv(:'ws_um'::uuid, :'canal'::uuid, '+5541999996302', :'cy'::uuid, null, null) as ky \gset
select pg_temp.conv(:'ws_um'::uuid, :'canal'::uuid, '+5541999996303', :'cw'::uuid, :'lw'::uuid, null) as kw \gset
select pg_temp.conv(:'ws_um'::uuid, :'canal'::uuid, '+5541999996304', null, null, null, true) as kr \gset
select pg_temp.conv(:'ws_dois'::uuid, :'canal2'::uuid, '+5541999996305', :'cz'::uuid, :'lz'::uuid, null) as kz \gset

select clock_timestamp() - interval '30 minutes' as t1 \gset
select pg_temp.m(:'kx'::uuid, 'cliente', :'t1'::timestamptz) as m1 \gset
select pg_temp.m(:'kx'::uuid, 'escritorio', :'t1'::timestamptz + interval '1 minute') as m2 \gset
select pg_temp.m(:'kx'::uuid, 'arquivo', :'t1'::timestamptz + interval '2 minutes') as m3 \gset
select pg_temp.m(:'kx'::uuid, 'chatbot', :'t1'::timestamptz + interval '3 minutes') as m4 \gset
select pg_temp.m(:'kx'::uuid, 'desconhecida', null) as m5 \gset
select pg_temp.m(:'kw'::uuid, 'cliente', :'t1'::timestamptz) as mw \gset
select pg_temp.m(:'kz'::uuid, 'cliente', :'t1'::timestamptz) as mz \gset
-- Texto longo para conferir o corte.
update public.messages set body_text = repeat('x', 3000) where id = (:'m1')::uuid;

-- =====================================================================
-- 1) Superfície e portão
-- =====================================================================

select ok(
  has_function_privilege('service_role', 'public.get_status_automation_context(uuid,uuid,integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.get_status_automation_context(uuid,uuid,integer)', 'execute')
  and not has_function_privilege('anon', 'public.get_status_automation_context(uuid,uuid,integer)', 'execute'),
  'o contexto é só do processamento interno (service_role)');
select ok((select p.prosecdef and p.proconfig = array['search_path=""'] from pg_proc p
  where p.oid = 'public.get_status_automation_context(uuid,uuid,integer)'::regprocedure), 'SECURITY DEFINER com search_path vazio');
select is(pg_temp.ctx(:'ws_um', :'kx') ->> 'erro', 'automation_disabled', 'portão fechado: o contexto também é recusado');
select is(pg_temp.u(:'ana', format($q$select get_status_automation_context(%L, %L, 30)$q$, :'ws_um', :'kx')) ->> 'erro',
  'permission denied for function get_status_automation_context', 'usuário autenticado não lê o contexto');

update public.status_track_automation_gate set enabled = true, enabled_at = now(), activation_ref = 'teste-pgtap-63';
select pg_temp.n('select (select count(*) from public.status_tracks) + (select count(*) from public.status_track_automation_decisions)') as antes \gset

select is(pg_temp.ctx(:'ws_um', :'kz') ->> 'erro', 'target_not_found', 'conversa de outro escritório: inexistente');
select is(pg_temp.ctx(:'ws_dois', :'kx') ->> 'erro', 'target_not_found', 'escritório declarado diferente: inexistente');
select is(pg_temp.ctx(:'ws_um', :'kx', 0) ->> 'erro', 'invalid_request', 'limite zero: recusado');
select is(pg_temp.ctx(:'ws_um', :'kx', 51) ->> 'erro', 'invalid_request', 'limite acima de 50: recusado');

-- =====================================================================
-- 2) Conteúdo: só a conversa, em ordem, autor calculado, sem horário nem identidade
-- =====================================================================

select pg_temp.ctx(:'ws_um', :'kx') as c \gset
select is(:'c'::jsonb ->> 'conversation_id', :'kx', 'o contexto é da conversa pedida');
select is(jsonb_array_length(:'c'::jsonb -> 'messages'), 5, 'só as mensagens da própria conversa');
select is((select string_agg(e ->> 'message_id', ',' order by o) from jsonb_array_elements(:'c'::jsonb -> 'messages') with ordinality x(e, o)),
  concat_ws(',', :'m1', :'m2', :'m3', :'m4', :'m5'), 'em ordem de chegada');
select is((select string_agg(e ->> 'author', ',' order by o) from jsonb_array_elements(:'c'::jsonb -> 'messages') with ordinality x(e, o)),
  'client,office,client,other,client', 'autor calculado pelo banco (cliente, escritório, outro)');
select is(:'c'::jsonb #>> '{messages,2,content_kind}', 'document', 'o tipo de conteúdo vem do registro (arquivo)');
select is(length(:'c'::jsonb #>> '{messages,0,text}'), 1500, 'o texto é cortado em 1.500 caracteres');
select ok(not exists (
    select 1 from jsonb_array_elements(:'c'::jsonb -> 'messages') e, jsonb_object_keys(e) k
    where k not in ('message_id', 'author', 'content_kind', 'text', 'eligible_attendance', 'eligible_case')),
  'cada mensagem só tem id, autor, tipo, texto e elegibilidade (sem horário, telefone, nome, papel)');
select ok(:'c'::jsonb::text !~ '(created_at|origin_time|phone|wa_id|sent_by|actor|role|permission|Xavier)',
  'nenhum horário, telefone, remetente, nome, papel ou permissão no contexto');
select is((select string_agg((e ->> 'eligible_attendance'), ',' order by o) from jsonb_array_elements(:'c'::jsonb -> 'messages') with ordinality x(e, o)),
  'true,true,true,true,false', 'elegibilidade no tempo por mensagem (origem desconhecida não é elegível)');

select is(:'c'::jsonb #>> '{attendance,status}', 'nao_informado', 'situação do atendimento atual');
select is((:'c'::jsonb #>> '{attendance,version}')::int, 0, 'versão atual da situação do atendimento');
select is(:'c'::jsonb #>> '{case,opportunity_id}', :'ox', 'caso único e ganho: presente');
select is(:'c'::jsonb ->> 'case_unavailable_reason', null, 'sem motivo de ausência quando o caso está presente');
select is(:'c'::jsonb #> '{case,plan}', 'null'::jsonb, 'caso sem roteiro: plan nulo');

select is(pg_temp.ctx(:'ws_um', :'kx', 2) -> 'messages' -> 0 ->> 'message_id', :'m4', 'limite: as N mais recentes, em ordem');

-- Decisão humana: a mensagem anterior deixa de ser elegível na trilha decidida, não na outra.
select pg_temp.u(:'ana', format($q$select set_conversation_attendance_status(%L, 'aguardando_cliente', 0, '{}'::uuid[], null)$q$, :'kx')) ->> 'version' as vh \gset
select pg_temp.ctx(:'ws_um', :'kx') as c2 \gset
select is(:'c2'::jsonb #>> '{messages,0,eligible_attendance}', 'false', 'depois da decisão humana, a mensagem anterior não é elegível na situação do atendimento');
select is(:'c2'::jsonb #>> '{messages,0,eligible_case}', 'true', 'e continua elegível no andamento (outra trilha, sem decisão humana)');
select is((:'c2'::jsonb #>> '{attendance,version}')::int, 1, 'a versão nova aparece no contexto');

-- Roteiro aparece quando aplicado.
select pg_temp.u(:'ana', format($q$select create_service_type(%L, 'Roteiro contexto', array['Documentos', 'Análise'])$q$, :'ws_um')) ->> 'id' as tipo \gset
select pg_temp.u(:'ana', format($q$select apply_case_service_plan(%L, %L, 0, 1, null)$q$, :'ox', :'tipo')) ->> 'version' as vplan \gset
select pg_temp.ctx(:'ws_um', :'kx') as c3 \gset
select is(jsonb_array_length(:'c3'::jsonb #> '{case,plan,steps}'), 2, 'roteiro: as etapas do caso');
select ok((:'c3'::jsonb #>> '{case,plan,current_step_id}') = (:'c3'::jsonb #>> '{case,plan,steps,0,step_id}'), 'roteiro: a etapa atual');

-- =====================================================================
-- 3) Caso indisponível: o motivo, nunca um palpite
-- =====================================================================

select is(pg_temp.ctx(:'ws_um', :'ky') ->> 'case_unavailable_reason', 'no_case', 'contato sem caso: no_case');
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select create_lead(:'ws_um'::uuid, (:'cy')::uuid, 'Família', 'Y1', '{}'::text[], 'media', :'ana'::uuid) as ly1 \gset
select create_lead(:'ws_um'::uuid, (:'cy')::uuid, 'Cível', 'Y2', '{}'::text[], 'media', :'ana'::uuid) as ly2 \gset
select create_opportunity((:'ly1')::uuid) as oy1 \gset
select create_opportunity((:'ly2')::uuid) as oy2 \gset
reset role;
select pg_temp.ctx(:'ws_um', :'ky') as cy2 \gset
select ok(:'cy2'::jsonb -> 'case' = 'null'::jsonb and :'cy2'::jsonb ->> 'case_unavailable_reason' = 'ambiguous_case', 'dois casos sem vínculo: ambiguous_case');
select is(pg_temp.ctx(:'ws_um', :'kr') ->> 'case_unavailable_reason', 'conversation_link_unresolved', 'vínculo pendente: conversation_link_unresolved');
select is(pg_temp.ctx(:'ws_um', :'kw') ->> 'case_unavailable_reason', 'opportunity_not_won', 'caso não ganho: opportunity_not_won');
select is(pg_temp.ctx(:'ws_um', :'kw') #>> '{messages,0,eligible_case}', 'false', 'sem caso disponível, nenhuma mensagem é elegível para o andamento');

select is(pg_temp.n('select (select count(*) from public.status_tracks) + (select count(*) from public.status_track_automation_decisions)'),
  (:'antes')::bigint + 2, 'o contexto não grava nada (só a decisão humana e o roteiro do teste criaram trilhas)');

select * from finish();
rollback;
