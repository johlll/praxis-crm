-- A6 — GRANT de tabela para stage_auto_activity_rules (mesmo achado já
-- documentado na A5, 20260910120600): toda tabela nova nasce sem NENHUM
-- privilégio padrão para anon/authenticated desde a correção da A3
-- (20260908050700) — a policy de SELECT sozinha não basta, precisa do
-- GRANT explícito na tabela para o Postgres sequer avaliar a policy.
--
-- activities não entra aqui: é deny-all (mesma categoria de
-- opportunities), acessada só por função SECURITY DEFINER.

grant select on public.stage_auto_activity_rules to authenticated;
