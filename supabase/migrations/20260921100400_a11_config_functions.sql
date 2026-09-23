-- A11 — configuração dos endpoints de formulário (owner/admin).
--
-- Nenhuma delas confia na interface: cada uma revalida papel e coerência
-- de pipeline/etapa por dentro, como em todas as fases anteriores.
--
-- Validação de destino (contrato §4), repetida na criação, na edição E no
-- processamento: pipeline do workspace, etapa do MESMO pipeline, etapa
-- não terminal (is_won = false e is_lost = false). `pipelines.is_default`
-- nunca é resolvido aqui — a interface pode pré-selecionar, o endpoint
-- persiste o ID explícito.

create function private.assert_form_endpoint_destination(
  p_workspace_id uuid,
  p_pipeline_id uuid,
  p_stage_id uuid
)
returns void
language plpgsql
stable
set search_path = ''
as $body$
declare
  v_stage public.pipeline_stages;
begin
  if not exists (
    select 1 from public.pipelines
    where id = p_pipeline_id and workspace_id = p_workspace_id
  ) then
    raise exception 'pipeline_not_found';
  end if;

  select * into v_stage from public.pipeline_stages
  where id = p_stage_id and pipeline_id = p_pipeline_id;

  if v_stage.id is null then
    raise exception 'stage_not_in_pipeline';
  end if;

  if v_stage.is_won or v_stage.is_lost then
    raise exception 'stage_is_terminal';
  end if;
end;
$body$;

revoke all on function private.assert_form_endpoint_destination(uuid, uuid, uuid) from public;

-- ---------------------------------------------------------------------
-- private.assert_answers_config — valida de verdade a lista de campos
--
-- O CHECK da tabela (jsonb_typeof(... -> 'fields') = 'array') só garante
-- a forma mínima. Sem isto, `answers_config` era decorativo: qualquer
-- JSON era aceito, a borda não tinha como saber quais campos existem e o
-- worker não tinha o que revalidar. Mesmo conjunto de regras aplicado na
-- borda (Zod, src/modules/forms/schema.ts) — aqui é o backstop do banco,
-- para que a validação nunca dependa só da aplicação.
-- ---------------------------------------------------------------------

create function private.assert_answers_config(p_config jsonb)
returns void
language plpgsql
stable
set search_path = ''
as $body$
declare
  v_field jsonb;
  v_key text;
  v_type text;
  v_keys text[] := array[]::text[];
begin
  if jsonb_typeof(p_config -> 'fields') is distinct from 'array' then
    raise exception 'answers_config_invalid: fields must be an array';
  end if;

  if jsonb_array_length(p_config -> 'fields') > 30 then
    raise exception 'answers_config_invalid: too many fields';
  end if;

  for v_field in select * from jsonb_array_elements(p_config -> 'fields')
  loop
    if jsonb_typeof(v_field) <> 'object' then
      raise exception 'answers_config_invalid: field must be an object';
    end if;

    v_key := v_field ->> 'key';
    v_type := v_field ->> 'type';

    if v_key is null or v_key !~ '^[a-z0-9_]{1,60}$' then
      raise exception 'answers_config_invalid: bad key %', coalesce(v_key, '<null>');
    end if;
    if v_key = any(v_keys) then
      raise exception 'answers_config_invalid: duplicate key %', v_key;
    end if;
    v_keys := v_keys || v_key;

    if nullif(btrim(coalesce(v_field ->> 'label', '')), '') is null
       or char_length(v_field ->> 'label') > 160 then
      raise exception 'answers_config_invalid: bad label for %', v_key;
    end if;

    if v_type is null or v_type not in ('text', 'boolean', 'number') then
      raise exception 'answers_config_invalid: bad type for %', v_key;
    end if;

    if v_field ? 'required' and jsonb_typeof(v_field -> 'required') <> 'boolean' then
      raise exception 'answers_config_invalid: required must be boolean for %', v_key;
    end if;

    if v_field ? 'maxLength' then
      if v_type <> 'text' then
        raise exception 'answers_config_invalid: maxLength only applies to text (%)', v_key;
      end if;
      if jsonb_typeof(v_field -> 'maxLength') <> 'number'
         or (v_field ->> 'maxLength')::numeric < 1
         or (v_field ->> 'maxLength')::numeric > 2000 then
        raise exception 'answers_config_invalid: bad maxLength for %', v_key;
      end if;
    end if;
  end loop;
end;
$body$;

revoke all on function private.assert_answers_config(jsonb) from public;

-- ---------------------------------------------------------------------
-- create_form_endpoint
-- ---------------------------------------------------------------------

create function public.create_form_endpoint(
  p_workspace_id uuid,
  p_name text,
  p_pipeline_id uuid,
  p_stage_id uuid,
  p_legal_area text,
  p_initial_activity_type public.activity_type,
  p_initial_activity_due_minutes integer,
  p_capture_mode public.form_capture_mode,
  p_turnstile_action text,
  p_allowed_hostnames text[],
  p_public_key text,
  p_answers_config jsonb default '{"fields": []}'::jsonb,
  p_contract_version integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_endpoint public.form_endpoints;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  -- Configuração de endpoint é restrita a owner/admin (contrato §14) —
  -- mais estrito que pipeline.configure, porque abre uma porta PÚBLICA.
  if not private.has_workspace_role(
    p_workspace_id, array['owner', 'admin']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  perform private.assert_form_endpoint_destination(p_workspace_id, p_pipeline_id, p_stage_id);
  perform private.assert_answers_config(coalesce(p_answers_config, '{"fields": []}'::jsonb));

  insert into public.form_endpoints (
    workspace_id, name, pipeline_id, stage_id, legal_area,
    initial_activity_type, initial_activity_due_minutes, capture_mode,
    contract_version, answers_config, turnstile_action, allowed_hostnames,
    created_by
  )
  values (
    p_workspace_id, btrim(p_name), p_pipeline_id, p_stage_id, btrim(p_legal_area),
    p_initial_activity_type, p_initial_activity_due_minutes, p_capture_mode,
    p_contract_version, coalesce(p_answers_config, '{"fields": []}'::jsonb),
    btrim(p_turnstile_action), p_allowed_hostnames,
    v_actor
  )
  returning * into v_endpoint;

  insert into public.form_endpoint_keys (workspace_id, form_endpoint_id, public_key, created_by)
  values (p_workspace_id, v_endpoint.id, p_public_key, v_actor);

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    p_workspace_id, v_actor, 'form_endpoint.created', 'form_endpoint', v_endpoint.id,
    jsonb_build_object('capture_mode', p_capture_mode, 'pipeline_id', p_pipeline_id, 'stage_id', p_stage_id)
  );

  return jsonb_build_object('id', v_endpoint.id, 'status', v_endpoint.status);
end;
$body$;

-- ---------------------------------------------------------------------
-- update_form_endpoint
-- ---------------------------------------------------------------------

create function public.update_form_endpoint(
  p_form_endpoint_id uuid,
  p_name text,
  p_pipeline_id uuid,
  p_stage_id uuid,
  p_legal_area text,
  p_initial_activity_type public.activity_type,
  p_initial_activity_due_minutes integer,
  p_capture_mode public.form_capture_mode,
  p_turnstile_action text,
  p_allowed_hostnames text[],
  p_answers_config jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_endpoint public.form_endpoints;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_endpoint from public.form_endpoints where id = p_form_endpoint_id for update;
  if v_endpoint.id is null then
    raise exception 'form_endpoint_not_found';
  end if;

  if not private.has_workspace_role(
    v_endpoint.workspace_id, array['owner', 'admin']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  perform private.assert_form_endpoint_destination(v_endpoint.workspace_id, p_pipeline_id, p_stage_id);
  if p_answers_config is not null then
    perform private.assert_answers_config(p_answers_config);
  end if;

  update public.form_endpoints set
    name = btrim(p_name),
    pipeline_id = p_pipeline_id,
    stage_id = p_stage_id,
    legal_area = btrim(p_legal_area),
    initial_activity_type = p_initial_activity_type,
    initial_activity_due_minutes = p_initial_activity_due_minutes,
    capture_mode = p_capture_mode,
    turnstile_action = btrim(p_turnstile_action),
    allowed_hostnames = p_allowed_hostnames,
    answers_config = coalesce(p_answers_config, answers_config),
    updated_at = now()
  where id = p_form_endpoint_id
  returning * into v_endpoint;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_endpoint.workspace_id, v_actor, 'form_endpoint.updated', 'form_endpoint', v_endpoint.id,
    jsonb_build_object('capture_mode', p_capture_mode, 'pipeline_id', p_pipeline_id, 'stage_id', p_stage_id)
  );

  return jsonb_build_object('id', v_endpoint.id, 'status', v_endpoint.status);
end;
$body$;

-- ---------------------------------------------------------------------
-- set_form_endpoint_status — desativar/reativar
--
-- Desativar NÃO apaga nem altera nenhum evento já recebido: só derruba a
-- captação nova (contrato §4).
-- ---------------------------------------------------------------------

create function public.set_form_endpoint_status(
  p_form_endpoint_id uuid,
  p_status public.form_endpoint_status
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_endpoint public.form_endpoints;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_endpoint from public.form_endpoints where id = p_form_endpoint_id for update;
  if v_endpoint.id is null then
    raise exception 'form_endpoint_not_found';
  end if;

  if not private.has_workspace_role(
    v_endpoint.workspace_id, array['owner', 'admin']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  if v_endpoint.status = p_status then
    return jsonb_build_object('id', v_endpoint.id, 'status', v_endpoint.status);
  end if;

  update public.form_endpoints set
    status = p_status,
    disabled_at = case when p_status = 'disabled' then now() else null end,
    disabled_by = case when p_status = 'disabled' then v_actor else null end,
    updated_at = now()
  where id = p_form_endpoint_id
  returning * into v_endpoint;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_endpoint.workspace_id, v_actor,
    case when p_status = 'disabled' then 'form_endpoint.disabled' else 'form_endpoint.enabled' end,
    'form_endpoint', v_endpoint.id, '{}'::jsonb
  );

  return jsonb_build_object('id', v_endpoint.id, 'status', v_endpoint.status);
end;
$body$;

-- ---------------------------------------------------------------------
-- rotate_form_endpoint_key — chave nova, chave anterior REVOGADA
--
-- A chave anterior continua existindo (histórico), marcada com
-- revoked_at: uma página antiga que ainda a use recebe a recusa genérica,
-- não um endpoint válido.
-- ---------------------------------------------------------------------

create function public.rotate_form_endpoint_key(
  p_form_endpoint_id uuid,
  p_new_public_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_endpoint public.form_endpoints;
  v_key public.form_endpoint_keys;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_endpoint from public.form_endpoints where id = p_form_endpoint_id for update;
  if v_endpoint.id is null then
    raise exception 'form_endpoint_not_found';
  end if;

  if not private.has_workspace_role(
    v_endpoint.workspace_id, array['owner', 'admin']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  update public.form_endpoint_keys
    set revoked_at = now(), revoked_by = v_actor
    where form_endpoint_id = p_form_endpoint_id and revoked_at is null;

  insert into public.form_endpoint_keys (workspace_id, form_endpoint_id, public_key, created_by)
  values (v_endpoint.workspace_id, v_endpoint.id, p_new_public_key, v_actor)
  returning * into v_key;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_endpoint.workspace_id, v_actor, 'form_endpoint.key_rotated', 'form_endpoint', v_endpoint.id, '{}'::jsonb
  );

  return jsonb_build_object('id', v_key.id, 'public_key', v_key.public_key);
end;
$body$;

-- ---------------------------------------------------------------------
-- list_form_endpoints — leitura para a tela de configuração
-- ---------------------------------------------------------------------

create function public.list_form_endpoints(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  if not private.has_workspace_role(
    p_workspace_id, array['owner', 'admin']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', e.id,
      'name', e.name,
      'status', e.status,
      'disabled_at', e.disabled_at,
      'pipeline_id', e.pipeline_id,
      'pipeline_name', p.name,
      'stage_id', e.stage_id,
      'stage_name', s.name,
      'legal_area', e.legal_area,
      'initial_activity_type', e.initial_activity_type,
      'initial_activity_due_minutes', e.initial_activity_due_minutes,
      'capture_mode', e.capture_mode,
      'contract_version', e.contract_version,
      'turnstile_action', e.turnstile_action,
      'allowed_hostnames', to_jsonb(e.allowed_hostnames),
      'answers_config', e.answers_config,
      'public_key', k.public_key,
      'revoked_key_count', (
        select count(*) from public.form_endpoint_keys rk
        where rk.form_endpoint_id = e.id and rk.revoked_at is not null
      ),
      'received_events', (
        select count(*) from public.webhook_events w where w.form_endpoint_id = e.id
      ),
      'created_at', e.created_at
    ) order by e.created_at desc
  ), '[]'::jsonb)
  into v_result
  from public.form_endpoints e
  join public.pipelines p on p.id = e.pipeline_id
  join public.pipeline_stages s on s.id = e.stage_id
  left join public.form_endpoint_keys k
    on k.form_endpoint_id = e.id and k.revoked_at is null
  where e.workspace_id = p_workspace_id;

  return v_result;
end;
$body$;

revoke all on function public.create_form_endpoint(uuid, text, uuid, uuid, text, public.activity_type, integer, public.form_capture_mode, text, text[], text, jsonb, integer) from public;
grant execute on function public.create_form_endpoint(uuid, text, uuid, uuid, text, public.activity_type, integer, public.form_capture_mode, text, text[], text, jsonb, integer) to authenticated;

revoke all on function public.update_form_endpoint(uuid, text, uuid, uuid, text, public.activity_type, integer, public.form_capture_mode, text, text[], jsonb) from public;
grant execute on function public.update_form_endpoint(uuid, text, uuid, uuid, text, public.activity_type, integer, public.form_capture_mode, text, text[], jsonb) to authenticated;

revoke all on function public.set_form_endpoint_status(uuid, public.form_endpoint_status) from public;
grant execute on function public.set_form_endpoint_status(uuid, public.form_endpoint_status) to authenticated;

revoke all on function public.rotate_form_endpoint_key(uuid, text) from public;
grant execute on function public.rotate_form_endpoint_key(uuid, text) to authenticated;

revoke all on function public.list_form_endpoints(uuid) from public;
grant execute on function public.list_form_endpoints(uuid) to authenticated;
