-- A5 — RLS.
--
-- Duas categorias, mesmo critério da A3/A4:
--
-- 1) Configuração não sensível (pipelines, pipeline_stages,
--    stage_requirements, lost_reasons) — SELECT direto por workspace via
--    private.auth_workspace_ids(), mesmo padrão de `contacts`. Mutação
--    sempre por RPC (validações de "não apagar etapa ocupada", "não
--    reordenar flag de ganho/perda de forma inconsistente" só são seguras
--    centralizadas).
--
-- 2) Dado sensível ou com escopo por registro (opportunities,
--    opportunity_requirement_values, stage_transitions, clients,
--    client_handoffs) — DENY-ALL, mesmo tratamento de `leads`/
--    `lead_values` na A4. Toda leitura E escrita passa por função
--    SECURITY DEFINER que aplica a projeção por papel e o alcance "seus +
--    sem responsável" (herdado do lead pai — não existe responsável
--    próprio de oportunidade nesta fase).

-- ---------------------------------------------------------------------
-- pipelines
-- ---------------------------------------------------------------------

alter table public.pipelines enable row level security;
alter table public.pipelines force row level security;

create policy pipelines_select on public.pipelines
  for select
  to authenticated
  using (workspace_id in (select private.auth_workspace_ids()));

create policy pipelines_insert_deny on public.pipelines for insert to authenticated with check (false);
create policy pipelines_update_deny on public.pipelines for update to authenticated using (false);
create policy pipelines_delete_deny on public.pipelines for delete to authenticated using (false);

-- ---------------------------------------------------------------------
-- pipeline_stages
-- ---------------------------------------------------------------------

alter table public.pipeline_stages enable row level security;
alter table public.pipeline_stages force row level security;

create policy pipeline_stages_select on public.pipeline_stages
  for select
  to authenticated
  using (workspace_id in (select private.auth_workspace_ids()));

create policy pipeline_stages_insert_deny on public.pipeline_stages for insert to authenticated with check (false);
create policy pipeline_stages_update_deny on public.pipeline_stages for update to authenticated using (false);
create policy pipeline_stages_delete_deny on public.pipeline_stages for delete to authenticated using (false);

-- ---------------------------------------------------------------------
-- stage_requirements
-- ---------------------------------------------------------------------

alter table public.stage_requirements enable row level security;
alter table public.stage_requirements force row level security;

create policy stage_requirements_select on public.stage_requirements
  for select
  to authenticated
  using (workspace_id in (select private.auth_workspace_ids()));

create policy stage_requirements_insert_deny on public.stage_requirements for insert to authenticated with check (false);
create policy stage_requirements_update_deny on public.stage_requirements for update to authenticated using (false);
create policy stage_requirements_delete_deny on public.stage_requirements for delete to authenticated using (false);

-- ---------------------------------------------------------------------
-- lost_reasons
-- ---------------------------------------------------------------------

alter table public.lost_reasons enable row level security;
alter table public.lost_reasons force row level security;

create policy lost_reasons_select on public.lost_reasons
  for select
  to authenticated
  using (workspace_id in (select private.auth_workspace_ids()));

create policy lost_reasons_insert_deny on public.lost_reasons for insert to authenticated with check (false);
create policy lost_reasons_update_deny on public.lost_reasons for update to authenticated using (false);
create policy lost_reasons_delete_deny on public.lost_reasons for delete to authenticated using (false);

-- ---------------------------------------------------------------------
-- opportunities — deny-all (dado financeiro).
-- ---------------------------------------------------------------------

alter table public.opportunities enable row level security;
alter table public.opportunities force row level security;

create policy opportunities_select_deny on public.opportunities for select to authenticated using (false);
create policy opportunities_insert_deny on public.opportunities for insert to authenticated with check (false);
create policy opportunities_update_deny on public.opportunities for update to authenticated using (false);
create policy opportunities_delete_deny on public.opportunities for delete to authenticated using (false);

-- ---------------------------------------------------------------------
-- opportunity_requirement_values — deny-all (só acessível via a mesma
-- RPC que retorna a oportunidade; escopo por registro herda da
-- oportunidade pai).
-- ---------------------------------------------------------------------

alter table public.opportunity_requirement_values enable row level security;
alter table public.opportunity_requirement_values force row level security;

create policy opportunity_requirement_values_select_deny on public.opportunity_requirement_values for select to authenticated using (false);
create policy opportunity_requirement_values_insert_deny on public.opportunity_requirement_values for insert to authenticated with check (false);
create policy opportunity_requirement_values_update_deny on public.opportunity_requirement_values for update to authenticated using (false);
create policy opportunity_requirement_values_delete_deny on public.opportunity_requirement_values for delete to authenticated using (false);

-- ---------------------------------------------------------------------
-- stage_transitions — deny-all, append-only só por função (histórico não
-- é financeiro, mas é escopado ao alcance por registro da oportunidade).
-- ---------------------------------------------------------------------

alter table public.stage_transitions enable row level security;
alter table public.stage_transitions force row level security;

create policy stage_transitions_select_deny on public.stage_transitions for select to authenticated using (false);
create policy stage_transitions_insert_deny on public.stage_transitions for insert to authenticated with check (false);
create policy stage_transitions_update_deny on public.stage_transitions for update to authenticated using (false);
create policy stage_transitions_delete_deny on public.stage_transitions for delete to authenticated using (false);

-- ---------------------------------------------------------------------
-- clients / client_handoffs — deny-all (fundação mínima da A8; sem tela
-- própria nesta fase, só as funções de negócio da A5 escrevem aqui).
-- ---------------------------------------------------------------------

alter table public.clients enable row level security;
alter table public.clients force row level security;

create policy clients_select_deny on public.clients for select to authenticated using (false);
create policy clients_insert_deny on public.clients for insert to authenticated with check (false);
create policy clients_update_deny on public.clients for update to authenticated using (false);
create policy clients_delete_deny on public.clients for delete to authenticated using (false);

alter table public.client_handoffs enable row level security;
alter table public.client_handoffs force row level security;

create policy client_handoffs_select_deny on public.client_handoffs for select to authenticated using (false);
create policy client_handoffs_insert_deny on public.client_handoffs for insert to authenticated with check (false);
create policy client_handoffs_update_deny on public.client_handoffs for update to authenticated using (false);
create policy client_handoffs_delete_deny on public.client_handoffs for delete to authenticated using (false);
