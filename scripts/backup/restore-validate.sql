-- B6c — validação da restauração (somente leitura, só números; nenhum dado sai daqui).
-- psql -At: cada linha é "chave=valor" ou "tabela|schema.nome|linhas".
--
-- 1) estrutura (mesma definição de escopo do backup)
with t as (
  select c.oid, c.relname, n.nspname
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and (n.nspname in ('public', 'private', 'supabase_migrations')
         or (n.nspname = 'auth' and c.relname in ('users', 'identities')))
)
select 'tables=' || count(*) from t
union all select 'constraints_p=' || count(*) from pg_constraint k join t on t.oid = k.conrelid where k.contype = 'p'
union all select 'constraints_f=' || count(*) from pg_constraint k join t on t.oid = k.conrelid where k.contype = 'f'
union all select 'constraints_u=' || count(*) from pg_constraint k join t on t.oid = k.conrelid where k.contype = 'u'
union all select 'constraints_c=' || count(*) from pg_constraint k join t on t.oid = k.conrelid where k.contype = 'c'
union all select 'rls_enabled=' || count(*) from pg_class c join t on t.oid = c.oid where c.relrowsecurity
union all select 'rls_forced=' || count(*) from pg_class c join t on t.oid = c.oid where c.relforcerowsecurity
union all select 'policies=' || count(*) from pg_policy p join t on t.oid = p.polrelid
union all select 'triggers=' || count(*) from pg_trigger g join t on t.oid = g.tgrelid where not g.tgisinternal
union all select 'functions=' || count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private', 'supabase_migrations')
-- 2) constraints existentes mas não validadas (devem ser zero)
union all select 'nao_validadas=' || count(*)
  from pg_constraint k join t on t.oid = k.conrelid where not k.convalidated
-- 3) linhas por tabela
union all select 'linhas|' || t.nspname || '.' || t.relname || '|'
  || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', t.nspname, t.relname), false, true, '')))[1]::text
  from t;
