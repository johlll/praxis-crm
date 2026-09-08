-- A3 — RLS: habilitada e FORÇADA nas 9 tabelas, policy separada por
-- operação. Nenhuma escrita direta do cliente em tabela nenhuma desta
-- fase — toda mutação passa por função SECURITY DEFINER (próxima
-- migration), pelos mesmos motivos da A2: lógica atômica (cifra, blind
-- index, detecção de duplicidade, mesclagem transacional, auditoria) só é
-- segura centralizada num lugar só, testável.

-- ---------------------------------------------------------------------
-- contacts
-- ---------------------------------------------------------------------

alter table public.contacts enable row level security;
alter table public.contacts force row level security;

create policy contacts_select on public.contacts
  for select
  to authenticated
  using (workspace_id in (select private.auth_workspace_ids()));

create policy contacts_insert_deny on public.contacts
  for insert
  to authenticated
  with check (false);

create policy contacts_update_deny on public.contacts
  for update
  to authenticated
  using (false);

create policy contacts_delete_deny on public.contacts
  for delete
  to authenticated
  using (false);

-- ---------------------------------------------------------------------
-- contact_phones
-- ---------------------------------------------------------------------

alter table public.contact_phones enable row level security;
alter table public.contact_phones force row level security;

create policy contact_phones_select on public.contact_phones
  for select
  to authenticated
  using (workspace_id in (select private.auth_workspace_ids()));

create policy contact_phones_insert_deny on public.contact_phones
  for insert
  to authenticated
  with check (false);

create policy contact_phones_update_deny on public.contact_phones
  for update
  to authenticated
  using (false);

create policy contact_phones_delete_deny on public.contact_phones
  for delete
  to authenticated
  using (false);

-- ---------------------------------------------------------------------
-- contact_emails
-- ---------------------------------------------------------------------

alter table public.contact_emails enable row level security;
alter table public.contact_emails force row level security;

create policy contact_emails_select on public.contact_emails
  for select
  to authenticated
  using (workspace_id in (select private.auth_workspace_ids()));

create policy contact_emails_insert_deny on public.contact_emails
  for insert
  to authenticated
  with check (false);

create policy contact_emails_update_deny on public.contact_emails
  for update
  to authenticated
  using (false);

create policy contact_emails_delete_deny on public.contact_emails
  for delete
  to authenticated
  using (false);

-- ---------------------------------------------------------------------
-- contact_identifiers
-- ---------------------------------------------------------------------

alter table public.contact_identifiers enable row level security;
alter table public.contact_identifiers force row level security;

create policy contact_identifiers_select on public.contact_identifiers
  for select
  to authenticated
  using (workspace_id in (select private.auth_workspace_ids()));

create policy contact_identifiers_insert_deny on public.contact_identifiers
  for insert
  to authenticated
  with check (false);

create policy contact_identifiers_update_deny on public.contact_identifiers
  for update
  to authenticated
  using (false);

create policy contact_identifiers_delete_deny on public.contact_identifiers
  for delete
  to authenticated
  using (false);

-- ---------------------------------------------------------------------
-- contact_sensitive — SELECT também negado por policy: nenhum acesso de
-- linha inteira pelo cliente, nem cifrado. Toda leitura (existência, busca
-- por blind index, revelação) passa por função SECURITY DEFINER.
-- ---------------------------------------------------------------------

alter table public.contact_sensitive enable row level security;
alter table public.contact_sensitive force row level security;

create policy contact_sensitive_select_deny on public.contact_sensitive
  for select
  to authenticated
  using (false);

create policy contact_sensitive_insert_deny on public.contact_sensitive
  for insert
  to authenticated
  with check (false);

create policy contact_sensitive_update_deny on public.contact_sensitive
  for update
  to authenticated
  using (false);

create policy contact_sensitive_delete_deny on public.contact_sensitive
  for delete
  to authenticated
  using (false);

-- ---------------------------------------------------------------------
-- contact_consents
-- ---------------------------------------------------------------------

alter table public.contact_consents enable row level security;
alter table public.contact_consents force row level security;

create policy contact_consents_select on public.contact_consents
  for select
  to authenticated
  using (workspace_id in (select private.auth_workspace_ids()));

create policy contact_consents_insert_deny on public.contact_consents
  for insert
  to authenticated
  with check (false);

create policy contact_consents_update_deny on public.contact_consents
  for update
  to authenticated
  using (false);

create policy contact_consents_delete_deny on public.contact_consents
  for delete
  to authenticated
  using (false);

-- ---------------------------------------------------------------------
-- duplicate_candidates
-- ---------------------------------------------------------------------

alter table public.duplicate_candidates enable row level security;
alter table public.duplicate_candidates force row level security;

create policy duplicate_candidates_select on public.duplicate_candidates
  for select
  to authenticated
  using (workspace_id in (select private.auth_workspace_ids()));

create policy duplicate_candidates_insert_deny on public.duplicate_candidates
  for insert
  to authenticated
  with check (false);

create policy duplicate_candidates_update_deny on public.duplicate_candidates
  for update
  to authenticated
  using (false);

create policy duplicate_candidates_delete_deny on public.duplicate_candidates
  for delete
  to authenticated
  using (false);

-- ---------------------------------------------------------------------
-- contact_merges — só owner/admin enxergam o histórico (mesmo padrão de
-- workspace_invitations_select na A2). Append-only.
-- ---------------------------------------------------------------------

alter table public.contact_merges enable row level security;
alter table public.contact_merges force row level security;

create policy contact_merges_select on public.contact_merges
  for select
  to authenticated
  using (
    workspace_id in (select private.auth_workspace_ids())
    and private.has_workspace_role(workspace_id, array['owner', 'admin']::public.membership_role[])
  );

create policy contact_merges_insert_deny on public.contact_merges
  for insert
  to authenticated
  with check (false);

create policy contact_merges_update_deny on public.contact_merges
  for update
  to authenticated
  using (false);

create policy contact_merges_delete_deny on public.contact_merges
  for delete
  to authenticated
  using (false);

-- ---------------------------------------------------------------------
-- sensitive_data_access — só owner/admin enxergam, mesmo padrão de
-- audit_logs. Append-only.
-- ---------------------------------------------------------------------

alter table public.sensitive_data_access enable row level security;
alter table public.sensitive_data_access force row level security;

create policy sensitive_data_access_select on public.sensitive_data_access
  for select
  to authenticated
  using (
    workspace_id in (select private.auth_workspace_ids())
    and private.has_workspace_role(workspace_id, array['owner', 'admin']::public.membership_role[])
  );

create policy sensitive_data_access_insert_deny on public.sensitive_data_access
  for insert
  to authenticated
  with check (false);

create policy sensitive_data_access_update_deny on public.sensitive_data_access
  for update
  to authenticated
  using (false);

create policy sensitive_data_access_delete_deny on public.sensitive_data_access
  for delete
  to authenticated
  using (false);
