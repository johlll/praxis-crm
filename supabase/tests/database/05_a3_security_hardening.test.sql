-- pgTAP — A3: RLS habilitada+forçada, GRANT exato, search_path travado nas
-- novas funções SECURITY DEFINER. Mesmo padrão de 04_security_hardening,
-- que pegou bugs reais na A2 — aplicado desde o início desta vez.

begin;
select plan(22);

-- -----------------------------------------------------------------
-- 1) RLS habilitada e FORÇADA nas 9 tabelas da A3.
-- -----------------------------------------------------------------
select is(
  (
    select count(*)::int
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname in (
        'contacts', 'contact_phones', 'contact_emails', 'contact_identifiers',
        'contact_sensitive', 'contact_consents', 'duplicate_candidates',
        'contact_merges', 'sensitive_data_access'
      )
      and (c.relrowsecurity is false or c.relforcerowsecurity is false)
  ),
  0,
  'Nenhuma das 9 tabelas da A3 ficou sem RLS habilitada+forçada'
);

-- -----------------------------------------------------------------
-- 2) GRANT exato — só o que os fluxos implementados usam por acesso
--    direto. contact_sensitive sem NENHUM grant, nem SELECT.
-- -----------------------------------------------------------------
select table_privs_are('public', 'contacts', 'authenticated', array['SELECT'], 'contacts: authenticated só SELECT');
select table_privs_are('public', 'contacts', 'anon', array[]::text[], 'contacts: anon nada');

select table_privs_are('public', 'contact_phones', 'authenticated', array['SELECT'], 'contact_phones: authenticated só SELECT');
select table_privs_are('public', 'contact_phones', 'anon', array[]::text[], 'contact_phones: anon nada');

select table_privs_are('public', 'contact_emails', 'authenticated', array['SELECT'], 'contact_emails: authenticated só SELECT');
select table_privs_are('public', 'contact_emails', 'anon', array[]::text[], 'contact_emails: anon nada');

select table_privs_are('public', 'duplicate_candidates', 'authenticated', array['SELECT'], 'duplicate_candidates: authenticated só SELECT');
select table_privs_are('public', 'duplicate_candidates', 'anon', array[]::text[], 'duplicate_candidates: anon nada');

select table_privs_are('public', 'contact_identifiers', 'authenticated', array[]::text[], 'contact_identifiers: authenticated nada (sem consumidor nesta fase)');
select table_privs_are('public', 'contact_identifiers', 'anon', array[]::text[], 'contact_identifiers: anon nada');

select table_privs_are('public', 'contact_sensitive', 'authenticated', array[]::text[], 'contact_sensitive: authenticated NADA — nem SELECT');
select table_privs_are('public', 'contact_sensitive', 'anon', array[]::text[], 'contact_sensitive: anon nada');

-- A7 (20260911140600_a7_table_grants.sql) concede SELECT — a Central de
-- Conversas passou a ler consentimento direto (RLS por workspace já
-- cobria o isolamento; só faltava o GRANT, igual contacts/contact_phones).
-- Mutação continua só por RPC (register_contact_consent()/
-- revoke_contact_consent()), por isso INSERT/UPDATE/DELETE não aparecem.
select table_privs_are('public', 'contact_consents', 'authenticated', array['SELECT'], 'contact_consents: authenticated só SELECT (desde a A7)');
select table_privs_are('public', 'contact_consents', 'anon', array[]::text[], 'contact_consents: anon nada');

select table_privs_are('public', 'contact_merges', 'authenticated', array[]::text[], 'contact_merges: authenticated nada (sem tela de histórico nesta fase)');
select table_privs_are('public', 'contact_merges', 'anon', array[]::text[], 'contact_merges: anon nada');

select table_privs_are('public', 'sensitive_data_access', 'authenticated', array[]::text[], 'sensitive_data_access: authenticated nada (sem tela nesta fase)');
select table_privs_are('public', 'sensitive_data_access', 'anon', array[]::text[], 'sensitive_data_access: anon nada');

-- -----------------------------------------------------------------
-- 3) search_path travado em toda função SECURITY DEFINER da A3.
-- -----------------------------------------------------------------
select is(
  (
    select count(*)::int
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.prosecdef = true
      and n.nspname = 'public'
      and p.proname in (
        'create_contact', 'update_contact_basic_fields',
        'add_contact_phone', 'remove_contact_phone', 'update_contact_phone',
        'add_contact_email', 'remove_contact_email', 'update_contact_email',
        'set_contact_cpf_cnpj', 'clear_contact_cpf_cnpj',
        'search_contacts_by_cpf_cnpj', 'contact_has_sensitive',
        'reveal_contact_cpf_cnpj', 'dismiss_duplicate_candidate',
        'merge_contacts', 'unmerge_contact'
      )
      and not exists (
        select 1 from unnest(coalesce(p.proconfig, array[]::text[])) as cfg
        where cfg like 'search_path=%'
      )
  ),
  0,
  'Toda função SECURITY DEFINER pública da A3 tem search_path travado'
);

select is(
  (
    select count(*)::int
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.prosecdef = true
      and n.nspname = 'private'
      and p.proname = 'detect_duplicate_candidates_for'
      and not exists (
        select 1 from unnest(coalesce(p.proconfig, array[]::text[])) as cfg
        where cfg like 'search_path=%'
      )
  ),
  0,
  'private.detect_duplicate_candidates_for tem search_path travado'
);

-- -----------------------------------------------------------------
-- 4) EXECUTE nunca concedido a PUBLIC em nenhuma função nova.
-- -----------------------------------------------------------------
select is(
  (
    select count(*)::int
    from information_schema.routine_privileges
    where routine_schema in ('public', 'private')
      and routine_name in (
        'create_contact', 'update_contact_basic_fields',
        'add_contact_phone', 'remove_contact_phone', 'update_contact_phone',
        'add_contact_email', 'remove_contact_email', 'update_contact_email',
        'set_contact_cpf_cnpj', 'clear_contact_cpf_cnpj',
        'search_contacts_by_cpf_cnpj', 'contact_has_sensitive',
        'reveal_contact_cpf_cnpj', 'dismiss_duplicate_candidate',
        'merge_contacts', 'unmerge_contact', 'detect_duplicate_candidates_for'
      )
      and grantee = 'PUBLIC'
  ),
  0,
  'Nenhuma função nova da A3 tem EXECUTE concedido a PUBLIC'
);

select * from finish();
rollback;
