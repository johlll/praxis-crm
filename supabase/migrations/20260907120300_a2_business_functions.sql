-- A2 — funções de negócio expostas via RPC (schema public, de propósito).
--
-- Diferente das funções em `private`: estas SÃO a superfície que o app
-- chama (`supabase.rpc(...)`) com a sessão do usuário — nunca com
-- service_role. Cada uma valida autorização e regras de negócio por dentro
-- (papel do chamador, último owner, e-mail do convite) antes de tocar em
-- qualquer tabela cujas policies de RLS, por design, negam INSERT/UPDATE/
-- DELETE direto do cliente (migration anterior). SECURITY DEFINER +
-- `set search_path = ''` + nomes totalmente qualificados em todas.

create function private.generate_invitation_token()
returns text
language sql
set search_path = ''
as $body$
  -- 32 bytes (256 bits) de entropia, base64url sem padding — cabe numa URL
  -- sem precisar de percent-encoding.
  select rtrim(
    replace(replace(encode(extensions.gen_random_bytes(32), 'base64'), '+', '-'), '/', '_'),
    '='
  );
$body$;

revoke all on function private.generate_invitation_token() from public;
grant execute on function private.generate_invitation_token() to authenticated;

-- ---------------------------------------------------------------------
-- create_workspace_with_owner — onboarding: cria o workspace e já torna
-- quem chamou o owner, na mesma transação. É o único jeito de criar um
-- workspace (a policy de INSERT em public.workspaces nega tudo do cliente).
-- ---------------------------------------------------------------------

create function public.create_workspace_with_owner(p_name text, p_slug text)
returns public.workspaces
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_workspace public.workspaces;
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  insert into public.workspaces (name, slug)
  values (btrim(p_name), lower(btrim(p_slug)))
  returning * into v_workspace;

  insert into public.memberships (workspace_id, user_id, role, status)
  values (v_workspace.id, v_actor, 'owner', 'active');

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_workspace.id, v_actor, 'workspace.created', 'workspace', v_workspace.id,
    jsonb_build_object('name', v_workspace.name, 'slug', v_workspace.slug)
  );

  return v_workspace;
end;
$body$;

revoke all on function public.create_workspace_with_owner(text, text) from public;
grant execute on function public.create_workspace_with_owner(text, text) to authenticated;

-- ---------------------------------------------------------------------
-- create_workspace_invitation — só owner/admin. Devolve o token em claro
-- UMA vez (é o próprio retorno da chamada) — o banco só guarda o hash.
-- ---------------------------------------------------------------------

create function public.create_workspace_invitation(
  p_workspace_id uuid,
  p_email text,
  p_role public.membership_role
)
returns table (id uuid, token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_email text := lower(btrim(p_email));
  v_token text;
  v_hash text;
  v_expires timestamptz := now() + interval '7 days';
  v_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if not private.has_workspace_role(p_workspace_id, array['owner', 'admin']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  -- Um admin pode convidar quase qualquer papel, mas não pode convidar
  -- outro owner — só quem já é owner concede o papel de owner. Fecha um
  -- caminho de escalonamento (admin convida "owner", coordena com o
  -- convidado para depois rebaixar os owners originais).
  if p_role = 'owner' and not private.has_workspace_role(p_workspace_id, array['owner']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid_email';
  end if;

  if exists (
    select 1
    from public.memberships m
    join public.users u on u.id = m.user_id
    where m.workspace_id = p_workspace_id
      and m.status = 'active'
      and lower(u.email) = v_email
  ) then
    raise exception 'already_a_member';
  end if;

  -- Evita acumular convites pendentes duplicados para o mesmo e-mail —
  -- o convite anterior (se houver) é cancelado, não apagado.
  update public.workspace_invitations
    set status = 'cancelled', cancelled_at = now()
    where workspace_id = p_workspace_id
      and email = v_email
      and status = 'pending';

  v_token := private.generate_invitation_token();
  v_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');

  insert into public.workspace_invitations (workspace_id, email, role, token_hash, invited_by, expires_at)
  values (p_workspace_id, v_email, p_role, v_hash, v_actor, v_expires)
  returning workspace_invitations.id into v_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    p_workspace_id, v_actor, 'invitation.created', 'workspace_invitation', v_id,
    jsonb_build_object('email', v_email, 'role', p_role)
  );

  return query select v_id, v_token, v_expires;
end;
$body$;

revoke all on function public.create_workspace_invitation(uuid, text, public.membership_role) from public;
grant execute on function public.create_workspace_invitation(uuid, text, public.membership_role) to authenticated;

-- ---------------------------------------------------------------------
-- cancel_workspace_invitation — só owner/admin, só convite pendente.
-- ---------------------------------------------------------------------

create function public.cancel_workspace_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_invitation public.workspace_invitations;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_invitation from public.workspace_invitations where id = p_invitation_id;

  if v_invitation.id is null then
    raise exception 'invitation_not_found';
  end if;

  if not private.has_workspace_role(v_invitation.workspace_id, array['owner', 'admin']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  if v_invitation.status <> 'pending' then
    raise exception 'invitation_not_pending';
  end if;

  update public.workspace_invitations
    set status = 'cancelled', cancelled_at = now()
    where id = p_invitation_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_invitation.workspace_id, v_actor, 'invitation.cancelled', 'workspace_invitation', p_invitation_id,
    jsonb_build_object('email', v_invitation.email)
  );
end;
$body$;

revoke all on function public.cancel_workspace_invitation(uuid) from public;
grant execute on function public.cancel_workspace_invitation(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- preview_workspace_invitation — callável por `anon`: a tela de aceite
-- precisa mostrar "você foi convidado para X como Y" ANTES do login. Não
-- confirma nada sobre quem está vendo, só o que o token já revela.
-- ---------------------------------------------------------------------

create function public.preview_workspace_invitation(p_token text)
returns table (
  workspace_name text,
  role public.membership_role,
  invited_by_name text,
  email text,
  status public.invitation_status,
  expires_at timestamptz
)
language sql
security definer
stable
set search_path = ''
as $body$
  select
    w.name,
    i.role,
    coalesce(u.full_name, u.email),
    i.email,
    case
      when i.status = 'pending' and i.expires_at < now() then 'expired'::public.invitation_status
      else i.status
    end,
    i.expires_at
  from public.workspace_invitations i
  join public.workspaces w on w.id = i.workspace_id
  left join public.users u on u.id = i.invited_by
  where i.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
$body$;

revoke all on function public.preview_workspace_invitation(text) from public;
grant execute on function public.preview_workspace_invitation(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- accept_workspace_invitation — o papel vem do convite salvo no banco, não
-- de nenhum parâmetro do cliente: o convidado não tem como pedir um papel
-- diferente do que foi decidido na criação do convite.
-- ---------------------------------------------------------------------

create function public.accept_workspace_invitation(p_token text)
returns public.memberships
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_invitation public.workspace_invitations;
  v_membership public.memberships;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select email into v_actor_email from public.users where id = v_actor;

  select * into v_invitation
    from public.workspace_invitations
    where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    for update;

  if v_invitation.id is null then
    raise exception 'invitation_not_found';
  end if;

  if v_invitation.status <> 'pending' then
    raise exception 'invitation_not_pending';
  end if;

  if v_invitation.expires_at < now() then
    update public.workspace_invitations set status = 'expired' where id = v_invitation.id;
    raise exception 'invitation_expired';
  end if;

  if lower(v_actor_email) is distinct from v_invitation.email then
    raise exception 'invitation_email_mismatch';
  end if;

  insert into public.memberships (workspace_id, user_id, role, status, invited_by)
  values (v_invitation.workspace_id, v_actor, v_invitation.role, 'active', v_invitation.invited_by)
  on conflict (workspace_id, user_id) do update
    set status = 'active',
        role = excluded.role
  returning * into v_membership;

  update public.workspace_invitations
    set status = 'accepted', accepted_at = now(), accepted_by = v_actor
    where id = v_invitation.id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_invitation.workspace_id, v_actor, 'invitation.accepted', 'workspace_invitation', v_invitation.id,
    jsonb_build_object('role', v_invitation.role)
  );

  return v_membership;
end;
$body$;

revoke all on function public.accept_workspace_invitation(text) from public;
grant execute on function public.accept_workspace_invitation(text) to authenticated;

-- ---------------------------------------------------------------------
-- update_membership_role — só owner/admin; nunca rebaixa o último owner.
-- ---------------------------------------------------------------------

create function public.update_membership_role(p_membership_id uuid, p_new_role public.membership_role)
returns public.memberships
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_membership public.memberships;
  v_old_role public.membership_role;
  v_remaining_owners int;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_membership from public.memberships where id = p_membership_id for update;

  if v_membership.id is null then
    raise exception 'membership_not_found';
  end if;

  if not private.has_workspace_role(v_membership.workspace_id, array['owner', 'admin']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  v_old_role := v_membership.role;

  -- Mesma restrição da criação de convite: promover alguém A owner exige
  -- que quem está promovendo já seja owner — admin não promove a owner.
  if p_new_role = 'owner' and v_old_role <> 'owner'
     and not private.has_workspace_role(v_membership.workspace_id, array['owner']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  if v_old_role = 'owner' and p_new_role <> 'owner' then
    select count(*) into v_remaining_owners
      from public.memberships
      where workspace_id = v_membership.workspace_id
        and role = 'owner'
        and status = 'active'
        and id <> v_membership.id;

    if v_remaining_owners = 0 then
      raise exception 'cannot_demote_last_owner';
    end if;
  end if;

  update public.memberships
    set role = p_new_role
    where id = p_membership_id
    returning * into v_membership;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_membership.workspace_id, v_actor, 'membership.role_changed', 'membership', p_membership_id,
    jsonb_build_object('from_role', v_old_role, 'to_role', p_new_role)
  );

  return v_membership;
end;
$body$;

revoke all on function public.update_membership_role(uuid, public.membership_role) from public;
grant execute on function public.update_membership_role(uuid, public.membership_role) to authenticated;

-- ---------------------------------------------------------------------
-- remove_membership — só owner/admin; nunca remove o último owner.
-- ---------------------------------------------------------------------

create function public.remove_membership(p_membership_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_membership public.memberships;
  v_remaining_owners int;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_membership from public.memberships where id = p_membership_id for update;

  if v_membership.id is null then
    raise exception 'membership_not_found';
  end if;

  if not private.has_workspace_role(v_membership.workspace_id, array['owner', 'admin']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  if v_membership.role = 'owner' then
    select count(*) into v_remaining_owners
      from public.memberships
      where workspace_id = v_membership.workspace_id
        and role = 'owner'
        and status = 'active'
        and id <> v_membership.id;

    if v_remaining_owners = 0 then
      raise exception 'cannot_remove_last_owner';
    end if;
  end if;

  delete from public.memberships where id = p_membership_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_membership.workspace_id, v_actor, 'membership.removed', 'membership', p_membership_id,
    jsonb_build_object('removed_user_id', v_membership.user_id, 'role', v_membership.role)
  );
end;
$body$;

revoke all on function public.remove_membership(uuid) from public;
grant execute on function public.remove_membership(uuid) to authenticated;
