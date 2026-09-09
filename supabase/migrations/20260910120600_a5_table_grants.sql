-- A5 — GRANT de tabela faltante nas 4 tabelas de configuração com RLS
-- aberta (pipelines, pipeline_stages, stage_requirements, lost_reasons).
--
-- Achado no smoke-test local: RLS sozinha não basta — desde a correção
-- da A3 (20260908050700), toda tabela nova já nasce SEM NENHUM
-- privilégio padrão para anon/authenticated (default privileges do papel
-- que cria a tabela), diferente da A2. A policy de SELECT dessas quatro
-- tabelas (20260910120100_a5_rls.sql) filtra QUAIS linhas — mas sem o
-- GRANT de tabela, o Postgres nem chega a avaliar a policy, retornando
-- "permission denied for table" (42501) antes disso. As tabelas deny-all
-- (opportunities, opportunity_requirement_values, stage_transitions,
-- clients, client_handoffs) não precisam de GRANT nenhum — só são
-- acessadas por função SECURITY DEFINER, que roda como o dono da função,
-- não como `authenticated`.

grant select on public.pipelines to authenticated;
grant select on public.pipeline_stages to authenticated;
grant select on public.stage_requirements to authenticated;
grant select on public.lost_reasons to authenticated;
