-- C4 mínima — campos personalizados tipados para contatos, leads,
-- oportunidades e clientes. As tabelas não são expostas ao cliente:
-- leitura e escrita passam exclusivamente pelas RPCs abaixo.

create type public.custom_field_entity as enum ('contact', 'lead', 'opportunity', 'client');
create type public.custom_field_type as enum ('short_text', 'number', 'date', 'boolean', 'single_select');
create type public.custom_field_status as enum ('active', 'archived');

create table public.custom_field_definitions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  entity_type public.custom_field_entity not null,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  field_type public.custom_field_type not null,
  position integer not null default 0 check (position between 0 and 10000),
  status public.custom_field_status not null default 'active',
  created_by uuid not null references public.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint custom_field_definitions_workspace_id_id_key unique (workspace_id, id)
);

create index custom_field_definitions_workspace_entity_idx
  on public.custom_field_definitions (workspace_id, entity_type, status, position, id);

create table public.custom_field_options (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  definition_id uuid not null,
  label text not null check (char_length(btrim(label)) between 1 and 80),
  position integer not null default 0 check (position between 0 and 10000),
  status public.custom_field_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint custom_field_options_definition_fkey
    foreign key (workspace_id, definition_id)
    references public.custom_field_definitions (workspace_id, id) on delete restrict,
  constraint custom_field_options_workspace_definition_id_key unique (workspace_id, definition_id, id)
);

create unique index custom_field_options_active_label_key
  on public.custom_field_options (workspace_id, definition_id, lower(btrim(label)))
  where status = 'active';

create table public.custom_field_values (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  definition_id uuid not null,
  contact_id uuid,
  lead_id uuid,
  opportunity_id uuid,
  client_id uuid,
  text_value text,
  number_value numeric,
  date_value date,
  boolean_value boolean,
  option_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint custom_field_values_definition_fkey
    foreign key (workspace_id, definition_id)
    references public.custom_field_definitions (workspace_id, id) on delete restrict,
  constraint custom_field_values_contact_fkey
    foreign key (workspace_id, contact_id) references public.contacts (workspace_id, id) on delete cascade,
  constraint custom_field_values_lead_fkey
    foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade,
  constraint custom_field_values_opportunity_fkey
    foreign key (workspace_id, opportunity_id) references public.opportunities (workspace_id, id) on delete cascade,
  constraint custom_field_values_client_fkey
    foreign key (workspace_id, client_id) references public.clients (workspace_id, id) on delete cascade,
  constraint custom_field_values_option_fkey
    foreign key (workspace_id, definition_id, option_id)
    references public.custom_field_options (workspace_id, definition_id, id) on delete restrict,
  constraint custom_field_values_one_record_check check (
    num_nonnulls(contact_id, lead_id, opportunity_id, client_id) = 1
  ),
  constraint custom_field_values_one_value_check check (
    num_nonnulls(text_value, number_value, date_value, boolean_value, option_id) = 1
  ),
  constraint custom_field_values_text_length_check check (
    text_value is null or char_length(btrim(text_value)) between 1 and 200
  ),
  constraint custom_field_values_number_range_check check (
    number_value is null or abs(number_value) <= 1000000000000000
  )
);

create unique index custom_field_values_contact_key
  on public.custom_field_values (definition_id, contact_id) where contact_id is not null;
create unique index custom_field_values_lead_key
  on public.custom_field_values (definition_id, lead_id) where lead_id is not null;
create unique index custom_field_values_opportunity_key
  on public.custom_field_values (definition_id, opportunity_id) where opportunity_id is not null;
create unique index custom_field_values_client_key
  on public.custom_field_values (definition_id, client_id) where client_id is not null;

alter table public.custom_field_definitions enable row level security;
alter table public.custom_field_definitions force row level security;
alter table public.custom_field_options enable row level security;
alter table public.custom_field_options force row level security;
alter table public.custom_field_values enable row level security;
alter table public.custom_field_values force row level security;

revoke all on table public.custom_field_definitions from public, anon, authenticated;
revoke all on table public.custom_field_options from public, anon, authenticated;
revoke all on table public.custom_field_values from public, anon, authenticated;

create trigger custom_field_definitions_set_updated_at
  before update on public.custom_field_definitions
  for each row execute function private.set_updated_at();
create trigger custom_field_options_set_updated_at
  before update on public.custom_field_options
  for each row execute function private.set_updated_at();
create trigger custom_field_values_set_updated_at
  before update on public.custom_field_values
  for each row execute function private.set_updated_at();

create function private.custom_field_definition_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $body$
begin
  if new.workspace_id <> old.workspace_id
     or new.entity_type <> old.entity_type
     or new.field_type <> old.field_type then
    raise exception 'custom_field_type_immutable';
  end if;
  return new;
end;
$body$;

revoke all on function private.custom_field_definition_guard() from public, anon, authenticated;

create trigger custom_field_definition_guard
  before update on public.custom_field_definitions
  for each row execute function private.custom_field_definition_guard();

create function private.custom_field_value_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_definition public.custom_field_definitions;
begin
  select * into v_definition
  from public.custom_field_definitions
  where id = new.definition_id and workspace_id = new.workspace_id;

  if v_definition.id is null or v_definition.status <> 'active' then
    raise exception 'custom_field_definition_not_found';
  end if;

  if (v_definition.entity_type = 'contact' and new.contact_id is null)
     or (v_definition.entity_type = 'lead' and new.lead_id is null)
     or (v_definition.entity_type = 'opportunity' and new.opportunity_id is null)
     or (v_definition.entity_type = 'client' and new.client_id is null) then
    raise exception 'custom_field_entity_mismatch';
  end if;

  if (v_definition.field_type = 'short_text' and new.text_value is null)
     or (v_definition.field_type = 'number' and new.number_value is null)
     or (v_definition.field_type = 'date' and new.date_value is null)
     or (v_definition.field_type = 'boolean' and new.boolean_value is null)
     or (v_definition.field_type = 'single_select' and new.option_id is null) then
    raise exception 'custom_field_value_type_mismatch';
  end if;

  if new.option_id is not null and not exists (
    select 1 from public.custom_field_options o
    where o.id = new.option_id
      and o.workspace_id = new.workspace_id
      and o.definition_id = new.definition_id
      and o.status = 'active'
  ) then
    raise exception 'custom_field_option_not_found';
  end if;

  return new;
end;
$body$;

revoke all on function private.custom_field_value_guard() from public, anon, authenticated;

create trigger custom_field_value_guard
  before insert or update on public.custom_field_values
  for each row execute function private.custom_field_value_guard();

-- Confirma existência, workspace e alcance da entidade. A função devolve
-- somente o workspace; nunca projeta dados do registro.
create function private.custom_field_record_workspace(
  p_entity public.custom_field_entity,
  p_record_id uuid,
  p_write boolean
)
returns uuid
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_workspace_id uuid;
  v_assigned_to uuid;
  v_role public.membership_role;
  v_allowed boolean := false;
begin
  if v_actor is null then raise exception 'authentication_required'; end if;

  if p_entity = 'contact' then
    select workspace_id into v_workspace_id from public.contacts
    where id = p_record_id and merged_into_contact_id is null;
  elsif p_entity = 'lead' then
    select workspace_id, assigned_to into v_workspace_id, v_assigned_to
    from public.leads where id = p_record_id;
  elsif p_entity = 'opportunity' then
    select o.workspace_id, l.assigned_to into v_workspace_id, v_assigned_to
    from public.opportunities o join public.leads l on l.id = o.lead_id
    where o.id = p_record_id;
  elsif p_entity = 'client' then
    select workspace_id into v_workspace_id from public.clients where id = p_record_id;
  end if;

  if v_workspace_id is null then raise exception 'custom_field_record_not_found'; end if;

  select role into v_role from public.memberships
  where workspace_id = v_workspace_id and user_id = v_actor and status = 'active';
  if v_role is null then raise exception 'custom_field_record_not_found'; end if;

  if p_entity = 'contact' then
    v_allowed := not p_write or v_role <> 'viewer';
  elsif p_entity in ('lead', 'opportunity') then
    v_allowed := (not p_write or v_role <> 'viewer')
      and private.lead_accessible_to_role(v_role, v_assigned_to, v_actor);
  elsif p_entity = 'client' then
    if p_write then
      v_allowed := v_role = any (array['owner', 'admin', 'manager']::public.membership_role[]);
    else
      v_allowed := v_role <> 'lawyer' or exists (
        select 1
        from public.client_handoffs ch
        join public.opportunities o on o.id = ch.opportunity_id
        join public.leads l on l.id = o.lead_id
        where ch.client_id = p_record_id
          and private.lead_accessible_to_role(v_role, l.assigned_to, v_actor)
      );
    end if;
  end if;

  if not v_allowed then raise exception 'custom_field_record_not_found'; end if;
  return v_workspace_id;
end;
$body$;

revoke all on function private.custom_field_record_workspace(public.custom_field_entity, uuid, boolean)
  from public, anon, authenticated;

create function public.list_custom_field_definitions(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
begin
  if not private.has_workspace_role(
    p_workspace_id, array['owner', 'admin']::public.membership_role[]
  ) then raise exception 'insufficient_permission'; end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', d.id, 'entity_type', d.entity_type, 'name', d.name,
      'field_type', d.field_type, 'position', d.position, 'status', d.status,
      'options', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', o.id, 'label', o.label, 'position', o.position, 'status', o.status
        ) order by o.position, o.id)
        from public.custom_field_options o where o.definition_id = d.id
      ), '[]'::jsonb)
    ) order by d.entity_type, d.position, d.id)
    from public.custom_field_definitions d where d.workspace_id = p_workspace_id
  ), '[]'::jsonb);
end;
$body$;

create function public.create_custom_field_definition(
  p_workspace_id uuid,
  p_entity_type public.custom_field_entity,
  p_name text,
  p_field_type public.custom_field_type,
  p_position integer,
  p_options text[] default '{}'::text[]
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_definition_id uuid;
  v_label text;
  v_position integer := 0;
begin
  if v_actor is null then raise exception 'authentication_required'; end if;
  if not private.has_workspace_role(
    p_workspace_id, array['owner', 'admin']::public.membership_role[]
  ) then raise exception 'insufficient_permission'; end if;

  perform 1 from public.workspaces where id = p_workspace_id for update;
  if (select count(*) from public.custom_field_definitions
      where workspace_id = p_workspace_id and entity_type = p_entity_type and status = 'active') >= 50 then
    raise exception 'custom_field_limit_reached';
  end if;
  if p_field_type <> 'single_select' and cardinality(coalesce(p_options, '{}'::text[])) > 0 then
    raise exception 'custom_field_options_not_allowed';
  end if;
  if p_field_type = 'single_select' and cardinality(coalesce(p_options, '{}'::text[])) = 0 then
    raise exception 'custom_field_options_required';
  end if;
  if cardinality(coalesce(p_options, '{}'::text[])) > 50 then
    raise exception 'invalid_custom_field_options';
  end if;

  insert into public.custom_field_definitions
    (workspace_id, entity_type, name, field_type, position, created_by)
  values (p_workspace_id, p_entity_type, btrim(p_name), p_field_type, p_position, v_actor)
  returning id into v_definition_id;

  foreach v_label in array coalesce(p_options, '{}'::text[]) loop
    insert into public.custom_field_options (workspace_id, definition_id, label, position)
    values (p_workspace_id, v_definition_id, btrim(v_label), v_position);
    v_position := v_position + 1;
  end loop;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (p_workspace_id, v_actor, 'custom_field.definition_created', 'custom_field_definition',
          v_definition_id, jsonb_build_object('definition_id', v_definition_id, 'entity', p_entity_type));
  return v_definition_id;
end;
$body$;

create function public.update_custom_field_definition(
  p_definition_id uuid,
  p_name text,
  p_position integer,
  p_options jsonb default '[]'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_definition public.custom_field_definitions;
  v_item jsonb;
  v_option_id uuid;
  v_seen uuid[] := '{}'::uuid[];
begin
  if v_actor is null then raise exception 'authentication_required'; end if;
  select * into v_definition from public.custom_field_definitions
  where id = p_definition_id for update;
  if v_definition.id is null then raise exception 'custom_field_definition_not_found'; end if;
  if not private.has_workspace_role(
    v_definition.workspace_id, array['owner', 'admin']::public.membership_role[]
  ) then raise exception 'custom_field_definition_not_found'; end if;
  if v_definition.status = 'archived' then raise exception 'custom_field_definition_archived'; end if;

  update public.custom_field_definitions
  set name = btrim(p_name), position = p_position where id = p_definition_id;

  if v_definition.field_type = 'single_select' then
    if jsonb_array_length(coalesce(p_options, '[]'::jsonb)) > 50 then
      raise exception 'invalid_custom_field_options';
    end if;
    for v_item in select value from jsonb_array_elements(coalesce(p_options, '[]'::jsonb)) loop
      if nullif(v_item ->> 'id', '') is null then
        insert into public.custom_field_options (workspace_id, definition_id, label, position)
        values (v_definition.workspace_id, v_definition.id, btrim(v_item ->> 'label'), (v_item ->> 'position')::integer)
        returning id into v_option_id;
      else
        v_option_id := (v_item ->> 'id')::uuid;
        update public.custom_field_options
        set label = btrim(v_item ->> 'label'), position = (v_item ->> 'position')::integer, status = 'active'
        where id = v_option_id and definition_id = v_definition.id and workspace_id = v_definition.workspace_id;
        if not found then raise exception 'custom_field_option_not_found'; end if;
      end if;
      v_seen := array_append(v_seen, v_option_id);
    end loop;

    if exists (
      select 1 from public.custom_field_options o
      where o.definition_id = v_definition.id and o.status = 'active' and not (o.id = any(v_seen))
        and exists (select 1 from public.custom_field_values v where v.option_id = o.id)
    ) then raise exception 'custom_field_option_in_use'; end if;

    if jsonb_array_length(coalesce(p_options, '[]'::jsonb)) = 0 then
      raise exception 'custom_field_options_required';
    end if;

    update public.custom_field_options set status = 'archived'
    where definition_id = v_definition.id and status = 'active' and not (id = any(v_seen));
  elsif jsonb_array_length(coalesce(p_options, '[]'::jsonb)) > 0 then
    raise exception 'custom_field_options_not_allowed';
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_definition.workspace_id, v_actor, 'custom_field.definition_updated', 'custom_field_definition',
          v_definition.id, jsonb_build_object('definition_id', v_definition.id, 'entity', v_definition.entity_type));
end;
$body$;

create function public.archive_custom_field_definition(p_definition_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_definition public.custom_field_definitions;
begin
  if v_actor is null then raise exception 'authentication_required'; end if;
  select * into v_definition from public.custom_field_definitions where id = p_definition_id for update;
  if v_definition.id is null then raise exception 'custom_field_definition_not_found'; end if;
  if not private.has_workspace_role(
    v_definition.workspace_id, array['owner', 'admin']::public.membership_role[]
  ) then raise exception 'custom_field_definition_not_found'; end if;
  update public.custom_field_definitions set status = 'archived'
  where id = p_definition_id and status = 'active';
  if found then
    insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
    values (v_definition.workspace_id, v_actor, 'custom_field.definition_archived', 'custom_field_definition',
            v_definition.id, jsonb_build_object('definition_id', v_definition.id, 'entity', v_definition.entity_type));
  end if;
end;
$body$;

create function public.get_custom_fields_for_record(
  p_workspace_id uuid,
  p_entity_type public.custom_field_entity,
  p_record_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_workspace_id uuid;
begin
  v_workspace_id := private.custom_field_record_workspace(p_entity_type, p_record_id, false);
  if v_workspace_id <> p_workspace_id then raise exception 'custom_field_record_not_found'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'definition_id', d.id, 'name', d.name, 'field_type', d.field_type, 'position', d.position,
      'text_value', v.text_value, 'number_value', v.number_value, 'date_value', v.date_value,
      'boolean_value', v.boolean_value, 'option_id', v.option_id,
      'options', coalesce((select jsonb_agg(jsonb_build_object(
        'id', o.id, 'label', o.label, 'position', o.position
      ) order by o.position, o.id) from public.custom_field_options o
      where o.definition_id = d.id and o.status = 'active'), '[]'::jsonb)
    ) order by d.position, d.id)
    from public.custom_field_definitions d
    left join public.custom_field_values v on v.definition_id = d.id and (
      (p_entity_type = 'contact' and v.contact_id = p_record_id) or
      (p_entity_type = 'lead' and v.lead_id = p_record_id) or
      (p_entity_type = 'opportunity' and v.opportunity_id = p_record_id) or
      (p_entity_type = 'client' and v.client_id = p_record_id)
    )
    where d.workspace_id = v_workspace_id and d.entity_type = p_entity_type and d.status = 'active'
  ), '[]'::jsonb);
end;
$body$;

create function public.set_custom_field_value(
  p_workspace_id uuid,
  p_definition_id uuid,
  p_record_id uuid,
  p_text_value text default null,
  p_number_value numeric default null,
  p_date_value date default null,
  p_boolean_value boolean default null,
  p_option_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_definition public.custom_field_definitions;
  v_workspace_id uuid;
  v_value_id uuid;
  v_created boolean := false;
begin
  if v_actor is null then raise exception 'authentication_required'; end if;
  select * into v_definition from public.custom_field_definitions
  where id = p_definition_id and workspace_id = p_workspace_id and status = 'active';
  if v_definition.id is null then raise exception 'custom_field_definition_not_found'; end if;
  v_workspace_id := private.custom_field_record_workspace(v_definition.entity_type, p_record_id, true);
  if v_workspace_id <> p_workspace_id then raise exception 'custom_field_record_not_found'; end if;

  if num_nonnulls(p_text_value, p_number_value, p_date_value, p_boolean_value, p_option_id) <> 1 then
    raise exception 'custom_field_value_required';
  end if;

  select id into v_value_id from public.custom_field_values
  where definition_id = v_definition.id and (
    (v_definition.entity_type = 'contact' and contact_id = p_record_id) or
    (v_definition.entity_type = 'lead' and lead_id = p_record_id) or
    (v_definition.entity_type = 'opportunity' and opportunity_id = p_record_id) or
    (v_definition.entity_type = 'client' and client_id = p_record_id)
  ) for update;

  if v_value_id is null then
    v_created := true;
    insert into public.custom_field_values (
      workspace_id, definition_id, contact_id, lead_id, opportunity_id, client_id,
      text_value, number_value, date_value, boolean_value, option_id
    ) values (
      v_workspace_id, v_definition.id,
      case when v_definition.entity_type = 'contact' then p_record_id end,
      case when v_definition.entity_type = 'lead' then p_record_id end,
      case when v_definition.entity_type = 'opportunity' then p_record_id end,
      case when v_definition.entity_type = 'client' then p_record_id end,
      nullif(btrim(p_text_value), ''), p_number_value, p_date_value, p_boolean_value, p_option_id
    );
  else
    update public.custom_field_values set
      text_value = nullif(btrim(p_text_value), ''), number_value = p_number_value,
      date_value = p_date_value, boolean_value = p_boolean_value, option_id = p_option_id
    where id = v_value_id;
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_workspace_id, v_actor,
          case when v_created then 'custom_field.value_created' else 'custom_field.value_updated' end,
          v_definition.entity_type::text, p_record_id,
          jsonb_build_object('definition_id', v_definition.id, 'entity', v_definition.entity_type,
                             'record_id', p_record_id,
                             'action', case when v_created then 'created' else 'updated' end));
end;
$body$;

-- A tela salva todos os campos visíveis do registro numa única chamada.
-- Se qualquer item falhar, a transação inteira (inclusive auditorias) é
-- desfeita; nunca sobra um formulário parcialmente gravado.
create function public.set_custom_field_values(
  p_workspace_id uuid,
  p_record_id uuid,
  p_values jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_item jsonb;
begin
  if jsonb_typeof(p_values) <> 'array' or jsonb_array_length(p_values) > 50 then
    raise exception 'invalid_custom_field_values';
  end if;

  for v_item in select value from jsonb_array_elements(p_values) loop
    perform public.set_custom_field_value(
      p_workspace_id,
      (v_item ->> 'definition_id')::uuid,
      p_record_id,
      v_item ->> 'text_value',
      (v_item ->> 'number_value')::numeric,
      (v_item ->> 'date_value')::date,
      (v_item ->> 'boolean_value')::boolean,
      (v_item ->> 'option_id')::uuid
    );
  end loop;
end;
$body$;

revoke all on function public.list_custom_field_definitions(uuid) from public;
revoke all on function public.create_custom_field_definition(uuid, public.custom_field_entity, text, public.custom_field_type, integer, text[]) from public;
revoke all on function public.update_custom_field_definition(uuid, text, integer, jsonb) from public;
revoke all on function public.archive_custom_field_definition(uuid) from public;
revoke all on function public.get_custom_fields_for_record(uuid, public.custom_field_entity, uuid) from public;
revoke all on function public.set_custom_field_value(uuid, uuid, uuid, text, numeric, date, boolean, uuid) from public, anon, authenticated;
revoke all on function public.set_custom_field_values(uuid, uuid, jsonb) from public;

grant execute on function public.list_custom_field_definitions(uuid) to authenticated;
grant execute on function public.create_custom_field_definition(uuid, public.custom_field_entity, text, public.custom_field_type, integer, text[]) to authenticated;
grant execute on function public.update_custom_field_definition(uuid, text, integer, jsonb) to authenticated;
grant execute on function public.archive_custom_field_definition(uuid) to authenticated;
grant execute on function public.get_custom_fields_for_record(uuid, public.custom_field_entity, uuid) to authenticated;
grant execute on function public.set_custom_field_value(uuid, uuid, uuid, text, numeric, date, boolean, uuid) to authenticated;
grant execute on function public.set_custom_field_values(uuid, uuid, jsonb) to authenticated;
