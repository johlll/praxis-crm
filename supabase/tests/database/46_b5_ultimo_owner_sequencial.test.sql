-- pgTAP — B5: update_membership_role e remove_membership depois que passaram
-- a travar o workspace inteiro para o último owner resistir à concorrência.
--
-- A PROVA de concorrência está em scripts/b5-last-owner-concurrency-check.sh
-- (sessões Postgres simultâneas). Aqui, o contrato SEQUENCIAL, que não pode
-- mudar: assinatura, retorno, SECURITY DEFINER, search_path, permissões,
-- códigos de erro, o que cada papel pode fazer, a auditoria e o isolamento
-- entre workspaces. Complementa o 03_last_owner (o caso básico do último owner).

begin;
select plan(38);

\set ana    '20000000-0000-0000-0000-000000000001'
\set bruno  '20000000-0000-0000-0000-000000000002'
\set carla  '20000000-0000-0000-0000-000000000003'
\set daniel '20000000-0000-0000-0000-000000000004'
\set elisa  '20000000-0000-0000-0000-000000000005'
\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'
\set ws      'e5000000-0000-0000-0000-000000000001'
\set sem_ninguem '99999999-9999-9999-9999-999999999999'

-- ---------------------------------------------------------------------
-- Ajudantes (só desta transação)
-- ---------------------------------------------------------------------

create function pg_temp.login(p_user uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$f$;

-- Leituras por fora do RLS (SECURITY DEFINER do dono, só aqui).
create function pg_temp.mid(p_ws uuid, p_user uuid) returns uuid language sql security definer as $f$
  select id from public.memberships where workspace_id = p_ws and user_id = p_user
$f$;
create function pg_temp.owners(p_ws uuid) returns integer language sql security definer as $f$
  select count(*)::int from public.memberships where workspace_id = p_ws and role = 'owner' and status = 'active'
$f$;
create function pg_temp.role_of(p_ws uuid, p_user uuid) returns text language sql security definer as $f$
  select coalesce((select role::text from public.memberships where workspace_id = p_ws and user_id = p_user), '-')
$f$;
create function pg_temp.snap(p_ws uuid) returns text language sql security definer as $f$
  select string_agg(id::text || ':' || user_id::text || ':' || role::text || ':' || status::text, ',' order by id)
  from public.memberships where workspace_id = p_ws
$f$;
create function pg_temp.audit_n(p_ws uuid, p_action text) returns integer language sql security definer as $f$
  select count(*)::int from public.audit_logs where workspace_id = p_ws and action = p_action
$f$;
create function pg_temp.audit_meta(p_ws uuid, p_action text) returns jsonb language sql security definer as $f$
  select metadata from public.audit_logs where workspace_id = p_ws and action = p_action order by created_at desc, id desc limit 1
$f$;

-- Fotografia dos outros workspaces, para provar o isolamento no fim.
select pg_temp.snap(:'ws_um'::uuid) as snap_um \gset
select pg_temp.snap(:'ws_dois'::uuid) as snap_dois \gset

-- Workspace só deste teste: Ana owner, Carla admin, Elisa viewer. Bruno (owner
-- do Dois) e Daniel (sem vínculo) são de fora.
insert into public.workspaces (id, name, slug, created_by)
values (:'ws'::uuid, 'Escritório B5 (teste)', 'escritorio-b5-teste', :'ana'::uuid);
insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws'::uuid, :'ana'::uuid,   'owner',  'active'),
  (:'ws'::uuid, :'carla'::uuid, 'admin',  'active'),
  (:'ws'::uuid, :'elisa'::uuid, 'viewer', 'active');

-- =====================================================================
-- 1) Contrato das duas funções (mesmo da A2)
-- =====================================================================

select ok(
  (select prosecdef from pg_proc where oid = 'public.update_membership_role(uuid, public.membership_role)'::regprocedure)
  and (select prosecdef from pg_proc where oid = 'public.remove_membership(uuid)'::regprocedure),
  'update_membership_role e remove_membership continuam SECURITY DEFINER'
);

select ok(
  exists (select 1 from pg_proc p, unnest(p.proconfig) c
          where p.oid = 'public.update_membership_role(uuid, public.membership_role)'::regprocedure and c like 'search_path=%')
  and exists (select 1 from pg_proc p, unnest(p.proconfig) c
              where p.oid = 'public.remove_membership(uuid)'::regprocedure and c like 'search_path=%'),
  'as duas continuam com o search_path travado'
);

select is(
  pg_get_function_identity_arguments('public.update_membership_role(uuid, public.membership_role)'::regprocedure)
    || ' -> ' || pg_get_function_result('public.update_membership_role(uuid, public.membership_role)'::regprocedure),
  'p_membership_id uuid, p_new_role membership_role -> memberships',
  'update_membership_role: mesma assinatura e mesmo retorno'
);

select is(
  pg_get_function_identity_arguments('public.remove_membership(uuid)'::regprocedure)
    || ' -> ' || pg_get_function_result('public.remove_membership(uuid)'::regprocedure),
  'p_membership_id uuid -> void',
  'remove_membership: mesma assinatura e mesmo retorno'
);

select ok(
  has_function_privilege('authenticated', 'public.update_membership_role(uuid, public.membership_role)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.remove_membership(uuid)', 'EXECUTE'),
  'authenticated segue executando as duas (a autorização é por papel, dentro da função)'
);

select ok(
  not exists (
    select 1
    from pg_proc p, aclexplode(p.proacl) a
    where p.oid in (
        'public.update_membership_role(uuid, public.membership_role)'::regprocedure,
        'public.remove_membership(uuid)'::regprocedure
      )
      and a.grantee = 0
  ),
  'PUBLIC segue sem EXECUTE nas duas'
);

set local role authenticated;

-- =====================================================================
-- 2) update_membership_role — comportamento sequencial
-- =====================================================================

select set_config('request.jwt.claims', '', true);
select throws_ok(
  format($i$ select public.update_membership_role(%L::uuid, 'lawyer') $i$, pg_temp.mid(:'ws'::uuid, :'carla'::uuid)),
  'P0001', 'authentication_required', 'sem sessão: recusado'
);

select pg_temp.login(:'ana'::uuid);
select throws_ok(
  format($i$ select public.update_membership_role(%L::uuid, 'lawyer') $i$, :'sem_ninguem'),
  'P0001', 'membership_not_found', 'membership inexistente: membership_not_found'
);

select pg_temp.login(:'daniel'::uuid);
select throws_ok(
  format($i$ select public.update_membership_role(%L::uuid, 'lawyer') $i$, pg_temp.mid(:'ws'::uuid, :'carla'::uuid)),
  'P0001', 'insufficient_permission', 'quem não tem vínculo nenhum é recusado'
);

select pg_temp.login(:'bruno'::uuid);
select throws_ok(
  format($i$ select public.update_membership_role(%L::uuid, 'lawyer') $i$, pg_temp.mid(:'ws'::uuid, :'carla'::uuid)),
  'P0001', 'insufficient_permission', 'owner de OUTRO workspace é recusado (workspace alheio)'
);

select pg_temp.login(:'elisa'::uuid);
select throws_ok(
  format($i$ select public.update_membership_role(%L::uuid, 'lawyer') $i$, pg_temp.mid(:'ws'::uuid, :'carla'::uuid)),
  'P0001', 'insufficient_permission', 'viewer é recusado'
);

select pg_temp.login(:'carla'::uuid);
select throws_ok(
  format($i$ select public.update_membership_role(%L::uuid, 'owner') $i$, pg_temp.mid(:'ws'::uuid, :'carla'::uuid)),
  'P0001', 'insufficient_permission', 'admin não promove ninguém a owner (nem a si mesmo)'
);

select pg_temp.login(:'ana'::uuid);
select throws_ok(
  format($i$ select public.update_membership_role(%L::uuid, 'admin') $i$, pg_temp.mid(:'ws'::uuid, :'ana'::uuid)),
  'P0001', 'cannot_demote_last_owner', 'o único owner não se rebaixa'
);

select is(
  (select role::text from public.update_membership_role(pg_temp.mid(:'ws'::uuid, :'carla'::uuid), 'owner')),
  'owner',
  'owner promove o admin a owner e a função devolve a membership já atualizada'
);

select is(
  pg_temp.audit_meta(:'ws'::uuid, 'membership.role_changed'),
  '{"from_role": "admin", "to_role": "owner"}'::jsonb,
  'a promoção gravou UMA auditoria, só com os papéis'
);

select is(pg_temp.audit_n(:'ws'::uuid, 'membership.role_changed'), 1, 'exatamente uma linha de auditoria até aqui');

-- Dois owners ativos (Ana e Carla): um owner pode rebaixar o outro.
select pg_temp.login(:'carla'::uuid);
select is(
  (select role::text from public.update_membership_role(pg_temp.mid(:'ws'::uuid, :'ana'::uuid), 'lawyer')),
  'lawyer',
  'com dois owners ativos, um rebaixa o outro'
);

select is(pg_temp.owners(:'ws'::uuid), 1, 'sobra exatamente um owner ativo (Carla)');

select throws_ok(
  format($i$ select public.update_membership_role(%L::uuid, 'lawyer') $i$, pg_temp.mid(:'ws'::uuid, :'carla'::uuid)),
  'P0001', 'cannot_demote_last_owner', 'agora Carla é a única owner: não se rebaixa'
);

select pg_temp.login(:'ana'::uuid);
select throws_ok(
  format($i$ select public.update_membership_role(%L::uuid, 'lawyer') $i$, pg_temp.mid(:'ws'::uuid, :'carla'::uuid)),
  'P0001', 'insufficient_permission', 'Ana, já rebaixada a lawyer, não tem mais permissão nenhuma sobre os papéis'
);

-- Um segundo owner SUSPENSO não conta como "outro owner".
set local role postgres;
update public.memberships set role = 'owner', status = 'suspended' where workspace_id = :'ws'::uuid and user_id = :'ana'::uuid;
set local role authenticated;
select pg_temp.login(:'carla'::uuid);
select throws_ok(
  format($i$ select public.update_membership_role(%L::uuid, 'lawyer') $i$, pg_temp.mid(:'ws'::uuid, :'carla'::uuid)),
  'P0001', 'cannot_demote_last_owner', 'owner suspenso não conta: Carla segue sendo a única owner ATIVA'
);

select lives_ok(
  format($i$ select public.update_membership_role(%L::uuid, 'viewer') $i$, pg_temp.mid(:'ws'::uuid, :'elisa'::uuid)),
  'repetir o mesmo papel é aceito, como sempre foi'
);

-- =====================================================================
-- 3) remove_membership — comportamento sequencial
-- =====================================================================

select set_config('request.jwt.claims', '', true);
select throws_ok(
  format($i$ select public.remove_membership(%L::uuid) $i$, pg_temp.mid(:'ws'::uuid, :'elisa'::uuid)),
  'P0001', 'authentication_required', 'sem sessão: recusado'
);

select pg_temp.login(:'carla'::uuid);
select throws_ok(
  format($i$ select public.remove_membership(%L::uuid) $i$, :'sem_ninguem'),
  'P0001', 'membership_not_found', 'membership inexistente: membership_not_found'
);

select pg_temp.login(:'daniel'::uuid);
select throws_ok(
  format($i$ select public.remove_membership(%L::uuid) $i$, pg_temp.mid(:'ws'::uuid, :'elisa'::uuid)),
  'P0001', 'insufficient_permission', 'quem não tem vínculo nenhum é recusado'
);

select pg_temp.login(:'bruno'::uuid);
select throws_ok(
  format($i$ select public.remove_membership(%L::uuid) $i$, pg_temp.mid(:'ws'::uuid, :'elisa'::uuid)),
  'P0001', 'insufficient_permission', 'owner de OUTRO workspace é recusado (workspace alheio)'
);

select pg_temp.login(:'elisa'::uuid);
select throws_ok(
  format($i$ select public.remove_membership(%L::uuid) $i$, pg_temp.mid(:'ws'::uuid, :'carla'::uuid)),
  'P0001', 'insufficient_permission', 'viewer é recusado'
);

select pg_temp.login(:'carla'::uuid);
select throws_ok(
  format($i$ select public.remove_membership(%L::uuid) $i$, pg_temp.mid(:'ws'::uuid, :'carla'::uuid)),
  'P0001', 'cannot_remove_last_owner', 'a única owner ATIVA (o outro owner está suspenso) não se remove'
);

select lives_ok(
  format($i$ select public.remove_membership(%L::uuid) $i$, pg_temp.mid(:'ws'::uuid, :'elisa'::uuid)),
  'remover quem não é owner funciona'
);

select is(pg_temp.role_of(:'ws'::uuid, :'elisa'::uuid), '-', 'a membership removida deixou de existir');

select is(
  pg_temp.audit_meta(:'ws'::uuid, 'membership.removed'),
  json_build_object('removed_user_id', :'elisa'::text, 'role', 'viewer')::jsonb,
  'a remoção gravou UMA auditoria, só com o id da pessoa e o papel'
);

select is(pg_temp.audit_n(:'ws'::uuid, 'membership.removed'), 1, 'exatamente uma linha de auditoria de remoção');

-- Com dois owners ATIVOS, um owner pode ser removido.
set local role postgres;
update public.memberships set status = 'active' where workspace_id = :'ws'::uuid and user_id = :'ana'::uuid;
set local role authenticated;
select pg_temp.login(:'carla'::uuid);
select lives_ok(
  format($i$ select public.remove_membership(%L::uuid) $i$, pg_temp.mid(:'ws'::uuid, :'ana'::uuid)),
  'com dois owners ativos, um owner pode ser removido'
);

select is(pg_temp.owners(:'ws'::uuid), 1, 'sobra exatamente um owner ativo (Carla)');

-- Um admin pode se remover (o bloqueio é só para o último owner).
set local role postgres;
insert into public.memberships (workspace_id, user_id, role, status) values (:'ws'::uuid, :'daniel'::uuid, 'admin', 'active');
set local role authenticated;
select pg_temp.login(:'daniel'::uuid);
select lives_ok(
  format($i$ select public.remove_membership(%L::uuid) $i$, pg_temp.mid(:'ws'::uuid, :'daniel'::uuid)),
  'um admin consegue se remover'
);

select pg_temp.login(:'carla'::uuid);
select throws_ok(
  format($i$ select public.remove_membership(%L::uuid) $i$, pg_temp.mid(:'ws'::uuid, :'carla'::uuid)),
  'P0001', 'cannot_remove_last_owner', 'e a última owner continua protegida no fim'
);

-- =====================================================================
-- 4) Isolamento: nada acima encostou nos outros workspaces
-- =====================================================================

select is(pg_temp.snap(:'ws_um'::uuid), :'snap_um', 'o Escritório Um ficou exatamente como estava');
select is(pg_temp.snap(:'ws_dois'::uuid), :'snap_dois', 'o Escritório Dois ficou exatamente como estava');

select * from finish();
rollback;
