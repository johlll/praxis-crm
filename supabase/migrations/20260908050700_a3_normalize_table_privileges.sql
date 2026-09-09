-- A3 — fecha a mesma lacuna da A2 (achado 21/22), desta vez completa.
--
-- A migration 20260908030000_a2_revoke_default_table_privileges.sql só
-- tinha revogado REFERENCES/TRIGGER/TRUNCATE/MAINTAIN do DEFAULT
-- PRIVILEGES do papel `postgres` — bastava para as 5 tabelas da A2 porque,
-- lá, o problema era GRANT FALTANDO no projeto hospedado (SELECT/INSERT/
-- UPDATE/DELETE nunca existiam por padrão em lugar nenhum, então corrigir
-- só precisava ADICIONAR). A primeira rodada de CI desta fase provou que
-- essa suposição não vale ao contrário: o Postgres LOCAL (Docker) do CI
-- concede SELECT/INSERT/UPDATE/DELETE por padrão a anon/authenticated em
-- toda tabela nova — um baseline mais aberto que nenhuma das 9 tabelas
-- desta fase tinha essa concessão revogada explicitamente, porque a A2
-- nunca precisou pensar nisso (só go GRANT faltando, nunca em GRANT
-- sobrando). `authenticated` chegou com INSERT/UPDATE/DELETE de brinde em
-- `contacts`/`contact_phones`/`contact_emails`/`duplicate_candidates`
-- (que só deviam ter SELECT) e com CRUD completo nas 5 tabelas que não
-- deviam ter GRANT nenhum (`contact_identifiers`, `contact_sensitive`,
-- `contact_consents`, `contact_merges`, `sensitive_data_access`).
--
-- Corrige as 9 tabelas desta fase com o mesmo `revoke all` + regrant só
-- do necessário que a A2 já usava, e — mais importante — estende o
-- DEFAULT PRIVILEGES para cobrir SELECT/INSERT/UPDATE/DELETE também, não
-- só os quatro de antes. Com isso, toda tabela de fase futura (A4 em
-- diante) já nasce sem NENHUM privilégio para anon/authenticated, em
-- QUALQUER ambiente (local ou hospedado) — sem essa surpresa se repetir.

revoke all on public.contacts from anon, authenticated;
revoke all on public.contact_phones from anon, authenticated;
revoke all on public.contact_emails from anon, authenticated;
revoke all on public.contact_identifiers from anon, authenticated;
revoke all on public.contact_sensitive from anon, authenticated;
revoke all on public.contact_consents from anon, authenticated;
revoke all on public.duplicate_candidates from anon, authenticated;
revoke all on public.contact_merges from anon, authenticated;
revoke all on public.sensitive_data_access from anon, authenticated;

grant select on public.contacts to authenticated;
grant select on public.contact_phones to authenticated;
grant select on public.contact_emails to authenticated;
grant select on public.duplicate_candidates to authenticated;

alter default privileges for role postgres in schema public
  revoke select, insert, update, delete, references, trigger, truncate, maintain
  on tables from anon, authenticated;
