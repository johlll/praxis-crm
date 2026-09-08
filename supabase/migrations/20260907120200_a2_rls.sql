-- A2 — RLS: habilitada e FORÇADA em toda tabela, com policy separada e
-- explícita por operação (SELECT/INSERT/UPDATE/DELETE). Nenhuma tabela
-- desta fase depende de uma policy genérica.
--
-- Padrão adotado: workspaces/memberships/workspace_invitations/audit_logs
-- não aceitam INSERT/UPDATE/DELETE direto do cliente (policy explícita
-- `with check (false)`, não ausência de policy) — toda escrita de negócio
-- passa pelas funções SECURITY DEFINER da próxima migration, que fazem a
-- validação atômica (último owner, token de convite, auditoria) num só
-- lugar testável. As únicas exceções voluntárias, com política própria e
-- testada, são: workspaces.UPDATE (renomear, restrito a owner/admin) e
-- users.UPDATE (o próprio perfil, com e-mail protegido por trigger).

-- ---------------------------------------------------------------------
-- workspaces
-- ---------------------------------------------------------------------

alter table public.workspaces enable row level security;
alter table public.workspaces force row level security;

create policy workspaces_select on public.workspaces
  for select
  to authenticated
  using (id in (select private.auth_workspace_ids()));

create policy workspaces_insert_deny on public.workspaces
  for insert
  to authenticated
  with check (false);

create policy workspaces_update on public.workspaces
  for update
  to authenticated
  using (private.has_workspace_role(id, array['owner', 'admin']::public.membership_role[]))
  with check (private.has_workspace_role(id, array['owner', 'admin']::public.membership_role[]));

create policy workspaces_delete_deny on public.workspaces
  for delete
  to authenticated
  using (false);

-- ---------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------

alter table public.users enable row level security;
alter table public.users force row level security;

create policy users_select on public.users
  for select
  to authenticated
  using (
    id = (select auth.uid())
    or private.shares_active_workspace_with(id)
  );

create policy users_insert_deny on public.users
  for insert
  to authenticated
  with check (false);

-- Perfil próprio (nome, avatar). O e-mail é protegido à parte por trigger
-- (private.protect_users_email, abaixo) — mesmo um UPDATE que tente mudar
-- o e-mail passa por esta policy, mas o trigger desfaz a mudança se a
-- chamada não vier do sincronismo com auth.users.
create policy users_update_self on public.users
  for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy users_delete_deny on public.users
  for delete
  to authenticated
  using (false);

-- pg_trigger_depth() dentro desta própria trigger nunca é zero — ela
-- mesma já é um nível de aninhamento. profundidade = 1 quer dizer "eu sou o
-- único gatilho ativo agora", ou seja, fui disparada direto por um UPDATE
-- de topo (o cliente, via PostgREST, batendo em public.users). O UPDATE
-- disparado de dentro de private.handle_auth_user_email_change() (gatilho
-- em auth.users) chega aqui em profundidade 2 — aninhado dentro daquele
-- outro gatilho — e passa livre: é a única fonte de verdade para e-mail.
create function private.protect_users_email()
returns trigger
language plpgsql
set search_path = ''
as $body$
begin
  if pg_trigger_depth() = 1 and new.email is distinct from old.email then
    new.email := old.email;
  end if;

  return new;
end;
$body$;

create trigger users_protect_email
  before update on public.users
  for each row execute function private.protect_users_email();

-- ---------------------------------------------------------------------
-- memberships
-- ---------------------------------------------------------------------

alter table public.memberships enable row level security;
alter table public.memberships force row level security;

create policy memberships_select on public.memberships
  for select
  to authenticated
  using (workspace_id in (select private.auth_workspace_ids()));

create policy memberships_insert_deny on public.memberships
  for insert
  to authenticated
  with check (false);

create policy memberships_update_deny on public.memberships
  for update
  to authenticated
  using (false);

create policy memberships_delete_deny on public.memberships
  for delete
  to authenticated
  using (false);

-- ---------------------------------------------------------------------
-- workspace_invitations
-- ---------------------------------------------------------------------

alter table public.workspace_invitations enable row level security;
alter table public.workspace_invitations force row level security;

-- Só owner/admin do workspace enxergam a lista de convites — inclusive
-- pendentes de outra pessoa. Quem recebe o convite nunca faz SELECT direto
-- nesta tabela: usa public.preview_workspace_invitation(token), que roda
-- como SECURITY DEFINER e devolve só o necessário para a tela de aceite.
create policy workspace_invitations_select on public.workspace_invitations
  for select
  to authenticated
  using (
    workspace_id in (select private.auth_workspace_ids())
    and private.has_workspace_role(workspace_id, array['owner', 'admin']::public.membership_role[])
  );

create policy workspace_invitations_insert_deny on public.workspace_invitations
  for insert
  to authenticated
  with check (false);

create policy workspace_invitations_update_deny on public.workspace_invitations
  for update
  to authenticated
  using (false);

create policy workspace_invitations_delete_deny on public.workspace_invitations
  for delete
  to authenticated
  using (false);

-- ---------------------------------------------------------------------
-- audit_logs — append-only: só SELECT tem policy permissiva.
-- ---------------------------------------------------------------------

alter table public.audit_logs enable row level security;
alter table public.audit_logs force row level security;

create policy audit_logs_select on public.audit_logs
  for select
  to authenticated
  using (
    workspace_id in (select private.auth_workspace_ids())
    and private.has_workspace_role(workspace_id, array['owner', 'admin']::public.membership_role[])
  );

create policy audit_logs_insert_deny on public.audit_logs
  for insert
  to authenticated
  with check (false);

create policy audit_logs_update_deny on public.audit_logs
  for update
  to authenticated
  using (false);

create policy audit_logs_delete_deny on public.audit_logs
  for delete
  to authenticated
  using (false);
