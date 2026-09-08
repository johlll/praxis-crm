-- A3 — create_contact()/update_contact_basic_fields(): adiciona
-- `default null` a p_city/p_uf/p_preferred_channel.
--
-- Sem isso, `supabase gen types typescript` gera esses parâmetros como
-- obrigatórios e não-nuláveis no lado TypeScript (Postgres não expõe
-- nulidade de parâmetro de função do mesmo jeito que expõe nulidade de
-- coluna — só a presença de um DEFAULT faz o gerador marcar o argumento
-- como opcional). UF e canal preferido genuinamente não têm um "vazio"
-- válido (o CHECK de uf exige 2 letras OU NULL; o enum não tem opção
-- "nenhum") — preciso do NULL de verdade chegando à função, não de uma
-- string vazia disfarçada. CREATE OR REPLACE mantém a mesma assinatura
-- (mesmos tipos de parâmetro = mesma função para o Postgres, não uma
-- sobrecarga nova) — GRANT/REVOKE já aplicados continuam valendo.

create or replace function public.create_contact(
  p_workspace_id uuid,
  p_type public.contact_type,
  p_name text,
  p_city text default null,
  p_uf text default null,
  p_preferred_channel public.contact_channel default null,
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

create or replace function public.update_contact_basic_fields(
  p_contact_id uuid,
  p_name text,
  p_city text default null,
  p_uf text default null,
  p_preferred_channel public.contact_channel default null
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
