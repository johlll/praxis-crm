-- A11 — RLS.
--
-- Duas categorias, como nas fases anteriores:
--
-- 1) form_endpoints / form_endpoint_keys — configuração administrativa,
--    também DENY-ALL. A tela de configuração lê por RPC
--    (list_form_endpoints, restrita a owner/admin), então SELECT direto
--    seria privilégio sem uso — e privilégio sem uso é privilégio a
--    menos a ser auditado. Diferente de whatsapp_channels (A7), que não
--    tem função de leitura própria.
--
-- 2) webhook_events / outbox / touchpoints / touchpoint_demand_links /
--    continuity_references / consent_evidence — DENY-ALL para o cliente.
--    Toda leitura E escrita passa por função SECURITY DEFINER, porque o
--    alcance depende do lead vinculado (advogado vê só o próprio alcance)
--    e porque payload cifrado, hash de token e HMAC de IP nunca devem
--    trafegar para o navegador, nem para papéis administrativos.
--
-- RLS habilitada E FORÇADA em todas — o dono da tabela também obedece
-- (04_security_hardening.test.sql varre pg_class e falha se faltar).

alter table public.form_endpoints enable row level security;
alter table public.form_endpoints force row level security;

create policy form_endpoints_select_deny on public.form_endpoints for select to authenticated using (false);

create policy form_endpoints_insert_deny on public.form_endpoints for insert to authenticated with check (false);
create policy form_endpoints_update_deny on public.form_endpoints for update to authenticated using (false);
create policy form_endpoints_delete_deny on public.form_endpoints for delete to authenticated using (false);

alter table public.form_endpoint_keys enable row level security;
alter table public.form_endpoint_keys force row level security;

create policy form_endpoint_keys_select_deny on public.form_endpoint_keys for select to authenticated using (false);

create policy form_endpoint_keys_insert_deny on public.form_endpoint_keys for insert to authenticated with check (false);
create policy form_endpoint_keys_update_deny on public.form_endpoint_keys for update to authenticated using (false);
create policy form_endpoint_keys_delete_deny on public.form_endpoint_keys for delete to authenticated using (false);

alter table public.webhook_events enable row level security;
alter table public.webhook_events force row level security;

create policy webhook_events_select_deny on public.webhook_events for select to authenticated using (false);
create policy webhook_events_insert_deny on public.webhook_events for insert to authenticated with check (false);
create policy webhook_events_update_deny on public.webhook_events for update to authenticated using (false);
create policy webhook_events_delete_deny on public.webhook_events for delete to authenticated using (false);

alter table public.outbox enable row level security;
alter table public.outbox force row level security;

create policy outbox_select_deny on public.outbox for select to authenticated using (false);
create policy outbox_insert_deny on public.outbox for insert to authenticated with check (false);
create policy outbox_update_deny on public.outbox for update to authenticated using (false);
create policy outbox_delete_deny on public.outbox for delete to authenticated using (false);

alter table public.touchpoints enable row level security;
alter table public.touchpoints force row level security;

create policy touchpoints_select_deny on public.touchpoints for select to authenticated using (false);
create policy touchpoints_insert_deny on public.touchpoints for insert to authenticated with check (false);
create policy touchpoints_update_deny on public.touchpoints for update to authenticated using (false);
create policy touchpoints_delete_deny on public.touchpoints for delete to authenticated using (false);

alter table public.touchpoint_demand_links enable row level security;
alter table public.touchpoint_demand_links force row level security;

create policy touchpoint_demand_links_select_deny on public.touchpoint_demand_links for select to authenticated using (false);
create policy touchpoint_demand_links_insert_deny on public.touchpoint_demand_links for insert to authenticated with check (false);
create policy touchpoint_demand_links_update_deny on public.touchpoint_demand_links for update to authenticated using (false);
create policy touchpoint_demand_links_delete_deny on public.touchpoint_demand_links for delete to authenticated using (false);

alter table public.continuity_references enable row level security;
alter table public.continuity_references force row level security;

create policy continuity_references_select_deny on public.continuity_references for select to authenticated using (false);
create policy continuity_references_insert_deny on public.continuity_references for insert to authenticated with check (false);
create policy continuity_references_update_deny on public.continuity_references for update to authenticated using (false);
create policy continuity_references_delete_deny on public.continuity_references for delete to authenticated using (false);

alter table public.consent_evidence enable row level security;
alter table public.consent_evidence force row level security;

create policy consent_evidence_select_deny on public.consent_evidence for select to authenticated using (false);
create policy consent_evidence_insert_deny on public.consent_evidence for insert to authenticated with check (false);
create policy consent_evidence_update_deny on public.consent_evidence for update to authenticated using (false);
create policy consent_evidence_delete_deny on public.consent_evidence for delete to authenticated using (false);
