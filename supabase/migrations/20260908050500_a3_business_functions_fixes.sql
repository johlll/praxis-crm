-- A3 — dois ajustes encontrados testando contra o Postgres hospedado de
-- verdade (não simulação): a migration anterior já foi aplicada, então
-- isto entra como correção nova, nunca editando o que já rodou.
--
-- 1) Faltava um jeito de EDITAR telefone/e-mail (só existia
--    adicionar/remover) — "edição dos dados básicos" do contato inclui
--    corrigir um telefone digitado errado sem perder metadado
--    (verified_at, source) só porque remove+adiciona de novo.
--
-- 2) unmerge_contact() não detectava conflito quando uma linha movida foi
--    APAGADA depois da mesclagem (não só editada) — o UPDATE de
--    reparentação simplesmente não afetava linha nenhuma, "desfazendo"
--    sem avisar que aquele telefone/e-mail específico não voltou. Corrige
--    para tratar ausência da linha como conflito também.

create function public.update_contact_phone(p_phone_id uuid, p_value_normalized text, p_is_primary boolean default null)
returns public.contact_phones
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_phone public.contact_phones;
  v_workspace_id uuid;
  v_contact_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select cp.contact_id into v_contact_id from public.contact_phones cp where cp.id = p_phone_id;
  if v_contact_id is null then
    raise exception 'phone_not_found';
  end if;
  select workspace_id into v_workspace_id from public.contacts where id = v_contact_id;

  if not private.has_workspace_role(
    v_workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  if p_is_primary then
    update public.contact_phones set is_primary = false where contact_id = v_contact_id and id <> p_phone_id;
  end if;

  update public.contact_phones
    set value_normalized = p_value_normalized, is_primary = coalesce(p_is_primary, is_primary)
    where id = p_phone_id
    returning * into v_phone;

  perform private.detect_duplicate_candidates_for(v_contact_id);

  return v_phone;
end;
$body$;

revoke all on function public.update_contact_phone(uuid, text, boolean) from public;
grant execute on function public.update_contact_phone(uuid, text, boolean) to authenticated;

create function public.update_contact_email(p_email_id uuid, p_value_normalized text, p_is_primary boolean default null)
returns public.contact_emails
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_email public.contact_emails;
  v_workspace_id uuid;
  v_contact_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select ce.contact_id into v_contact_id from public.contact_emails ce where ce.id = p_email_id;
  if v_contact_id is null then
    raise exception 'email_not_found';
  end if;
  select workspace_id into v_workspace_id from public.contacts where id = v_contact_id;

  if not private.has_workspace_role(
    v_workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  if p_is_primary then
    update public.contact_emails set is_primary = false where contact_id = v_contact_id and id <> p_email_id;
  end if;

  update public.contact_emails
    set value_normalized = lower(btrim(p_value_normalized)), is_primary = coalesce(p_is_primary, is_primary)
    where id = p_email_id
    returning * into v_email;

  perform private.detect_duplicate_candidates_for(v_contact_id);

  return v_email;
end;
$body$;

revoke all on function public.update_contact_email(uuid, text, boolean) from public;
grant execute on function public.update_contact_email(uuid, text, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- unmerge_contact — CREATE OR REPLACE para corrigir a detecção de
-- conflito: linha movida que foi APAGADA depois da mesclagem também
-- bloqueia o desfazer (antes só edição in-place era detectada). Mesma
-- assinatura, mesmo GRANT — não precisa revoke/grant de novo.
-- ---------------------------------------------------------------------

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

  -- Conflito nas linhas reparentadas: editada (updated_at diferente) OU
  -- apagada (linha não existe mais) depois da mesclagem.
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
    else
      v_row_exists := null;
    end if;

    if v_row_exists is not true then
      -- Linha foi apagada depois da mesclagem — nada para reparentar de
      -- volta com segurança; conflito, não um "desfazer parcial" silencioso.
      v_conflicts := v_conflicts || (v_table || ':' || v_id::text || ' (removida depois da mesclagem)');
    elsif v_prev_updated_at is not null and v_current_updated_at is distinct from v_prev_updated_at then
      v_conflicts := v_conflicts || (v_table || ':' || v_id::text);
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
