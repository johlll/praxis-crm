-- A2 — funções auxiliares no schema `private` (nunca exposto pela Data API).
--
-- private.auth_workspace_ids() é a peça central do isolamento: toda policy
-- de RLS que precisa saber "quais workspaces este usuário pode ver" chama
-- esta função em vez de fazer JOIN direto em public.memberships. Se a
-- policy consultasse public.memberships diretamente, a RLS de
-- public.memberships (que também restringe por workspace) entraria em
-- vigor DENTRO da própria checagem de outra policy — recursão. SECURITY
-- DEFINER quebra esse ciclo: a função roda com o privilégio de quem a
-- definiu, não do chamador, então a leitura interna a memberships ignora a
-- RLS de memberships (com segurança, porque a função só devolve
-- workspace_id, nunca uma linha inteira, e só para o próprio auth.uid()).

create function private.auth_workspace_ids()
returns setof uuid
language sql
security definer
stable
set search_path = ''
as $body$
  select m.workspace_id
  from public.memberships m
  where m.user_id = (select auth.uid())
    and m.status = 'active';
$body$;

comment on function private.auth_workspace_ids() is
  'Workspaces com membership ativa do usuário autenticado. Único caminho que as policies usam para checar acesso — nunca JOIN direto em memberships dentro de outra policy (recursão).';

-- EXECUTE começa revogado de tudo; concedido só para quem a Data API
-- realmente autentica como usuário logado ou anônimo. `anon` também recebe
-- porque políticas em tabelas legíveis por anônimo (nenhuma nesta fase)
-- poderiam precisar chamar a função sem quebrar — e porque negar a `anon`
-- não teria efeito de segurança aqui (a função já só devolve linhas do
-- próprio auth.uid(), que para `anon` é sempre null → conjunto vazio).
revoke all on function private.auth_workspace_ids() from public;
grant execute on function private.auth_workspace_ids() to authenticated, anon;

-- ---------------------------------------------------------------------
-- private.has_workspace_role(workspace_id, papéis[])
--
-- Wrapper de conveniência para "o usuário atual é dono/admin deste
-- workspace específico". Usado tanto em policies (UPDATE/DELETE de
-- memberships e invitations) quanto dentro das funções públicas de negócio
-- da próxima migration.
-- ---------------------------------------------------------------------

create function private.has_workspace_role(
  p_workspace_id uuid,
  p_roles public.membership_role[]
)
returns boolean
language sql
security definer
stable
set search_path = ''
as $body$
  select exists (
    select 1
    from public.memberships m
    where m.workspace_id = p_workspace_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and m.role = any (p_roles)
  );
$body$;

comment on function private.has_workspace_role(uuid, public.membership_role[]) is
  'O usuário autenticado tem, no workspace informado, um papel ativo dentre os listados.';

revoke all on function private.has_workspace_role(uuid, public.membership_role[]) from public;
grant execute on function private.has_workspace_role(uuid, public.membership_role[]) to authenticated;

-- ---------------------------------------------------------------------
-- private.shares_active_workspace_with(user_id)
--
-- Usada só pela policy de SELECT em public.users: um membro só enxerga o
-- perfil (nome, avatar, e-mail) de gente com quem compartilha pelo menos
-- um workspace ativo, além de si mesmo. Evita JOIN direto em memberships
-- dentro da policy de users pelo mesmo motivo de recursão do primeiro
-- comentário.
-- ---------------------------------------------------------------------

create function private.shares_active_workspace_with(p_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $body$
  select exists (
    select 1
    from public.memberships mine
    join public.memberships theirs
      on theirs.workspace_id = mine.workspace_id
    where mine.user_id = (select auth.uid())
      and mine.status = 'active'
      and theirs.user_id = p_user_id
      and theirs.status = 'active'
  );
$body$;

comment on function private.shares_active_workspace_with(uuid) is
  'O usuário autenticado compartilha ao menos um workspace ativo com o usuário informado.';

revoke all on function private.shares_active_workspace_with(uuid) from public;
grant execute on function private.shares_active_workspace_with(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Trigger: cria public.users ao criar auth.users, e mantém e-mail em dia.
-- Tem que rodar como o dono da função (SECURITY DEFINER) porque o
-- INSERT em public.users, de outra forma, cairia na policy de INSERT
-- (que nega tudo vindo do cliente — ver migration de RLS) e o próprio
-- auth.uid() ainda não existe de fato como sessão no momento do signup.
-- ---------------------------------------------------------------------

create function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $body$
begin
  insert into public.users (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do update
    set email = excluded.email,
        updated_at = now();

  return new;
end;
$body$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_auth_user();

create function private.handle_auth_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $body$
begin
  if new.email is distinct from old.email then
    update public.users
      set email = new.email,
          updated_at = now()
      where id = new.id;
  end if;

  return new;
end;
$body$;

create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row execute function private.handle_auth_user_email_change();
