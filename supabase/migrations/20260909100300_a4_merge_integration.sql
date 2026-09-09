-- A4 — integra `leads` ao merge/undo de contatos da A3. `leads` não
-- existia quando merge_contacts()/unmerge_contact() foram escritas — sem
-- isso, mesclar um contato deixaria os leads dele "presos" ao contato
-- perdedor (que passa a responder como inativo), e desfazer não teria
-- como restaurar o vínculo.
--
-- Mesma assinatura, mesmo GRANT de antes — CREATE OR REPLACE só troca o
-- corpo. `moved_rows` já é um formato genérico (`{"table", "id",
-- "previous_updated_at"}`); só é preciso ensinar as duas funções a
-- reconhecer "leads" como mais uma tabela reparentável — o loop de
-- reparentamento em si (com UPDATE...RETURNING updated_at, não SELECT
-- antes do UPDATE) usa o mesmo padrão já corrigido no achado 7 da A3.

create or replace function public.merge_contacts(
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
  v_field_updated_at timestamptz;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if p_kept_contact_id = p_merged_contact_id then
    raise exception 'cannot_merge_contact_with_itself';
  end if;

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

  if p_field_resolutions ->> 'name' = 'b' then
    update public.contacts set name = v_merged.name where id = v_kept.id
      returning updated_at into v_field_updated_at;
    v_previous := v_previous || jsonb_build_object(
      'name', jsonb_build_object('previous', v_kept.name, 'previous_updated_at', v_field_updated_at)
    );
  end if;
  if p_field_resolutions ->> 'city' = 'b' then
    update public.contacts set city = v_merged.city where id = v_kept.id
      returning updated_at into v_field_updated_at;
    v_previous := v_previous || jsonb_build_object(
      'city', jsonb_build_object('previous', v_kept.city, 'previous_updated_at', v_field_updated_at)
    );
  end if;
  if p_field_resolutions ->> 'uf' = 'b' then
    update public.contacts set uf = v_merged.uf where id = v_kept.id
      returning updated_at into v_field_updated_at;
    v_previous := v_previous || jsonb_build_object(
      'uf', jsonb_build_object('previous', v_kept.uf, 'previous_updated_at', v_field_updated_at)
    );
  end if;
  if p_field_resolutions ->> 'preferred_channel' = 'b' then
    update public.contacts set preferred_channel = v_merged.preferred_channel where id = v_kept.id
      returning updated_at into v_field_updated_at;
    v_previous := v_previous || jsonb_build_object(
      'preferred_channel', jsonb_build_object('previous', v_kept.preferred_channel, 'previous_updated_at', v_field_updated_at)
    );
  end if;

  for v_row in
    update public.contact_phones set contact_id = v_kept.id
    where contact_id = v_merged.id
    returning id, updated_at
  loop
    v_moved := v_moved || jsonb_build_array(
      jsonb_build_object('table', 'contact_phones', 'id', v_row.id, 'previous_updated_at', v_row.updated_at)
    );
  end loop;

  for v_row in
    update public.contact_emails set contact_id = v_kept.id
    where contact_id = v_merged.id
    returning id, updated_at
  loop
    v_moved := v_moved || jsonb_build_array(
      jsonb_build_object('table', 'contact_emails', 'id', v_row.id, 'previous_updated_at', v_row.updated_at)
    );
  end loop;

  for v_row in
    update public.contact_identifiers set contact_id = v_kept.id
    where contact_id = v_merged.id
    returning id
  loop
    v_moved := v_moved || jsonb_build_array(
      jsonb_build_object('table', 'contact_identifiers', 'id', v_row.id, 'previous_updated_at', null)
    );
  end loop;

  for v_row in
    update public.contact_consents set contact_id = v_kept.id
    where contact_id = v_merged.id
    returning id, updated_at
  loop
    v_moved := v_moved || jsonb_build_array(
      jsonb_build_object('table', 'contact_consents', 'id', v_row.id, 'previous_updated_at', v_row.updated_at)
    );
  end loop;

  -- Novo na A4: leads do contato perdedor passam para o vencedor — o
  -- lead continua existindo e utilizável, em vez de ficar "preso" a um
  -- contato inativo. RETURNING updated_at captura o timestamp DEPOIS do
  -- próprio UPDATE (mesma correção do achado 7 da A3), nunca antes.
  for v_row in
    update public.leads set contact_id = v_kept.id
    where contact_id = v_merged.id
    returning id, updated_at
  loop
    v_moved := v_moved || jsonb_build_array(
      jsonb_build_object('table', 'leads', 'id', v_row.id, 'previous_updated_at', v_row.updated_at)
    );
  end loop;

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

create or replace function public.unmerge_contact(p_merge_id uuid)
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
  v_row_exists boolean;
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

  for v_row in select * from jsonb_array_elements(v_merge.moved_rows)
  loop
    v_table := v_row ->> 'table';
    v_id := (v_row ->> 'id')::uuid;
    v_prev_updated_at := nullif(v_row ->> 'previous_updated_at', '')::timestamptz;

    if v_table = 'contact_phones' then
      select updated_at, true into v_current_updated_at, v_row_exists from public.contact_phones where id = v_id;
    elsif v_table = 'contact_emails' then
      select updated_at, true into v_current_updated_at, v_row_exists from public.contact_emails where id = v_id;
    elsif v_table = 'contact_consents' then
      select updated_at, true into v_current_updated_at, v_row_exists from public.contact_consents where id = v_id;
    elsif v_table = 'contact_identifiers' then
      select true into v_row_exists from public.contact_identifiers where id = v_id;
      v_current_updated_at := null;
    elsif v_table = 'contact_sensitive' then
      select true into v_row_exists from public.contact_sensitive where contact_id = v_merge.kept_contact_id;
      v_current_updated_at := null;
    elsif v_table = 'leads' then
      select updated_at, true into v_current_updated_at, v_row_exists from public.leads where id = v_id;
    else
      v_row_exists := null;
    end if;

    if v_row_exists is not true then
      v_conflicts := v_conflicts || (v_table || ':' || v_id::text || ' (removida depois da mesclagem)');
    elsif v_prev_updated_at is not null and v_current_updated_at is distinct from v_prev_updated_at then
      v_conflicts := v_conflicts || (v_table || ':' || v_id::text);
    end if;
  end loop;

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
    elsif v_table = 'leads' then
      update public.leads set contact_id = v_merge.merged_contact_id where id = v_id;
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
