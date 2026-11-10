-- C4 mínima — campos personalizados: o escritório cria campos próprios e
-- preenche os valores em contatos, leads, oportunidades e clientes, sem mudar o
-- schema a cada campo novo. Migration NOVA e forward-only: três tabelas, funções
-- privadas e as RPCs. Nenhuma função, policy, grant, tabela, enum ou migration
-- existente é alterada.
--
-- Tipos FECHADOS: texto curto, número, data, booleano e seleção única. Nada de
-- texto rico, múltipla seleção, fórmula, arquivo, relacionamento, campo
-- calculado, expressão ou JSON livre.
--
-- Estrutura.
--   * custom_field_definitions: a definição (workspace, entidade, nome, tipo,
--     posição, estado ativo/arquivado). Identificador gerado pelo banco. Entidade
--     e tipo NUNCA mudam depois da criação (trigger). Até 50 definições ATIVAS
--     por workspace e entidade (trigger, sob trava).
--   * custom_field_options: as opções da seleção única. Tabela própria para o
--     banco garantir, por chave estrangeira composta, que a opção escolhida
--     pertence à PRÓPRIA definição. Opção já usada não é removida.
--   * custom_field_values: um valor por definição e registro, em COLUNAS
--     TIPADAS (texto, número, data, booleano, opção), nunca num JSON livre. O
--     banco garante, por chaves estrangeiras compostas e CHECK, que: definição e
--     registro são do mesmo workspace; a definição é daquela entidade; o registro
--     existe; o valor tem a forma do tipo da definição; a opção é da definição.
--
-- Acesso. As três tabelas têm RLS habilitada e FORÇADA, sem policy e sem grant:
-- tudo passa pelas funções abaixo (SECURITY DEFINER, search_path vazio).
--   * Administrar definições: só owner e admin (de qualquer workspace alheio a
--     resposta é "não encontrado").
--   * Ler valores: a permissão de leitura da entidade e o MESMO alcance por
--     registro que a tela da entidade já aplica (advogado só vê leads/oportunidades
--     "seus + sem responsável"; cliente exige alcance a uma negociação).
--   * Editar valores: a permissão de edição da entidade (contatos, leads e
--     oportunidades: todos menos visualizador; clientes: owner, admin e manager),
--     com o mesmo alcance por registro. Campo personalizado nunca amplia acesso.
--   * Gravar vários valores é UMA chamada, portanto UMA transação: ou entram
--     todos ou nenhum.
--
-- Auditoria. Só ids e a ação: definição, entidade e registro. NUNCA o conteúdo
-- do valor, a opção escolhida, texto digitado, valor anterior ou novo.

-- ---------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------

create table public.custom_field_definitions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  entity_type text not null check (entity_type in ('contact', 'lead', 'opportunity', 'client')),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  field_type text not null check (field_type in ('text', 'number', 'date', 'boolean', 'select')),
  position integer not null default 0 check (position between 0 and 1000),
  archived_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Alvos das chaves compostas de opções e valores.
  constraint custom_field_definitions_workspace_id_id_key unique (workspace_id, id),
  constraint custom_field_definitions_workspace_id_id_type_key unique (workspace_id, id, field_type),
  constraint custom_field_definitions_workspace_id_id_shape_key unique (workspace_id, id, entity_type, field_type)
);

-- Nome único entre as definições ATIVAS da entidade (arquivar libera o nome).
create unique index custom_field_definitions_active_name_key
  on public.custom_field_definitions (workspace_id, entity_type, lower(btrim(name)))
  where archived_at is null;

create index custom_field_definitions_list_idx
  on public.custom_field_definitions (workspace_id, entity_type, position, name);

create trigger custom_field_definitions_set_updated_at
  before update on public.custom_field_definitions
  for each row execute function private.set_updated_at();

create table public.custom_field_options (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  definition_id uuid not null,
  -- Só definição do tipo seleção única tem opções (FK composta com este valor fixo).
  field_type text not null default 'select' check (field_type = 'select'),
  label text not null check (char_length(btrim(label)) between 1 and 80),
  position integer not null default 0 check (position between 0 and 1000),
  created_at timestamptz not null default now(),
  constraint custom_field_options_definition_fkey
    foreign key (workspace_id, definition_id, field_type)
    references public.custom_field_definitions (workspace_id, id, field_type) on delete cascade,
  -- Alvo da chave composta dos valores: a opção é da PRÓPRIA definição.
  constraint custom_field_options_workspace_definition_id_key unique (workspace_id, definition_id, id)
);

create unique index custom_field_options_label_key
  on public.custom_field_options (definition_id, lower(btrim(label)));

create table public.custom_field_values (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  definition_id uuid not null,
  -- Cópias da definição, presas por FK composta: nunca divergem dela.
  entity_type text not null,
  field_type text not null,
  -- Exatamente UM registro, na coluna da entidade (CHECK abaixo).
  contact_id uuid,
  lead_id uuid,
  opportunity_id uuid,
  client_id uuid,
  -- Exatamente UMA coluna de valor, a do tipo (CHECK abaixo). Nula = campo limpo.
  value_text text check (value_text is null or char_length(value_text) between 1 and 500),
  value_number numeric(18, 4),
  value_date date check (value_date is null or value_date between date '1900-01-01' and date '2200-12-31'),
  value_boolean boolean,
  option_id uuid,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint custom_field_values_definition_fkey
    foreign key (workspace_id, definition_id, entity_type, field_type)
    references public.custom_field_definitions (workspace_id, id, entity_type, field_type) on delete restrict,
  constraint custom_field_values_option_fkey
    foreign key (workspace_id, definition_id, option_id)
    references public.custom_field_options (workspace_id, definition_id, id) on delete restrict,
  constraint custom_field_values_contact_fkey
    foreign key (workspace_id, contact_id) references public.contacts (workspace_id, id) on delete cascade,
  constraint custom_field_values_lead_fkey
    foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade,
  constraint custom_field_values_opportunity_fkey
    foreign key (workspace_id, opportunity_id) references public.opportunities (workspace_id, id) on delete cascade,
  constraint custom_field_values_client_fkey
    foreign key (workspace_id, client_id) references public.clients (workspace_id, id) on delete cascade,
  constraint custom_field_values_record_shape check (
    (entity_type = 'contact' and contact_id is not null and lead_id is null and opportunity_id is null and client_id is null) or
    (entity_type = 'lead' and lead_id is not null and contact_id is null and opportunity_id is null and client_id is null) or
    (entity_type = 'opportunity' and opportunity_id is not null and contact_id is null and lead_id is null and client_id is null) or
    (entity_type = 'client' and client_id is not null and contact_id is null and lead_id is null and opportunity_id is null)
  ),
  constraint custom_field_values_value_shape check (
    (field_type = 'text' and value_number is null and value_date is null and value_boolean is null and option_id is null) or
    (field_type = 'number' and value_text is null and value_date is null and value_boolean is null and option_id is null) or
    (field_type = 'date' and value_text is null and value_number is null and value_boolean is null and option_id is null) or
    (field_type = 'boolean' and value_text is null and value_number is null and value_date is null and option_id is null) or
    (field_type = 'select' and value_text is null and value_number is null and value_date is null and value_boolean is null)
  )
);

-- No máximo UM valor por definição e registro.
create unique index custom_field_values_contact_key on public.custom_field_values (definition_id, contact_id) where contact_id is not null;
create unique index custom_field_values_lead_key on public.custom_field_values (definition_id, lead_id) where lead_id is not null;
create unique index custom_field_values_opportunity_key on public.custom_field_values (definition_id, opportunity_id) where opportunity_id is not null;
create unique index custom_field_values_client_key on public.custom_field_values (definition_id, client_id) where client_id is not null;
create index custom_field_values_option_idx on public.custom_field_values (option_id) where option_id is not null;

create trigger custom_field_values_set_updated_at
  before update on public.custom_field_values
  for each row execute function private.set_updated_at();

alter table public.custom_field_definitions enable row level security;
alter table public.custom_field_definitions force row level security;
revoke all on table public.custom_field_definitions from public, anon, authenticated;

alter table public.custom_field_options enable row level security;
alter table public.custom_field_options force row level security;
revoke all on table public.custom_field_options from public, anon, authenticated;

alter table public.custom_field_values enable row level security;
alter table public.custom_field_values force row level security;
revoke all on table public.custom_field_values from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Regras no banco: entidade e tipo imutáveis; limite de 50 ativos
-- ---------------------------------------------------------------------

create function private.custom_field_definition_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $body$
begin
  if new.id is distinct from old.id
     or new.workspace_id is distinct from old.workspace_id
     or new.entity_type is distinct from old.entity_type
     or new.field_type is distinct from old.field_type then
    raise exception 'custom_field_immutable';
  end if;
  return new;
end;
$body$;

create trigger custom_field_definitions_immutable
  before update on public.custom_field_definitions
  for each row execute function private.custom_field_definition_immutable();

create function private.custom_field_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $body$
begin
  if new.archived_at is not null then
    return new;
  end if;
  -- Serializa criações/restaurações simultâneas da mesma entidade no workspace.
  perform pg_advisory_xact_lock(hashtextextended('custom_field_limit:' || new.workspace_id::text || ':' || new.entity_type, 0));
  if (
    select count(*) from public.custom_field_definitions d
    where d.workspace_id = new.workspace_id and d.entity_type = new.entity_type
      and d.archived_at is null and d.id <> new.id
  ) >= 50 then
    raise exception 'custom_field_limit_reached';
  end if;
  return new;
end;
$body$;

create trigger custom_field_definitions_limit
  before insert or update of archived_at on public.custom_field_definitions
  for each row execute function private.custom_field_limit();

revoke all on function private.custom_field_definition_immutable() from public, anon, authenticated;
revoke all on function private.custom_field_limit() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Funções privadas
-- ---------------------------------------------------------------------

-- Alcance do registro: devolve o workspace do registro, ou recusa. É a ÚNICA
-- porta de leitura e escrita de valores, e repete o que a tela de cada entidade
-- já aplica: workspace alheio e registro fora do alcance respondem "não
-- encontrado"; papel sem a permissão de edição responde "sem permissão".
create function private.custom_field_record_scope(p_entity_type text, p_record_id uuid, p_write boolean)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_workspace_id uuid;
  v_assigned uuid;
  v_role public.membership_role;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if p_entity_type = 'contact' then
    select c.workspace_id into v_workspace_id from public.contacts c
    where c.id = p_record_id and c.merged_into_contact_id is null;
  elsif p_entity_type = 'lead' then
    select l.workspace_id, l.assigned_to into v_workspace_id, v_assigned from public.leads l where l.id = p_record_id;
  elsif p_entity_type = 'opportunity' then
    select o.workspace_id, l.assigned_to into v_workspace_id, v_assigned
    from public.opportunities o join public.leads l on l.id = o.lead_id
    where o.id = p_record_id;
  elsif p_entity_type = 'client' then
    select c.workspace_id into v_workspace_id from public.clients c where c.id = p_record_id;
  else
    raise exception 'custom_field_invalid_entity';
  end if;

  if v_workspace_id is null then
    raise exception 'custom_field_record_not_found';
  end if;

  select m.role into v_role from public.memberships m
  where m.workspace_id = v_workspace_id and m.user_id = v_actor and m.status = 'active';
  if v_role is null then
    raise exception 'custom_field_record_not_found';
  end if;

  -- Alcance por registro (igual ao de get_lead / get_opportunity / get_client).
  if p_entity_type in ('lead', 'opportunity')
     and not private.lead_accessible_to_role(v_role, v_assigned, v_actor) then
    raise exception 'custom_field_record_not_found';
  end if;
  if p_entity_type = 'client' and v_role not in ('owner', 'admin', 'manager') then
    if not coalesce((
      select bool_or(private.lead_accessible_to_role(v_role, l.assigned_to, v_actor))
      from public.client_handoffs ch
      join public.opportunities o on o.id = ch.opportunity_id
      join public.leads l on l.id = o.lead_id
      where ch.client_id = p_record_id
    ), false) then
      raise exception 'custom_field_record_not_found';
    end if;
  end if;

  -- Edição: a permissão de edição da entidade.
  if p_write then
    if p_entity_type = 'client' then
      if v_role not in ('owner', 'admin', 'manager') then
        raise exception 'insufficient_permission';
      end if;
    elsif v_role not in ('owner', 'admin', 'manager', 'lawyer', 'sales') then
      raise exception 'insufficient_permission';
    end if;
  end if;

  return v_workspace_id;
end;
$body$;

-- Definição para administrar: trava a linha; membro sem papel de gestão recebe
-- "sem permissão"; quem nem é membro (ou definição inexistente) recebe "não encontrado".
create function private.custom_field_definition_for_admin(p_definition_id uuid)
returns public.custom_field_definitions
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_def public.custom_field_definitions;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_def from public.custom_field_definitions where id = p_definition_id;
  if v_def.id is null then
    raise exception 'custom_field_not_found';
  end if;

  if not private.has_workspace_role(v_def.workspace_id, array['owner', 'admin']::public.membership_role[]) then
    if exists (
      select 1 from public.memberships m
      where m.workspace_id = v_def.workspace_id and m.user_id = v_actor and m.status = 'active'
    ) then
      raise exception 'insufficient_permission';
    end if;
    raise exception 'custom_field_not_found';
  end if;

  select * into v_def from public.custom_field_definitions where id = p_definition_id for update;
  return v_def;
end;
$body$;

-- Valida e normaliza a lista de opções ([{"id"?: uuid, "label": texto}]). Devolve
-- jsonb [{"id": uuid|null, "label": texto}] na ordem recebida.
create function private.custom_field_normalize_options(p_options jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $body$
declare
  v_item jsonb;
  v_out jsonb := '[]'::jsonb;
  v_label text;
  v_id uuid;
  v_labels text[] := '{}';
  v_ids uuid[] := '{}';
begin
  if p_options is null or jsonb_typeof(p_options) <> 'array'
     or jsonb_array_length(p_options) not between 1 and 30 then
    raise exception 'custom_field_invalid_options';
  end if;

  for v_item in select value from jsonb_array_elements(p_options) loop
    if jsonb_typeof(v_item) <> 'object'
       or exists (select 1 from jsonb_object_keys(v_item) k where k not in ('id', 'label'))
       or jsonb_typeof(v_item -> 'label') is distinct from 'string' then
      raise exception 'custom_field_invalid_options';
    end if;

    v_label := btrim(v_item ->> 'label');
    if char_length(v_label) not between 1 and 80 or lower(v_label) = any (v_labels) then
      raise exception 'custom_field_invalid_options';
    end if;
    v_labels := v_labels || lower(v_label);

    v_id := null;
    if v_item ? 'id' and jsonb_typeof(v_item -> 'id') <> 'null' then
      if jsonb_typeof(v_item -> 'id') <> 'string' then
        raise exception 'custom_field_invalid_options';
      end if;
      begin
        v_id := (v_item ->> 'id')::uuid;
      exception when invalid_text_representation then
        raise exception 'custom_field_invalid_options';
      end;
      if v_id = any (v_ids) then
        raise exception 'custom_field_invalid_options';
      end if;
      v_ids := v_ids || v_id;
    end if;

    v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_id, 'label', v_label));
  end loop;

  return v_out;
end;
$body$;

revoke all on function private.custom_field_record_scope(text, uuid, boolean) from public, anon, authenticated;
revoke all on function private.custom_field_definition_for_admin(uuid) from public, anon, authenticated;
revoke all on function private.custom_field_normalize_options(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Administrar definições (owner e admin)
-- ---------------------------------------------------------------------

create function public.create_custom_field(
  p_workspace_id uuid,
  p_entity_type text,
  p_name text,
  p_field_type text,
  p_position integer default null,
  p_options jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_id uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_position integer;
  v_options jsonb;
  v_item jsonb;
  v_index integer := 0;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if not private.has_workspace_role(p_workspace_id, array['owner', 'admin']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  if p_entity_type is null or p_entity_type not in ('contact', 'lead', 'opportunity', 'client') then
    raise exception 'custom_field_invalid_entity';
  end if;
  if p_field_type is null or p_field_type not in ('text', 'number', 'date', 'boolean', 'select') then
    raise exception 'custom_field_invalid_type';
  end if;
  if char_length(v_name) not between 1 and 80 then
    raise exception 'custom_field_invalid_name';
  end if;
  if p_position is not null and p_position not between 0 and 1000 then
    raise exception 'custom_field_invalid_position';
  end if;

  if p_field_type = 'select' then
    v_options := private.custom_field_normalize_options(p_options);
    -- Opção nova não pode trazer id.
    if exists (select 1 from jsonb_array_elements(v_options) o where o ->> 'id' is not null) then
      raise exception 'custom_field_invalid_options';
    end if;
  elsif p_options is not null and p_options <> '[]'::jsonb and p_options <> 'null'::jsonb then
    raise exception 'custom_field_invalid_options';
  end if;

  v_position := coalesce(
    p_position,
    (select least(coalesce(max(d.position), -1) + 1, 1000)
       from public.custom_field_definitions d
       where d.workspace_id = p_workspace_id and d.entity_type = p_entity_type)
  );

  begin
    insert into public.custom_field_definitions (workspace_id, entity_type, name, field_type, position, created_by)
    values (p_workspace_id, p_entity_type, v_name, p_field_type, v_position, v_actor)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'custom_field_name_taken';
  end;

  if p_field_type = 'select' then
    for v_item in select value from jsonb_array_elements(v_options) loop
      insert into public.custom_field_options (workspace_id, definition_id, label, position)
      values (p_workspace_id, v_id, v_item ->> 'label', v_index);
      v_index := v_index + 1;
    end loop;
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (p_workspace_id, v_actor, 'custom_field.created', 'custom_field_definition', v_id,
          jsonb_build_object('entity_type', p_entity_type));

  return v_id;
end;
$body$;

-- Nome, posição e opções permitidas. Entidade e tipo não mudam. Opção que já tem
-- valor NÃO sai da lista: a chamada é recusada, nunca remove em silêncio.
create function public.update_custom_field(
  p_definition_id uuid,
  p_name text,
  p_position integer default null,
  p_options jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_def public.custom_field_definitions;
  v_name text := btrim(coalesce(p_name, ''));
  v_options jsonb;
  v_item jsonb;
  v_existing public.custom_field_options;
  v_index integer := 0;
  v_changed boolean := false;
  v_kept uuid[] := '{}';
  v_item_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  v_def := private.custom_field_definition_for_admin(p_definition_id);

  if v_def.archived_at is not null then
    raise exception 'custom_field_archived';
  end if;
  if char_length(v_name) not between 1 and 80 then
    raise exception 'custom_field_invalid_name';
  end if;
  if p_position is not null and p_position not between 0 and 1000 then
    raise exception 'custom_field_invalid_position';
  end if;

  if p_options is not null and p_options <> 'null'::jsonb then
    if v_def.field_type <> 'select' then
      raise exception 'custom_field_invalid_options';
    end if;
    v_options := private.custom_field_normalize_options(p_options);

    -- Toda opção citada com id precisa ser desta definição.
    for v_item in select value from jsonb_array_elements(v_options) loop
      v_item_id := nullif(v_item ->> 'id', '')::uuid;
      if v_item_id is not null then
        if not exists (select 1 from public.custom_field_options o where o.id = v_item_id and o.definition_id = v_def.id) then
          raise exception 'custom_field_invalid_options';
        end if;
        v_kept := v_kept || v_item_id;
      end if;
    end loop;

    begin
    -- Opção que sairia da lista: só se ninguém a usa.
    for v_existing in
      select * from public.custom_field_options o where o.definition_id = v_def.id and o.id <> all (v_kept) for update
    loop
      if exists (select 1 from public.custom_field_values v where v.option_id = v_existing.id) then
        raise exception 'custom_field_option_in_use';
      end if;
      delete from public.custom_field_options where id = v_existing.id;
      v_changed := true;
    end loop;

    for v_item in select value from jsonb_array_elements(v_options) loop
      v_item_id := nullif(v_item ->> 'id', '')::uuid;
      if v_item_id is null then
        insert into public.custom_field_options (workspace_id, definition_id, label, position)
        values (v_def.workspace_id, v_def.id, v_item ->> 'label', v_index);
        v_changed := true;
      else
        update public.custom_field_options o
          set label = v_item ->> 'label', position = v_index
          where o.id = v_item_id
            and (o.label is distinct from v_item ->> 'label' or o.position is distinct from v_index);
        if found then
          v_changed := true;
        end if;
      end if;
      v_index := v_index + 1;
    end loop;
    exception when unique_violation then
      -- Rótulo repetido depois das trocas (ex.: dois rótulos trocados de lugar).
      raise exception 'custom_field_invalid_options';
    end;
  end if;

  if v_def.name is distinct from v_name or (p_position is not null and v_def.position is distinct from p_position) then
    begin
      update public.custom_field_definitions
        set name = v_name, position = coalesce(p_position, position)
        where id = v_def.id;
    exception when unique_violation then
      raise exception 'custom_field_name_taken';
    end;
    v_changed := true;
  end if;

  if v_changed then
    insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
    values (v_def.workspace_id, v_actor, 'custom_field.updated', 'custom_field_definition', v_def.id,
            jsonb_build_object('entity_type', v_def.entity_type));
  end if;
end;
$body$;

-- Arquivar preserva TODOS os valores; o campo só deixa de aparecer nos
-- formulários ativos. Restaurar volta a oferecê-lo (respeita o limite e o nome).
create function public.set_custom_field_archived(p_definition_id uuid, p_archived boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_def public.custom_field_definitions;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;
  if p_archived is null then
    raise exception 'custom_field_invalid_type';
  end if;

  v_def := private.custom_field_definition_for_admin(p_definition_id);

  if p_archived then
    if v_def.archived_at is not null then
      return;
    end if;
    update public.custom_field_definitions set archived_at = now() where id = v_def.id;
    insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
    values (v_def.workspace_id, v_actor, 'custom_field.archived', 'custom_field_definition', v_def.id,
            jsonb_build_object('entity_type', v_def.entity_type));
  else
    if v_def.archived_at is null then
      return;
    end if;
    begin
      update public.custom_field_definitions set archived_at = null where id = v_def.id;
    exception when unique_violation then
      raise exception 'custom_field_name_taken';
    end;
    insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
    values (v_def.workspace_id, v_actor, 'custom_field.restored', 'custom_field_definition', v_def.id,
            jsonb_build_object('entity_type', v_def.entity_type));
  end if;
end;
$body$;

-- Lista para a tela de administração (inclui arquivadas), com as opções e se
-- cada uma já tem valor. Só owner e admin; nunca devolve valor de registro.
create function public.list_custom_field_definitions(p_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $body$
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  if not private.has_workspace_role(p_workspace_id, array['owner', 'admin']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', d.id,
        'entity_type', d.entity_type,
        'name', d.name,
        'field_type', d.field_type,
        'position', d.position,
        'archived', d.archived_at is not null,
        'options', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id', o.id,
              'label', o.label,
              'in_use', exists (select 1 from public.custom_field_values v where v.option_id = o.id)
            )
            order by o.position, o.label, o.id
          )
          from public.custom_field_options o
          where o.definition_id = d.id
        ), '[]'::jsonb)
      )
      order by d.entity_type, d.archived_at is not null, d.position, d.name, d.id
    )
    from public.custom_field_definitions d
    where d.workspace_id = p_workspace_id
  ), '[]'::jsonb);
end;
$body$;

-- ---------------------------------------------------------------------
-- Valores (permissão e alcance da entidade)
-- ---------------------------------------------------------------------

-- Campos ATIVOS da entidade no workspace do registro, com o valor atual (ou null).
-- select -> id da opção; data -> 'AAAA-MM-DD'. Arquivadas não aparecem.
create function public.get_custom_field_values(p_entity_type text, p_record_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_workspace_id uuid;
begin
  v_workspace_id := private.custom_field_record_scope(p_entity_type, p_record_id, false);

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'definition_id', d.id,
        'name', d.name,
        'field_type', d.field_type,
        'position', d.position,
        'options', coalesce((
          select jsonb_agg(jsonb_build_object('id', o.id, 'label', o.label) order by o.position, o.label, o.id)
          from public.custom_field_options o
          where o.definition_id = d.id
        ), '[]'::jsonb),
        'value', coalesce(
          case d.field_type
            when 'text' then to_jsonb(v.value_text)
            when 'number' then to_jsonb(v.value_number)
            when 'date' then to_jsonb(to_char(v.value_date, 'YYYY-MM-DD'))
            when 'boolean' then to_jsonb(v.value_boolean)
            else to_jsonb(v.option_id::text)
          end,
          'null'::jsonb
        )
      )
      order by d.position, d.name, d.id
    )
    from public.custom_field_definitions d
    left join public.custom_field_values v
      on v.definition_id = d.id
     and (v.contact_id = p_record_id or v.lead_id = p_record_id or v.opportunity_id = p_record_id or v.client_id = p_record_id)
    where d.workspace_id = v_workspace_id and d.entity_type = p_entity_type and d.archived_at is null
  ), '[]'::jsonb);
end;
$body$;

-- Grava vários valores de UM registro numa só transação: qualquer item inválido
-- desfaz a chamada inteira (nada parcial). p_values = [{"definition_id": uuid,
-- "value": <escalar|null>}]. null (ou texto vazio) limpa o campo. Devolve quantos
-- valores mudaram de fato; valor igual ao atual não grava nem audita.
create function public.set_custom_field_values(p_entity_type text, p_record_id uuid, p_values jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_workspace_id uuid;
  v_item jsonb;
  v_def public.custom_field_definitions;
  v_existing public.custom_field_values;
  v_def_id uuid;
  v_seen uuid[] := '{}';
  v_raw jsonb;
  v_kind text;
  v_text text;
  v_number numeric;
  v_date date;
  v_bool boolean;
  v_option uuid;
  v_changed integer := 0;
  v_value_id uuid;
  v_found boolean;
begin
  v_workspace_id := private.custom_field_record_scope(p_entity_type, p_record_id, true);

  if p_values is null or jsonb_typeof(p_values) <> 'array' or jsonb_array_length(p_values) > 50 then
    raise exception 'custom_field_invalid_value';
  end if;

  -- Gravações simultâneas do mesmo registro andam em fila.
  perform pg_advisory_xact_lock(hashtextextended('custom_field_values:' || p_record_id::text, 0));

  for v_item in select value from jsonb_array_elements(p_values) loop
    if jsonb_typeof(v_item) <> 'object'
       or exists (select 1 from jsonb_object_keys(v_item) k where k not in ('definition_id', 'value'))
       or not (v_item ? 'definition_id' and v_item ? 'value')
       or jsonb_typeof(v_item -> 'definition_id') <> 'string' then
      raise exception 'custom_field_invalid_value';
    end if;

    begin
      v_def_id := (v_item ->> 'definition_id')::uuid;
    exception when invalid_text_representation then
      raise exception 'custom_field_invalid_value';
    end;
    if v_def_id = any (v_seen) then
      raise exception 'custom_field_invalid_value';
    end if;
    v_seen := v_seen || v_def_id;

    -- A definição precisa ser do MESMO workspace e DESTA entidade (outra entidade
    -- ou outro workspace respondem como inexistentes).
    select * into v_def from public.custom_field_definitions d
    where d.id = v_def_id and d.workspace_id = v_workspace_id and d.entity_type = p_entity_type;
    if v_def.id is null then
      raise exception 'custom_field_not_found';
    end if;
    if v_def.archived_at is not null then
      raise exception 'custom_field_archived';
    end if;

    v_raw := v_item -> 'value';
    v_kind := jsonb_typeof(v_raw);
    v_text := null; v_number := null; v_date := null; v_bool := null; v_option := null;

    if v_kind <> 'null' then
      if v_def.field_type = 'text' then
        if v_kind <> 'string' then raise exception 'custom_field_invalid_value'; end if;
        v_text := nullif(btrim(v_raw #>> '{}'), '');
        if v_text is not null and char_length(v_text) > 500 then
          raise exception 'custom_field_invalid_value';
        end if;
      elsif v_def.field_type = 'number' then
        if v_kind <> 'number' then raise exception 'custom_field_invalid_value'; end if;
        v_number := (v_raw #>> '{}')::numeric;
        if abs(v_number) >= 100000000000000 or scale(v_number) > 4 then
          raise exception 'custom_field_invalid_value';
        end if;
      elsif v_def.field_type = 'date' then
        if v_kind <> 'string' then raise exception 'custom_field_invalid_value'; end if;
        if (v_raw #>> '{}') = '' then
          v_date := null;
        else
          if (v_raw #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'custom_field_invalid_value'; end if;
          begin
            v_date := (v_raw #>> '{}')::date;
          exception when others then
            raise exception 'custom_field_invalid_value';
          end;
          if v_date not between date '1900-01-01' and date '2200-12-31' then
            raise exception 'custom_field_invalid_value';
          end if;
        end if;
      elsif v_def.field_type = 'boolean' then
        if v_kind <> 'boolean' then raise exception 'custom_field_invalid_value'; end if;
        v_bool := (v_raw #>> '{}')::boolean;
      else
        if v_kind <> 'string' then raise exception 'custom_field_invalid_value'; end if;
        if (v_raw #>> '{}') <> '' then
          begin
            v_option := (v_raw #>> '{}')::uuid;
          exception when invalid_text_representation then
            raise exception 'custom_field_invalid_option';
          end;
          -- A opção precisa ser da PRÓPRIA definição.
          if not exists (select 1 from public.custom_field_options o where o.id = v_option and o.definition_id = v_def.id) then
            raise exception 'custom_field_invalid_option';
          end if;
        end if;
      end if;
    end if;

    select * into v_existing from public.custom_field_values v
    where v.definition_id = v_def.id
      and (v.contact_id = p_record_id or v.lead_id = p_record_id or v.opportunity_id = p_record_id or v.client_id = p_record_id);
    v_found := v_existing.id is not null;

    if not v_found then
      -- Campo ainda sem valor e nada a gravar: não cria linha vazia.
      continue when v_text is null and v_number is null and v_date is null and v_bool is null and v_option is null;

      insert into public.custom_field_values (
        workspace_id, definition_id, entity_type, field_type,
        contact_id, lead_id, opportunity_id, client_id,
        value_text, value_number, value_date, value_boolean, option_id, updated_by
      )
      values (
        v_workspace_id, v_def.id, v_def.entity_type, v_def.field_type,
        case when p_entity_type = 'contact' then p_record_id end,
        case when p_entity_type = 'lead' then p_record_id end,
        case when p_entity_type = 'opportunity' then p_record_id end,
        case when p_entity_type = 'client' then p_record_id end,
        v_text, v_number, v_date, v_bool, v_option, v_actor
      )
      returning id into v_value_id;
    else
      continue when (v_existing.value_text, v_existing.value_number, v_existing.value_date, v_existing.value_boolean, v_existing.option_id)
        is not distinct from (v_text, v_number, v_date, v_bool, v_option);

      update public.custom_field_values
        set value_text = v_text, value_number = v_number, value_date = v_date,
            value_boolean = v_bool, option_id = v_option, updated_by = v_actor
        where id = v_existing.id
        returning id into v_value_id;
    end if;

    -- Auditoria: só ids. Nunca o valor, a opção, o texto nem o valor anterior.
    insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
    values (v_workspace_id, v_actor, 'custom_field.value_set', 'custom_field_value', v_value_id,
            jsonb_build_object('definition_id', v_def.id, 'entity_type', p_entity_type, 'record_id', p_record_id));
    v_changed := v_changed + 1;
  end loop;

  return v_changed;
end;
$body$;

revoke all on function public.create_custom_field(uuid, text, text, text, integer, jsonb) from public, anon;
grant execute on function public.create_custom_field(uuid, text, text, text, integer, jsonb) to authenticated;

revoke all on function public.update_custom_field(uuid, text, integer, jsonb) from public, anon;
grant execute on function public.update_custom_field(uuid, text, integer, jsonb) to authenticated;

revoke all on function public.set_custom_field_archived(uuid, boolean) from public, anon;
grant execute on function public.set_custom_field_archived(uuid, boolean) to authenticated;

revoke all on function public.list_custom_field_definitions(uuid) from public, anon;
grant execute on function public.list_custom_field_definitions(uuid) to authenticated;

revoke all on function public.get_custom_field_values(text, uuid) from public, anon;
grant execute on function public.get_custom_field_values(text, uuid) to authenticated;

revoke all on function public.set_custom_field_values(text, uuid, jsonb) from public, anon;
grant execute on function public.set_custom_field_values(text, uuid, jsonb) to authenticated;
