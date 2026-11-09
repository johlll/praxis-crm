-- pgTAP — B5 mínima: tela de auditoria (list_audit_log) e transferência de
-- posse (transfer_workspace_ownership).
--
-- Auditoria: só owner/admin consultam (manager, lawyer, sales, viewer, quem não
-- é membro e owner suspenso são recusados); outro workspace é indistinguível
-- de um que não existe; a resposta tem formato fechado e NUNCA devolve
-- `metadata` cru, e-mail, nome de contato, rótulo, telefone, token, segredo ou
-- identificador de provedor — mesmo quando gravados em `metadata`; valores
-- fora do vocabulário (papel, ambiente, provedor) são descartados; filtros por
-- ação, pessoa e período (dias do fuso do escritório, inclusivos); paginação
-- por cursor sem pular nem repetir registros do mesmo instante.
--
-- Posse: só owner ATIVO transfere; destinatário precisa ser membro ATIVO do
-- MESMO workspace (membership de outro workspace = inexistente); recusa o
-- próprio chamador; troca de papéis atômica (destinatário -> owner, quem
-- transferiu -> admin) e o workspace nunca fica sem owner, inclusive quando algo
-- falha no meio; UMA linha de auditoria, sem dado pessoal.
--
-- `audit_logs` continua sem nenhum grant de tabela para authenticated/anon.

begin;
select plan(108);

\set ana     '20000000-0000-0000-0000-000000000001'
\set bruno   '20000000-0000-0000-0000-000000000002'
\set carla   '20000000-0000-0000-0000-000000000003'
\set daniel  '20000000-0000-0000-0000-000000000004'
\set elisa   '20000000-0000-0000-0000-000000000005'
\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'
\set ws_nada '10000000-0000-0000-0000-0000000000ff'
\set sem_ninguem '99999999-9999-9999-9999-999999999999'

-- Ana: owner no Um. Carla: lawyer no Um, sales no Dois. Elisa: viewer no Um.
-- Bruno: owner no Dois. Daniel: sem membership. (seed)

-- ---------------------------------------------------------------------
-- Ajudantes (só desta transação)
-- ---------------------------------------------------------------------

create function pg_temp.login(p_user uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$f$;

-- A página (items) da trilha, como o usuário atual.
create function pg_temp.audit(
  p_ws uuid, p_action text default null, p_actor uuid default null,
  p_from date default null, p_to date default null, p_limit integer default 25
) returns jsonb language sql as $f$
  select items from public.list_audit_log(p_ws, p_action, p_actor, p_from, p_to, null, null, p_limit)
$f$;

-- Percorre TODAS as páginas pelo cursor e devolve os ids na ordem recebida.
create function pg_temp.page_ids(p_ws uuid, p_action text, p_limit integer)
returns text language plpgsql as $f$
declare
  v_ids text[] := array[]::text[];
  v_before timestamptz;
  v_before_id uuid;
  v_items jsonb;
  v_more boolean;
  v_guard integer := 0;
begin
  loop
    select l.items, l.has_more into v_items, v_more
    from public.list_audit_log(p_ws, p_action, null, null, null, v_before, v_before_id, p_limit) l;
    exit when jsonb_array_length(v_items) = 0;
    v_ids := v_ids || array(select e ->> 'id' from jsonb_array_elements(v_items) e);
    v_before := (v_items -> (jsonb_array_length(v_items) - 1) ->> 'created_at')::timestamptz;
    v_before_id := (v_items -> (jsonb_array_length(v_items) - 1) ->> 'id')::uuid;
    exit when not v_more;
    v_guard := v_guard + 1;
    exit when v_guard > 50;
  end loop;
  return array_to_string(v_ids, ',');
end;
$f$;

-- Leituras de verificação por fora do RLS (SECURITY DEFINER do dono, só aqui).
create function pg_temp.snap(p_ws uuid) returns text language sql security definer as $f$
  select string_agg(user_id::text || ':' || role::text || ':' || status::text, ',' order by user_id)
  from public.memberships where workspace_id = p_ws
$f$;
create function pg_temp.owners(p_ws uuid) returns integer language sql security definer as $f$
  select count(*)::int from public.memberships where workspace_id = p_ws and role = 'owner' and status = 'active'
$f$;
create function pg_temp.audit_count(p_ws uuid, p_action text) returns integer language sql security definer as $f$
  select count(*)::int from public.audit_logs where workspace_id = p_ws and action = p_action
$f$;
create function pg_temp.audit_row(p_ws uuid, p_action text) returns jsonb language sql security definer as $f$
  select to_jsonb(a) from public.audit_logs a where a.workspace_id = p_ws and a.action = p_action
$f$;

-- Ids de membership para as chamadas.
select id as m_ana    from public.memberships where workspace_id = :'ws_um'::uuid   and user_id = :'ana'::uuid   \gset
select id as m_carla  from public.memberships where workspace_id = :'ws_um'::uuid   and user_id = :'carla'::uuid \gset
select id as m_elisa  from public.memberships where workspace_id = :'ws_um'::uuid   and user_id = :'elisa'::uuid \gset
select id as m_bruno  from public.memberships where workspace_id = :'ws_dois'::uuid and user_id = :'bruno'::uuid \gset
select id as m_carla2 from public.memberships where workspace_id = :'ws_dois'::uuid and user_id = :'carla'::uuid \gset

-- ---------------------------------------------------------------------
-- Dados de prova (como dono do banco; authenticated não escreve em audit_logs)
-- ---------------------------------------------------------------------

insert into public.audit_logs (id, workspace_id, actor_user_id, action, resource_type, resource_id, metadata, created_at) values
  ('a1000000-0000-0000-0000-000000000001', :'ws_um'::uuid, :'ana'::uuid,   'lead.created', 'lead', null, '{}', '2026-11-05 15:00:00+00'),
  ('a1000000-0000-0000-0000-000000000002', :'ws_um'::uuid, :'carla'::uuid, 'lead.created', 'lead', null, '{}', '2026-11-06 15:00:00+00'),
  ('a1000000-0000-0000-0000-000000000003', :'ws_um'::uuid, :'ana'::uuid,   'lead.updated', 'lead', null, '{}', '2026-11-08 12:00:00+00'),
  -- 23:30 de 08/11 em São Paulo (02:30 UTC de 09/11): pertence ao dia 08.
  ('a1000000-0000-0000-0000-000000000004', :'ws_um'::uuid, :'ana'::uuid,   'membership.role_changed', 'membership', null,
     '{"from_role":"viewer","to_role":"admin"}', '2026-11-09 02:30:00+00'),
  -- 00:00 de 09/11 em São Paulo (03:00 UTC): primeiro instante do dia 09.
  ('a1000000-0000-0000-0000-000000000005', :'ws_um'::uuid, :'carla'::uuid, 'lead.updated', 'lead', null, '{}', '2026-11-09 03:00:00+00'),
  ('a1000000-0000-0000-0000-000000000006', :'ws_um'::uuid, null,           'message.received', 'message', null,
     '{"source":"whatsapp_webhook","conversation_id":"c0000000-0000-0000-0000-000000000001"}', '2026-11-09 14:00:00+00'),
  ('a1000000-0000-0000-0000-000000000007', :'ws_um'::uuid, :'ana'::uuid,   'invitation.created', 'workspace_invitation', null,
     '{"email":"convidado@exemplo.com","role":"lawyer"}', '2026-11-09 15:00:00+00'),
  ('a1000000-0000-0000-0000-000000000008', :'ws_um'::uuid, :'ana'::uuid,   'contact.created', 'contact', null,
     '{"name":"Maria Silva","source":"whatsapp"}', '2026-11-09 15:01:00+00'),
  ('a1000000-0000-0000-0000-000000000009', :'ws_um'::uuid, :'ana'::uuid,   'whatsapp.channel.created', 'whatsapp_channel', null,
     '{"environment":"preview","provider":"ycloud","label":"Canal do João","token":"tok_123","api_key":"sk_live_x","phone":"+5511999990000","body_text":"texto sigiloso"}', '2026-11-09 15:02:00+00'),
  ('a1000000-0000-0000-0000-00000000000a', :'ws_um'::uuid, :'ana'::uuid,   'proposal.email.accepted_by_provider', 'proposal', null,
     '{"provider_message_id":"msg_ABC","proposal_id":"d0000000-0000-0000-0000-000000000001"}', '2026-11-09 15:03:00+00'),
  -- Valores fora do vocabulário ou de tipo errado: todos descartados.
  ('a1000000-0000-0000-0000-00000000000b', :'ws_um'::uuid, :'ana'::uuid,   'lead.assigned', 'lead', null,
     '{"role":"superuser","environment":"staging","provider":"outro","from_role":5,"to_role":{"x":1}}', '2026-11-09 15:04:00+00'),
  ('a1000000-0000-0000-0000-00000000000c', :'ws_um'::uuid, :'ana'::uuid,   'membership.removed', 'membership', null,
     json_build_object('removed_user_id', :'elisa'::text, 'role', 'viewer')::jsonb, '2026-11-09 15:05:00+00'),
  -- Mesma chave de alvo em OUTRA ação: não resolve nome.
  ('a1000000-0000-0000-0000-00000000000e', :'ws_um'::uuid, :'ana'::uuid,   'lead.assigned', 'lead', null,
     json_build_object('new_owner_user_id', :'carla'::text)::jsonb, '2026-11-09 15:06:00+00'),
  ('a1000000-0000-0000-0000-00000000000f', :'ws_um'::uuid, :'ana'::uuid,   'membership.removed', 'membership', null,
     '{"removed_user_id":"nao-e-um-uuid"}', '2026-11-09 15:07:00+00'),
  -- metadata que nem é objeto.
  ('a1000000-0000-0000-0000-000000000010', :'ws_um'::uuid, :'ana'::uuid,   'x.scalar', 'x', null, '"texto solto"'::jsonb, '2026-11-09 15:08:00+00'),
  ('a1000000-0000-0000-0000-000000000011', :'ws_um'::uuid, :'ana'::uuid,   'x.array', 'x', null, '[1,2]'::jsonb, '2026-11-09 15:09:00+00'),
  -- Outro workspace.
  ('b2000000-0000-0000-0000-000000000001', :'ws_dois'::uuid, :'bruno'::uuid, 'lead.created', 'lead', null, '{}', '2026-11-06 15:00:00+00'),
  ('b2000000-0000-0000-0000-000000000002', :'ws_dois'::uuid, :'bruno'::uuid, 'zz.ws_dois_only', 'x', null, '{}', '2026-11-09 16:00:00+00');

-- Sete registros do MESMO instante (empate): a paginação não pode pular nem repetir.
insert into public.audit_logs (id, workspace_id, actor_user_id, action, resource_type, metadata, created_at)
select ('c1000000-0000-0000-0000-00000000000' || n)::uuid, :'ws_um'::uuid, :'ana'::uuid, 'tie.test', 'x', '{}', '2026-11-07 10:00:00+00'
from generate_series(1, 7) n;

-- Esperado, calculado por fora do RLS, na ordem da trilha.
select string_agg(id::text, ',' order by created_at desc, id desc) as esperado_empate
from public.audit_logs where workspace_id = :'ws_um'::uuid and action = 'tie.test' \gset
select string_agg(id::text, ',' order by created_at desc, id desc) as esperado_todos
from public.audit_logs where workspace_id = :'ws_um'::uuid \gset

-- =====================================================================
-- 1) Superfície: privilégios e endurecimento
-- =====================================================================

select ok(
  not has_function_privilege('anon', 'public.list_audit_log(uuid, text, uuid, date, date, timestamptz, uuid, integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.transfer_workspace_ownership(uuid, uuid)', 'EXECUTE'),
  'anon não executa list_audit_log nem transfer_workspace_ownership'
);

select ok(
  has_function_privilege('authenticated', 'public.list_audit_log(uuid, text, uuid, date, date, timestamptz, uuid, integer)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.transfer_workspace_ownership(uuid, uuid)', 'EXECUTE'),
  'authenticated executa as duas (a autorização é por papel, dentro da função)'
);

select ok(
  not has_function_privilege('authenticated', 'private.audit_log_safe_details(jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'private.audit_log_safe_details(jsonb)', 'EXECUTE'),
  'o auxiliar da projeção sanitizada não é chamável pelo cliente'
);

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('list_audit_log', 'transfer_workspace_ownership')
     and p.prosecdef
     and exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) c where c like 'search_path=%')),
  2,
  'as duas funções públicas são SECURITY DEFINER com search_path travado'
);

select is(
  (select p.provolatile::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'list_audit_log'),
  's',
  'list_audit_log é STABLE: somente leitura'
);

select table_privs_are('public', 'audit_logs', 'authenticated', array[]::text[],
  'audit_logs continua sem nenhum privilégio de tabela para authenticated');
select table_privs_are('public', 'audit_logs', 'anon', array[]::text[],
  'audit_logs continua sem nenhum privilégio de tabela para anon');

-- =====================================================================
-- 2) Quem pode consultar a auditoria
-- =====================================================================

set local role authenticated;

select set_config('request.jwt.claims', '', true);
select throws_ok(
  format($i$ select pg_temp.audit(%L::uuid) $i$, :'ws_um'),
  'P0001', 'authentication_required', 'sem sessão: recusado'
);

select pg_temp.login(:'ana'::uuid);
select is(jsonb_array_length(pg_temp.audit(:'ws_um'::uuid)), 23, 'owner (Ana) consulta a trilha do próprio workspace');

set local role postgres;
update public.memberships set role = 'admin' where id = :'m_carla'::uuid;
set local role authenticated;
select pg_temp.login(:'carla'::uuid);
select is(jsonb_array_length(pg_temp.audit(:'ws_um'::uuid)), 23, 'admin (Carla promovida) também consulta');

set local role postgres;
update public.memberships set role = 'manager' where id = :'m_carla'::uuid;
set local role authenticated;
select pg_temp.login(:'carla'::uuid);
select throws_ok(format($i$ select pg_temp.audit(%L::uuid) $i$, :'ws_um'), 'P0001', 'insufficient_permission', 'manager é recusado');

set local role postgres;
update public.memberships set role = 'sales' where id = :'m_carla'::uuid;
set local role authenticated;
select pg_temp.login(:'carla'::uuid);
select throws_ok(format($i$ select pg_temp.audit(%L::uuid) $i$, :'ws_um'), 'P0001', 'insufficient_permission', 'sales é recusado');

set local role postgres;
update public.memberships set role = 'lawyer' where id = :'m_carla'::uuid;
set local role authenticated;
select pg_temp.login(:'carla'::uuid);
select throws_ok(format($i$ select pg_temp.audit(%L::uuid) $i$, :'ws_um'), 'P0001', 'insufficient_permission', 'lawyer é recusado');

select pg_temp.login(:'elisa'::uuid);
select throws_ok(format($i$ select pg_temp.audit(%L::uuid) $i$, :'ws_um'), 'P0001', 'insufficient_permission', 'viewer é recusado');

select pg_temp.login(:'daniel'::uuid);
select throws_ok(format($i$ select pg_temp.audit(%L::uuid) $i$, :'ws_um'), 'P0001', 'insufficient_permission', 'quem não é membro é recusado');

set local role postgres;
update public.memberships set status = 'suspended' where id = :'m_ana'::uuid;
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select throws_ok(format($i$ select pg_temp.audit(%L::uuid) $i$, :'ws_um'), 'P0001', 'insufficient_permission', 'owner suspenso é recusado');
set local role postgres;
update public.memberships set status = 'active' where id = :'m_ana'::uuid;
set local role authenticated;

-- Isolamento: workspace alheio e workspace inexistente dão EXATAMENTE o mesmo erro.
select pg_temp.login(:'bruno'::uuid);
select throws_ok(format($i$ select pg_temp.audit(%L::uuid) $i$, :'ws_um'), 'P0001', 'insufficient_permission',
  'owner de OUTRO workspace não lê a trilha do Um');
select throws_ok(format($i$ select pg_temp.audit(%L::uuid) $i$, :'ws_nada'), 'P0001', 'insufficient_permission',
  'workspace inexistente: o mesmo erro que o workspace alheio');
select is(jsonb_array_length(pg_temp.audit(:'ws_dois'::uuid)), 2, 'Bruno vê só as duas linhas do próprio workspace');

-- =====================================================================
-- 3) Formato da resposta: fechado, sem metadata
-- =====================================================================

select pg_temp.login(:'ana'::uuid);

select is(
  (select count(*)::int from jsonb_array_elements(pg_temp.audit(:'ws_um'::uuid)) e
   where e ->> 'action' = 'zz.ws_dois_only'),
  0, 'nenhuma linha do outro workspace aparece'
);

select is(
  (select count(*)::int from jsonb_array_elements(pg_temp.audit(:'ws_um'::uuid)) e
   where (select array_agg(k order by k) from jsonb_object_keys(e) k)
         <> array['action', 'actor_name', 'actor_user_id', 'created_at', 'details', 'id', 'target_name']),
  0, 'todo item tem exatamente as chaves do contrato — sem metadata, sem workspace_id, sem ids de recurso'
);

select is(
  (select e ->> 'actor_name' from jsonb_array_elements(pg_temp.audit(:'ws_um'::uuid)) e where e ->> 'id' = 'a1000000-0000-0000-0000-000000000001'),
  'Ana Owner (seed)', 'o nome de quem agiu vem resolvido'
);
select is(
  (select e -> 'actor_name' from jsonb_array_elements(pg_temp.audit(:'ws_um'::uuid)) e where e ->> 'id' = 'a1000000-0000-0000-0000-000000000006'),
  'null'::jsonb, 'registro do sistema (sem ator) tem actor_name nulo'
);

select is(
  (select e ->> 'id' from jsonb_array_elements(pg_temp.audit(:'ws_um'::uuid, null, null, null, null, 1)) e),
  'a1000000-0000-0000-0000-000000000011'::text,
  'o registro mais recente vem primeiro'
);

-- =====================================================================
-- 4) Sanitização: nada sensível sai, mesmo gravado em metadata
-- =====================================================================

select is(
  (select count(*)::int
   from unnest(array[
     'convidado@exemplo.com', 'Maria Silva', 'tok_123', 'sk_live_x', '+5511999990000', 'msg_ABC',
     'Canal do João', 'texto sigiloso', 'whatsapp_webhook', 'provider_message_id', 'metadata',
     'conversation_id', 'removed_user_id', 'nao-e-um-uuid'
   ]) f(x)
   where position(f.x in pg_temp.audit(:'ws_um'::uuid)::text) > 0),
  0, 'e-mail, nome de contato, rótulo, token, chave, telefone, texto, id de provedor e metadata não aparecem em lugar nenhum'
);

select is(
  (select e -> 'details' from jsonb_array_elements(pg_temp.audit(:'ws_um'::uuid)) e where e ->> 'id' = 'a1000000-0000-0000-0000-000000000009'),
  '{"environment":"preview","provider":"ycloud"}'::jsonb,
  'canal de WhatsApp: só ambiente e provedor (sem rótulo, token, chave, telefone, texto)'
);
select is(
  (select e -> 'details' from jsonb_array_elements(pg_temp.audit(:'ws_um'::uuid)) e where e ->> 'id' = 'a1000000-0000-0000-0000-000000000004'),
  '{"from_role":"viewer","to_role":"admin"}'::jsonb, 'troca de papel: papel antigo e novo'
);
select is(
  (select e -> 'details' from jsonb_array_elements(pg_temp.audit(:'ws_um'::uuid)) e where e ->> 'id' = 'a1000000-0000-0000-0000-000000000007'),
  '{"role":"lawyer"}'::jsonb, 'convite: só o papel (o e-mail do convidado não sai)'
);
select is(
  (select e -> 'details' from jsonb_array_elements(pg_temp.audit(:'ws_um'::uuid)) e where e ->> 'id' = 'a1000000-0000-0000-0000-000000000008'),
  '{}'::jsonb, 'contato criado: nada (o nome do contato não sai)'
);
select is(
  (select e -> 'details' from jsonb_array_elements(pg_temp.audit(:'ws_um'::uuid)) e where e ->> 'id' = 'a1000000-0000-0000-0000-00000000000a'),
  '{}'::jsonb, 'e-mail de proposta: nada (id de provedor não sai)'
);
select is(
  (select e -> 'details' from jsonb_array_elements(pg_temp.audit(:'ws_um'::uuid)) e where e ->> 'id' = 'a1000000-0000-0000-0000-00000000000b'),
  '{}'::jsonb, 'papel, ambiente e provedor fora do vocabulário, ou de tipo errado, são descartados'
);
select is(
  (select count(*)::int from jsonb_array_elements(pg_temp.audit(:'ws_um'::uuid)) e
   where e ->> 'id' in ('a1000000-0000-0000-0000-000000000010', 'a1000000-0000-0000-0000-000000000011')
     and e -> 'details' = '{}'::jsonb),
  2, 'metadata que não é objeto (texto, lista) vira detalhes vazios, sem erro'
);
select is(
  (select count(*)::int
   from jsonb_array_elements(pg_temp.audit(:'ws_um'::uuid)) e, jsonb_object_keys(e -> 'details') k
   where k not in ('role', 'from_role', 'to_role', 'new_owner_previous_role', 'previous_owner_new_role', 'environment', 'provider')),
  0, 'em TODA a trilha, as chaves de details estão dentro da lista de permissão'
);

-- Pessoa-alvo
select is(
  (select e ->> 'target_name' from jsonb_array_elements(pg_temp.audit(:'ws_um'::uuid)) e where e ->> 'id' = 'a1000000-0000-0000-0000-00000000000c'),
  'Elisa Viewer (seed)', 'membro removido: o nome da pessoa-alvo vem resolvido'
);
select is(
  (select e -> 'details' from jsonb_array_elements(pg_temp.audit(:'ws_um'::uuid)) e where e ->> 'id' = 'a1000000-0000-0000-0000-00000000000c'),
  '{"role":"viewer"}'::jsonb, 'membro removido: o papel que tinha'
);
select is(
  (select e -> 'target_name' from jsonb_array_elements(pg_temp.audit(:'ws_um'::uuid)) e where e ->> 'id' = 'a1000000-0000-0000-0000-00000000000f'),
  'null'::jsonb, 'valor de alvo que não é uuid: sem nome, sem erro'
);
select is(
  (select e -> 'target_name' from jsonb_array_elements(pg_temp.audit(:'ws_um'::uuid)) e where e ->> 'id' = 'a1000000-0000-0000-0000-00000000000e'),
  'null'::jsonb, 'a chave de alvo em outra ação não resolve nome'
);

-- =====================================================================
-- 5) Filtros
-- =====================================================================

select is(jsonb_array_length(pg_temp.audit(:'ws_um'::uuid, 'lead.created')), 2, 'filtro por ação (exata)');
select is(jsonb_array_length(pg_temp.audit(:'ws_um'::uuid, 'lead.cre')), 0, 'a ação é exata, não prefixo');
select is(jsonb_array_length(pg_temp.audit(:'ws_um'::uuid, 'acao.que.nao.existe')), 0, 'ação sem registros: lista vazia, sem erro');
select is(jsonb_array_length(pg_temp.audit(:'ws_um'::uuid, null, :'carla'::uuid)), 2, 'filtro por pessoa');
select is(
  pg_temp.audit(:'ws_um'::uuid, null, :'bruno'::uuid)::text,
  pg_temp.audit(:'ws_um'::uuid, null, :'sem_ninguem'::uuid)::text,
  'pessoa de outro workspace e pessoa inexistente: o mesmo resultado (vazio)'
);
select is(jsonb_array_length(pg_temp.audit(:'ws_um'::uuid, null, :'bruno'::uuid)), 0, 'pessoa de outro workspace: nenhuma linha');

select is(jsonb_array_length(pg_temp.audit(:'ws_um'::uuid, null, null, '2026-11-08', '2026-11-08')), 2,
  'um dia no fuso do escritório: 08/11 inclui as 23:30 de Brasília (02:30 UTC de 09/11)');
select is(jsonb_array_length(pg_temp.audit(:'ws_um'::uuid, null, null, '2026-11-09', '2026-11-09')), 12,
  'um dia no fuso do escritório: 09/11 começa à 00:00 de Brasília (03:00 UTC), inclusive');
select is(jsonb_array_length(pg_temp.audit(:'ws_um'::uuid, null, null, '2026-11-09')), 12, 'só a data inicial');
select is(jsonb_array_length(pg_temp.audit(:'ws_um'::uuid, null, null, null, '2026-11-06')), 2, 'só a data final (inclusiva)');
select is(jsonb_array_length(pg_temp.audit(:'ws_um'::uuid, null, null, '2026-11-07', '2026-11-07')), 7, 'dia dos sete registros empatados');
select is(
  (select e ->> 'id' from jsonb_array_elements(pg_temp.audit(:'ws_um'::uuid, 'lead.updated', :'carla'::uuid, '2026-11-09', '2026-11-30')) e),
  'a1000000-0000-0000-0000-000000000005'::text, 'ação + pessoa + período juntos'
);

select throws_ok(format($i$ select pg_temp.audit(%L::uuid, 'lead.created; drop table x') $i$, :'ws_um'),
  'P0001', 'invalid_filter', 'ação com formato inválido é recusada');
select throws_ok(format($i$ select pg_temp.audit(%L::uuid, 'Lead.Created') $i$, :'ws_um'),
  'P0001', 'invalid_filter', 'ação em maiúsculas é recusada');
select throws_ok(format($i$ select pg_temp.audit(%L::uuid, '') $i$, :'ws_um'),
  'P0001', 'invalid_filter', 'ação vazia é recusada');
select throws_ok(format($i$ select pg_temp.audit(%L::uuid, null, null, '2026-11-10', '2026-11-01') $i$, :'ws_um'),
  'P0001', 'invalid_period', 'período invertido é recusado');
select throws_ok(format($i$ select pg_temp.audit(%L::uuid, null, null, 'infinity', null) $i$, :'ws_um'),
  'P0001', 'invalid_period', 'data infinita é recusada');

-- =====================================================================
-- 6) Paginação por cursor
-- =====================================================================

select is(pg_temp.page_ids(:'ws_um'::uuid, 'tie.test', 3), :'esperado_empate',
  'limite 3 percorre os 7 registros do MESMO instante sem pular nem repetir, na ordem');
select is(pg_temp.page_ids(:'ws_um'::uuid, null, 5), :'esperado_todos',
  'limite 5 percorre toda a trilha (23 registros) exatamente uma vez, na ordem');

select jsonb_array_length(items) as n1, has_more as m1, (items -> 2 ->> 'created_at') as c1_at, (items -> 2 ->> 'id') as c1_id
from public.list_audit_log(:'ws_um'::uuid, 'tie.test', null, null, null, null, null, 3) \gset
select is(:n1::int, 3, 'primeira página: 3 itens');
select is(:'m1'::text, 't', 'primeira página: há mais');

select jsonb_array_length(items) as n2, has_more as m2, (items -> 2 ->> 'created_at') as c2_at, (items -> 2 ->> 'id') as c2_id
from public.list_audit_log(:'ws_um'::uuid, 'tie.test', null, null, null, :'c1_at'::timestamptz, :'c1_id'::uuid, 3) \gset
select is(:n2::int, 3, 'segunda página: 3 itens');
select is(:'m2'::text, 't', 'segunda página: ainda há mais');

select jsonb_array_length(items) as n3, has_more as m3
from public.list_audit_log(:'ws_um'::uuid, 'tie.test', null, null, null, :'c2_at'::timestamptz, :'c2_id'::uuid, 3) \gset
select is(:n3::int, 1, 'terceira página: o último registro');
select is(:'m3'::text, 'f', 'terceira página: acabou');

select throws_ok(
  format($i$ select * from public.list_audit_log(%L::uuid, null, null, null, null, now(), null, 25) $i$, :'ws_um'),
  'P0001', 'invalid_cursor', 'cursor sem id é recusado');
select throws_ok(
  format($i$ select * from public.list_audit_log(%L::uuid, null, null, null, null, null, %L::uuid, 25) $i$, :'ws_um', :'ana'),
  'P0001', 'invalid_cursor', 'id de cursor sem instante é recusado');

select is(jsonb_array_length(pg_temp.audit(:'ws_um'::uuid, null, null, null, null, 0)), 1, 'limite 0 vira 1');
select is(jsonb_array_length(pg_temp.audit(:'ws_um'::uuid, null, null, null, null, 100000)), 23, 'limite enorme é limitado a 100 (aqui há 23)');
select is(
  (select jsonb_array_length(items) from public.list_audit_log(:'ws_um'::uuid, null, null, null, null, null, null, null)),
  23, 'limite nulo usa o padrão (25)'
);

-- =====================================================================
-- 7) Transferência de posse — recusas
-- =====================================================================

-- Quem não é owner ativo do workspace.
select pg_temp.login(:'carla'::uuid);
select throws_ok(format($i$ select public.transfer_workspace_ownership(%L::uuid, %L::uuid) $i$, :'ws_um', :'m_elisa'),
  'P0001', 'insufficient_permission', 'lawyer não transfere a posse');

set local role postgres;
update public.memberships set role = 'admin' where id = :'m_carla'::uuid;
set local role authenticated;
select pg_temp.login(:'carla'::uuid);
select throws_ok(format($i$ select public.transfer_workspace_ownership(%L::uuid, %L::uuid) $i$, :'ws_um', :'m_elisa'),
  'P0001', 'insufficient_permission', 'admin não transfere a posse');

set local role postgres;
update public.memberships set role = 'manager' where id = :'m_carla'::uuid;
set local role authenticated;
select pg_temp.login(:'carla'::uuid);
select throws_ok(format($i$ select public.transfer_workspace_ownership(%L::uuid, %L::uuid) $i$, :'ws_um', :'m_elisa'),
  'P0001', 'insufficient_permission', 'manager não transfere a posse');

set local role postgres;
update public.memberships set role = 'lawyer' where id = :'m_carla'::uuid;
set local role authenticated;

select pg_temp.login(:'elisa'::uuid);
select throws_ok(format($i$ select public.transfer_workspace_ownership(%L::uuid, %L::uuid) $i$, :'ws_um', :'m_carla'),
  'P0001', 'insufficient_permission', 'viewer não transfere a posse');

select pg_temp.login(:'daniel'::uuid);
select throws_ok(format($i$ select public.transfer_workspace_ownership(%L::uuid, %L::uuid) $i$, :'ws_um', :'m_carla'),
  'P0001', 'insufficient_permission', 'quem não é membro não transfere a posse');

select pg_temp.login(:'bruno'::uuid);
select throws_ok(format($i$ select public.transfer_workspace_ownership(%L::uuid, %L::uuid) $i$, :'ws_um', :'m_carla'),
  'P0001', 'insufficient_permission', 'owner de OUTRO workspace não transfere a posse do Um');
select throws_ok(format($i$ select public.transfer_workspace_ownership(%L::uuid, %L::uuid) $i$, :'ws_nada', :'m_carla'),
  'P0001', 'insufficient_permission', 'workspace inexistente: o mesmo erro do workspace alheio');

set local role postgres;
update public.memberships set status = 'suspended' where id = :'m_ana'::uuid;
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select throws_ok(format($i$ select public.transfer_workspace_ownership(%L::uuid, %L::uuid) $i$, :'ws_um', :'m_carla'),
  'P0001', 'insufficient_permission', 'owner suspenso não transfere a posse');
set local role postgres;
update public.memberships set status = 'active' where id = :'m_ana'::uuid;
set local role authenticated;

select set_config('request.jwt.claims', '', true);
select throws_ok(format($i$ select public.transfer_workspace_ownership(%L::uuid, %L::uuid) $i$, :'ws_um', :'m_carla'),
  'P0001', 'authentication_required', 'sem sessão: recusado');

-- Owner (Ana), destinatário inválido.
select pg_temp.login(:'ana'::uuid);
select throws_ok(format($i$ select public.transfer_workspace_ownership(%L::uuid, %L::uuid) $i$, :'ws_um', :'m_ana'),
  'P0001', 'cannot_transfer_to_self', 'não transfere a posse para si mesmo');
select throws_ok(format($i$ select public.transfer_workspace_ownership(%L::uuid, %L::uuid) $i$, :'ws_um', :'m_bruno'),
  'P0001', 'membership_not_found', 'destinatário de OUTRO workspace: membership_not_found');
select throws_ok(format($i$ select public.transfer_workspace_ownership(%L::uuid, %L::uuid) $i$, :'ws_um', :'sem_ninguem'),
  'P0001', 'membership_not_found', 'destinatário inexistente: o MESMO membership_not_found');
select throws_ok(format($i$ select public.transfer_workspace_ownership(%L::uuid, null) $i$, :'ws_um'),
  'P0001', 'membership_not_found', 'destinatário nulo: membership_not_found');

set local role postgres;
update public.memberships set status = 'suspended' where id = :'m_elisa'::uuid;
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select throws_ok(format($i$ select public.transfer_workspace_ownership(%L::uuid, %L::uuid) $i$, :'ws_um', :'m_elisa'),
  'P0001', 'membership_not_active', 'destinatário inativo (suspenso) é recusado');
set local role postgres;
update public.memberships set status = 'active' where id = :'m_elisa'::uuid;
set local role authenticated;

-- Nenhuma recusa mexeu em papel nem gravou auditoria.
select is(
  pg_temp.snap(:'ws_um'::uuid),
  (:'ana' || ':owner:active,' || :'carla' || ':lawyer:active,' || :'elisa' || ':viewer:active'),
  'depois das recusas, os papéis do Um são os de antes'
);
select is(pg_temp.audit_count(:'ws_um'::uuid, 'workspace.ownership_transferred'), 0, 'depois das recusas, nenhuma auditoria de transferência');

-- =====================================================================
-- 8) Transferência de posse — sucesso
-- =====================================================================

select pg_temp.login(:'ana'::uuid);
select lives_ok(
  format($i$ select public.transfer_workspace_ownership(%L::uuid, %L::uuid) $i$, :'ws_um', :'m_carla'),
  'Ana (owner) transfere a posse a Carla (lawyer ativa do mesmo workspace)'
);

select is(
  pg_temp.snap(:'ws_um'::uuid),
  (:'ana' || ':admin:active,' || :'carla' || ':owner:active,' || :'elisa' || ':viewer:active'),
  'Carla virou owner, Ana virou admin, Elisa não mudou'
);
select is(pg_temp.owners(:'ws_um'::uuid), 1, 'o workspace tem exatamente um owner ativo');
select is(
  pg_temp.snap(:'ws_dois'::uuid),
  (:'bruno' || ':owner:active,' || :'carla' || ':sales:active'),
  'o outro workspace não foi tocado (inclusive o papel de Carla lá)'
);

select is(pg_temp.audit_count(:'ws_um'::uuid, 'workspace.ownership_transferred'), 1, 'UMA linha de auditoria da transferência');
select is(pg_temp.audit_count(:'ws_um'::uuid, 'membership.role_changed'), 1, 'sem linhas duplicadas de troca de papel (continua só a de antes)');
select is(
  pg_temp.audit_row(:'ws_um'::uuid, 'workspace.ownership_transferred') - 'id' - 'created_at',
  jsonb_build_object(
    'workspace_id', :'ws_um', 'actor_user_id', :'ana', 'action', 'workspace.ownership_transferred',
    'resource_type', 'workspace', 'resource_id', :'ws_um',
    'metadata', jsonb_build_object('new_owner_user_id', :'carla', 'new_owner_previous_role', 'lawyer', 'previous_owner_new_role', 'admin')
  ),
  'a auditoria registra quem transferiu, o workspace e só ids e papéis'
);
select is(
  (select count(*)::int from unnest(array['@', 'Carla', 'Ana', 'seed', 'praxis.test']) f(x)
   where position(f.x in (pg_temp.audit_row(:'ws_um'::uuid, 'workspace.ownership_transferred') -> 'metadata')::text) > 0),
  0, 'a auditoria da transferência não carrega e-mail nem nome'
);

-- A nova owner (Carla) vê a entrada, com o nome da pessoa-alvo resolvido.
select pg_temp.login(:'carla'::uuid);
select is(
  (select e - 'id' - 'created_at' from jsonb_array_elements(pg_temp.audit(:'ws_um'::uuid, 'workspace.ownership_transferred')) e),
  jsonb_build_object(
    'action', 'workspace.ownership_transferred', 'actor_user_id', :'ana', 'actor_name', 'Ana Owner (seed)',
    'target_name', 'Carla Compartilhada (seed)',
    'details', jsonb_build_object('new_owner_previous_role', 'lawyer', 'previous_owner_new_role', 'admin')
  ),
  'a tela mostra quem transferiu, para quem, e os papéis — sem ids de usuário nos detalhes'
);

-- Ana agora é admin: ainda consulta a auditoria, mas não transfere de novo.
select pg_temp.login(:'ana'::uuid);
select lives_ok(format($i$ select pg_temp.audit(%L::uuid) $i$, :'ws_um'), 'quem transferiu (agora admin) continua consultando a auditoria');
select throws_ok(format($i$ select public.transfer_workspace_ownership(%L::uuid, %L::uuid) $i$, :'ws_um', :'m_ana'),
  'P0001', 'insufficient_permission', 'quem transferiu (agora admin) não transfere de novo');

-- Dois owners: transferir para quem já é owner deixa uma só owner.
set local role postgres;
update public.memberships set role = 'owner' where id = :'m_elisa'::uuid;
set local role authenticated;
select pg_temp.login(:'carla'::uuid);
select lives_ok(
  format($i$ select public.transfer_workspace_ownership(%L::uuid, %L::uuid) $i$, :'ws_um', :'m_elisa'),
  'com dois owners, um transfere para o outro'
);
select is(
  pg_temp.snap(:'ws_um'::uuid),
  (:'ana' || ':admin:active,' || :'carla' || ':admin:active,' || :'elisa' || ':owner:active'),
  'Elisa segue owner; Carla virou admin; ninguém ficou sem papel'
);
select is(pg_temp.owners(:'ws_um'::uuid), 1, 'continua exatamente um owner');

-- =====================================================================
-- 9) Atomicidade: falha no meio não altera nenhum papel
-- =====================================================================

set local role postgres;
create function public.pgtap_falha() returns trigger language plpgsql as $f$
begin
  raise exception 'falha_injetada';
end;
$f$;

-- 9a) A instrução que troca os papéis falha ao REBAIXAR quem transferiu.
create trigger pgtap_falha_rebaixa before update on public.memberships
  for each row when (old.role = 'owner' and new.role = 'admin') execute function public.pgtap_falha();
set local role authenticated;
select pg_temp.login(:'elisa'::uuid);
select throws_ok(format($i$ select public.transfer_workspace_ownership(%L::uuid, %L::uuid) $i$, :'ws_um', :'m_carla'),
  'P0001', 'falha_injetada', 'falha ao rebaixar quem transferiu: a transferência inteira falha');
select is(
  pg_temp.snap(:'ws_um'::uuid),
  (:'ana' || ':admin:active,' || :'carla' || ':admin:active,' || :'elisa' || ':owner:active'),
  '...e nenhum papel mudou (o destinatário não ficou owner)'
);
set local role postgres;
drop trigger pgtap_falha_rebaixa on public.memberships;

-- 9b) A instrução falha ao PROMOVER o destinatário.
create trigger pgtap_falha_promove before update on public.memberships
  for each row when (new.role = 'owner' and old.role <> 'owner') execute function public.pgtap_falha();
set local role authenticated;
select pg_temp.login(:'elisa'::uuid);
select throws_ok(format($i$ select public.transfer_workspace_ownership(%L::uuid, %L::uuid) $i$, :'ws_um', :'m_carla'),
  'P0001', 'falha_injetada', 'falha ao promover o destinatário: a transferência inteira falha');
select is(
  pg_temp.snap(:'ws_um'::uuid),
  (:'ana' || ':admin:active,' || :'carla' || ':admin:active,' || :'elisa' || ':owner:active'),
  '...e nenhum papel mudou (quem transferiu continua owner)'
);
set local role postgres;
drop trigger pgtap_falha_promove on public.memberships;

-- 9c) Os dois papéis JÁ foram trocados quando a gravação da auditoria falha:
--     tudo é desfeito.
create trigger pgtap_falha_auditoria before insert on public.audit_logs
  for each row when (new.action = 'workspace.ownership_transferred') execute function public.pgtap_falha();
set local role authenticated;
select pg_temp.login(:'elisa'::uuid);
select throws_ok(format($i$ select public.transfer_workspace_ownership(%L::uuid, %L::uuid) $i$, :'ws_um', :'m_carla'),
  'P0001', 'falha_injetada', 'falha ao gravar a auditoria, DEPOIS de trocar os papéis: a transferência falha');
select is(
  pg_temp.snap(:'ws_um'::uuid),
  (:'ana' || ':admin:active,' || :'carla' || ':admin:active,' || :'elisa' || ':owner:active'),
  '...e os papéis voltaram ao que eram (nenhum papel alterado)'
);
select is(pg_temp.owners(:'ws_um'::uuid), 1, '...e o workspace nunca ficou sem owner');
select is(pg_temp.audit_count(:'ws_um'::uuid, 'workspace.ownership_transferred'), 2, '...e nenhuma auditoria a mais foi gravada');
set local role postgres;
drop trigger pgtap_falha_auditoria on public.audit_logs;
set local role authenticated;

-- Sem as falhas injetadas, a mesma chamada funciona (a causa era a falha).
select pg_temp.login(:'elisa'::uuid);
select lives_ok(format($i$ select public.transfer_workspace_ownership(%L::uuid, %L::uuid) $i$, :'ws_um', :'m_carla'),
  'sem a falha injetada, a transferência acontece');
select is(
  pg_temp.snap(:'ws_um'::uuid),
  (:'ana' || ':admin:active,' || :'carla' || ':owner:active,' || :'elisa' || ':admin:active'),
  'Carla owner; Ana e Elisa admin'
);
select is(pg_temp.owners(:'ws_um'::uuid), 1, 'sempre exatamente um owner ativo');

select * from finish();
rollback;
