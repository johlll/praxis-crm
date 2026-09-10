-- A6 — RLS.
--
-- Mesmas duas categorias da A3/A4/A5:
--
-- 1) stage_auto_activity_rules — configuração não sensível, SELECT direto
--    por workspace via private.auth_workspace_ids(). Mutação só por RPC
--    (administrativa, owner/admin/manager — mesmo nível de
--    pipeline.configure).
--
-- 2) activities — escopo por registro (herdado do lead pai), DENY-ALL.
--    Toda leitura E escrita passa por função SECURITY DEFINER que aplica
--    private.lead_accessible_to_role().

-- ---------------------------------------------------------------------
-- stage_auto_activity_rules
-- ---------------------------------------------------------------------

alter table public.stage_auto_activity_rules enable row level security;
alter table public.stage_auto_activity_rules force row level security;

create policy stage_auto_activity_rules_select on public.stage_auto_activity_rules
  for select
  to authenticated
  using (workspace_id in (select private.auth_workspace_ids()));

create policy stage_auto_activity_rules_insert_deny on public.stage_auto_activity_rules for insert to authenticated with check (false);
create policy stage_auto_activity_rules_update_deny on public.stage_auto_activity_rules for update to authenticated using (false);
create policy stage_auto_activity_rules_delete_deny on public.stage_auto_activity_rules for delete to authenticated using (false);

-- ---------------------------------------------------------------------
-- activities — deny-all (escopo por registro herdado do lead).
-- ---------------------------------------------------------------------

alter table public.activities enable row level security;
alter table public.activities force row level security;

create policy activities_select_deny on public.activities for select to authenticated using (false);
create policy activities_insert_deny on public.activities for insert to authenticated with check (false);
create policy activities_update_deny on public.activities for update to authenticated using (false);
create policy activities_delete_deny on public.activities for delete to authenticated using (false);
