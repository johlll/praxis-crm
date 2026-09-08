-- A3 — funções de negócio expostas via RPC (schema public). Mesmo padrão
-- da A2: SECURITY DEFINER + `set search_path = ''` + nomes totalmente
-- qualificados; cada uma valida papel/workspace internamente, nunca confia
-- só na RLS (que aqui nem se aplica — SECURITY DEFINER roda por cima
-- dela). CPF/CNPJ em claro NUNCA passa por nenhuma destas funções — só
-- ciphertext/blind index já calculados em Node
-- (src/server/crypto/contact-sensitive.ts).

-- ---------------------------------------------------------------------
-- create_contact
-- ---------------------------------------------------------------------

create function public.create_contact(
  p_workspace_id uuid,
  p_type public.contact_type,
  p_name text,
  p_city text,
  p_uf text,
  p_preferred_channel public.contact_channel,
  p_phones jsonb default '[]'::jsonb,
  p_emails jsonb default '[]'::jsonb,
  p_cpf_ciphertext_base64 text default null,
  p_cpf_blind_index_base64 text default null,
  p_cpf_key_version text default null
)
returns public.contacts
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_contact public.contacts;
  v_item jsonb;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if not private.has_workspace_role(
    p_workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  insert into public.contacts (workspace_id, type, name, city, uf, preferred_channel)
  values (p_workspace_id, p_type, btrim(p_name), nullif(btrim(coalesce(p_city, '')), ''), p_uf, p_preferred_channel)
  returning * into v_contact;

  for v_item in select * from jsonb_array_elements(coalesce(p_phones, '[]'::jsonb))
  loop
    insert into public.contact_phones (workspace_id, contact_id, value_normalized, is_primary)
    values (p_workspace_id, v_contact.id, v_item ->> 'value_normalized', coalesce((v_item ->> 'is_primary')::boolean, false));
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(p_emails, '[]'::jsonb))
  loop
    insert into public.contact_emails (workspace_id, contact_id, value_normalized, is_primary)
    values (p_workspace_id, v_contact.id, v_item ->> 'value_normalized', coalesce((v_item ->> 'is_primary')::boolean, false));
  end loop;

  if p_cpf_ciphertext_base64 is not null then
    insert into public.contact_sensitive (contact_id, workspace_id, cpf_cnpj_ciphertext, cpf_cnpj_blind_index, key_version)
    values (
      v_contact.id, p_workspace_id,
      decode(p_cpf_ciphertext_base64, 'base64'), decode(p_cpf_blind_index_base64, 'base64'), p_cpf_key_version
    );
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (p_workspace_id, v_actor, 'contact.created', 'contact', v_contact.id, jsonb_build_object('name', v_contact.name));

  perform private.detect_duplicate_candidates_for(v_contact.id);

  return v_contact;
end;
$body$;

revoke all on function public.create_contact(
  uuid, public.contact_type, text, text, text, public.contact_channel, jsonb, jsonb, text, text, text
) from public;
grant execute on function public.create_contact(
  uuid, public.contact_type, text, text, text, public.contact_channel, jsonb, jsonb, text, text, text
) to authenticated;

-- ---------------------------------------------------------------------
-- update_contact_basic_fields
-- ---------------------------------------------------------------------

create function public.update_contact_basic_fields(
  p_contact_id uuid,
  p_name text,
  p_city text,
  p_uf text,
  p_preferred_channel public.contact_channel
)
returns public.contacts
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_contact public.contacts;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_contact from public.contacts where id = p_contact_id and merged_into_contact_id is null for update;
  if v_contact.id is null then
    raise exception 'contact_not_found';
  end if;

  if not private.has_workspace_role(
    v_contact.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  update public.contacts
    set name = btrim(p_name), city = nullif(btrim(coalesce(p_city, '')), ''), uf = p_uf, preferred_channel = p_preferred_channel
    where id = p_contact_id
    returning * into v_contact;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_contact.workspace_id, v_actor, 'contact.updated', 'contact', v_contact.id, '{}'::jsonb);

  perform private.detect_duplicate_candidates_for(p_contact_id);

  return v_contact;
end;
$body$;

revoke all on function public.update_contact_basic_fields(uuid, text, text, text, public.contact_channel) from public;
grant execute on function public.update_contact_basic_fields(uuid, text, text, text, public.contact_channel) to authenticated;

-- ---------------------------------------------------------------------
-- Telefones e e-mails — adicionar/remover.
-- ---------------------------------------------------------------------

create function public.add_contact_phone(p_contact_id uuid, p_value_normalized text, p_is_primary boolean default false)
returns public.contact_phones
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_contact public.contacts;
  v_phone public.contact_phones;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_contact from public.contacts where id = p_contact_id and merged_into_contact_id is null;
  if v_contact.id is null then
    raise exception 'contact_not_found';
  end if;

  if not private.has_workspace_role(
    v_contact.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  if p_is_primary then
    update public.contact_phones set is_primary = false where contact_id = p_contact_id;
  end if;

  insert into public.contact_phones (workspace_id, contact_id, value_normalized, is_primary)
  values (v_contact.workspace_id, p_contact_id, p_value_normalized, p_is_primary)
  returning * into v_phone;

  perform private.detect_duplicate_candidates_for(p_contact_id);

  return v_phone;
end;
$body$;

revoke all on function public.add_contact_phone(uuid, text, boolean) from public;
grant execute on function public.add_contact_phone(uuid, text, boolean) to authenticated;

create function public.remove_contact_phone(p_phone_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_phone public.contact_phones;
  v_workspace_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_phone from public.contact_phones where id = p_phone_id;
  if v_phone.id is null then
    raise exception 'phone_not_found';
  end if;

  select workspace_id into v_workspace_id from public.contacts where id = v_phone.contact_id;

  if not private.has_workspace_role(
    v_workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  delete from public.contact_phones where id = p_phone_id;

  perform private.detect_duplicate_candidates_for(v_phone.contact_id);
end;
$body$;

revoke all on function public.remove_contact_phone(uuid) from public;
grant execute on function public.remove_contact_phone(uuid) to authenticated;

create function public.add_contact_email(p_contact_id uuid, p_value_normalized text, p_is_primary boolean default false)
returns public.contact_emails
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_contact public.contacts;
  v_email public.contact_emails;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_contact from public.contacts where id = p_contact_id and merged_into_contact_id is null;
  if v_contact.id is null then
    raise exception 'contact_not_found';
  end if;

  if not private.has_workspace_role(
    v_contact.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  if p_is_primary then
    update public.contact_emails set is_primary = false where contact_id = p_contact_id;
  end if;

  insert into public.contact_emails (workspace_id, contact_id, value_normalized, is_primary)
  values (v_contact.workspace_id, p_contact_id, lower(btrim(p_value_normalized)), p_is_primary)
  returning * into v_email;

  perform private.detect_duplicate_candidates_for(p_contact_id);

  return v_email;
end;
$body$;

revoke all on function public.add_contact_email(uuid, text, boolean) from public;
grant execute on function public.add_contact_email(uuid, text, boolean) to authenticated;

create function public.remove_contact_email(p_email_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_email public.contact_emails;
  v_workspace_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_email from public.contact_emails where id = p_email_id;
  if v_email.id is null then
    raise exception 'email_not_found';
  end if;

  select workspace_id into v_workspace_id from public.contacts where id = v_email.contact_id;

  if not private.has_workspace_role(
    v_workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  delete from public.contact_emails where id = p_email_id;

  perform private.detect_duplicate_candidates_for(v_email.contact_id);
end;
$body$;

revoke all on function public.remove_contact_email(uuid) from public;
grant execute on function public.remove_contact_email(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- CPF/CNPJ — gravar, limpar, buscar por blind index, revelar (auditado).
-- Todas recebem ciphertext/blind index JÁ calculados em Node — nunca CPF
-- em claro chega aqui.
-- ---------------------------------------------------------------------

create function public.set_contact_cpf_cnpj(
  p_contact_id uuid,
  p_ciphertext_base64 text,
  p_blind_index_base64 text,
  p_key_version text
)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_contact public.contacts;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_contact from public.contacts where id = p_contact_id and merged_into_contact_id is null;
  if v_contact.id is null then
    raise exception 'contact_not_found';
  end if;

  if not private.has_workspace_role(
    v_contact.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  insert into public.contact_sensitive (contact_id, workspace_id, cpf_cnpj_ciphertext, cpf_cnpj_blind_index, key_version)
  values (p_contact_id, v_contact.workspace_id, decode(p_ciphertext_base64, 'base64'), decode(p_blind_index_base64, 'base64'), p_key_version)
  on conflict (contact_id) do update set
    cpf_cnpj_ciphertext = excluded.cpf_cnpj_ciphertext,
    cpf_cnpj_blind_index = excluded.cpf_cnpj_blind_index,
    key_version = excluded.key_version,
    updated_at = now();

  -- Ação registrada, NUNCA o valor — nem cifrado nem em claro.
  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_contact.workspace_id, v_actor, 'contact.cpf_set', 'contact', p_contact_id, '{}'::jsonb);

  perform private.detect_duplicate_candidates_for(p_contact_id);
end;
$body$;

revoke all on function public.set_contact_cpf_cnpj(uuid, text, text, text) from public;
grant execute on function public.set_contact_cpf_cnpj(uuid, text, text, text) to authenticated;

create function public.clear_contact_cpf_cnpj(p_contact_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_contact public.contacts;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_contact from public.contacts where id = p_contact_id and merged_into_contact_id is null;
  if v_contact.id is null then
    raise exception 'contact_not_found';
  end if;

  if not private.has_workspace_role(
    v_contact.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  delete from public.contact_sensitive where contact_id = p_contact_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_contact.workspace_id, v_actor, 'contact.cpf_cleared', 'contact', p_contact_id, '{}'::jsonb);

  -- Remove candidatos 'strong' pendentes que dependiam só do CPF que
  -- acabou de sumir (o loop de detecção já limpa o que não bate mais).
  perform private.detect_duplicate_candidates_for(p_contact_id);
end;
$body$;

revoke all on function public.clear_contact_cpf_cnpj(uuid) from public;
grant execute on function public.clear_contact_cpf_cnpj(uuid) to authenticated;

create function public.search_contacts_by_cpf_cnpj(p_workspace_id uuid, p_blind_indexes_base64 text[])
returns setof public.contacts
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if not private.has_workspace_role(
    p_workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  return query
    select c.*
    from public.contacts c
    join public.contact_sensitive cs on cs.contact_id = c.id
    where c.workspace_id = p_workspace_id
      and c.merged_into_contact_id is null
      and cs.cpf_cnpj_blind_index in (
        select decode(x, 'base64') from unnest(p_blind_indexes_base64) as x
      );
end;
$body$;

revoke all on function public.search_contacts_by_cpf_cnpj(uuid, text[]) from public;
grant execute on function public.search_contacts_by_cpf_cnpj(uuid, text[]) to authenticated;

create function public.contact_has_sensitive(p_contact_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $body$
  select exists (
    select 1
    from public.contact_sensitive cs
    join public.contacts c on c.id = cs.contact_id
    where cs.contact_id = p_contact_id
      and c.workspace_id in (select private.auth_workspace_ids())
  );
$body$;

revoke all on function public.contact_has_sensitive(uuid) from public;
grant execute on function public.contact_has_sensitive(uuid) to authenticated;

-- Revelação: SEMPRE auditada (sensitive_data_access), nunca guarda o
-- valor. `atendimento` (sales) precisa de motivo; os demais papéis
-- permitidos, não. `viewer` nunca revela.
create function public.reveal_contact_cpf_cnpj(p_contact_id uuid, p_reason text default null)
returns table (ciphertext_base64 text, key_version text)
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_workspace_id uuid;
  v_role public.membership_role;
  v_sensitive public.contact_sensitive;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select c.workspace_id into v_workspace_id
    from public.contacts c
    where c.id = p_contact_id and c.merged_into_contact_id is null;
  if v_workspace_id is null then
    raise exception 'contact_not_found';
  end if;

  select m.role into v_role
    from public.memberships m
    where m.workspace_id = v_workspace_id and m.user_id = v_actor and m.status = 'active';

  if v_role is null or v_role not in ('owner', 'admin', 'manager', 'lawyer', 'sales') then
    raise exception 'insufficient_permission';
  end if;

  if v_role = 'sales' and (p_reason is null or btrim(p_reason) = '') then
    raise exception 'reason_required';
  end if;

  select * into v_sensitive from public.contact_sensitive where contact_id = p_contact_id;
  if v_sensitive.contact_id is null then
    raise exception 'no_sensitive_data';
  end if;

  insert into public.sensitive_data_access (workspace_id, contact_id, actor_user_id, field, reason)
  values (v_workspace_id, p_contact_id, v_actor, 'cpf_cnpj', nullif(btrim(coalesce(p_reason, '')), ''));

  return query select encode(v_sensitive.cpf_cnpj_ciphertext, 'base64'), v_sensitive.key_version;
end;
$body$;

revoke all on function public.reveal_contact_cpf_cnpj(uuid, text) from public;
grant execute on function public.reveal_contact_cpf_cnpj(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- Duplicidade — descartar candidato. Mesclar/desfazer permitido só a
-- owner/admin/manager (plano: "Mesclar/desfazer contatos").
-- ---------------------------------------------------------------------

create function public.dismiss_duplicate_candidate(p_candidate_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_candidate public.duplicate_candidates;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_candidate from public.duplicate_candidates where id = p_candidate_id for update;
  if v_candidate.id is null then
    raise exception 'candidate_not_found';
  end if;

  if not private.has_workspace_role(
    v_candidate.workspace_id, array['owner', 'admin', 'manager']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  if v_candidate.status <> 'pending' then
    raise exception 'candidate_not_pending';
  end if;

  update public.duplicate_candidates
    set status = 'dismissed', decided_by = v_actor, decided_at = now()
    where id = p_candidate_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_candidate.workspace_id, v_actor, 'duplicate_candidate.dismissed', 'duplicate_candidate', p_candidate_id, '{}'::jsonb);
end;
$body$;

revoke all on function public.dismiss_duplicate_candidate(uuid) from public;
grant execute on function public.dismiss_duplicate_candidate(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- merge_contacts — mesclagem "soft", transacional, com snapshot mínimo
-- para desfazer. Nunca entre workspaces, nunca contato já mesclado, nunca
-- dois candidatos mesclando o mesmo par ao mesmo tempo (lock explícito).
-- ---------------------------------------------------------------------

create function public.merge_contacts(
  p_kept_contact_id uuid,
  p_merged_contact_id uuid,
  p_field_resolutions jsonb default '{}'::jsonb,
  p_candidate_id uuid default null
)
returns public.contacts
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_kept public.contacts;
  v_merged public.contacts;
  v_workspace_id uuid;
  v_previous jsonb := '{}'::jsonb;
  v_moved jsonb := '[]'::jsonb;
  v_row record;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if p_kept_contact_id = p_merged_contact_id then
    raise exception 'cannot_merge_contact_with_itself';
  end if;

  -- Lock nas duas linhas antes de checar qualquer estado — impede duas
  -- mesclagens concorrentes no mesmo par.
  select * into v_kept from public.contacts where id = p_kept_contact_id for update;
  select * into v_merged from public.contacts where id = p_merged_contact_id for update;

  if v_kept.id is null or v_merged.id is null then
    raise exception 'contact_not_found';
  end if;

  if v_kept.workspace_id <> v_merged.workspace_id then
    raise exception 'cross_workspace_merge_denied';
  end if;
  v_workspace_id := v_kept.workspace_id;

  if not private.has_workspace_role(
    v_workspace_id, array['owner', 'admin', 'manager']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  if v_kept.merged_into_contact_id is not null or v_merged.merged_into_contact_id is not null then
    raise exception 'contact_already_merged';
  end if;

  -- Resolução de campo conflitante: default mantém o valor do contato
  -- vencedor; só troca se o chamador escolher 'b' explicitamente.
  if p_field_resolutions ->> 'name' = 'b' then
    v_previous := v_previous || jsonb_build_object(
      'name', jsonb_build_object('previous', v_kept.name, 'previous_updated_at', v_kept.updated_at)
    );
    update public.contacts set name = v_merged.name where id = v_kept.id;
  end if;
  if p_field_resolutions ->> 'city' = 'b' then
    v_previous := v_previous || jsonb_build_object(
      'city', jsonb_build_object('previous', v_kept.city, 'previous_updated_at', v_kept.updated_at)
    );
    update public.contacts set city = v_merged.city where id = v_kept.id;
  end if;
  if p_field_resolutions ->> 'uf' = 'b' then
    v_previous := v_previous || jsonb_build_object(
      'uf', jsonb_build_object('previous', v_kept.uf, 'previous_updated_at', v_kept.updated_at)
    );
    update public.contacts set uf = v_merged.uf where id = v_kept.id;
  end if;
  if p_field_resolutions ->> 'preferred_channel' = 'b' then
    v_previous := v_previous || jsonb_build_object(
      'preferred_channel', jsonb_build_object('previous', v_kept.preferred_channel, 'previous_updated_at', v_kept.updated_at)
    );
    update public.contacts set preferred_channel = v_merged.preferred_channel where id = v_kept.id;
  end if;

  -- Reparenta telefones/e-mails/identificadores/consentimentos — registra
  -- cada linha (tabela, id, updated_at ANTES de mover) para o undo
  -- detectar edição posterior sem sobrescrever silenciosamente.
  for v_row in select id, updated_at from public.contact_phones where contact_id = v_merged.id
  loop
    v_moved := v_moved || jsonb_build_array(
      jsonb_build_object('table', 'contact_phones', 'id', v_row.id, 'previous_updated_at', v_row.updated_at)
    );
  end loop;
  update public.contact_phones set contact_id = v_kept.id where contact_id = v_merged.id;

  for v_row in select id, updated_at from public.contact_emails where contact_id = v_merged.id
  loop
    v_moved := v_moved || jsonb_build_array(
      jsonb_build_object('table', 'contact_emails', 'id', v_row.id, 'previous_updated_at', v_row.updated_at)
    );
  end loop;
  update public.contact_emails set contact_id = v_kept.id where contact_id = v_merged.id;

  for v_row in select id from public.contact_identifiers where contact_id = v_merged.id
  loop
    v_moved := v_moved || jsonb_build_array(
      jsonb_build_object('table', 'contact_identifiers', 'id', v_row.id, 'previous_updated_at', null)
    );
  end loop;
  update public.contact_identifiers set contact_id = v_kept.id where contact_id = v_merged.id;

  for v_row in select id, updated_at from public.contact_consents where contact_id = v_merged.id
  loop
    v_moved := v_moved || jsonb_build_array(
      jsonb_build_object('table', 'contact_consents', 'id', v_row.id, 'previous_updated_at', v_row.updated_at)
    );
  end loop;
  update public.contact_consents set contact_id = v_kept.id where contact_id = v_merged.id;

  -- contact_sensitive: só reparenta se o vencedor ainda não tiver CPF — se
  -- os dois tiverem, a linha de v_merged fica onde está (nada é perdido,
  -- sem ambiguidade de qual CPF é "o" do vencedor).
  if not exists (select 1 from public.contact_sensitive where contact_id = v_kept.id)
     and exists (select 1 from public.contact_sensitive where contact_id = v_merged.id) then
    v_moved := v_moved || jsonb_build_array(
      jsonb_build_object('table', 'contact_sensitive', 'id', v_merged.id, 'previous_updated_at', null)
    );
    update public.contact_sensitive set contact_id = v_kept.id where contact_id = v_merged.id;
  end if;

  update public.contacts set merged_into_contact_id = v_kept.id where id = v_merged.id;

  insert into public.contact_merges (
    workspace_id, kept_contact_id, merged_contact_id, candidate_id,
    kept_contact_previous_values, moved_rows, merged_by
  )
  values (v_workspace_id, v_kept.id, v_merged.id, p_candidate_id, v_previous, v_moved, v_actor);

  if p_candidate_id is not null then
    update public.duplicate_candidates
      set status = 'merged', decided_by = v_actor, decided_at = now()
      where id = p_candidate_id and status = 'pending';
  end if;

  -- Qualquer outro candidato pendente envolvendo o contato que virou
  -- "mesclado" deixa de fazer sentido — ele não compete mais.
  update public.duplicate_candidates
    set status = 'dismissed', decided_by = v_actor, decided_at = now()
    where workspace_id = v_workspace_id
      and status = 'pending'
      and (contact_a_id = v_merged.id or contact_b_id = v_merged.id);

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_workspace_id, v_actor, 'contact.merged', 'contact', v_kept.id,
    jsonb_build_object('merged_contact_id', v_merged.id)
  );

  select * into v_kept from public.contacts where id = v_kept.id;
  return v_kept;
end;
$body$;

revoke all on function public.merge_contacts(uuid, uuid, jsonb, uuid) from public;
grant execute on function public.merge_contacts(uuid, uuid, jsonb, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- unmerge_contact — desfaz, exceto se algo movido/alterado tiver sido
-- editado depois da mesclagem (nunca sobrescreve silenciosamente: aborta
-- a transação inteira e informa o que está em conflito).
-- ---------------------------------------------------------------------

create function public.unmerge_contact(p_merge_id uuid)
returns public.contacts
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_merge public.contact_merges;
  v_conflicts text[] := array[]::text[];
  v_row jsonb;
  v_table text;
  v_id uuid;
  v_prev_updated_at timestamptz;
  v_current_updated_at timestamptz;
  v_field text;
  v_field_data jsonb;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_merge from public.contact_merges where id = p_merge_id for update;
  if v_merge.id is null then
    raise exception 'merge_not_found';
  end if;

  if not private.has_workspace_role(
    v_merge.workspace_id, array['owner', 'admin', 'manager']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  if v_merge.undone_at is not null then
    raise exception 'merge_already_undone';
  end if;

  -- Conflito nas linhas reparentadas.
  for v_row in select * from jsonb_array_elements(v_merge.moved_rows)
  loop
    v_table := v_row ->> 'table';
    v_id := (v_row ->> 'id')::uuid;
    v_prev_updated_at := nullif(v_row ->> 'previous_updated_at', '')::timestamptz;

    if v_prev_updated_at is not null then
      if v_table = 'contact_phones' then
        select updated_at into v_current_updated_at from public.contact_phones where id = v_id;
      elsif v_table = 'contact_emails' then
        select updated_at into v_current_updated_at from public.contact_emails where id = v_id;
      elsif v_table = 'contact_consents' then
        select updated_at into v_current_updated_at from public.contact_consents where id = v_id;
      else
        v_current_updated_at := null;
      end if;

      if v_current_updated_at is not null and v_current_updated_at <> v_prev_updated_at then
        v_conflicts := v_conflicts || (v_table || ':' || v_id::text);
      end if;
    end if;
  end loop;

  -- Conflito nos campos escalares sobrescritos no vencedor.
  for v_field in select jsonb_object_keys(v_merge.kept_contact_previous_values)
  loop
    v_field_data := v_merge.kept_contact_previous_values -> v_field;
    v_prev_updated_at := nullif(v_field_data ->> 'previous_updated_at', '')::timestamptz;
    select updated_at into v_current_updated_at from public.contacts where id = v_merge.kept_contact_id;
    if v_current_updated_at is distinct from v_prev_updated_at then
      v_conflicts := v_conflicts || ('contacts.' || v_field);
    end if;
  end loop;

  if array_length(v_conflicts, 1) > 0 then
    raise exception 'undo_conflict: %', array_to_string(v_conflicts, ', ');
  end if;

  -- Sem conflito — reverte campo a campo.
  for v_field in select jsonb_object_keys(v_merge.kept_contact_previous_values)
  loop
    v_field_data := v_merge.kept_contact_previous_values -> v_field;
    if v_field = 'name' then
      update public.contacts set name = v_field_data ->> 'previous' where id = v_merge.kept_contact_id;
    elsif v_field = 'city' then
      update public.contacts set city = v_field_data ->> 'previous' where id = v_merge.kept_contact_id;
    elsif v_field = 'uf' then
      update public.contacts set uf = v_field_data ->> 'previous' where id = v_merge.kept_contact_id;
    elsif v_field = 'preferred_channel' then
      update public.contacts
        set preferred_channel = (v_field_data ->> 'previous')::public.contact_channel
        where id = v_merge.kept_contact_id;
    end if;
  end loop;

  -- Reparenta de volta.
  for v_row in select * from jsonb_array_elements(v_merge.moved_rows)
  loop
    v_table := v_row ->> 'table';
    v_id := (v_row ->> 'id')::uuid;
    if v_table = 'contact_phones' then
      update public.contact_phones set contact_id = v_merge.merged_contact_id where id = v_id;
    elsif v_table = 'contact_emails' then
      update public.contact_emails set contact_id = v_merge.merged_contact_id where id = v_id;
    elsif v_table = 'contact_identifiers' then
      update public.contact_identifiers set contact_id = v_merge.merged_contact_id where id = v_id;
    elsif v_table = 'contact_consents' then
      update public.contact_consents set contact_id = v_merge.merged_contact_id where id = v_id;
    elsif v_table = 'contact_sensitive' then
      update public.contact_sensitive set contact_id = v_merge.merged_contact_id where contact_id = v_merge.kept_contact_id;
    end if;
  end loop;

  update public.contacts set merged_into_contact_id = null where id = v_merge.merged_contact_id;

  update public.contact_merges set undone_by = v_actor, undone_at = now() where id = p_merge_id;

  if v_merge.candidate_id is not null then
    update public.duplicate_candidates
      set status = 'pending', decided_by = null, decided_at = null
      where id = v_merge.candidate_id;
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_merge.workspace_id, v_actor, 'contact.merge_undone', 'contact', v_merge.kept_contact_id,
    jsonb_build_object('merge_id', p_merge_id, 'restored_contact_id', v_merge.merged_contact_id)
  );

  return (select c from public.contacts c where c.id = v_merge.kept_contact_id);
end;
$body$;

revoke all on function public.unmerge_contact(uuid) from public;
grant execute on function public.unmerge_contact(uuid) to authenticated;
