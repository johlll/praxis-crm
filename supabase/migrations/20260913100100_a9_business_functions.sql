-- A9 — Perfil 360º do lead: funções de negócio.
--
-- Mesmo padrão de escopo/duplicação deliberada da A6 (a6_business_functions,
-- comentário de topo): cada função busca e checa o alcance por conta
-- própria — nenhum helper compartilhado de "busca + checa", para cada
-- função ficar legível e auditável sozinha.
--
-- Papéis com escrita em proposals/lead_notes: mesma lista de
-- activities/opportunities (owner, admin, manager, lawyer, sales) —
-- alcance por registro herdado do LEAD via
-- private.lead_accessible_to_role(), reaproveitada sem mudança.
--
-- conflict_checks: escrita restrita a owner/admin/manager/lawyer — sales/
-- viewer só leem (decisão registrada em docs/decisoes/a9-perfil-360.md §5).

-- ---------------------------------------------------------------------
-- private.proposal_financial_projection — mesma política de
-- private.opportunity_financial_projection (A5), adaptada ao formato de
-- proposta (sem probability/forecast_date, que não existem aqui).
-- ---------------------------------------------------------------------

create function private.proposal_financial_projection(
  p_role public.membership_role,
  p_value_cents bigint,
  p_fee_model public.fee_model
)
returns jsonb
language sql
stable
set search_path = ''
as $body$
  select case
    when p_role = 'viewer' then '{}'::jsonb
    when p_role = 'sales' then jsonb_build_object('value_band', private.money_band_label(p_value_cents))
    else jsonb_build_object('value_cents', p_value_cents, 'fee_model', p_fee_model)
  end;
$body$;

comment on function private.proposal_financial_projection(public.membership_role, bigint, public.fee_model) is
  'Projeção financeira de proposta por papel — mesma política de private.opportunity_financial_projection: viewer nada, sales só a faixa, os demais o exato.';

revoke all on function private.proposal_financial_projection(public.membership_role, bigint, public.fee_model) from public;
grant execute on function private.proposal_financial_projection(public.membership_role, bigint, public.fee_model) to authenticated;

-- ---------------------------------------------------------------------
-- create_proposal
-- ---------------------------------------------------------------------

create function public.create_proposal(
  p_opportunity_id uuid,
  p_value_cents bigint,
  p_fee_model public.fee_model
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_opportunity public.opportunities;
  v_lead public.leads;
  v_number text;
  v_seq integer;
  v_proposal_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if p_value_cents is null or p_value_cents < 0 then
    raise exception 'invalid_value_cents';
  end if;

  select * into v_opportunity from public.opportunities where id = p_opportunity_id;
  if v_opportunity.id is null then
    raise exception 'opportunity_not_found';
  end if;

  select * into v_lead from public.leads where id = v_opportunity.lead_id;

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

  -- Numeração sequencial por workspace+ano — não é uma sequência atômica
  -- do banco (baixo volume esperado desta ação, manual, uma de cada vez);
  -- uma colisão rara na numeração falha por causa do unique constraint,
  -- nunca cria um número duplicado silenciosamente.
  select count(*) + 1 into v_seq
  from public.proposals
  where workspace_id = v_lead.workspace_id
    and number like 'PROP-' || to_char(now(), 'YYYY') || '-%';

  v_number := 'PROP-' || to_char(now(), 'YYYY') || '-' || lpad(v_seq::text, 4, '0');

  insert into public.proposals (
    workspace_id, lead_id, opportunity_id, number, value_cents, fee_model, created_by
  )
  values (
    v_lead.workspace_id, v_lead.id, p_opportunity_id, v_number, p_value_cents, p_fee_model, v_actor
  )
  returning id into v_proposal_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_lead.workspace_id, v_actor, 'proposal.created', 'proposal', v_proposal_id,
    jsonb_build_object('lead_id', v_lead.id, 'opportunity_id', p_opportunity_id, 'number', v_number)
  );

  return v_proposal_id;
end;
$body$;

revoke all on function public.create_proposal(uuid, bigint, public.fee_model) from public;
grant execute on function public.create_proposal(uuid, bigint, public.fee_model) to authenticated;

-- ---------------------------------------------------------------------
-- send_proposal — rascunho -> enviada. Concorrência via lock_version,
-- mesmo padrão de move/win/lose_opportunity (A5).
-- ---------------------------------------------------------------------

create function public.send_proposal(
  p_proposal_id uuid,
  p_lock_version bigint,
  p_channels public.proposal_channel[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_proposal public.proposals;
  v_lead public.leads;
  v_updated integer;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if p_channels is null or array_length(p_channels, 1) is null then
    raise exception 'channels_required';
  end if;

  select * into v_proposal from public.proposals where id = p_proposal_id;
  if v_proposal.id is null then
    raise exception 'proposal_not_found';
  end if;

  select * into v_lead from public.leads where id = v_proposal.lead_id;

  if not private.has_workspace_role(
    v_lead.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_lead.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'proposal_not_found';
  end if;

  if v_proposal.status <> 'rascunho' then
    raise exception 'proposal_already_sent';
  end if;

  update public.proposals
  set status = 'enviada', sent_channels = p_channels, sent_at = now(), lock_version = lock_version + 1
  where id = p_proposal_id and lock_version = p_lock_version;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'stale_version';
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_lead.workspace_id, v_actor, 'proposal.sent', 'proposal', p_proposal_id,
    jsonb_build_object('channels', to_jsonb(p_channels))
  );
end;
$body$;

revoke all on function public.send_proposal(uuid, bigint, public.proposal_channel[]) from public;
grant execute on function public.send_proposal(uuid, bigint, public.proposal_channel[]) to authenticated;

-- ---------------------------------------------------------------------
-- decide_proposal — enviada -> aceita | recusada.
-- ---------------------------------------------------------------------

create function public.decide_proposal(
  p_proposal_id uuid,
  p_lock_version bigint,
  p_decision public.proposal_status,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_proposal public.proposals;
  v_lead public.leads;
  v_updated integer;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if p_decision not in ('aceita', 'recusada') then
    raise exception 'invalid_decision';
  end if;

  select * into v_proposal from public.proposals where id = p_proposal_id;
  if v_proposal.id is null then
    raise exception 'proposal_not_found';
  end if;

  select * into v_lead from public.leads where id = v_proposal.lead_id;

  if not private.has_workspace_role(
    v_lead.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_lead.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'proposal_not_found';
  end if;

  if v_proposal.status <> 'enviada' then
    raise exception 'proposal_not_sent';
  end if;

  update public.proposals
  set status = p_decision,
      decided_at = now(),
      decision_note = nullif(btrim(coalesce(p_note, '')), ''),
      lock_version = lock_version + 1
  where id = p_proposal_id and lock_version = p_lock_version;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'stale_version';
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_lead.workspace_id, v_actor, 'proposal.decided', 'proposal', p_proposal_id,
    jsonb_build_object('decision', p_decision)
  );
end;
$body$;

revoke all on function public.decide_proposal(uuid, bigint, public.proposal_status, text) from public;
grant execute on function public.decide_proposal(uuid, bigint, public.proposal_status, text) to authenticated;

-- ---------------------------------------------------------------------
-- get_proposal / list_proposals_for_lead — leitura, projeção financeira
-- por papel.
-- ---------------------------------------------------------------------

create function public.get_proposal(p_proposal_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_proposal public.proposals;
  v_lead public.leads;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_proposal from public.proposals where id = p_proposal_id;
  if v_proposal.id is null then
    raise exception 'proposal_not_found';
  end if;

  select * into v_lead from public.leads where id = v_proposal.lead_id;

  if not private.has_workspace_role(
    v_lead.workspace_id,
    array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_lead.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'proposal_not_found';
  end if;

  return jsonb_build_object('id', v_proposal.id, 'lead_id', v_proposal.lead_id, 'opportunity_id', v_proposal.opportunity_id)
    || jsonb_build_object(
      'number', v_proposal.number,
      'status', v_proposal.status,
      'sent_channels', to_jsonb(v_proposal.sent_channels),
      'sent_at', v_proposal.sent_at,
      'decided_at', v_proposal.decided_at,
      'decision_note', v_proposal.decision_note,
      'lock_version', v_proposal.lock_version,
      'created_at', v_proposal.created_at
    )
    || private.proposal_financial_projection(v_role, v_proposal.value_cents, v_proposal.fee_model);
end;
$body$;

revoke all on function public.get_proposal(uuid) from public;
grant execute on function public.get_proposal(uuid) to authenticated;

create function public.list_proposals_for_lead(p_lead_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_lead public.leads;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_lead from public.leads where id = p_lead_id;
  if v_lead.id is null then
    raise exception 'lead_not_found';
  end if;

  if not private.has_workspace_role(
    v_lead.workspace_id,
    array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_lead.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'lead_not_found';
  end if;

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', p.id, 'opportunity_id', p.opportunity_id, 'number', p.number, 'status', p.status,
          'sent_channels', to_jsonb(p.sent_channels), 'sent_at', p.sent_at, 'decided_at', p.decided_at,
          'decision_note', p.decision_note, 'lock_version', p.lock_version, 'created_at', p.created_at
        )
        || private.proposal_financial_projection(v_role, p.value_cents, p.fee_model)
        order by p.created_at desc, p.id desc
      )
      from public.proposals p
      where p.lead_id = p_lead_id
    ),
    '[]'::jsonb
  );
end;
$body$;

revoke all on function public.list_proposals_for_lead(uuid) from public;
grant execute on function public.list_proposals_for_lead(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- upsert_conflict_check — 1 registro por lead. Escrita restrita a
-- owner/admin/manager/lawyer (sales/viewer só leem via get_conflict_check).
-- ---------------------------------------------------------------------

create function public.upsert_conflict_check(
  p_lead_id uuid,
  p_status public.conflict_check_status,
  p_note text default null,
  p_lock_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_lead public.leads;
  v_existing public.conflict_checks;
  v_result public.conflict_checks;
  v_updated integer;
  v_checked_at timestamptz;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_lead from public.leads where id = p_lead_id;
  if v_lead.id is null then
    raise exception 'lead_not_found';
  end if;

  if not private.has_workspace_role(
    v_lead.workspace_id, array['owner', 'admin', 'manager', 'lawyer']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_lead.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'lead_not_found';
  end if;

  v_checked_at := case when p_status = 'nao_verificado' then null else now() end;

  select * into v_existing from public.conflict_checks where lead_id = p_lead_id;

  if v_existing.id is null then
    insert into public.conflict_checks (
      workspace_id, lead_id, status, note, checked_by, checked_at
    )
    values (
      v_lead.workspace_id, p_lead_id, p_status, nullif(btrim(coalesce(p_note, '')), ''),
      case when p_status = 'nao_verificado' then null else v_actor end, v_checked_at
    )
    returning * into v_result;
  else
    if p_lock_version is null or p_lock_version <> v_existing.lock_version then
      raise exception 'stale_version';
    end if;

    -- A versão precisa entrar no próprio WHERE, não só numa comparação
    -- anterior ao UPDATE: duas chamadas concorrentes podem ler o mesmo
    -- v_existing.lock_version, passar as duas pela checagem acima, e cada
    -- UPDATE que filtra só por id afeta 1 linha sem nunca detectar a
    -- outra — perdendo uma escrita silenciosamente (mesma correção já
    -- aplicada em oportunidades/atividades/propostas desde a A4/A9).
    update public.conflict_checks
    set status = p_status,
        note = nullif(btrim(coalesce(p_note, '')), ''),
        checked_by = case when p_status = 'nao_verificado' then null else v_actor end,
        checked_at = v_checked_at,
        lock_version = lock_version + 1
    where id = v_existing.id and lock_version = p_lock_version
    returning * into v_result;

    get diagnostics v_updated = row_count;
    if v_updated = 0 then
      raise exception 'stale_version';
    end if;
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_lead.workspace_id, v_actor, 'conflict_check.updated', 'conflict_check', v_result.id,
    jsonb_build_object('lead_id', p_lead_id, 'status', p_status)
  );

  return jsonb_build_object(
    'id', v_result.id, 'lead_id', v_result.lead_id, 'status', v_result.status, 'note', v_result.note,
    'checked_by', v_result.checked_by, 'checked_at', v_result.checked_at, 'lock_version', v_result.lock_version
  );
end;
$body$;

revoke all on function public.upsert_conflict_check(uuid, public.conflict_check_status, text, bigint) from public;
grant execute on function public.upsert_conflict_check(uuid, public.conflict_check_status, text, bigint) to authenticated;

-- ---------------------------------------------------------------------
-- get_conflict_check — leitura para os 6 papéis (owner..viewer), sem
-- registro ainda = estado padrão "não verificado" (nunca 404 — a ausência
-- de verificação é um estado legítimo, não um erro de acesso).
-- ---------------------------------------------------------------------

create function public.get_conflict_check(p_lead_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_lead public.leads;
  v_check public.conflict_checks;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_lead from public.leads where id = p_lead_id;
  if v_lead.id is null then
    raise exception 'lead_not_found';
  end if;

  if not private.has_workspace_role(
    v_lead.workspace_id,
    array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_lead.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'lead_not_found';
  end if;

  select * into v_check from public.conflict_checks where lead_id = p_lead_id;

  if v_check.id is null then
    return jsonb_build_object(
      'id', null, 'status', 'nao_verificado', 'note', null,
      'checked_by', null, 'checked_at', null, 'lock_version', null
    );
  end if;

  -- A nota de conflito pode conter detalhe sensível sobre partes
  -- envolvidas (mesma razão de honorários ficarem em faixa para
  -- atendimento): só quem pode escrever a verificação
  -- (owner/admin/manager/lawyer) lê o texto da nota; sales/viewer veem
  -- status e data, nunca o conteúdo. Filtrado aqui, não escondido só na
  -- interface — a nota nunca chega ao navegador desses papéis.
  return jsonb_build_object(
    'id', v_check.id, 'status', v_check.status,
    'note', case when v_role in ('owner', 'admin', 'manager', 'lawyer') then v_check.note else null end,
    'checked_by', v_check.checked_by, 'checked_at', v_check.checked_at, 'lock_version', v_check.lock_version
  );
end;
$body$;

revoke all on function public.get_conflict_check(uuid) from public;
grant execute on function public.get_conflict_check(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- create_lead_note
-- ---------------------------------------------------------------------

create function public.create_lead_note(p_lead_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_lead public.leads;
  v_body text;
  v_note_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  v_body := nullif(btrim(coalesce(p_body, '')), '');
  if v_body is null then
    raise exception 'body_required';
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

  insert into public.lead_notes (workspace_id, lead_id, body, created_by)
  values (v_lead.workspace_id, p_lead_id, v_body, v_actor)
  returning id into v_note_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_lead.workspace_id, v_actor, 'lead_note.created', 'lead_note', v_note_id, jsonb_build_object('lead_id', p_lead_id));

  return v_note_id;
end;
$body$;

revoke all on function public.create_lead_note(uuid, text) from public;
grant execute on function public.create_lead_note(uuid, text) to authenticated;
