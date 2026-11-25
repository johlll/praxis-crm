-- pgTAP — Conversas + IA: APLICADOR determinístico de propostas de mudança de status.
--
-- Prova: superfície fechada (só service_role, portão fechado por padrão); proposta malformada e alvo de
-- outro escritório são erros sem gravação; situação do atendimento, andamento e roteiro separados (uma
-- proposta nunca mexe em outra trilha nem na etapa comercial); decisão humana × mensagem anterior,
-- dentro da margem de 5 s, desconhecida ou atrasada; mensagem atrasada não desfaz aplicação automática
-- mais nova; pausa e retomada; versão desatualizada; repetição e resposta perdida (mesma decisão, nada
-- duplicado); chave compartilhada com a correção manual e o roteiro; dois casos do mesmo contato (caso
-- ambíguo e caso errado); remetente sem autoridade; "enviei" × arquivo recebido; catálogo fechado
-- (concluído, em análise, encerrado, etapa comercial, ganho/perda e conclusão de etapa são humanos); o
-- roteiro só avança a etapa atual, sem concluir as anteriores; a aplicação automática não grava
-- manual_decided_at nem inventa usuário; registro sem texto; exportação do titular; exclusão em cascata.
--
-- Fixtures do seed: ana=owner no Escritório Um; bruno=owner no Escritório Dois. Dados sintéticos: as
-- mensagens são inseridas direto (como o efeito da B3 faria) e o horário de origem é gravado pelo
-- caminho interno da #358, com horários controlados.

begin;
select plan(105);

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
create function pg_temp.t(p_sql text) returns text language plpgsql security definer as $f$
declare v text;
begin
  execute p_sql into v;
  return v;
end;
$f$;

-- Mensagem sintética na conversa, com horário de origem controlado:
--   cliente | arquivo | equipe_recebida | indeterminado | escritorio | eco | chatbot | desconhecida (cliente sem origem)
create function pg_temp.m(p_conv uuid, p_kind text, p_origin timestamptz) returns uuid language plpgsql security definer as $f$
declare
  c public.conversations;
  v uuid;
  v_pm text := 'pm-62-' || gen_random_uuid();
begin
  select * into c from public.conversations where id = p_conv;
  if p_kind = 'escritorio' then
    insert into public.messages (workspace_id, conversation_id, channel_id, direction, status, origin, sender_classification,
      content_kind, body_text, provider, provider_message_id, sent_by, client_dedupe_key, origin_correlation_kind, origin_correlation_ref, created_at)
    values (c.workspace_id, c.id, c.channel_id, 'outbound', 'sent', 'crm', 'internal', 'text', 'Mensagem fictícia do escritório',
      'ycloud', v_pm, '20000000-0000-0000-0000-000000000001', gen_random_uuid(), 'crm_outbox', v_pm, p_origin)
    returning id into v;
    return v; -- o gatilho da #358 grava crm_accepted = created_at
  end if;
  insert into public.messages (workspace_id, conversation_id, channel_id, direction, status, origin, sender_classification,
    content_kind, body_text, provider, provider_message_id, origin_correlation_kind, origin_correlation_ref, created_at)
  values (c.workspace_id, c.id, c.channel_id,
    (case when p_kind in ('eco', 'chatbot') then 'outbound' else 'inbound' end)::public.message_direction,
    (case when p_kind in ('eco', 'chatbot') then 'sent' else 'delivered' end)::public.message_status,
    (case p_kind when 'eco' then 'business_app' when 'chatbot' then 'chatbot' else 'inbound' end)::public.whatsapp_message_origin,
    case p_kind when 'equipe_recebida' then 'internal' when 'indeterminado' then 'unresolved'
                when 'eco' then 'internal' when 'chatbot' then 'automation' else 'external' end::public.whatsapp_sender_classification,
    case when p_kind = 'arquivo' then 'document' else 'text' end,
    case when p_kind = 'arquivo' then null else 'Mensagem fictícia: enviei os documentos' end,
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

-- O aplicador, como o processamento interno (service_role): o jsonb devolvido ou {"erro": mensagem}.
create function pg_temp.ap(
  p_ws uuid, p_conv uuid, p_change text, p_track text, p_opp uuid, p_to text, p_step uuid,
  p_ver bigint, p_ids uuid[], p_key uuid, p_ref text default 'extrator-teste:1'
) returns jsonb language plpgsql as $f$
declare v jsonb;
begin
  execute 'set local role service_role';
  select public.apply_status_track_automation(p_ws, p_conv, p_change, p_track::public.status_track_kind, p_opp, p_to, p_step,
    p_ver, p_ids, p_key, p_ref) into v;
  execute 'reset role';
  return v;
exception when others then
  execute 'reset role';
  return jsonb_build_object('erro', sqlerrm);
end;
$f$;

-- Chamada de usuário (correção manual, pausa, roteiro): resultado ou {"erro": mensagem}.
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

create function pg_temp.vat(p_conv uuid) returns bigint language sql security definer as $f$
  select coalesce((select version from public.status_tracks where conversation_id = p_conv and track = 'attendance'), 0)
$f$;
create function pg_temp.vcp(p_opp uuid) returns bigint language sql security definer as $f$
  select coalesce((select version from public.status_tracks where opportunity_id = p_opp and track = 'case_progress'), 0)
$f$;
create function pg_temp.sat(p_conv uuid) returns text language sql security definer as $f$
  select coalesce((select attendance_status::text from public.status_tracks where conversation_id = p_conv and track = 'attendance'), 'nao_informado')
$f$;
create function pg_temp.scp(p_opp uuid) returns text language sql security definer as $f$
  select coalesce((select case_progress_status::text from public.status_tracks where opportunity_id = p_opp and track = 'case_progress'), 'nao_informado')
$f$;
create function pg_temp.mda(p_track text, p_target uuid) returns timestamptz language sql security definer as $f$
  select manual_decided_at from public.status_tracks
  where (p_track = 'attendance' and conversation_id = p_target) or (p_track <> 'attendance' and opportunity_id = p_target and track = p_track::public.status_track_kind)
$f$;
create function pg_temp.etapa(p_opp uuid, p_pos int) returns uuid language sql security definer as $f$
  select s.id from public.case_service_plan_steps s join public.case_service_plans p on p.id = s.plan_id
  where p.opportunity_id = p_opp and p.status = 'active' and s.position = p_pos
$f$;

-- ---------------------------------------------------------------------
-- Dados de apoio
-- ---------------------------------------------------------------------

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
-- X: um caso ganho. Y: dois casos ganhos (dois leads). W: um caso aberto.
select (create_contact(:'ws_um'::uuid, 'pf', 'Xavier Aplicador', null, null, null)).id as cx \gset
select create_lead(:'ws_um'::uuid, (:'cx')::uuid, 'Imobiliário', 'X', '{}'::text[], 'media', :'ana'::uuid) as lx \gset
select create_opportunity((:'lx')::uuid) as ox \gset
select win_opportunity((:'ox')::uuid, 0, 100000, 'fixed');
select (create_contact(:'ws_um'::uuid, 'pf', 'Yara Aplicador', null, null, null)).id as cy \gset
select create_lead(:'ws_um'::uuid, (:'cy')::uuid, 'Família', 'Y1', '{}'::text[], 'media', :'ana'::uuid) as ly1 \gset
select create_lead(:'ws_um'::uuid, (:'cy')::uuid, 'Cível', 'Y2', '{}'::text[], 'media', :'ana'::uuid) as ly2 \gset
select create_opportunity((:'ly1')::uuid) as oy1 \gset
select create_opportunity((:'ly2')::uuid) as oy2 \gset
select win_opportunity((:'oy1')::uuid, 0, 100000, 'fixed');
select win_opportunity((:'oy2')::uuid, 0, 100000, 'fixed');
select (create_contact(:'ws_um'::uuid, 'pf', 'Wilma Aplicador', null, null, null)).id as cw \gset
select create_lead(:'ws_um'::uuid, (:'cw')::uuid, 'Trabalhista', 'W', '{}'::text[], 'media', :'ana'::uuid) as lw \gset
select create_opportunity((:'lw')::uuid) as ow \gset
select pg_temp.login(:'bruno'::uuid);
select (create_contact(:'ws_dois'::uuid, 'pf', 'Zeca Aplicador', null, null, null)).id as cz \gset
select create_lead(:'ws_dois'::uuid, (:'cz')::uuid, 'Cível', 'Z', '{}'::text[], 'media', :'bruno'::uuid) as lz \gset
select create_opportunity((:'lz')::uuid) as oz \gset
select win_opportunity((:'oz')::uuid, 0, 100000, 'fixed');
reset role;

insert into public.whatsapp_channels (workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment, routing_key)
  values (:'ws_um'::uuid, 'Canal aplicador', '+5541900006200', :'ana'::uuid, 'ycloud', false, 'preview', 'rota-62-um') returning id as canal \gset
insert into public.whatsapp_channels (workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment, routing_key)
  values (:'ws_dois'::uuid, 'Canal aplicador 2', '+5541900006299', :'bruno'::uuid, 'ycloud', false, 'preview', 'rota-62-dois') returning id as canal2 \gset
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
select pg_temp.conv(:'ws_um'::uuid, :'canal'::uuid, '+5541999996201', :'cx'::uuid, :'lx'::uuid, null) as kx \gset
select pg_temp.conv(:'ws_um'::uuid, :'canal'::uuid, '+5541999996202', :'cy'::uuid, null, null) as ky \gset
select pg_temp.conv(:'ws_um'::uuid, :'canal'::uuid, '+5541999996203', :'cy'::uuid, :'ly1'::uuid, :'oy1'::uuid) as ky1 \gset
select pg_temp.conv(:'ws_um'::uuid, :'canal'::uuid, '+5541999996207', :'cy'::uuid, :'ly2'::uuid, null) as kyl \gset
select pg_temp.conv(:'ws_um'::uuid, :'canal'::uuid, '+5541999996204', :'cw'::uuid, :'lw'::uuid, null) as kw \gset
select pg_temp.conv(:'ws_um'::uuid, :'canal'::uuid, '+5541999996205', null, null, null, true) as kr \gset
select pg_temp.conv(:'ws_dois'::uuid, :'canal2'::uuid, '+5541999996206', :'cz'::uuid, :'lz'::uuid, null) as kz \gset

-- Base da linha do tempo no passado: as origens ficam aquém do limite de futuro (5 min) do banco.
select clock_timestamp() - interval '30 minutes' as t1 \gset

-- =====================================================================
-- 1) Superfície e portão
-- =====================================================================

select is(
  pg_temp.n($q$select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('status_track_automation_gate', 'status_track_automation_decisions',
      'status_track_automation_decision_evidence') and c.relrowsecurity and c.relforcerowsecurity$q$),
  3::bigint, 'as três tabelas novas têm RLS ligada e forçada');
select is(
  pg_temp.n($q$select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role')
      and table_name in ('status_track_automation_gate', 'status_track_automation_decisions', 'status_track_automation_decision_evidence')$q$),
  0::bigint, 'nenhum privilégio de tabela para os papéis de API (nem service_role)');
select ok(
  has_function_privilege('service_role', 'public.apply_status_track_automation(uuid,uuid,text,public.status_track_kind,uuid,text,uuid,bigint,uuid[],uuid,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.apply_status_track_automation(uuid,uuid,text,public.status_track_kind,uuid,text,uuid,bigint,uuid[],uuid,text)', 'execute')
  and not has_function_privilege('anon', 'public.apply_status_track_automation(uuid,uuid,text,public.status_track_kind,uuid,text,uuid,bigint,uuid[],uuid,text)', 'execute'),
  'o aplicador é só do processamento interno (service_role); usuário autenticado e anônimo não chamam');
select is(
  pg_temp.n($q$select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname like 'status_track_automation%'
      and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('service_role', p.oid, 'execute'))$q$),
  0::bigint, 'nenhuma função privada nova é chamável por papel de API');
select ok(
  (select p.prosecdef and p.proconfig = array['search_path=""'] from pg_proc p
   where p.oid = 'public.apply_status_track_automation(uuid,uuid,text,public.status_track_kind,uuid,text,uuid,bigint,uuid[],uuid,text)'::regprocedure),
  'o aplicador é SECURITY DEFINER com search_path vazio');
select is(pg_temp.t('select enabled::text from public.status_track_automation_gate'), 'false', 'o portão nasce fechado');

select pg_temp.m(:'kx'::uuid, 'cliente', :'t1'::timestamptz) as mx1 \gset
select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', null, 'aguardando_escritorio', null, 0, array[:'mx1'::uuid], gen_random_uuid()) ->> 'erro',
  'automation_disabled', 'portão fechado: tudo recusado como automation_disabled');
select is(pg_temp.n('select count(*) from public.status_track_automation_decisions'), 0::bigint, 'portão fechado: nada gravado');
select is(pg_temp.u(:'ana', $q$select to_jsonb(1) from public.status_track_automation_gate$q$) ->> 'erro', 'permission denied for table status_track_automation_gate',
  'usuário não lê nem abre o portão');

-- Abertura só por comando direto no banco, com a referência da ativação.
select throws_ok($q$update public.status_track_automation_gate set enabled = true, enabled_at = now()$q$, '23514', null,
  'abrir o portão sem a referência da ativação é recusado');
update public.status_track_automation_gate set enabled = true, enabled_at = now(), activation_ref = 'teste-pgtap-62';

-- =====================================================================
-- 2) Forma da proposta e isolamento entre escritórios
-- =====================================================================

select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', null, 'aguardando_escritorio', null, 0, '{}'::uuid[], gen_random_uuid()) ->> 'erro',
  'invalid_proposal', 'sem evidência: proposta inválida');
select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', :'ox', 'aguardando_escritorio', null, 0, array[:'mx1'::uuid], gen_random_uuid()) ->> 'erro',
  'invalid_proposal', 'situação do atendimento com caso informado: proposta inválida (uma trilha por proposta)');
select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', null, 'concluido', null, 0, array[:'mx1'::uuid], gen_random_uuid()) ->> 'erro',
  'invalid_proposal', 'estado de outra trilha: proposta inválida');
select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', null, 'aguardando_escritorio', null, 0, array[:'mx1'::uuid], null) ->> 'erro',
  'invalid_proposal', 'sem chave de idempotência: proposta inválida');
select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', null, 'aguardando_escritorio', null, 0, array[:'mx1'::uuid], gen_random_uuid(), 'texto livre do modelo') ->> 'erro',
  'invalid_proposal', 'referência do extrator com texto livre: proposta inválida');
select is(pg_temp.ap(:'ws_um', :'kz', 'set_status', 'attendance', null, 'aguardando_escritorio', null, 0, array[:'mx1'::uuid], gen_random_uuid()) ->> 'erro',
  'target_not_found', 'conversa de OUTRO escritório: inexistente');
select is(pg_temp.ap(:'ws_dois', :'kx', 'set_status', 'attendance', null, 'aguardando_escritorio', null, 0, array[:'mx1'::uuid], gen_random_uuid()) ->> 'erro',
  'target_not_found', 'escritório declarado diferente do da conversa: inexistente');
select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'case_progress', :'oz', 'aguardando_documentos', null, 0, array[:'mx1'::uuid], gen_random_uuid()) ->> 'erro',
  'target_not_found', 'caso de OUTRO escritório: inexistente');
select is(pg_temp.n('select count(*) from public.status_track_automation_decisions'), 0::bigint, 'erros de forma e de escritório não gravam decisão');

select pg_temp.m(:'kw'::uuid, 'cliente', :'t1'::timestamptz) as mw1 \gset
select pg_temp.m(:'kz'::uuid, 'cliente', :'t1'::timestamptz) as mz1 \gset
select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', null, 'aguardando_escritorio', null, 0, array[:'mw1'::uuid], gen_random_uuid()) ->> 'reason',
  'evidence_invalid', 'evidência de outra conversa do mesmo escritório: recusada');
select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', null, 'aguardando_escritorio', null, 0, array[:'mz1'::uuid], gen_random_uuid()) ->> 'reason',
  'evidence_invalid', 'evidência de outro escritório: recusada');
select is(pg_temp.n($q$select count(*) from public.status_track_automation_decision_evidence$q$), 0::bigint,
  'evidência inválida não é referenciada');

-- =====================================================================
-- 3) Situação do atendimento: aplicação, autoria e repetição
-- =====================================================================

select gen_random_uuid() as k1 \gset
select pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', null, 'aguardando_escritorio', null, 0, array[:'mx1'::uuid], :'k1') as r1 \gset
select is(:'r1'::jsonb ->> 'outcome', 'applied', 'mensagem do cliente com origem válida: aplicada');
select is(pg_temp.sat(:'kx'), 'aguardando_escritorio', 'situação do atendimento mudou');
select is(pg_temp.vat(:'kx'), 1::bigint, 'a versão da trilha subiu como em qualquer mudança');
select is(pg_temp.mda('attendance', :'kx'), null, 'a aplicação automática NÃO grava manual_decided_at');
select is(pg_temp.t(format($q$select concat_ws('|', actor_kind, coalesce(actor_user_id::text, '-'), (automation_decision_id = %L)::text, coalesce(idempotency_key::text, '-'), evidence_count)
  from public.status_track_events where id = %L$q$, :'r1'::jsonb ->> 'decision_id', :'r1'::jsonb ->> 'event_id')),
  'automation|-|true|-|1', 'evento: autoria automática, sem usuário, com a decisão e sem a chave (que fica na decisão)');
select is(pg_temp.t(format($q$select concat_ws('|', kind, verdict) from public.status_track_automation_decision_evidence where decision_id = %L$q$, :'r1'::jsonb ->> 'decision_id')),
  'client_message|eligible', 'decisão guarda a classificação e o veredito da evidência, calculados pelo banco');
select is(pg_temp.t(format($q$select source from public.status_track_idempotency_keys where idempotency_key = %L$q$, :'k1')),
  'status_track_automation_decisions', 'a chave entrou no registro único compartilhado');

-- Repetição (resposta perdida): mesma decisão, nada novo.
select pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', null, 'aguardando_escritorio', null, 0, array[:'mx1'::uuid], :'k1') as r1b \gset
select is(:'r1b'::jsonb ->> 'replayed', 'true', 'repetição da mesma proposta: devolve a mesma decisão');
select is(:'r1b'::jsonb ->> 'event_id', :'r1'::jsonb ->> 'event_id', 'repetição: mesmo evento');
select is(pg_temp.n(format($q$select count(*) from public.status_track_events e join public.status_tracks t on t.id = e.track_id where t.conversation_id = %L$q$, :'kx')),
  1::bigint, 'repetição: nenhum evento duplicado');
select is(pg_temp.vat(:'kx'), 1::bigint, 'repetição: versão não sobe');
select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', null, 'aguardando_cliente', null, 0, array[:'mx1'::uuid], :'k1') ->> 'erro',
  'idempotency_conflict', 'mesma chave com outro pedido: conflito');
select is(pg_temp.u(:'ana', format($q$select set_conversation_attendance_status(%L, 'encerrado', 1, '{}'::uuid[], %L)$q$, :'kx', :'k1')) ->> 'erro',
  'idempotency_conflict', 'a chave do aplicador não vale na correção manual (registro único)');
select is(pg_temp.vat(:'kx'), 1::bigint, 'o conflito não subiu a versão');

-- Versão desatualizada e catálogo fechado.
select pg_temp.m(:'kx'::uuid, 'escritorio', :'t1'::timestamptz + interval '1 minute') as mx2 \gset
select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', null, 'aguardando_cliente', null, 0, array[:'mx2'::uuid], gen_random_uuid()) ->> 'reason',
  'version_stale', 'versão desatualizada: recusada');
select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', null, 'encerrado', null, 1, array[:'mx2'::uuid], gen_random_uuid()) ->> 'reason',
  'transition_not_automatable', 'encerrar a conversa é sempre humano');
select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', null, 'aguardando_escritorio', null, 1, array[:'mx2'::uuid], gen_random_uuid()) ->> 'reason',
  'status_unchanged', 'estado igual ao atual: recusado sem evento');
select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', null, 'aguardando_cliente', null, 1,
  array[pg_temp.m(:'kx'::uuid, 'cliente', :'t1'::timestamptz + interval '90 seconds'), :'mx2'::uuid], gen_random_uuid()) ->> 'reason',
  'evidence_kind_insufficient', 'evidência mista (cliente + escritório) para "aguardando cliente": recusada');

-- Refusal replay: a mesma recusa, sem nova linha.
select gen_random_uuid() as k2 \gset
select pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', null, 'encerrado', null, 1, array[:'mx2'::uuid], :'k2') as r2 \gset
select pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', null, 'encerrado', null, 1, array[:'mx2'::uuid], :'k2') as r2b \gset
select ok((:'r2b'::jsonb ->> 'replayed')::boolean and :'r2b'::jsonb ->> 'decision_id' = :'r2'::jsonb ->> 'decision_id',
  'repetição de uma recusa: devolve a mesma recusa');
select is(pg_temp.n(format($q$select count(*) from public.status_track_automation_decisions where idempotency_key = %L$q$, :'k2')), 1::bigint,
  'repetição de uma recusa: uma linha só');

select pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', null, 'aguardando_cliente', null, 1, array[:'mx2'::uuid], gen_random_uuid()) as r3 \gset
select is(:'r3'::jsonb ->> 'outcome', 'applied', 'mensagem do escritório: "aguardando cliente" aplicada');

-- Remetente sem autoridade e evidência fora do catálogo.
select pg_temp.m(:'kx'::uuid, 'equipe_recebida', :'t1'::timestamptz + interval '2 minutes') as mx3 \gset
select pg_temp.m(:'kx'::uuid, 'indeterminado', :'t1'::timestamptz + interval '2 minutes') as mx4 \gset
select pg_temp.m(:'kx'::uuid, 'chatbot', :'t1'::timestamptz + interval '2 minutes') as mx5 \gset
select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', null, 'aguardando_escritorio', null, 2, array[:'mx3'::uuid], gen_random_uuid()) ->> 'reason',
  'sender_not_authorized', 'mensagem recebida de alguém da equipe não é do cliente');
select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', null, 'aguardando_escritorio', null, 2, array[:'mx4'::uuid], gen_random_uuid()) ->> 'reason',
  'sender_not_authorized', 'remetente indeterminado não é do cliente');
select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', null, 'aguardando_escritorio', null, 2, array[:'mx5'::uuid], gen_random_uuid()) ->> 'reason',
  'evidence_kind_insufficient', 'mensagem do chatbot não é evidência do cliente');

-- =====================================================================
-- 4) Decisão humana, margem, origem desconhecida, mensagem atrasada
-- =====================================================================

select pg_temp.u(:'ana', format($q$select set_conversation_attendance_status(%L, 'encerrado', 2, '{}'::uuid[], null)$q$, :'kx')) ->> 'version' as vh \gset
select is(:'vh'::text, '3', 'correção manual depois da aplicação automática: aceita (a automação não trava o humano)');
select pg_temp.mda('attendance', :'kx') as decidido \gset
-- Mensagem que OCORREU antes da decisão e chegou depois (atrasada).
select pg_temp.m(:'kx'::uuid, 'cliente', :'decidido'::timestamptz - interval '1 hour') as m_antes \gset
select pg_temp.m(:'kx'::uuid, 'cliente', :'decidido'::timestamptz + interval '4 seconds') as m_margem \gset
select pg_temp.m(:'kx'::uuid, 'desconhecida', null) as m_desc \gset
select pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', null, 'aguardando_escritorio', null, 3, array[:'m_antes'::uuid], gen_random_uuid()) as r4 \gset
select is(:'r4'::jsonb ->> 'reason', 'evidence_not_eligible', 'mensagem anterior à decisão humana não a sobrescreve');
select is(pg_temp.t(format($q$select verdict from public.status_track_automation_decision_evidence where decision_id = %L$q$, :'r4'::jsonb ->> 'decision_id')),
  'not_after_decision', 'o motivo verificável fica na evidência (not_after_decision)');
select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', null, 'aguardando_escritorio', null, 3, array[:'m_margem'::uuid], gen_random_uuid()) ->> 'reason',
  'evidence_not_eligible', 'dentro da margem de 5 s da decisão: não autoriza');
select pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', null, 'aguardando_escritorio', null, 3, array[:'m_desc'::uuid], gen_random_uuid()) as r5 \gset
select is(pg_temp.t(format($q$select verdict from public.status_track_automation_decision_evidence where decision_id = %L$q$, :'r5'::jsonb ->> 'decision_id')),
  'origin_unknown', 'origem desconhecida: inelegível (created_at não serve)');
select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', null, 'aguardando_escritorio', null, 3, array[:'m_antes'::uuid, :'m_margem'::uuid], gen_random_uuid()) ->> 'reason',
  'evidence_not_eligible', 'basta uma evidência inelegível para recusar');
select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'attendance', null, 'aguardando_escritorio', null, 3,
  array[pg_temp.m(:'kx'::uuid, 'cliente', :'decidido'::timestamptz + interval '3 minutes')], gen_random_uuid()) ->> 'reason',
  'transition_not_automatable', 'conversa ENCERRADA por pessoa: reabrir é humano mesmo com mensagem nova do cliente');
select is(pg_temp.sat(:'kx'), 'encerrado', 'a decisão humana ficou de pé');

-- Mensagem atrasada × aplicação automática mais nova (outra conversa, sem decisão humana).
select pg_temp.m(:'kw'::uuid, 'escritorio', :'t1'::timestamptz + interval '3 minutes') as mw_nova \gset
select pg_temp.m(:'kw'::uuid, 'cliente', :'t1'::timestamptz + interval '2 minutes') as mw_velha \gset
select is(pg_temp.ap(:'ws_um', :'kw', 'set_status', 'attendance', null, 'aguardando_cliente', null, 0, array[:'mw_nova'::uuid], gen_random_uuid()) ->> 'outcome',
  'applied', 'aplicação automática com evidência às t+3 min');
select is(pg_temp.ap(:'ws_um', :'kw', 'set_status', 'attendance', null, 'aguardando_escritorio', null, 1, array[:'mw_velha'::uuid], gen_random_uuid()) ->> 'reason',
  'evidence_superseded', 'mensagem atrasada (t+2 min) não desfaz o que foi aplicado com evidência mais nova');
select is(pg_temp.sat(:'kw'), 'aguardando_cliente', 'o estado aplicado com a evidência mais nova continua');

-- =====================================================================
-- 5) Pausa e retomada
-- =====================================================================

select pg_temp.u(:'ana', format($q$select set_status_track_automation('attendance', %L, true, 1)$q$, :'kw')) ->> 'version' as vp \gset
select pg_temp.m(:'kw'::uuid, 'cliente', :'t1'::timestamptz + interval '4 minutes') as mw_pos \gset
select is(pg_temp.ap(:'ws_um', :'kw', 'set_status', 'attendance', null, 'aguardando_escritorio', null, (:'vp')::bigint, array[:'mw_pos'::uuid], gen_random_uuid()) ->> 'reason',
  'automation_paused', 'pausa ativa: recusada');
select is(pg_temp.sat(:'kw'), 'aguardando_cliente', 'pausa: nada mudou');
select pg_temp.u(:'ana', format($q$select set_status_track_automation('attendance', %L, false, %s)$q$, :'kw', :'vp')) ->> 'version' as vr \gset
select is(pg_temp.ap(:'ws_um', :'kw', 'set_status', 'attendance', null, 'aguardando_escritorio', null, (:'vp')::bigint, array[:'mw_pos'::uuid], gen_random_uuid()) ->> 'reason',
  'version_stale', 'depois de retomar, a proposta feita sobre a versão da pausa está desatualizada');
select is(pg_temp.ap(:'ws_um', :'kw', 'set_status', 'attendance', null, 'aguardando_escritorio', null, (:'vr')::bigint, array[:'mw_pos'::uuid], gen_random_uuid()) ->> 'outcome',
  'applied', 'retomada: proposta nova sobre a versão atual é aplicada');

-- =====================================================================
-- 6) Andamento do serviço: caso inequívoco, catálogo, "enviei" × arquivo
-- =====================================================================

select pg_temp.m(:'ky'::uuid, 'escritorio', :'t1'::timestamptz) as my1 \gset
select is(pg_temp.ap(:'ws_um', :'ky', 'set_status', 'case_progress', :'oy1', 'aguardando_documentos', null, 0, array[:'my1'::uuid], gen_random_uuid()) ->> 'reason',
  'ambiguous_case', 'contato com dois casos e conversa sem vínculo: caso ambíguo');
select is(pg_temp.ap(:'ws_um', :'kyl', 'set_status', 'case_progress', :'oy2', 'aguardando_documentos', null, 0,
  array[pg_temp.m(:'kyl'::uuid, 'escritorio', :'t1'::timestamptz)], gen_random_uuid()) ->> 'reason',
  'ambiguous_case', 'conversa só com o lead de um dos dois casos do contato (palpite, sem vínculo): caso ambíguo');
select pg_temp.m(:'ky1'::uuid, 'escritorio', :'t1'::timestamptz) as my2 \gset
select is(pg_temp.ap(:'ws_um', :'ky1', 'set_status', 'case_progress', :'oy2', 'aguardando_documentos', null, 0, array[:'my2'::uuid], gen_random_uuid()) ->> 'reason',
  'target_mismatch', 'conversa vinculada ao caso 1 não muda o caso 2');
select is(pg_temp.ap(:'ws_um', :'ky1', 'set_status', 'case_progress', :'oy1', 'aguardando_documentos', null, 0, array[:'my2'::uuid], gen_random_uuid()) ->> 'outcome',
  'applied', 'conversa vinculada ao caso 1: andamento do caso 1 aplicado');
select ok(pg_temp.scp(:'oy1') = 'aguardando_documentos' and pg_temp.scp(:'oy2') = 'nao_informado' and pg_temp.vcp(:'oy2') = 0,
  'dois casos do mesmo contato: só o caso certo mudou');
select pg_temp.m(:'kr'::uuid, 'escritorio', :'t1'::timestamptz) as mr1 \gset
select is(pg_temp.ap(:'ws_um', :'kr', 'set_status', 'case_progress', :'ox', 'aguardando_documentos', null, 0, array[:'mr1'::uuid], gen_random_uuid()) ->> 'reason',
  'conversation_link_unresolved', 'conversa com vínculo pendente não fala por caso nenhum');
select pg_temp.m(:'kw'::uuid, 'escritorio', :'t1'::timestamptz + interval '5 minutes') as mw2 \gset
select is(pg_temp.ap(:'ws_um', :'kw', 'set_status', 'case_progress', :'ow', 'aguardando_documentos', null, 0, array[:'mw2'::uuid], gen_random_uuid()) ->> 'reason',
  'opportunity_not_won', 'caso não ganho: sem andamento automático');

select pg_temp.m(:'kx'::uuid, 'escritorio', :'t1'::timestamptz + interval '5 minutes') as mxo \gset
select pg_temp.vat(:'kx') as vat_antes \gset
select pg_temp.t(format($q$select stage_id::text from public.opportunities where id = %L$q$, :'ox')) as etapa_antes \gset
select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'case_progress', :'ox', 'aguardando_documentos', null, 0, array[:'mxo'::uuid], gen_random_uuid()) ->> 'outcome',
  'applied', 'escritório pediu documentos: "aguardando documentos" aplicado');
select ok(pg_temp.vat(:'kx') = (:'vat_antes')::bigint and pg_temp.sat(:'kx') = 'encerrado',
  'o andamento não mexeu na situação do atendimento');
select is(pg_temp.t(format($q$select stage_id::text from public.opportunities where id = %L$q$, :'ox')), :'etapa_antes',
  'o andamento não mexeu na etapa comercial');
select pg_temp.m(:'kx'::uuid, 'cliente', :'t1'::timestamptz + interval '6 minutes') as mx_enviei \gset
select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'case_progress', :'ox', 'documentos_recebidos', null, 1, array[:'mx_enviei'::uuid], gen_random_uuid()) ->> 'reason',
  'evidence_kind_insufficient', '"enviei" em texto não comprova recebimento');
select pg_temp.m(:'kx'::uuid, 'arquivo', :'t1'::timestamptz + interval '7 minutes') as mx_arq \gset
select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'case_progress', :'ox', 'documentos_recebidos', null, 1, array[:'mx_arq'::uuid], gen_random_uuid()) ->> 'outcome',
  'applied', 'arquivo recebido do cliente: "documentos recebidos" aplicado');
select pg_temp.m(:'kx'::uuid, 'arquivo', :'t1'::timestamptz + interval '8 minutes') as mx_arq2 \gset
select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'case_progress', :'ox', 'em_analise', null, 2, array[:'mx_arq2'::uuid], gen_random_uuid()) ->> 'reason',
  'transition_not_automatable', 'arquivo recebido não vira conferido/em análise');
select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'case_progress', :'ox', 'concluido', null, 2, array[:'mx_arq2'::uuid], gen_random_uuid()) ->> 'reason',
  'transition_not_automatable', 'concluir o serviço é sempre humano');
select is(pg_temp.ap(:'ws_um', :'kx', 'set_status', 'case_progress', :'ox', 'em_execucao', null, 2, array[:'mx_arq2'::uuid], gen_random_uuid()) ->> 'reason',
  'transition_not_automatable', 'protocolo/execução não se presume');
select is(pg_temp.ap(:'ws_um', :'kw', 'set_status', 'case_progress', :'ow', 'documentos_recebidos', null, 0,
  array[pg_temp.m(:'kw'::uuid, 'arquivo', :'t1'::timestamptz + interval '9 minutes')], gen_random_uuid()) ->> 'reason',
  'opportunity_not_won', 'arquivo de caso não ganho: recusado');
select is(pg_temp.mda('case_progress', :'ox'), null, 'aplicações no andamento não gravaram manual_decided_at');

-- Etapa comercial, ganho e perda: humanos.
select is(pg_temp.ap(:'ws_um', :'kx', 'commercial_stage', 'commercial_stage', :'ox', null, null, 0, array[:'mxo'::uuid], gen_random_uuid()) ->> 'reason',
  'commercial_manual_only', 'mudança de etapa comercial: humana');
select is(pg_temp.ap(:'ws_um', :'kw', 'commercial_outcome', 'commercial_stage', :'ow', null, null, 0, array[:'mw2'::uuid], gen_random_uuid()) ->> 'reason',
  'commercial_manual_only', 'ganho/perda: humanos');
select is(pg_temp.t(format($q$select status::text from public.opportunities where id = %L$q$, :'ow')), 'open', 'o caso aberto continua aberto');

-- =====================================================================
-- 7) Roteiro: só avança a etapa atual, sem concluir nada
-- =====================================================================

select pg_temp.u(:'ana', format($q$select create_service_type(%L, 'Roteiro aplicador', array['Documentos', 'Análise', 'Protocolo', 'Sentença'])$q$, :'ws_um')) ->> 'id' as tipo \gset
select pg_temp.u(:'ana', format($q$select apply_case_service_plan(%L, %L, %s, 1, null)$q$, :'ox', :'tipo', pg_temp.vcp(:'ox'))) ->> 'version' as vplan \gset
select pg_temp.mda('case_progress', :'ox') as decidido_cp \gset
select ok(:'decidido_cp' <> '', 'aplicar o roteiro é decisão humana (grava o marco)');
select pg_temp.m(:'kx'::uuid, 'cliente', :'decidido_cp'::timestamptz - interval '30 seconds') as mx_r_antes \gset
select is(pg_temp.ap(:'ws_um', :'kx', 'set_current_step', 'case_progress', :'ox', null, pg_temp.etapa(:'ox', 3), (:'vplan')::bigint, array[:'mx_r_antes'::uuid], gen_random_uuid()) ->> 'reason',
  'evidence_not_eligible', 'roteiro: mensagem anterior à decisão humana sobre o roteiro não serve');
select pg_temp.m(:'kx'::uuid, 'escritorio', :'decidido_cp'::timestamptz + interval '2 minutes') as mx_r \gset
select pg_temp.ap(:'ws_um', :'kx', 'set_current_step', 'case_progress', :'ox', null, pg_temp.etapa(:'ox', 3), (:'vplan')::bigint, array[:'mx_r'::uuid], gen_random_uuid()) as r6 \gset
select is(:'r6'::jsonb ->> 'outcome', 'applied', 'roteiro: avança a etapa atual para a 3');
select is(pg_temp.t(format($q$select current_step_id::text from public.case_service_plans where opportunity_id = %L and status = 'active'$q$, :'ox')),
  pg_temp.etapa(:'ox', 3)::text, 'a etapa atual é a 3');
select is(pg_temp.n(format($q$select count(*) from public.case_service_plan_steps s join public.case_service_plans p on p.id = s.plan_id
  where p.opportunity_id = %L and p.status = 'active' and s.completed_at is not null$q$, :'ox')),
  0::bigint, 'avançar não concluiu as etapas anteriores (1 e 2 seguem pendentes)');
select is(pg_temp.t(format($q$select concat_ws('|', op, actor_kind, coalesce(actor_user_id::text, '-'), (automation_decision_id is not null)::text) from public.case_service_events where id = %L$q$, :'r6'::jsonb ->> 'event_id')),
  'current_step_set|automation|-|true', 'evento do roteiro com autoria automática, sem usuário');
select is(pg_temp.mda('case_progress', :'ox'), :'decidido_cp'::timestamptz, 'o roteiro automático não mexeu no marco da decisão humana');
select is(pg_temp.scp(:'ox'), 'documentos_recebidos', 'avançar o roteiro não mudou o estado do andamento');
select is(pg_temp.ap(:'ws_um', :'kx', 'set_current_step', 'case_progress', :'ox', null, pg_temp.etapa(:'ox', 2), pg_temp.vcp(:'ox'),
  array[pg_temp.m(:'kx'::uuid, 'escritorio', :'decidido_cp'::timestamptz + interval '3 minutes')], gen_random_uuid()) ->> 'reason',
  'step_not_after_current', 'roteiro: voltar a etapa atual é humano');
select is(pg_temp.ap(:'ws_um', :'kx', 'complete_step', 'case_progress', :'ox', null, pg_temp.etapa(:'ox', 3), pg_temp.vcp(:'ox'),
  array[pg_temp.m(:'kx'::uuid, 'escritorio', :'decidido_cp'::timestamptz + interval '4 minutes')], gen_random_uuid()) ->> 'reason',
  'step_completion_manual_only', 'concluir etapa (protocolo, sentença…) é sempre humano');
select is(pg_temp.n(format($q$select count(*) from public.case_service_plan_steps s join public.case_service_plans p on p.id = s.plan_id
  where p.opportunity_id = %L and s.completed_at is not null$q$, :'ox')), 0::bigint, 'nenhuma etapa concluída pelo aplicador');
select is(pg_temp.ap(:'ws_um', :'ky1', 'set_current_step', 'case_progress', :'oy1', null, pg_temp.etapa(:'ox', 4), pg_temp.vcp(:'oy1'),
  array[pg_temp.m(:'ky1'::uuid, 'escritorio', :'t1'::timestamptz + interval '10 minutes')], gen_random_uuid()) ->> 'reason',
  'service_plan_missing', 'etapa de outro caso / caso sem roteiro: recusado');

-- Correção manual depois: o humano segue livre e o marco avança.
select pg_temp.u(:'ana', format($q$select set_opportunity_case_progress(%L, 'em_analise', %s, '{}'::uuid[], null)$q$, :'ox', pg_temp.vcp(:'ox'))) ->> 'status' as manual_cp \gset
select is(:'manual_cp'::text, 'em_analise', 'correção manual do andamento depois da automação: aceita');
select ok(pg_temp.mda('case_progress', :'ox') > :'decidido_cp'::timestamptz, 'a correção manual grava o novo marco humano');

-- =====================================================================
-- 8) Autoria sem usuário inventado; registro sem texto; exportação; cascata
-- =====================================================================

select throws_ok(format($q$insert into public.status_track_events (workspace_id, track_id, event, from_status, to_status, from_version, to_version, actor_kind, actor_user_id, evidence_count, automation_decision_id)
  select workspace_id, id, 'status_changed', 'encerrado', 'novo', version, version + 1, 'automation', null, 0, gen_random_uuid() from public.status_tracks where conversation_id = %L$q$, :'kx'),
  'P0001', 'automation_event_requires_decision', 'evento automático fora do aplicador: recusado');
select throws_ok(format($q$insert into public.status_track_events (workspace_id, track_id, event, from_status, to_status, from_version, to_version, actor_kind, actor_user_id, evidence_count)
  select workspace_id, id, 'status_changed', 'encerrado', 'novo', version, version + 1, 'user', null, 0 from public.status_tracks where conversation_id = %L$q$, :'kx'),
  '23514', null, 'evento de usuário sem usuário: recusado (a proteção do actor_user_id continua)');
select set_config('praxis.automation_decision', '62000000-0000-0000-0000-0000000000aa', true);
select throws_ok(format($q$insert into public.status_track_events (workspace_id, track_id, event, from_status, to_status, from_version, to_version, actor_kind, actor_user_id, evidence_count, automation_decision_id)
  select workspace_id, id, 'status_changed', 'encerrado', 'novo', version, version + 1, 'automation', %L, 0, '62000000-0000-0000-0000-0000000000aa' from public.status_tracks where conversation_id = %L$q$, :'ana', :'kx'),
  '23514', null, 'evento automático com usuário: recusado (a automação não finge ser alguém)');
select set_config('praxis.automation_decision', '', true);
select throws_ok($q$update public.status_track_automation_decisions set reason = 'version_stale'$q$, 'P0001', 'automation_decision_immutable',
  'decisão gravada é imutável');
select is(pg_temp.n($q$select count(*) from public.status_track_automation_decisions d where to_jsonb(d)::text like '%Mensagem fictícia%'$q$), 0::bigint,
  'nenhuma decisão copia texto de mensagem');
select is(pg_temp.n($q$select count(*) from public.status_track_automation_decisions where outcome = 'refused' and reason is null$q$), 0::bigint,
  'toda recusa tem motivo em código');

select private.privacy_export_payload(:'ws_um'::uuid, :'cx'::uuid) as exp \gset
select is(jsonb_array_length(:'exp'::jsonb -> 'status_track_automation_decisions'),
  pg_temp.n(format($q$select count(*)::int from public.status_track_automation_decisions where conversation_id = %L$q$, :'kx'))::int,
  'exportação do titular: todas as decisões das conversas dele');
select ok(:'exp'::jsonb ? 'case_documents' and :'exp'::jsonb ? 'case_notes'
  and (:'exp'::jsonb -> 'messages' -> 0) ? 'origin_time'
  and not ((:'exp'::jsonb -> 'status_track_automation_decisions' -> 0) ?| array['idempotency_key', 'request_fingerprint', 'extractor_ref']),
  'exportação: seções anteriores preservadas; decisões sem chave, impressão nem referência do extrator');

-- Cascata: a conversa apagada leva as decisões, as evidências e libera as chaves.
select gen_random_uuid() as kcas \gset
select pg_temp.ap(:'ws_um', :'kr', 'set_status', 'attendance', null, 'aguardando_escritorio', null, 0,
  array[pg_temp.m(:'kr'::uuid, 'cliente', :'t1'::timestamptz)], :'kcas') ->> 'outcome' as rcas \gset
select is(:'rcas'::text, 'applied', 'situação do atendimento não depende do vínculo com caso');
delete from public.conversations where id = (:'kr')::uuid;
select is(pg_temp.n(format($q$select (select count(*) from public.status_track_automation_decisions where conversation_id = %L)
  + (select count(*) from public.status_track_idempotency_keys where idempotency_key = %L)$q$, :'kr', :'kcas')), 0::bigint,
  'conversa apagada: decisões e chaves somem junto');

select * from finish();
rollback;
