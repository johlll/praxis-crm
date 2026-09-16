-- A9 — bloco "Consulta" do Perfil 360 (docs/decisoes/a9-perfil-360.md §11).
--
-- O cartão era derivado da primeira página de atividades já carregada
-- pela página (50 itens, ordem due_at asc): uma reunião concluída fora
-- dessa página sumia do cartão, ou ele mostrava uma consulta mais antiga
-- no lugar da mais recente — e "carregar mais" no navegador nunca
-- recalcula o cartão, que é montado no servidor. Esta função busca
-- direto a última reunião concluída do lead, sem depender de paginação.
--
-- Mesmo controle de acesso de list_activities()/get_activity(): gate de
-- papel no workspace + alcance por registro do lead. Ordem determinística:
-- completed_at desc, id desc (duas reuniões concluídas no mesmo instante
-- sempre resolvem para a mesma). Sem reunião concluída = null, não erro.

create function public.get_last_completed_meeting(p_lead_id uuid)
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
  v_result jsonb;
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

  select jsonb_build_object(
    'id', a.id, 'lead_id', a.lead_id, 'opportunity_id', a.opportunity_id,
    'contact_name', c.name, 'legal_area', v_lead.legal_area,
    'type', a.type, 'title', a.title, 'notes', a.notes,
    'assigned_to', a.assigned_to, 'assigned_to_name', u.full_name,
    'priority', a.priority, 'due_at', a.due_at, 'has_time', a.has_time,
    'status', a.status, 'completed_at', a.completed_at,
    'source', a.source, 'lock_version', a.lock_version,
    'created_at', a.created_at, 'updated_at', a.updated_at
  )
  into v_result
  from public.activities a
  join public.contacts c on c.id = v_lead.contact_id
  left join public.users u on u.id = a.assigned_to
  where a.lead_id = p_lead_id
    and a.workspace_id = v_lead.workspace_id
    and a.type = 'meeting'
    and a.status = 'done'
  order by a.completed_at desc nulls last, a.id desc
  limit 1;

  return v_result;
end;
$body$;

revoke all on function public.get_last_completed_meeting(uuid) from public;
grant execute on function public.get_last_completed_meeting(uuid) to authenticated;
