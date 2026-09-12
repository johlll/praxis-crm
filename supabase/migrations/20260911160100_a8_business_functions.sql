-- A8 — Clientes e handoff: funções de escrita.
--
-- Mutação restrita a owner/admin/manager (item 3 do pedido — sales/
-- viewer/lawyer não alteram status nem responsável nesta entrega).
-- Nenhuma das duas funções toca oportunidades ou handoffs: mudar o
-- status do cliente NUNCA reescreve retroativamente uma oportunidade
-- ganha nem um handoff já registrado (item 4) — é literalmente
-- impossível aqui, porque nenhum UPDATE abaixo referencia essas tabelas.
--
-- Concorrência: mesmo padrão de lock_version de opportunities/activities
-- — UPDATE condicionado no WHERE, `if not found` vira 'client_conflict'.

-- ---------------------------------------------------------------------
-- update_client_status — reativar (voltar para 'ativo') passa por uma
-- checagem explícita ANTES do UPDATE (mensagem clara e imediata para o
-- caso comum) E por um handler de unique_violation ao redor do UPDATE
-- (rede de segurança para a corrida entre duas chamadas concorrentes —
-- o índice parcial clients_one_active_per_contact_idx, já existente
-- desde a A5, é quem garante isto de verdade). Em nenhum dos dois casos
-- há mesclagem ou exclusão de cadastro — só recusa com erro tratado,
-- exatamente como pedido.
-- ---------------------------------------------------------------------

create function public.update_client_status(
  p_client_id uuid,
  p_status public.client_status,
  p_lock_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_client public.clients;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_client from public.clients where id = p_client_id;
  if v_client.id is null then
    raise exception 'client_not_found';
  end if;

  if not private.has_workspace_role(
    v_client.workspace_id, array['owner', 'admin', 'manager']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  if p_status = 'ativo' and v_client.status <> 'ativo' and exists (
    select 1 from public.clients
    where workspace_id = v_client.workspace_id
      and contact_id = v_client.contact_id
      and status = 'ativo'
      and id <> v_client.id
  ) then
    raise exception 'active_client_conflict';
  end if;

  begin
    update public.clients
    set status = p_status, lock_version = lock_version + 1
    where id = p_client_id and lock_version = p_lock_version
    returning * into v_client;
  exception when unique_violation then
    raise exception 'active_client_conflict';
  end;

  if not found then
    raise exception 'client_conflict';
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_client.workspace_id, v_actor, 'client.status_changed', 'client', p_client_id,
    jsonb_build_object('status', p_status)
  );

  return jsonb_build_object('id', v_client.id, 'status', v_client.status, 'lock_version', v_client.lock_version);
end;
$body$;

revoke all on function public.update_client_status(uuid, public.client_status, bigint) from public;
grant execute on function public.update_client_status(uuid, public.client_status, bigint) to authenticated;

-- ---------------------------------------------------------------------
-- transfer_client_owner — reaproveita a mesma checagem de membership
-- ativa que assign_lead() (A4) já usa para "essa pessoa não é membro
-- deste workspace" (mesmo código de erro, já mapeado em
-- src/lib/errors.ts). p_owner_user_id nulo é uma transferência válida
-- ("sem responsável"), mesmo espírito de assign_lead().
-- ---------------------------------------------------------------------

create function public.transfer_client_owner(
  p_client_id uuid,
  p_lock_version bigint,
  p_owner_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_client public.clients;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_client from public.clients where id = p_client_id;
  if v_client.id is null then
    raise exception 'client_not_found';
  end if;

  if not private.has_workspace_role(
    v_client.workspace_id, array['owner', 'admin', 'manager']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  if p_owner_user_id is not null and not exists (
    select 1 from public.memberships
    where workspace_id = v_client.workspace_id and user_id = p_owner_user_id and status = 'active'
  ) then
    raise exception 'assignee_not_a_member';
  end if;

  update public.clients
  set owner_user_id = p_owner_user_id, lock_version = lock_version + 1
  where id = p_client_id and lock_version = p_lock_version
  returning * into v_client;

  if not found then
    raise exception 'client_conflict';
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_client.workspace_id, v_actor, 'client.owner_transferred', 'client', p_client_id,
    jsonb_build_object('owner_user_id', p_owner_user_id)
  );

  return jsonb_build_object(
    'id', v_client.id, 'owner_user_id', v_client.owner_user_id, 'lock_version', v_client.lock_version
  );
end;
$body$;

revoke all on function public.transfer_client_owner(uuid, bigint, uuid) from public;
grant execute on function public.transfer_client_owner(uuid, bigint, uuid) to authenticated;
