-- A5 — revisão pós-fechamento, item 3 (decisão aprovada pelo usuário):
-- distingue requisito de AVANÇO (já existia, só bloqueia
-- move_opportunity_stage) de requisito NECESSÁRIO PARA GANHAR — um novo
-- campo explícito `required_for_win`, desmarcado por padrão em todo
-- requisito existente e novo, que o admin liga caso a caso na tela de
-- configuração. Ganhar passa a validar TODOS os requisitos marcados do
-- PIPELINE inteiro da oportunidade, independentemente da etapa atual —
-- não só os do caminho percorrido. Perder continua exigindo só o motivo,
-- sem nenhuma checagem de requisito (avanço ou ganho).

alter table public.stage_requirements
  add column required_for_win boolean not null default false;

comment on column public.stage_requirements.required_for_win is
  'Quando true, também bloqueia win_opportunity() enquanto pendente — independente da etapa atual da oportunidade. Distinto de ser requisito de avanço (que só bloqueia mover PARA a etapa dele). Desmarcado por padrão.';

-- ---------------------------------------------------------------------
-- create_stage_requirement — ganha p_required_for_win (mudança de
-- assinatura: DROP+CREATE, não CREATE OR REPLACE, mesmo padrão de
-- 20260910120500).
-- ---------------------------------------------------------------------

drop function if exists public.create_stage_requirement(
  uuid, text, public.stage_requirement_type, text, integer
);

create function public.create_stage_requirement(
  p_stage_id uuid,
  p_label text,
  p_field_type public.stage_requirement_type,
  p_hint text default null,
  p_position integer default null,
  p_required_for_win boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_workspace_id uuid;
  v_position integer;
  v_requirement_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select workspace_id into v_workspace_id from public.pipeline_stages where id = p_stage_id;
  if v_workspace_id is null then
    raise exception 'stage_not_found';
  end if;

  if not private.has_workspace_role(v_workspace_id, array['owner', 'admin', 'manager']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  if p_position is not null then
    v_position := p_position;
  else
    select coalesce(max(position) + 1, 0) into v_position
    from public.stage_requirements where stage_id = p_stage_id;
  end if;

  insert into public.stage_requirements (workspace_id, stage_id, label, field_type, hint, position, required_for_win)
  values (v_workspace_id, p_stage_id, btrim(p_label), p_field_type, nullif(btrim(coalesce(p_hint, '')), ''), v_position, coalesce(p_required_for_win, false))
  returning id into v_requirement_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_workspace_id, v_actor, 'stage_requirement.created', 'stage_requirement', v_requirement_id, jsonb_build_object('required_for_win', coalesce(p_required_for_win, false)));

  return v_requirement_id;
end;
$body$;

revoke all on function public.create_stage_requirement(uuid, text, public.stage_requirement_type, text, integer, boolean) from public;
grant execute on function public.create_stage_requirement(uuid, text, public.stage_requirement_type, text, integer, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- update_stage_requirement — só alterna required_for_win num requisito
-- já existente (não reabre nome/tipo/hint nesta entrega — a tela só
-- precisa disto para requisitos criados antes deste campo existir).
-- ---------------------------------------------------------------------

create function public.update_stage_requirement(
  p_requirement_id uuid,
  p_required_for_win boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_workspace_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select workspace_id into v_workspace_id from public.stage_requirements where id = p_requirement_id;
  if v_workspace_id is null then
    raise exception 'requirement_not_found';
  end if;

  if not private.has_workspace_role(v_workspace_id, array['owner', 'admin', 'manager']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  update public.stage_requirements set required_for_win = p_required_for_win where id = p_requirement_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_workspace_id, v_actor, 'stage_requirement.updated', 'stage_requirement', p_requirement_id, jsonb_build_object('required_for_win', p_required_for_win));
end;
$body$;

revoke all on function public.update_stage_requirement(uuid, boolean) from public;
grant execute on function public.update_stage_requirement(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- get_win_requirements_status — o que falta preencher, dos requisitos
-- marcados required_for_win, em QUALQUER etapa do pipeline da
-- oportunidade (não só o caminho já percorrido — mesmo espírito de
-- get_stage_requirements_status, mas sem o filtro de posição). Chamada
-- pela UI antes de abrir/ao abrir o WonDialog.
-- ---------------------------------------------------------------------

create function public.get_win_requirements_status(p_opportunity_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_opportunity public.opportunities;
  v_lead public.leads;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_opportunity from public.opportunities where id = p_opportunity_id;
  if v_opportunity.id is null then
    raise exception 'opportunity_not_found';
  end if;

  select * into v_lead from public.leads where id = v_opportunity.lead_id;

  if not private.has_workspace_role(
    v_opportunity.workspace_id,
    array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_opportunity.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'opportunity_not_found';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'requirement_id', sr.id,
      'stage_id', sr.stage_id,
      'stage_name', ps.name,
      'label', sr.label,
      'field_type', sr.field_type,
      'hint', sr.hint,
      'value_text', orv.value_text,
      'value_bool', orv.value_bool,
      'filled', case
        when sr.field_type = 'checkbox' then orv.value_bool is true
        else orv.value_text is not null and btrim(orv.value_text) <> ''
      end
    ) order by ps.position, sr.position)
    from public.stage_requirements sr
    join public.pipeline_stages ps on ps.id = sr.stage_id
    left join public.opportunity_requirement_values orv
      on orv.requirement_id = sr.id and orv.opportunity_id = p_opportunity_id
    where ps.pipeline_id = v_opportunity.pipeline_id
      and sr.required_for_win = true
  ), '[]'::jsonb);
end;
$body$;

revoke all on function public.get_win_requirements_status(uuid) from public;
grant execute on function public.get_win_requirements_status(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- win_opportunity — ganha p_requirement_values e a validação de
-- required_for_win. Mudança de assinatura: DROP+CREATE. A checagem
-- acontece ANTES do UPDATE que marca status='won' e antes de qualquer
-- criação de cliente/handoff — uma recusa não altera a oportunidade nem
-- cria nada (a função inteira é uma transação; a exceção desfaz também
-- os requirement_values gravados nesta mesma chamada).
-- ---------------------------------------------------------------------

drop function if exists public.win_opportunity(uuid, bigint, bigint, public.fee_model, date);

create function public.win_opportunity(
  p_opportunity_id uuid,
  p_lock_version bigint,
  p_value_cents bigint,
  p_fee_model public.fee_model,
  p_signed_at date default null,
  p_requirement_values jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_opportunity public.opportunities;
  v_lead public.leads;
  v_client_id uuid;
  v_handoff_id uuid;
  v_item jsonb;
  v_req record;
  v_missing_count integer;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if p_value_cents is null or p_value_cents < 0 then
    raise exception 'invalid_value';
  end if;
  if p_fee_model is null then
    raise exception 'fee_model_required';
  end if;

  select * into v_opportunity from public.opportunities where id = p_opportunity_id;
  if v_opportunity.id is null then
    raise exception 'opportunity_not_found';
  end if;

  select * into v_lead from public.leads where id = v_opportunity.lead_id;

  if not private.has_workspace_role(
    v_opportunity.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_opportunity.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'opportunity_not_found';
  end if;

  -- Checado ANTES da validação de required_for_win (diferente da versão
  -- original, que só detectava conflito no UPDATE final): sem isto, uma
  -- oportunidade já encerrada com requisito pendente cairia em
  -- 'win_requirements_pending' em vez de 'opportunity_conflict' — a
  -- mensagem errada para o motivo real (idempotência), não uma checagem
  -- redundante.
  if v_opportunity.status <> 'open' then
    raise exception 'opportunity_conflict';
  end if;

  -- Grava os valores enviados junto com o pedido de ganho ANTES de
  -- checar o que falta — mesmo princípio de move_opportunity_stage():
  -- preencher e confirmar são a mesma chamada.
  for v_item in select * from jsonb_array_elements(coalesce(p_requirement_values, '[]'::jsonb))
  loop
    select * into v_req from public.stage_requirements
    where id = (v_item ->> 'requirement_id')::uuid and workspace_id = v_opportunity.workspace_id;
    if v_req.id is null then
      continue;
    end if;

    insert into public.opportunity_requirement_values (
      workspace_id, opportunity_id, requirement_id, value_text, value_bool
    )
    values (
      v_opportunity.workspace_id, p_opportunity_id, v_req.id,
      case when v_req.field_type <> 'checkbox' then nullif(btrim(coalesce(v_item ->> 'value_text', '')), '') end,
      case when v_req.field_type = 'checkbox' then (v_item ->> 'value_bool')::boolean end
    )
    on conflict (opportunity_id, requirement_id) do update
      set value_text = excluded.value_text, value_bool = excluded.value_bool, updated_at = now();
  end loop;

  -- Requisitos marcados required_for_win, em QUALQUER etapa do pipeline
  -- desta oportunidade — não só as etapas já visitadas.
  select count(*) into v_missing_count
  from public.stage_requirements sr
  join public.pipeline_stages ps on ps.id = sr.stage_id
  where ps.pipeline_id = v_opportunity.pipeline_id
    and sr.required_for_win = true
    and not exists (
      select 1 from public.opportunity_requirement_values orv
      where orv.opportunity_id = p_opportunity_id
        and orv.requirement_id = sr.id
        and (
          (sr.field_type = 'checkbox' and orv.value_bool is true)
          or (sr.field_type <> 'checkbox' and orv.value_text is not null and btrim(orv.value_text) <> '')
        )
    );

  if v_missing_count > 0 then
    raise exception 'win_requirements_pending';
  end if;

  update public.opportunities
  set status = 'won',
      won_at = now(),
      value_cents = p_value_cents,
      fee_model = p_fee_model,
      signed_at = p_signed_at,
      lock_version = lock_version + 1
  where id = p_opportunity_id and lock_version = p_lock_version and status = 'open'
  returning * into v_opportunity;

  if not found then
    raise exception 'opportunity_conflict';
  end if;

  -- Cria o cliente só se não existir um ATIVO para este contato — o
  -- índice parcial único (workspace_id, contact_id) where status='ativo'
  -- é quem garante isto sem uma segunda corrida: ON CONFLICT DO NOTHING
  -- seguido de SELECT, tudo na mesma transação.
  insert into public.clients (workspace_id, contact_id, owner_user_id)
  values (v_opportunity.workspace_id, v_lead.contact_id, v_lead.assigned_to)
  on conflict (workspace_id, contact_id) where status = 'ativo' do nothing
  returning id into v_client_id;

  if v_client_id is null then
    select id into v_client_id from public.clients
    where workspace_id = v_opportunity.workspace_id and contact_id = v_lead.contact_id and status = 'ativo';
  end if;

  insert into public.client_handoffs (workspace_id, client_id, opportunity_id, status, payload)
  values (
    v_opportunity.workspace_id, v_client_id, p_opportunity_id, 'pendente',
    jsonb_build_object(
      'lead_id', v_lead.id,
      'legal_area', v_lead.legal_area,
      'value_cents', p_value_cents,
      'fee_model', p_fee_model,
      'signed_at', p_signed_at,
      'assigned_to', v_lead.assigned_to
    )
  )
  returning id into v_handoff_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_opportunity.workspace_id, v_actor, 'opportunity.won', 'opportunity', p_opportunity_id,
    jsonb_build_object('client_id', v_client_id, 'handoff_id', v_handoff_id)
  );

  return jsonb_build_object(
    'id', v_opportunity.id, 'status', v_opportunity.status, 'won_at', v_opportunity.won_at,
    'lock_version', v_opportunity.lock_version, 'client_id', v_client_id, 'handoff_id', v_handoff_id
  );
end;
$body$;

revoke all on function public.win_opportunity(uuid, bigint, bigint, public.fee_model, date, jsonb) from public;
grant execute on function public.win_opportunity(uuid, bigint, bigint, public.fee_model, date, jsonb) to authenticated;
