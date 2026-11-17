-- pgTAP — Conversas + IA, PR 1: fundação das trilhas (sem IA).
--
-- Prova: superfície fechada (deny-all, sem anon), padrão "nao_informado" para
-- dados legados, correção manual da situação do atendimento e do andamento
-- (permissão própria por trilha, alcance do papel, isolamento entre
-- escritórios, versão esperada, idempotência), evidência validada no servidor
-- (escritório, conversa, alcance e alvo), pausa/retomada persistida que não
-- bloqueia a correção manual, versão/marco da trilha comercial atualizados por
-- toda movimentação em stage_transitions (sem segundo histórico), histórico
-- com antes/depois/autor/versão/evidência, oportunidade em foco sem escrita
-- (várias oportunidades do mesmo contato, vínculo incompatível), origem e
-- classificação das mensagens na leitura, e o caminho da C3b (a conversa e as
-- referências caem em cascata; o esqueleto anonimizado fica imutável).
--
-- Fixtures do seed: ana=owner, carla=lawyer, elisa=viewer no Escritório Um;
-- bruno=owner e carla=sales no Escritório Dois; daniel sem membership. Aqui:
-- bruno=sales e daniel=manager no Escritório Um. Todos os dados são sintéticos.

begin;
select plan(135);

\set ana    '20000000-0000-0000-0000-000000000001'
\set bruno  '20000000-0000-0000-0000-000000000002'
\set carla  '20000000-0000-0000-0000-000000000003'
\set daniel '20000000-0000-0000-0000-000000000004'
\set elisa  '20000000-0000-0000-0000-000000000005'
\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'
\set ninguem 'f0000000-0000-4000-8000-0000000000ff'

insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws_um'::uuid, :'bruno'::uuid, 'sales', 'active'),
  (:'ws_um'::uuid, :'daniel'::uuid, 'manager', 'active');

-- ---------------------------------------------------------------------
-- Ajudantes (só desta transação)
-- ---------------------------------------------------------------------

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

create function pg_temp.t(p_sql text) returns text language plpgsql security definer as $f$
declare v text;
begin
  execute p_sql into v;
  return v;
end;
$f$;

create function pg_temp.archive_at(p_lead uuid, p_at timestamptz) returns void language plpgsql as $f$
begin
  update public.leads set status = 'arquivado' where id = p_lead;
  alter table public.leads disable trigger leads_retention_mark;
  update public.leads set archived_at = p_at where id = p_lead;
  alter table public.leads enable trigger leads_retention_mark;
end;
$f$;

-- ---------------------------------------------------------------------
-- Dados de apoio
-- ---------------------------------------------------------------------

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select (create_contact(:'ws_um'::uuid, 'pf', 'Contato X Fundação', null, null, null)).id as cx \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Contato Y Fundação', null, null, null)).id as cy \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Titular W Fundação', null, null, null)).id as cw \gset
select create_lead(:'ws_um'::uuid, (:'cx')::uuid, 'Trabalhista', 'X da Ana', '{}'::text[], 'media', :'ana'::uuid) as l1 \gset
select create_lead(:'ws_um'::uuid, (:'cx')::uuid, 'Cível', 'X da Carla', '{}'::text[], 'media', :'carla'::uuid) as l2 \gset
select create_lead(:'ws_um'::uuid, (:'cx')::uuid, 'Família', 'X sem responsável', '{}'::text[], 'media', null) as l3 \gset
select create_lead(:'ws_um'::uuid, (:'cy')::uuid, 'Tributário', 'Y da Ana', '{}'::text[], 'media', :'ana'::uuid) as ly \gset
select create_lead(:'ws_um'::uuid, (:'cw')::uuid, 'Empresarial', 'W', '{}'::text[], 'media', :'ana'::uuid) as lw \gset
select create_opportunity((:'l1')::uuid) as o1 \gset
select create_opportunity((:'l1')::uuid) as o2 \gset
select create_opportunity((:'l2')::uuid) as o3 \gset
select create_opportunity((:'l3')::uuid) as o4 \gset
select create_opportunity((:'ly')::uuid) as oy \gset
select create_opportunity((:'lw')::uuid) as ow \gset
select win_opportunity((:'o2')::uuid, 0, 100000, 'fixed');
select win_opportunity((:'oy')::uuid, 0, 100000, 'fixed');
select pg_temp.login(:'bruno'::uuid);
select (create_contact(:'ws_dois'::uuid, 'pf', 'Contato Z Fundação', null, null, null)).id as cz \gset
select create_lead(:'ws_dois'::uuid, (:'cz')::uuid, 'Cível', 'Z', '{}'::text[], 'media', :'bruno'::uuid) as lz \gset
select create_opportunity((:'lz')::uuid) as oz \gset
select win_opportunity((:'oz')::uuid, 0, 100000, 'fixed');
reset role;

insert into public.whatsapp_channels (workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment, routing_key) values
  (:'ws_um'::uuid, 'Canal fundação', '+5541900005500', :'ana'::uuid, 'ycloud', false, 'preview', 'rota-55-um')
  returning id as canal \gset
insert into public.whatsapp_channels (workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment, routing_key) values
  (:'ws_dois'::uuid, 'Canal fundação dois', '+5541900005501', :'bruno'::uuid, 'ycloud', false, 'preview', 'rota-55-dois')
  returning id as canal2 \gset

create function pg_temp.conv(p_ws uuid, p_channel uuid, p_phone text, p_contact uuid, p_lead uuid, p_opp uuid) returns uuid
language plpgsql as $f$
declare v_ident uuid; v_conv uuid;
begin
  insert into public.whatsapp_identities (workspace_id, channel_id, provider, environment, phone_e164)
  values (p_ws, p_channel, 'ycloud', 'preview', p_phone) returning id into v_ident;
  insert into public.conversations (workspace_id, channel_id, identity_id, contact_id, lead_id, opportunity_id)
  values (p_ws, p_channel, v_ident, p_contact, p_lead, p_opp) returning id into v_conv;
  return v_conv;
end;
$f$;

create function pg_temp.msg(p_ws uuid, p_conv uuid, p_channel uuid, p_ref text) returns uuid
language plpgsql as $f$
declare v uuid;
begin
  insert into public.messages (workspace_id, conversation_id, channel_id, direction, status, origin, sender_classification, content_kind, body_text, provider, provider_message_id)
  values (p_ws, p_conv, p_channel, 'inbound', 'delivered', 'inbound', 'external', 'text', 'Mensagem sintética ' || p_ref, 'ycloud', 'WAMID-55-' || p_ref)
  returning id into v;
  return v;
end;
$f$;

select pg_temp.conv(:'ws_um'::uuid, (:'canal')::uuid, '+5541999995501', (:'cx')::uuid, (:'l1')::uuid, (:'o1')::uuid) as conv_x \gset
select pg_temp.conv(:'ws_um'::uuid, (:'canal')::uuid, '+5541999995502', (:'cx')::uuid, (:'l2')::uuid, null) as conv_x2 \gset
select pg_temp.conv(:'ws_um'::uuid, (:'canal')::uuid, '+5541999995503', (:'cy')::uuid, (:'ly')::uuid, null) as conv_y \gset
select pg_temp.conv(:'ws_um'::uuid, (:'canal')::uuid, '+5541999995504', null, null, null) as conv_nc \gset
select pg_temp.conv(:'ws_um'::uuid, (:'canal')::uuid, '+5541999995505', (:'cw')::uuid, (:'lw')::uuid, (:'ow')::uuid) as conv_w \gset
select pg_temp.conv(:'ws_dois'::uuid, (:'canal2')::uuid, '+5541999995506', (:'cz')::uuid, (:'lz')::uuid, (:'oz')::uuid) as conv_z \gset

select pg_temp.msg(:'ws_um'::uuid, (:'conv_x')::uuid, (:'canal')::uuid, 'x1') as m_x1 \gset
select pg_temp.msg(:'ws_um'::uuid, (:'conv_x')::uuid, (:'canal')::uuid, 'x2') as m_x2 \gset
select pg_temp.msg(:'ws_um'::uuid, (:'conv_x2')::uuid, (:'canal')::uuid, 'x3') as m_x3 \gset
select pg_temp.msg(:'ws_um'::uuid, (:'conv_y')::uuid, (:'canal')::uuid, 'y1') as m_y1 \gset
select pg_temp.msg(:'ws_um'::uuid, (:'conv_nc')::uuid, (:'canal')::uuid, 'nc') as m_nc \gset
select pg_temp.msg(:'ws_um'::uuid, (:'conv_w')::uuid, (:'canal')::uuid, 'w1') as m_w1 \gset
select pg_temp.msg(:'ws_dois'::uuid, (:'conv_z')::uuid, (:'canal2')::uuid, 'z1') as m_z1 \gset
-- Saídas: uma do chatbot COM correlação positiva e uma de integração não identificada.
insert into public.messages (workspace_id, conversation_id, channel_id, direction, status, origin, sender_classification, content_kind, body_text, provider, provider_message_id, origin_correlation_kind, origin_correlation_ref)
values (:'ws_um'::uuid, (:'conv_x')::uuid, (:'canal')::uuid, 'outbound', 'delivered', 'chatbot', 'automation', 'text', 'Resposta automática sintética', 'ycloud', 'WAMID-55-bot', 'chatbot_request', 'pedido-55')
returning id as m_bot \gset
insert into public.messages (workspace_id, conversation_id, channel_id, direction, status, origin, sender_classification, content_kind, provider, provider_message_id)
values (:'ws_um'::uuid, (:'conv_x')::uuid, (:'canal')::uuid, 'outbound', 'delivered', 'external_api', 'unresolved', 'document', 'ycloud', 'WAMID-55-api')
returning id as m_api \gset

-- =====================================================================
-- 1) Superfície fechada
-- =====================================================================

select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.status_tracks'::regclass), 'status_tracks: RLS ligada e forçada');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.status_track_events'::regclass), 'status_track_events: RLS ligada e forçada');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.status_track_event_evidence'::regclass), 'status_track_event_evidence: RLS ligada e forçada');
select ok(not has_table_privilege('authenticated', 'public.status_tracks', 'select,insert,update,delete'), 'authenticated não acessa status_tracks diretamente');
select ok(not has_table_privilege('authenticated', 'public.status_track_events', 'select,insert,update,delete'), 'authenticated não acessa o histórico diretamente');
select ok(not has_table_privilege('anon', 'public.status_track_event_evidence', 'select'), 'anon não acessa a evidência');
select ok(
  not has_function_privilege('anon', 'public.set_conversation_attendance_status(uuid, public.conversation_attendance_status, bigint, uuid[], uuid)', 'execute')
  and not has_function_privilege('anon', 'public.set_opportunity_case_progress(uuid, public.case_progress_status, bigint, uuid[], uuid)', 'execute')
  and not has_function_privilege('anon', 'public.set_status_track_automation(public.status_track_kind, uuid, boolean, bigint)', 'execute')
  and not has_function_privilege('anon', 'public.get_status_track(public.status_track_kind, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.list_status_track_history(public.status_track_kind, uuid, timestamptz, uuid, integer)', 'execute')
  and not has_function_privilege('anon', 'public.list_conversation_case_options(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.get_conversation_case(uuid, uuid)', 'execute'),
  'nenhuma função nova é executável por anon'
);
select ok(
  (select bool_and(p.prosecdef and p.proconfig = array['search_path=""'])
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('set_conversation_attendance_status', 'set_opportunity_case_progress',
     'set_status_track_automation', 'get_status_track', 'list_status_track_history', 'list_conversation_case_options', 'get_conversation_case')),
  'funções novas: SECURITY DEFINER com search_path vazio'
);
select ok(
  not has_function_privilege('authenticated', 'private.status_track_lock(uuid, public.status_track_kind, uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.status_track_validate_evidence(uuid, public.membership_role, uuid, public.status_track_kind, uuid, uuid, uuid[])', 'execute'),
  'funções internas não são chamáveis pela API'
);

-- =====================================================================
-- 2) Dado legado: "nao_informado", versão 0, sem pausa, sem registro
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select get_status_track('attendance', (:'conv_y')::uuid) as st_y \gset
select get_status_track('case_progress', (:'o2')::uuid) as st_o2 \gset
select get_status_track('case_progress', (:'o1')::uuid) as st_o1 \gset
reset role;
select is(:'st_y'::jsonb ->> 'status', 'nao_informado', 'conversa antiga: situação nao_informado (nunca "novo")');
select is((:'st_y'::jsonb ->> 'version')::int, 0, 'conversa antiga: versão 0');
select ok(not (:'st_y'::jsonb ->> 'automation_paused')::boolean and not (:'st_y'::jsonb ->> 'has_record')::boolean, 'conversa antiga: sem pausa e sem registro');
select is(:'st_o2'::jsonb ->> 'status', 'nao_informado', 'oportunidade ganha antiga: andamento nao_informado (nunca "em análise")');
select ok((:'st_o1'::jsonb ->> 'applicable')::boolean = false and (:'st_o1'::jsonb ->> 'status') is null, 'oportunidade aberta: andamento não se aplica');
select is(pg_temp.n('select count(*) from public.status_tracks where track <> ''commercial_stage'''), 0::bigint, 'a migration não cria nenhum registro de situação ou andamento');

-- =====================================================================
-- 3) Situação do atendimento — correção manual
-- =====================================================================

select count(*) as act_antes from public.activities where workspace_id = (:'ws_um')::uuid \gset
select count(*) as auto_antes from public.automation_events where workspace_id = (:'ws_um')::uuid \gset

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select set_conversation_attendance_status((:'conv_x')::uuid, 'aguardando_escritorio', 0, array[(:'m_x1')::uuid]) as at1 \gset
reset role;
select is(:'at1'::jsonb ->> 'status', 'aguardando_escritorio', 'owner corrige a situação');
select is((:'at1'::jsonb ->> 'version')::int, 1, 'versão passa a 1');
select ok((:'at1'::jsonb ->> 'manual_decided_at') is not null, 'marco de evidência gravado');
select is(pg_temp.t(format('select from_status || ''>'' || to_status || ''|'' || from_version || ''>'' || to_version || ''|'' || actor_kind || ''|'' || actor_user_id || ''|'' || evidence_count from public.status_track_events where id = %L', :'at1'::jsonb ->> 'event_id')),
  'nao_informado>aguardando_escritorio|0>1|user|' || :'ana' || '|1', 'histórico: antes/depois, versões, autor humano e contagem de evidência');
select is(pg_temp.n(format('select count(*) from public.status_track_event_evidence where event_id = %L and message_id = %L', :'at1'::jsonb ->> 'event_id', :'m_x1')), 1::bigint, 'referência da evidência gravada (só o id)');
select is(pg_temp.n(format('select count(*) from public.audit_logs where resource_id = %L and action = ''conversation.attendance_changed''', :'conv_x')), 1::bigint, 'auditoria registrada');
select ok(pg_temp.t(format('select metadata::text from public.audit_logs where resource_id = %L and action = ''conversation.attendance_changed''', :'conv_x')) not like '%Mensagem sintética%', 'auditoria sem texto de mensagem');

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select throws_ok(format($q$select set_conversation_attendance_status(%L, 'aguardando_cliente', 0)$q$, :'conv_x'), 'P0001', 'track_conflict', 'versão antiga: track_conflict');
select throws_ok(format($q$select set_conversation_attendance_status(%L, 'aguardando_escritorio', 1)$q$, :'conv_x'), 'P0001', 'status_unchanged', 'mesmo estado: status_unchanged');
select throws_ok(format($q$select set_conversation_attendance_status(%L, 'nao_informado', 1)$q$, :'conv_x'), 'P0001', 'invalid_status', 'nao_informado não é escolha manual');
select throws_ok(format($q$select set_conversation_attendance_status(%L, 'encerrado', null)$q$, :'conv_x'), 'P0001', 'invalid_version', 'sem versão esperada: invalid_version');
select throws_ok(format($q$select set_conversation_attendance_status(%L, 'encerrado', 0)$q$, :'ninguem'), 'P0001', 'conversation_not_found', 'conversa inexistente');
select throws_ok(format($q$select set_conversation_attendance_status(%L, 'encerrado', 0)$q$, :'conv_z'), 'P0001', 'insufficient_permission', 'conversa de outro escritório: recusada');

-- Papéis
select pg_temp.login(:'bruno'::uuid);
select lives_ok(format($q$select set_conversation_attendance_status(%L, 'aguardando_cliente', 1)$q$, :'conv_x'), 'atendimento (sales) corrige a situação do atendimento');
select pg_temp.login(:'daniel'::uuid);
select lives_ok(format($q$select set_conversation_attendance_status(%L, 'novo', 0)$q$, :'conv_nc'), 'manager corrige conversa sem contato (alcance administrativo)');
select pg_temp.login(:'elisa'::uuid);
select throws_ok(format($q$select set_conversation_attendance_status(%L, 'encerrado', 2)$q$, :'conv_x'), 'P0001', 'insufficient_permission', 'visualizador não corrige');
select pg_temp.login(:'carla'::uuid);
select throws_ok(format($q$select set_conversation_attendance_status(%L, 'encerrado', 2)$q$, :'conv_x'), 'P0001', 'conversation_not_found', 'advogado fora do alcance: não encontrado');
select throws_ok(format($q$select set_conversation_attendance_status(%L, 'encerrado', 1)$q$, :'conv_nc'), 'P0001', 'conversation_not_found', 'advogado não alcança conversa sem lead');
select lives_ok(format($q$select set_conversation_attendance_status(%L, 'aguardando_escritorio', 0, array[%L]::uuid[])$q$, :'conv_x2', :'m_x3'), 'advogado corrige conversa do próprio lead');
select pg_temp.login(:'daniel'::uuid);
select throws_ok(format($q$select set_conversation_attendance_status(%L, 'encerrado', 0)$q$, :'conv_z'), 'P0001', 'insufficient_permission', 'sem membership no outro escritório');
reset role;

-- Idempotência
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select set_conversation_attendance_status((:'conv_y')::uuid, 'aguardando_escritorio', 0, array[(:'m_y1')::uuid], 'a0000000-0000-4000-8000-000000000055') as idem1 \gset
select set_conversation_attendance_status((:'conv_y')::uuid, 'aguardando_escritorio', 0, array[(:'m_y1')::uuid], 'a0000000-0000-4000-8000-000000000055') as idem2 \gset
select is(:'idem2'::jsonb ->> 'event_id', :'idem1'::jsonb ->> 'event_id', 'mesma chave e mesmo pedido: devolve o mesmo evento');
select ok((:'idem2'::jsonb ->> 'replayed')::boolean and (:'idem2'::jsonb ->> 'version')::int = 1, 'repetição marcada como replayed, sem nova versão');
select throws_ok(format($q$select set_conversation_attendance_status(%L, 'encerrado', 1, '{}'::uuid[], 'a0000000-0000-4000-8000-000000000055')$q$, :'conv_y'), 'P0001', 'idempotency_conflict', 'mesma chave com outro estado: idempotency_conflict');
select throws_ok(format($q$select set_conversation_attendance_status(%L, 'aguardando_escritorio', 0, '{}'::uuid[], 'a0000000-0000-4000-8000-000000000055')$q$, :'conv_x2'), 'P0001', 'idempotency_conflict', 'mesma chave em outro alvo: idempotency_conflict');
select throws_ok(format($q$select set_conversation_attendance_status(%L, 'aguardando_escritorio', 0, '{}'::uuid[], 'a0000000-0000-4000-8000-000000000055')$q$, :'conv_y'), 'P0001', 'idempotency_conflict', 'mesma chave com outra evidência: idempotency_conflict');
reset role;
select is(pg_temp.n(format('select count(*) from public.status_track_events where idempotency_key = %L', 'a0000000-0000-4000-8000-000000000055')), 1::bigint, 'uma única mudança gravada para a chave');

-- =====================================================================
-- 4) Evidência validada no servidor
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select throws_ok(format($q$select set_conversation_attendance_status(%L, 'encerrado', 2, array[%L]::uuid[])$q$, :'conv_x', :'m_y1'), 'P0001', 'invalid_evidence', 'mensagem de outra conversa: recusada');
select throws_ok(format($q$select set_conversation_attendance_status(%L, 'encerrado', 2, array[%L]::uuid[])$q$, :'conv_x', :'m_z1'), 'P0001', 'invalid_evidence', 'mensagem de outro escritório: recusada');
select throws_ok(format($q$select set_conversation_attendance_status(%L, 'encerrado', 2, array[%L]::uuid[])$q$, :'conv_x', :'ninguem'), 'P0001', 'invalid_evidence', 'id inexistente: recusado');
select throws_ok(format($q$select set_conversation_attendance_status(%L, 'encerrado', 2, array[%L, %L]::uuid[])$q$, :'conv_x', :'m_x1', :'m_x1'), 'P0001', 'invalid_evidence', 'id repetido: recusado');
select throws_ok(format($q$select set_conversation_attendance_status(%L, 'encerrado', 2, array[%L, null]::uuid[])$q$, :'conv_x', :'m_x1'), 'P0001', 'invalid_evidence', 'nulo na lista: recusado');
select throws_ok(format($q$select set_conversation_attendance_status(%L, 'encerrado', 2, (select array_agg(gen_random_uuid()) from generate_series(1, 21)))$q$, :'conv_x'), 'P0001', 'invalid_evidence', 'mais de 20 referências: recusado');
select pg_temp.login(:'carla'::uuid);
select throws_ok(format($q$select set_conversation_attendance_status(%L, 'encerrado', 1, array[%L]::uuid[])$q$, :'conv_x2', :'m_x1'), 'P0001', 'invalid_evidence', 'mensagem de outra conversa do mesmo contato não vale para a situação desta conversa');
reset role;
select is(pg_temp.n(format('select version from public.status_tracks where conversation_id = %L', :'conv_x')), 2::bigint, 'nenhuma tentativa inválida alterou a trilha');

-- =====================================================================
-- 5) Andamento do caso/serviço — só oportunidade ganha
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select set_opportunity_case_progress((:'o2')::uuid, 'aguardando_documentos', 0, array[(:'m_x1')::uuid, (:'m_x3')::uuid]) as cp1 \gset
reset role;
select is(:'cp1'::jsonb ->> 'status', 'aguardando_documentos', 'owner corrige o andamento da oportunidade ganha');
select is(pg_temp.n(format('select evidence_count from public.status_track_events where id = %L', :'cp1'::jsonb ->> 'event_id')), 2::bigint, 'evidência de duas conversas do MESMO contato aceita');
select is(pg_temp.n(format('select count(*) from public.audit_logs where resource_id = %L and action = ''opportunity.case_progress_changed''', :'o2')), 1::bigint, 'auditoria do andamento');

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select throws_ok(format($q$select set_opportunity_case_progress(%L, 'em_analise', 0)$q$, :'o1'), 'P0001', 'opportunity_not_won', 'oportunidade aberta: sem andamento');
select throws_ok(format($q$select set_opportunity_case_progress(%L, 'em_analise', 1, array[%L]::uuid[])$q$, :'o2', :'m_y1'), 'P0001', 'invalid_evidence', 'mensagem de OUTRO contato não serve de evidência do caso');
select throws_ok(format($q$select set_opportunity_case_progress(%L, 'em_analise', 1, array[%L]::uuid[])$q$, :'o2', :'m_nc'), 'P0001', 'invalid_evidence', 'mensagem de conversa sem contato não serve de evidência do caso');
select throws_ok(format($q$select set_opportunity_case_progress(%L, 'em_analise', 0)$q$, :'o2'), 'P0001', 'track_conflict', 'andamento: versão antiga recusada');
select throws_ok(format($q$select set_opportunity_case_progress(%L, 'em_analise', 0)$q$, :'oz'), 'P0001', 'insufficient_permission', 'andamento de outro escritório: recusado');
select pg_temp.login(:'bruno'::uuid);
select throws_ok(format($q$select set_opportunity_case_progress(%L, 'em_analise', 1)$q$, :'o2'), 'P0001', 'insufficient_permission', 'atendimento (sales) NÃO corrige andamento jurídico');
select pg_temp.login(:'elisa'::uuid);
select throws_ok(format($q$select set_opportunity_case_progress(%L, 'em_analise', 1)$q$, :'o2'), 'P0001', 'insufficient_permission', 'visualizador não corrige andamento');
select pg_temp.login(:'carla'::uuid);
select throws_ok(format($q$select set_opportunity_case_progress(%L, 'em_analise', 1)$q$, :'o2'), 'P0001', 'opportunity_not_found', 'advogado fora do alcance do lead: não encontrado');
select pg_temp.login(:'daniel'::uuid);
select lives_ok(format($q$select set_opportunity_case_progress(%L, 'em_analise', 1)$q$, :'o2'), 'manager corrige andamento');
reset role;

-- =====================================================================
-- 6) Pausa e retomada das FUTURAS alterações automáticas
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select set_status_track_automation('case_progress', (:'o2')::uuid, true, 2) as pz1 \gset
reset role;
select ok((:'pz1'::jsonb ->> 'automation_paused')::boolean, 'pausa gravada no andamento');
select is((:'pz1'::jsonb ->> 'version')::int, 3, 'pausar incrementa a versão');
select is(pg_temp.t(format('select event || ''|'' || coalesce(from_status, ''-'') || ''|'' || evidence_count from public.status_track_events where id = %L', :'pz1'::jsonb ->> 'event_id')), 'automation_paused|-|0', 'pausa entra no histórico, sem estado nem evidência');

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select throws_ok(format($q$select set_status_track_automation('case_progress', %L, true, 3)$q$, :'o2'), 'P0001', 'automation_already_paused', 'pausar de novo: recusado');
select lives_ok(format($q$select set_opportunity_case_progress(%L, 'em_execucao', 3)$q$, :'o2'), 'a pausa NÃO bloqueia a correção manual');
select throws_ok(format($q$select set_status_track_automation('case_progress', %L, false, 3)$q$, :'o2'), 'P0001', 'track_conflict', 'retomar com versão antiga (anterior à correção): recusado');
select set_status_track_automation('case_progress', (:'o2')::uuid, false, 4) as rz1 \gset
select throws_ok(format($q$select set_status_track_automation('case_progress', %L, false, 5)$q$, :'o2'), 'P0001', 'automation_not_paused', 'retomar sem pausa: recusado');
select pg_temp.login(:'bruno'::uuid);
select throws_ok(format($q$select set_status_track_automation('case_progress', %L, true, 5)$q$, :'o2'), 'P0001', 'insufficient_permission', 'atendimento não pausa o andamento');
select lives_ok(format($q$select set_status_track_automation('attendance', %L, true, 2)$q$, :'conv_x'), 'atendimento pausa a situação do atendimento da conversa');
select pg_temp.login(:'elisa'::uuid);
select throws_ok(format($q$select set_status_track_automation('attendance', %L, false, 3)$q$, :'conv_x'), 'P0001', 'insufficient_permission', 'visualizador não retoma');
select pg_temp.login(:'ana'::uuid);
select throws_ok(format($q$select set_status_track_automation('case_progress', %L, true, 0)$q$, :'o1'), 'P0001', 'opportunity_not_won', 'pausa do andamento exige oportunidade ganha');
select throws_ok(format($q$select set_status_track_automation('commercial_stage', %L, true, 0)$q$, :'o2'), 'P0001', 'opportunity_closed', 'pausa comercial exige oportunidade aberta');
select (get_status_track('commercial_stage', (:'o1')::uuid) ->> 'version')::bigint as o1_cv \gset
select (get_status_track('commercial_stage', (:'o1')::uuid) ->> 'stage_id') as o1_stage_lido \gset
select set_status_track_automation('commercial_stage', (:'o1')::uuid, true, (:'o1_cv')::bigint) as pc1 \gset
reset role;
select ok((:'rz1'::jsonb ->> 'automation_paused')::boolean = false and (:'rz1'::jsonb ->> 'version')::int = 5, 'retomada grava pausa=false e nova versão');
select ok((:'pc1'::jsonb ->> 'automation_paused')::boolean and (:'pc1'::jsonb ->> 'version')::bigint = (:'o1_cv')::bigint + 1, 'trilha comercial: pausa por oportunidade, nova versão');
select is(pg_temp.t(format('select stage_id::text from public.opportunities where id = %L', :'o1')), :'o1_stage_lido', 'pausar não muda a etapa');
select is(pg_temp.t(format('select automation_paused_by::text from public.status_tracks where id = %L', :'pc1'::jsonb ->> 'track_id')), :'ana', 'quem pausou fica registrado');
select is(pg_temp.n('select count(*) from public.activities where workspace_id = ''' || :'ws_um' || ''''), (:'act_antes')::bigint, 'correções e pausas não criaram atividade');
select is(pg_temp.n('select count(*) from public.automation_events where workspace_id = ''' || :'ws_um' || ''''), (:'auto_antes')::bigint, 'correções e pausas não geraram evento de automação');

-- =====================================================================
-- 7) Trilha comercial: stage_transitions continua a fonte canônica
-- =====================================================================

select count(*) as st_antes from public.stage_transitions where opportunity_id = (:'o1')::uuid \gset
select stage_id as o1_stage, pipeline_id as o1_pipe, lock_version as o1_lock from public.opportunities where id = (:'o1')::uuid \gset
select id as o1_next from public.pipeline_stages
where pipeline_id = (:'o1_pipe')::uuid and id <> (:'o1_stage')::uuid and not is_won and not is_lost
order by position limit 1 \gset
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select move_opportunity_stage((:'o1')::uuid, (:'o1_stage')::uuid, (:'o1_next')::uuid, (:'o1_lock')::bigint);
reset role;
select is(pg_temp.n(format('select count(*) from public.stage_transitions where opportunity_id = %L', :'o1')), (:'st_antes')::bigint + 1, 'movimentação manual gravada em stage_transitions (uma vez)');
select is(pg_temp.n(format('select version from public.status_tracks where opportunity_id = %L and track = ''commercial_stage''', :'o1')), (:'o1_cv')::bigint + 2, 'a movimentação incrementa a versão da trilha comercial');
select ok(pg_temp.t(format('select manual_decided_at::text from public.status_tracks where opportunity_id = %L and track = ''commercial_stage''', :'o1')) is not null, 'e grava o marco de evidência');
select is(pg_temp.n(format('select count(*) from public.status_track_events e join public.status_tracks t on t.id = e.track_id where t.opportunity_id = %L', :'o1')), 1::bigint, 'nenhum segundo histórico da movimentação (só o evento da pausa)');
select ok(pg_temp.t(format('select automation_paused::text from public.status_tracks where opportunity_id = %L and track = ''commercial_stage''', :'o1')) = 'true', 'a pausa continua depois da movimentação manual');
select is(pg_temp.n(format('select count(*) from public.stage_transitions where opportunity_id = %L and actor_user_id is null', :'o1')), 0::bigint, 'stage_transitions.actor_user_id segue obrigatório');
select is(
  coalesce(pg_temp.n(format('select version from public.status_tracks where opportunity_id = %L and track = ''commercial_stage''', :'o2')), 0),
  pg_temp.n(format('select count(*) from public.stage_transitions where opportunity_id = %L', :'o2')),
  'a versão comercial conta exatamente as transições registradas em stage_transitions (ganhar não passa por ela)'
);

-- =====================================================================
-- 8) Leitura do histórico
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select items as h_o2, has_more as h_o2_more from list_status_track_history('case_progress', (:'o2')::uuid) \gset
select items as h_o2_p1, has_more as h_o2_p1_more from list_status_track_history('case_progress', (:'o2')::uuid, null, null, 2) \gset
reset role;
select is(jsonb_array_length(:'h_o2'::jsonb), 5, 'histórico do andamento: 3 mudanças + pausa + retomada');
select is(:'h_o2'::jsonb -> 0 ->> 'event', 'automation_resumed', 'mais recente primeiro');
select ok((select bool_and(e ? 'actor_name' and e ? 'from_version' and e ? 'to_version' and e ? 'occurred_at') from jsonb_array_elements(:'h_o2'::jsonb) e), 'cada evento traz autor, versões e horário');
select ok(
  (select bool_and(not (ev ? 'body_text')) from jsonb_array_elements(:'h_o2'::jsonb) e, jsonb_array_elements(e -> 'evidence') ev),
  'evidência sem texto de mensagem'
);
select is(
  (select jsonb_array_length(e -> 'evidence') from jsonb_array_elements(:'h_o2'::jsonb) e where e ->> 'to_status' = 'aguardando_documentos'),
  2, 'owner vê as duas evidências'
);
select ok((:'h_o2_p1_more')::boolean and jsonb_array_length(:'h_o2_p1'::jsonb) = 2, 'paginação: página de 2 com has_more');

select (:'h_o2_p1'::jsonb -> 1 ->> 'occurred_at') as cur_at, (:'h_o2_p1'::jsonb -> 1 ->> 'id') as cur_id \gset
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select items as h_o2_p2 from list_status_track_history('case_progress', (:'o2')::uuid, (:'cur_at')::timestamptz, (:'cur_id')::uuid, 2) \gset
select throws_ok(format($q$select * from list_status_track_history('case_progress', %L, now(), null)$q$, :'o2'), 'P0001', 'invalid_cursor', 'cursor incompleto recusado');
select pg_temp.login(:'carla'::uuid);
select throws_ok(format($q$select * from list_status_track_history('case_progress', %L)$q$, :'o2'), 'P0001', 'opportunity_not_found', 'advogado fora do alcance não lê o histórico');
select pg_temp.login(:'ana'::uuid);
select throws_ok(format($q$select * from list_status_track_history('attendance', %L)$q$, :'conv_z'), 'P0001', 'insufficient_permission', 'histórico de outro escritório: recusado');
reset role;
select ok(
  (select count(*) = 0 from jsonb_array_elements(:'h_o2_p1'::jsonb) a, jsonb_array_elements(:'h_o2_p2'::jsonb) b where a ->> 'id' = b ->> 'id')
  and jsonb_array_length(:'h_o2_p2'::jsonb) = 2,
  'página seguinte sem repetir eventos'
);

-- Quem lê com alcance menor: a oportunidade fica no alcance do advogado (lead sem
-- responsável), mas a conversa da segunda evidência não (lead de outra pessoa).
update public.leads set assigned_to = null where id = (:'l1')::uuid;
update public.leads set assigned_to = :'ana'::uuid where id = (:'l2')::uuid;
set local role authenticated;
select pg_temp.login(:'carla'::uuid);
select items as h_carla from list_status_track_history('case_progress', (:'o2')::uuid) \gset
select (get_status_track('case_progress', (:'o2')::uuid) ->> 'version')::bigint as o2_v \gset
select throws_ok(format($q$select set_opportunity_case_progress(%L, 'em_analise', %s, array[%L]::uuid[])$q$, :'o2', :'o2_v', :'m_x3'), 'P0001', 'invalid_evidence', 'advogado não usa como evidência mensagem de conversa fora do alcance dele (mesmo do mesmo contato)');
reset role;
update public.leads set assigned_to = :'ana'::uuid where id = (:'l1')::uuid;
update public.leads set assigned_to = :'carla'::uuid where id = (:'l2')::uuid;
select ok(
  (select (e ->> 'evidence_hidden')::int = 1 and jsonb_array_length(e -> 'evidence') = 1
          and e -> 'evidence' -> 0 ->> 'message_id' = :'m_x1'
   from jsonb_array_elements(:'h_carla'::jsonb) e where e ->> 'to_status' = 'aguardando_documentos'),
  'evidência de conversa fora do alcance de quem lê: contada como oculta, sem referência'
);

-- =====================================================================
-- 9) Oportunidade em foco — várias oportunidades, sem escrita
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select list_conversation_case_options((:'conv_x')::uuid) as opts_ana \gset
select get_conversation_case((:'conv_x')::uuid, (:'o3')::uuid) as foco_o3 \gset
select list_conversation_case_options((:'conv_nc')::uuid) as opts_nc \gset
select throws_ok(format($q$select get_conversation_case(%L, %L)$q$, :'conv_x', :'oy'), 'P0001', 'case_not_selectable', 'oportunidade de OUTRO contato: vínculo incompatível');
select throws_ok(format($q$select get_conversation_case(%L, %L)$q$, :'conv_x', :'oz'), 'P0001', 'case_not_selectable', 'oportunidade de outro escritório: recusada');
select throws_ok(format($q$select get_conversation_case(%L, %L)$q$, :'conv_x', :'ninguem'), 'P0001', 'case_not_selectable', 'oportunidade inexistente: recusada');
select throws_ok(format($q$select get_conversation_case(%L, %L)$q$, :'conv_nc', :'o1'), 'P0001', 'case_not_selectable', 'conversa sem contato resolvido: nenhum caso selecionável');
select pg_temp.login(:'carla'::uuid);
select list_conversation_case_options((:'conv_x2')::uuid) as opts_carla \gset
select throws_ok(format($q$select get_conversation_case(%L, %L)$q$, :'conv_x2', :'o1'), 'P0001', 'case_not_selectable', 'advogado não foca oportunidade de lead fora do alcance');
reset role;
select is(jsonb_array_length(:'opts_ana' ::jsonb -> 'items'), 4, 'owner: as quatro oportunidades do mesmo contato (três leads)');
select is(:'opts_ana'::jsonb -> 'items' -> 0 ->> 'opportunity_id', :'o1', 'o vínculo persistido vem primeiro');
select ok((:'opts_ana'::jsonb -> 'items' -> 0 ->> 'is_linked')::boolean and (select count(*) = 1 from jsonb_array_elements(:'opts_ana'::jsonb -> 'items') i where (i ->> 'is_linked')::boolean), 'só uma opção marcada como vínculo persistido');
select ok(
  (select bool_and(i ->> 'opportunity_id' <> :'oy') from jsonb_array_elements(:'opts_ana'::jsonb -> 'items') i),
  'nenhuma oportunidade de outro contato entre as opções'
);
select is(
  (select i ->> 'case_progress_status' from jsonb_array_elements(:'opts_ana'::jsonb -> 'items') i where i ->> 'opportunity_id' = :'o2'),
  'em_execucao', 'opção ganha traz o andamento atual'
);
select ok(:'foco_o3'::jsonb ->> 'opportunity_id' = :'o3' and not (:'foco_o3'::jsonb ->> 'is_linked')::boolean, 'foco em outra oportunidade do contato é válido e não é o vínculo');
select is(pg_temp.t(format('select opportunity_id::text from public.conversations where id = %L', :'conv_x')), :'o1', 'escolher o foco NÃO altera conversations.opportunity_id');
select ok(not (:'opts_nc'::jsonb ->> 'contact_resolved')::boolean and jsonb_array_length(:'opts_nc'::jsonb -> 'items') = 0, 'conversa sem contato: nenhuma opção');
select is(
  (select array_agg(i ->> 'opportunity_id' order by i ->> 'opportunity_id') from jsonb_array_elements(:'opts_carla'::jsonb -> 'items') i),
  (select array_agg(x order by x) from unnest(array[:'o3', :'o4']) x),
  'advogado: só oportunidades dos leads dele e sem responsável'
);

-- =====================================================================
-- 10) Mensagens: origem, classificação e tipo de conteúdo
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select items as msgs_x from list_conversation_messages((:'conv_x')::uuid) \gset
reset role;
select is(
  (select m ->> 'origin' || '|' || (m ->> 'sender_classification') || '|' || (m ->> 'content_kind') from jsonb_array_elements(:'msgs_x'::jsonb) m where m ->> 'id' = :'m_x1'),
  'inbound|external|text', 'mensagem recebida: origem, classificação e tipo'
);
select is(
  (select m ->> 'origin' || '|' || (m ->> 'sender_classification') from jsonb_array_elements(:'msgs_x'::jsonb) m where m ->> 'id' = :'m_bot'),
  'chatbot|automation', 'chatbot com correlação: automation (sem rótulo de pessoa)'
);
select is(
  (select m ->> 'origin' || '|' || (m ->> 'sender_classification') || '|' || (m ->> 'content_kind') from jsonb_array_elements(:'msgs_x'::jsonb) m where m ->> 'id' = :'m_api'),
  'external_api|unresolved|document', 'sem correlação: classificação desconhecida preservada'
);
select ok((select bool_and(m ? 'body_text' and m ? 'status' and m ? 'created_at') from jsonb_array_elements(:'msgs_x'::jsonb) m), 'campos anteriores continuam iguais');

-- =====================================================================
-- 11) Concorrência (sequencial): a versão esperada e a trava da linha
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select (get_status_track('attendance', (:'conv_x2')::uuid) ->> 'version')::bigint as v_x2 \gset
select lives_ok(format($q$select set_conversation_attendance_status(%L, 'encerrado', %s)$q$, :'conv_x2', :'v_x2'), 'primeira correção com a versão lida passa');
select pg_temp.login(:'carla'::uuid);
select throws_ok(format($q$select set_conversation_attendance_status(%L, 'aguardando_cliente', %s)$q$, :'conv_x2', :'v_x2'), 'P0001', 'track_conflict', 'segunda correção com a MESMA versão lida: track_conflict');
reset role;
select is(pg_temp.n(format('select count(*) from public.status_tracks where conversation_id = %L', :'conv_x2')), 1::bigint, 'uma única linha de trilha por conversa');
select throws_ok(
  format($q$insert into public.status_tracks (workspace_id, track, conversation_id, attendance_status) values (%L, 'attendance', %L, 'novo')$q$, :'ws_um', :'conv_x2'),
  '23505', null, 'índice único impede segunda linha da mesma trilha'
);
select throws_ok(
  format($q$update public.status_tracks set opportunity_id = %L where conversation_id = %L$q$, :'o1', :'conv_x2'),
  'P0001', 'status_track_target_immutable', 'o alvo da trilha é imutável'
);
select throws_ok(
  format($q$update public.status_track_events set to_status = 'encerrado' where id = %L$q$, :'at1'::jsonb ->> 'event_id'),
  'P0001', 'status_track_history_immutable', 'o histórico é imutável'
);
select throws_ok(
  format($q$insert into public.status_tracks (workspace_id, track, conversation_id, attendance_status) values (%L, 'attendance', %L, 'novo')$q$, :'ws_dois', :'conv_w'),
  '23503', null, 'trilha não aponta para conversa de outro escritório'
);
select throws_ok(
  format($q$insert into public.status_track_event_evidence (workspace_id, event_id, message_id) values (%L, %L, %L)$q$, :'ws_um', :'at1'::jsonb ->> 'event_id', :'m_z1'),
  '23503', null, 'evidência não aponta para mensagem de outro escritório'
);

-- =====================================================================
-- 12) C3b: a anonimização leva a conversa, as trilhas dela e as referências
-- =====================================================================

-- Titular W: lead arquivado há mais de 12 meses, oportunidade perdida, sem cliente.
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select set_status_track_automation('commercial_stage', (:'ow')::uuid, true,
  (get_status_track('commercial_stage', (:'ow')::uuid) ->> 'version')::bigint) as pw \gset
select set_conversation_attendance_status((:'conv_w')::uuid, 'aguardando_cliente', 0, array[(:'m_w1')::uuid]) as aw \gset
reset role;
select pg_temp.archive_at((:'lw')::uuid, ((now() at time zone 'UTC') - interval '14 months') at time zone 'UTC');
update public.opportunities
set status = 'lost', lost_reason_id = (select id from public.lost_reasons where workspace_id = (:'ws_um')::uuid order by position limit 1)
where id = (:'ow')::uuid;

select is(pg_temp.n(format('select count(*) from public.status_track_event_evidence where message_id = %L', :'m_w1')), 1::bigint, 'antes: a referência existe');
set local role service_role;
select anonymize_privacy_contact((:'ana')::uuid, (:'ws_um')::uuid, (:'cw')::uuid) as r_w \gset
reset role;
select is(:'r_w'::jsonb ->> 'result', 'anonymized', 'a anonimização conclui com as tabelas novas presentes');
select is(pg_temp.n(format('select count(*) from public.status_tracks where conversation_id = %L', :'conv_w')), 0::bigint, 'a trilha da conversa some com a conversa');
select is(pg_temp.n(format('select count(*) from public.status_track_events where id = %L', :'aw'::jsonb ->> 'event_id')), 0::bigint, 'o histórico da conversa some junto');
select is(pg_temp.n(format('select count(*) from public.status_track_event_evidence where message_id = %L', :'m_w1')), 0::bigint, 'nenhuma referência à mensagem apagada sobra');
select is(pg_temp.n(format('select count(*) from public.status_tracks where opportunity_id = %L', :'ow')), 1::bigint, 'o controle da trilha da oportunidade fica no esqueleto (só códigos)');
select throws_ok(
  format($q$update public.status_tracks set automation_paused = false, automation_paused_at = null, automation_paused_by = null where opportunity_id = %L$q$, :'ow'),
  'P0001', 'contact_anonymized', 'esqueleto anonimizado: trilha imutável'
);
select throws_ok(
  format($q$insert into public.status_tracks (workspace_id, track, opportunity_id, case_progress_status) values (%L, 'case_progress', %L, 'em_analise')$q$, :'ws_um', :'ow'),
  'P0001', 'contact_anonymized', 'esqueleto anonimizado: nenhuma trilha nova'
);

-- Retenção da conversa (sem anonimizar o contato): a mensagem apagada leva a referência
-- usada no andamento de OUTRA oportunidade, e o histórico conta como removida.
delete from public.conversations where id = (:'conv_x2')::uuid;
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select items as h_o2_pos from list_status_track_history('case_progress', (:'o2')::uuid) \gset
reset role;
select ok(
  (select (e ->> 'evidence_removed')::int = 1 and jsonb_array_length(e -> 'evidence') = 1
   from jsonb_array_elements(:'h_o2_pos'::jsonb) e where e ->> 'to_status' = 'aguardando_documentos'),
  'mensagem apagada: a referência some e o histórico mostra uma evidência removida'
);
select is(pg_temp.n(format('select count(*) from public.status_track_event_evidence where message_id = %L', :'m_x3')), 0::bigint, 'nenhum caminho indireto para a mensagem apagada');

-- =====================================================================
-- 13) Nada externo: nenhuma escrita em outbox, atividade ou automação
-- =====================================================================

select is(pg_temp.n('select count(*) from public.whatsapp_outbox'), 0::bigint, 'nenhuma mensagem enfileirada para envio');

select * from finish();
rollback;
