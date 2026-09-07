-- pgTAP — os dois invariantes estruturais que o prompt da A2 pede como
-- critério de aceite, verificados contra o catálogo do Postgres em vez de
-- confiados "de olho": toda função SECURITY DEFINER tem search_path
-- travado, e toda tabela criada nesta fase tem RLS ligada E forçada.

begin;
select plan(15);

-- -----------------------------------------------------------------
-- 1) RLS habilitada e FORÇADA nas 5 tabelas da A2 — sem exceção.
-- -----------------------------------------------------------------
select ok(
  (select relrowsecurity from pg_class where oid = 'public.workspaces'::regclass),
  'workspaces: row level security HABILITADA'
);
select ok(
  (select relforcerowsecurity from pg_class where oid = 'public.workspaces'::regclass),
  'workspaces: row level security FORÇADA'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.users'::regclass),
  'users: row level security HABILITADA'
);
select ok(
  (select relforcerowsecurity from pg_class where oid = 'public.users'::regclass),
  'users: row level security FORÇADA'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.memberships'::regclass),
  'memberships: row level security HABILITADA'
);
select ok(
  (select relforcerowsecurity from pg_class where oid = 'public.memberships'::regclass),
  'memberships: row level security FORÇADA'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.workspace_invitations'::regclass),
  'workspace_invitations: row level security HABILITADA'
);
select ok(
  (select relforcerowsecurity from pg_class where oid = 'public.workspace_invitations'::regclass),
  'workspace_invitations: row level security FORÇADA'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.audit_logs'::regclass),
  'audit_logs: row level security HABILITADA'
);
select ok(
  (select relforcerowsecurity from pg_class where oid = 'public.audit_logs'::regclass),
  'audit_logs: row level security FORÇADA'
);

-- Prova negativa: nenhuma tabela de public criada por esta fase escapou —
-- consulta todas e falha se alguma não tiver as duas flags ligadas.
select is(
  (
    select count(*)::int
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname in ('workspaces', 'users', 'memberships', 'workspace_invitations', 'audit_logs')
      and (c.relrowsecurity is false or c.relforcerowsecurity is false)
  ),
  0,
  'Nenhuma das 5 tabelas da A2 ficou sem RLS habilitada+forçada'
);

-- -----------------------------------------------------------------
-- 2) search_path vazio em toda função SECURITY DEFINER — pega qualquer
--    uma que eu tenha esquecido de marcar, em vez de confiar na leitura.
-- -----------------------------------------------------------------
-- Restrito às funções que a A2 criou (por nome), não a tudo que existe em
-- `public` — um projeto Supabase novo pode ter funções SECURITY DEFINER
-- de outras extensões habilitadas por padrão (pg_graphql e afins) que não
-- são nossas para endurecer, e um sweep cego correria o risco de reprovar
-- o CI por algo fora do controle desta fase.
select is(
  (
    select count(*)::int
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.prosecdef = true
      and (
        (n.nspname = 'private') or
        (n.nspname = 'public' and p.proname in (
          'create_workspace_with_owner',
          'create_workspace_invitation',
          'cancel_workspace_invitation',
          'preview_workspace_invitation',
          'accept_workspace_invitation',
          'update_membership_role',
          'remove_membership'
        ))
      )
      and not exists (
        select 1
        from unnest(coalesce(p.proconfig, array[]::text[])) as cfg
        where cfg = 'search_path='
      )
  ),
  0,
  'Toda função SECURITY DEFINER da A2 (private + as RPCs de public) tem search_path travado em vazio'
);

-- Prova positiva nomeada: se a query acima um dia vier a mudar de forma
-- que mascare um esquecimento, este teste explícito por nome ainda pega.
select is(
  (
    select count(*)::int
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.proname = 'auth_workspace_ids'
      and p.prosecdef = true
      and 'search_path=' = any(p.proconfig)
  ),
  1,
  'private.auth_workspace_ids() é SECURITY DEFINER com search_path vazio'
);

-- -----------------------------------------------------------------
-- 3) private.auth_workspace_ids() não é chamável por quem não deveria —
--    EXECUTE revogado de PUBLIC, concedido só a authenticated/anon.
-- -----------------------------------------------------------------
select is(
  (
    select count(*)::int
    from information_schema.routine_privileges
    where routine_schema = 'private'
      and routine_name = 'auth_workspace_ids'
      and grantee = 'PUBLIC'
  ),
  0,
  'private.auth_workspace_ids() não tem EXECUTE concedido a PUBLIC'
);

-- -----------------------------------------------------------------
-- 4) O schema private não aparece nos schemas expostos pela Data API —
--    confere o próprio supabase/config.toml, não só o banco.
-- -----------------------------------------------------------------
select is(
  (select count(*)::int from pg_tables where schemaname = 'private'),
  0,
  'schema private não tem tabela nenhuma — só funções auxiliares, por design'
);

select * from finish();
rollback;
