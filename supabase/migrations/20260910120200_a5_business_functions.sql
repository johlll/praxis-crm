-- A5 — Pipeline e oportunidades: funções de negócio.
--
-- Papéis com acesso de ESCRITA a oportunidades (criar, mover etapa,
-- ganhar, perder): mesma lista de leads (owner, admin, manager, lawyer,
-- sales) — movimentar oportunidades já inclui "suas" para lawyer/sales
-- na matriz do plano. Configurar pipeline/etapas/requisitos/motivos de
-- perda é administrativo: owner/admin/manager apenas.
--
-- Alcance por registro (herdado do LEAD pai — não existe responsável
-- próprio de oportunidade nesta fase): reaproveita
-- private.lead_accessible_to_role() direto, sem duplicar a regra. Regra
-- é a mesma que já protege o lead, aplicada ao mesmo assigned_to.
--
-- Projeção financeira por papel: viewer nunca recebe nenhuma chave
-- financeira; sales recebe só a faixa (private.money_band_label, já
-- existente e reaproveitada sem mudança) — nunca o valor exato nem
-- soma exata de coluna; owner/admin/manager/lawyer(sua) recebem o valor
-- exato e os campos auxiliares (fee_model, probability, forecast_date).
--
-- Separação leitura/escrita: a permissão para VER o valor (mesmo que
-- como faixa) não é a mesma para DEFINI-LO — sales/lawyer podem
-- escrever value_cents ao criar/editar uma oportunidade dentro do seu
-- alcance (faz parte do trabalho comercial), mas a LEITURA de volta
-- sempre passa pela projeção; nenhuma escrita lê o valor atual como
-- prova de permissão de leitura, e nenhuma leitura concede escrita.

-- ---------------------------------------------------------------------
-- private.opportunity_financial_projection — projeção explícita por
-- papel para o valor de UMA oportunidade. Reaproveita
-- private.money_band_label (A4) sem mudança.
-- ---------------------------------------------------------------------

create function private.opportunity_financial_projection(
  p_role public.membership_role,
  p_value_cents bigint,
  p_fee_model public.fee_model,
  p_probability smallint,
  p_forecast_date date
)
returns jsonb
language sql
stable
set search_path = ''
as $body$
  select case
    when p_role = 'viewer' then '{}'::jsonb
    when p_role = 'sales' then jsonb_build_object('value_band', private.money_band_label(p_value_cents))
    else jsonb_build_object(
      'value_cents', p_value_cents,
      'fee_model', p_fee_model,
      'probability', p_probability,
      'forecast_date', p_forecast_date
    )
  end;
$body$;

comment on function private.opportunity_financial_projection(public.membership_role, bigint, public.fee_model, smallint, date) is
  'Projeção financeira por papel de uma oportunidade individual — viewer nada, sales só a faixa, os demais o exato. Usada em detalhe, card e tabela.';

revoke all on function private.opportunity_financial_projection(public.membership_role, bigint, public.fee_model, smallint, date) from public;
grant execute on function private.opportunity_financial_projection(public.membership_role, bigint, public.fee_model, smallint, date) to authenticated;

-- ---------------------------------------------------------------------
-- private.opportunity_column_sum_projection — projeção de um AGREGADO
-- (soma por coluna do kanban). Sales e viewer não recebem NENHUM total,
-- exato ou aproximado — nunca deriva soma de faixas, que revelaria uma
-- estimativa dos valores individuais.
-- ---------------------------------------------------------------------

create function private.opportunity_column_sum_projection(
  p_role public.membership_role,
  p_sum_cents bigint
)
returns jsonb
language sql
stable
set search_path = ''
as $body$
  select case
    when p_role in ('owner', 'admin', 'manager', 'lawyer') then jsonb_build_object('value_sum_cents', p_sum_cents)
    else '{}'::jsonb
  end;
$body$;

comment on function private.opportunity_column_sum_projection(public.membership_role, bigint) is
  'Soma financeira por coluna do kanban, projetada por papel. lawyer só agrega o que já filtrou por alcance (suas oportunidades), então a soma nunca inclui valor de terceiros.';

revoke all on function private.opportunity_column_sum_projection(public.membership_role, bigint) from public;
grant execute on function private.opportunity_column_sum_projection(public.membership_role, bigint) to authenticated;

-- ---------------------------------------------------------------------
-- create_opportunity
-- ---------------------------------------------------------------------

create function public.create_opportunity(
  p_lead_id uuid,
  p_pipeline_id uuid default null,
  p_stage_id uuid default null,
  p_value_cents bigint default null,
  p_fee_model public.fee_model default null,
  p_probability smallint default null,
  p_forecast_date date default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_lead public.leads;
  v_pipeline_id uuid;
  v_stage_id uuid;
  v_opportunity_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_lead from public.leads where id = p_lead_id;
  if v_lead.id is null then
    raise exception 'lead_not_found';
  end if;

  if not private.has_workspace_role(
    v_lead.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_lead.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'lead_not_found';
  end if;

  if p_value_cents is not null and p_value_cents < 0 then
    raise exception 'invalid_value';
  end if;

  if p_pipeline_id is not null then
    if not exists (select 1 from public.pipelines where id = p_pipeline_id and workspace_id = v_lead.workspace_id) then
      raise exception 'pipeline_not_found';
    end if;
    v_pipeline_id := p_pipeline_id;
  else
    select id into v_pipeline_id from public.pipelines
    where workspace_id = v_lead.workspace_id and is_default;
    if v_pipeline_id is null then
      raise exception 'pipeline_not_found';
    end if;
  end if;

  if p_stage_id is not null then
    if not exists (
      select 1 from public.pipeline_stages where id = p_stage_id and pipeline_id = v_pipeline_id
    ) then
      raise exception 'stage_not_in_pipeline';
    end if;
    v_stage_id := p_stage_id;
  else
    select id into v_stage_id from public.pipeline_stages
    where pipeline_id = v_pipeline_id
    order by position asc
    limit 1;
    if v_stage_id is null then
      raise exception 'pipeline_has_no_stages';
    end if;
  end if;

  insert into public.opportunities (
    workspace_id, lead_id, pipeline_id, stage_id,
    value_cents, fee_model, probability, forecast_date
  )
  values (
    v_lead.workspace_id, p_lead_id, v_pipeline_id, v_stage_id,
    p_value_cents, p_fee_model, p_probability, p_forecast_date
  )
  returning id into v_opportunity_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_lead.workspace_id, v_actor, 'opportunity.created', 'opportunity', v_opportunity_id,
    jsonb_build_object('lead_id', p_lead_id, 'pipeline_id', v_pipeline_id, 'stage_id', v_stage_id)
  );

  return v_opportunity_id;
end;
$body$;

revoke all on function public.create_opportunity(uuid, uuid, uuid, bigint, public.fee_model, smallint, date) from public;
grant execute on function public.create_opportunity(uuid, uuid, uuid, bigint, public.fee_model, smallint, date) to authenticated;

-- ---------------------------------------------------------------------
-- move_opportunity_stage — a função mais sensível da fase.
--
-- Validações, nesta ordem: autenticação; existência + alcance do
-- registro (via lead pai); oportunidade ainda 'open' (encerrada não se
-- move — erro 'opportunity_closed'); etapa de destino pertence ao MESMO
-- pipeline (garantido pela FK composta, mas checado aqui também para dar
-- erro específico antes de tentar o UPDATE); etapa de ORIGEM informada
-- bate com a atual (erro 'stage_mismatch' se não bater — cobre reload
-- desatualizado além do lock_version); requisitos de TODAS as etapas
-- entre a atual (exclusive) e o destino (inclusive), na direção do
-- avanço, satisfeitos (voltar nunca exige requisito — só avançar).
--
-- Atualização + lock_version + histórico na MESMA transação: o UPDATE
-- condicionado no WHERE é a operação atômica; o INSERT em
-- stage_transitions roda logo em seguida, ainda dentro da mesma
-- transação de função (Postgres: uma função PL/pgSQL inteira é uma
-- transação, a menos que haja commit explícito, que não existe aqui) —
-- se qualquer parte falhar, nada é gravado.
-- ---------------------------------------------------------------------

create function public.move_opportunity_stage(
  p_opportunity_id uuid,
  p_from_stage_id uuid,
  p_to_stage_id uuid,
  p_lock_version bigint,
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
  v_from_position integer;
  v_to_position integer;
  v_missing_count integer;
  v_seconds_in_stage bigint;
  v_item jsonb;
  v_req record;
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
    v_opportunity.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_opportunity.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'opportunity_not_found';
  end if;

  if v_opportunity.status <> 'open' then
    raise exception 'opportunity_closed';
  end if;

  if v_opportunity.stage_id <> p_from_stage_id then
    raise exception 'stage_mismatch';
  end if;

  if not exists (
    select 1 from public.pipeline_stages where id = p_to_stage_id and pipeline_id = v_opportunity.pipeline_id
  ) then
    raise exception 'stage_not_in_pipeline';
  end if;

  select position into v_from_position from public.pipeline_stages where id = p_from_stage_id;
  select position into v_to_position from public.pipeline_stages where id = p_to_stage_id;

  if v_from_position = v_to_position then
    raise exception 'stage_unchanged';
  end if;

  -- Só ao AVANÇAR: os requisitos de toda etapa entre a atual (exclusive)
  -- e o destino (inclusive) precisam estar satisfeitos — pular colunas
  -- não contorna o requisito de nenhuma delas. Voltar nunca é bloqueado.
  if v_to_position > v_from_position then
    select count(*) into v_missing_count
    from public.stage_requirements sr
    where sr.workspace_id = v_opportunity.workspace_id
      and sr.stage_id in (
        select id from public.pipeline_stages
        where pipeline_id = v_opportunity.pipeline_id
          and position > v_from_position and position <= v_to_position
      )
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
      raise exception 'stage_requirements_pending';
    end if;
  end if;

  -- Grava os valores de requisito enviados junto com o movimento (a UI
  -- só permite avançar depois de preencher — mas o servidor não confia
  -- nisso: a checagem acima já rejeitou se algo essencial faltar).
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

  v_seconds_in_stage := extract(epoch from (now() - v_opportunity.stage_entered_at))::bigint;

  update public.opportunities
  set stage_id = p_to_stage_id,
      stage_entered_at = now(),
      lock_version = lock_version + 1
  where id = p_opportunity_id and lock_version = p_lock_version and status = 'open'
  returning * into v_opportunity;

  if not found then
    raise exception 'opportunity_conflict';
  end if;

  insert into public.stage_transitions (
    workspace_id, opportunity_id, from_stage_id, to_stage_id, actor_user_id, seconds_in_previous_stage
  )
  values (
    v_opportunity.workspace_id, p_opportunity_id, p_from_stage_id, p_to_stage_id, v_actor, v_seconds_in_stage
  );

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_opportunity.workspace_id, v_actor, 'opportunity.stage_moved', 'opportunity', p_opportunity_id,
    jsonb_build_object('from_stage_id', p_from_stage_id, 'to_stage_id', p_to_stage_id)
  );

  return jsonb_build_object(
    'id', v_opportunity.id,
    'stage_id', v_opportunity.stage_id,
    'stage_entered_at', v_opportunity.stage_entered_at,
    'lock_version', v_opportunity.lock_version
  );
end;
$body$;

revoke all on function public.move_opportunity_stage(uuid, uuid, uuid, bigint, jsonb) from public;
grant execute on function public.move_opportunity_stage(uuid, uuid, uuid, bigint, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- win_opportunity — atômica: encerra como ganha, cria/vincula cliente,
-- registra handoff pendente. Idempotência natural: uma segunda chamada
-- encontra status <> 'open' e falha em 'opportunity_conflict' antes de
-- chegar perto de criar qualquer coisa nova — nenhum cliente nem handoff
-- duplicado em tentativa repetida (duplo clique, retry de rede).
-- ---------------------------------------------------------------------

create function public.win_opportunity(
  p_opportunity_id uuid,
  p_lock_version bigint,
  p_value_cents bigint,
  p_fee_model public.fee_model,
  p_signed_at date default null
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

revoke all on function public.win_opportunity(uuid, bigint, bigint, public.fee_model, date) from public;
grant execute on function public.win_opportunity(uuid, bigint, bigint, public.fee_model, date) to authenticated;

-- ---------------------------------------------------------------------
-- lose_opportunity
-- ---------------------------------------------------------------------

create function public.lose_opportunity(
  p_opportunity_id uuid,
  p_lock_version bigint,
  p_lost_reason_id uuid,
  p_lost_note text default null,
  p_followup_date date default null
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
    v_opportunity.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_opportunity.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'opportunity_not_found';
  end if;

  if not exists (
    select 1 from public.lost_reasons
    where id = p_lost_reason_id and workspace_id = v_opportunity.workspace_id and active
  ) then
    raise exception 'invalid_lost_reason';
  end if;

  update public.opportunities
  set status = 'lost',
      lost_reason_id = p_lost_reason_id,
      lost_note = nullif(btrim(coalesce(p_lost_note, '')), ''),
      lost_followup_date = p_followup_date,
      lock_version = lock_version + 1
  where id = p_opportunity_id and lock_version = p_lock_version and status = 'open'
  returning * into v_opportunity;

  if not found then
    raise exception 'opportunity_conflict';
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_opportunity.workspace_id, v_actor, 'opportunity.lost', 'opportunity', p_opportunity_id,
    jsonb_build_object('lost_reason_id', p_lost_reason_id)
  );

  return jsonb_build_object(
    'id', v_opportunity.id, 'status', v_opportunity.status, 'lock_version', v_opportunity.lock_version
  );
end;
$body$;

revoke all on function public.lose_opportunity(uuid, bigint, uuid, text, date) from public;
grant execute on function public.lose_opportunity(uuid, bigint, uuid, text, date) to authenticated;
