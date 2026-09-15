-- A9 — correções ao conflict_checks encontradas numa segunda revisão de
-- código depois do CI verde inicial (docs/decisoes/a9-perfil-360.md §11).
-- `20260913100100_a9_business_functions.sql` já está aplicada em
-- ambientes reais (praxis-crm-dev) — migrations são forward-only (ver
-- plano §15), então as correções entram AQUI, numa migration nova, em vez
-- de editar o arquivo já aplicado. `create or replace` basta nas duas: a
-- aridade de `upsert_conflict_check`/`get_conflict_check` não muda, só o
-- corpo.

-- ---------------------------------------------------------------------
-- 1) upsert_conflict_check — a comparação de lock_version acontecia
--    antes do UPDATE, mas o UPDATE filtrava só por id: duas chamadas
--    concorrentes podiam ler a mesma versão, passar as duas pela
--    checagem, e a segunda sobrescrever a primeira sem nunca disparar
--    stale_version. A versão entra agora no próprio WHERE do UPDATE,
--    igual ao padrão já usado em send_proposal/decide_proposal.
-- ---------------------------------------------------------------------

create or replace function public.upsert_conflict_check(
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
    -- aplicada em oportunidades/atividades/propostas desde a A4).
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
-- 2) get_conflict_check — a nota pode conter detalhe sensível sobre
--    partes envolvidas (mesma razão de honorários virarem faixa para
--    atendimento em private.proposal_financial_projection): só quem pode
--    ESCREVER a verificação (owner/admin/manager/lawyer) lê o texto;
--    sales/viewer recebem note = null. status/checked_at continuam
--    visíveis aos 6 papéis, como já era — filtrado dentro da própria
--    RPC, nunca escondido só na interface.
-- ---------------------------------------------------------------------

create or replace function public.get_conflict_check(p_lead_id uuid)
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

  return jsonb_build_object(
    'id', v_check.id, 'status', v_check.status,
    'note', case when v_role in ('owner', 'admin', 'manager', 'lawyer') then v_check.note else null end,
    'checked_by', v_check.checked_by, 'checked_at', v_check.checked_at, 'lock_version', v_check.lock_version
  );
end;
$body$;

revoke all on function public.get_conflict_check(uuid) from public;
grant execute on function public.get_conflict_check(uuid) to authenticated;
