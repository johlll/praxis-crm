-- B5 mínima — tela de auditoria (somente leitura) e transferência de posse.
--
-- Migration NOVA e ADITIVA: duas funções públicas e um auxiliar privado. Não
-- cria tabela, coluna, índice, enum nem dado, e não toca em nenhuma função,
-- policy ou grant existente.
--
-- 1) list_audit_log — leitura da trilha para a tela de Configurações.
--
--    `audit_logs` continua SEM nenhum grant de tabela para `authenticated`
--    (testes 01 e 04 da A2 exigem isso, e a nota da A2 previa "o grant certo
--    é uma nova migration"). Em vez de abrir o SELECT da tabela — que
--    entregaria a coluna `metadata` crua a quem consulta a Data API —, a
--    leitura passa por esta função, que devolve SÓ uma projeção sanitizada:
--      * quando, quem (nome), qual ação;
--      * `details`: lista de permissão de chaves com valor de formato fechado
--        (papéis, ambiente, provedor). Nome de contato, e-mail de convidado,
--        rótulos, identificadores de provedor, telefone, texto de mensagem,
--        token, segredo — nada disso passa, mesmo que algum dia seja gravado
--        em `metadata`;
--      * `target_name`: nome da pessoa-alvo, só para as duas ações cuja
--        pessoa-alvo é membro da equipe (posse transferida, membro removido).
--    Só owner/admin do workspace consultado (mesma regra da policy de SELECT
--    de `audit_logs` e de `audit_log.view` em src/lib/roles.ts). Um workspace
--    de que o chamador não participa é INDISTINGUÍVEL de um que não existe:
--    nos dois casos o erro é `insufficient_permission`.
--    Paginação por cursor composto (created_at, id), como list_conversation_messages
--    da A7: estável com a trilha crescendo e sem pular linhas de mesmo instante.
--    O período é em dias do fuso do escritório (America/Sao_Paulo), inclusivo.
--
-- 2) transfer_workspace_ownership — passa a posse do workspace a outro membro.
--
--    Só um owner ATIVO do workspace chama. O destinatário é identificado por
--    membership DENTRO do workspace informado: membership de outro workspace e
--    membership inexistente dão o mesmo `membership_not_found`. Recusa o
--    próprio chamador, membro que não esteja ativo e qualquer chamador que não
--    seja owner ativo. Os dois papéis (destinatário -> owner, quem transferiu
--    -> admin) mudam numa ÚNICA instrução UPDATE, com as duas linhas travadas em
--    ordem fixa (sem deadlock entre transferências concorrentes); qualquer
--    falha depois disso desfaz a função inteira, então o workspace nunca fica
--    sem owner nem com os papéis pela metade. Grava UMA linha de auditoria
--    (`workspace.ownership_transferred`), só com ids e papéis — sem e-mail nem
--    nome. Não substitui update_membership_role/remove_membership, que seguem
--    iguais.

-- ---------------------------------------------------------------------
-- private.audit_log_safe_details — a lista de permissão da projeção.
--
-- Mantém só entradas string com valor de formato fechado. Qualquer outra
-- chave, ou valor fora do vocabulário, é descartado em silêncio. Não é
-- chamável pelo cliente (sem grant); só pela função de leitura abaixo.
-- ---------------------------------------------------------------------

create function private.audit_log_safe_details(p_metadata jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $body$
  select coalesce(jsonb_object_agg(kv.key, kv.value), '{}'::jsonb)
  from jsonb_each(
    case when jsonb_typeof(p_metadata) = 'object' then p_metadata else '{}'::jsonb end
  ) as kv(key, value)
  where jsonb_typeof(kv.value) = 'string'
    and (
      (
        kv.key in ('role', 'from_role', 'to_role', 'new_owner_previous_role', 'previous_owner_new_role')
        and (kv.value #>> '{}') = any (enum_range(null::public.membership_role)::text[])
      )
      or (kv.key = 'environment' and (kv.value #>> '{}') in ('preview', 'production'))
      or (kv.key = 'provider' and (kv.value #>> '{}') in ('simulated', 'ycloud', 'meta'))
    );
$body$;

comment on function private.audit_log_safe_details(jsonb) is
  'Projeção sanitizada de audit_logs.metadata: só papéis, ambiente e provedor, com valor de vocabulário fechado. Tudo o mais é descartado. Sem grant: só list_audit_log chama.';

revoke all on function private.audit_log_safe_details(jsonb) from public;

-- ---------------------------------------------------------------------
-- list_audit_log
-- ---------------------------------------------------------------------

create function public.list_audit_log(
  p_workspace_id uuid,
  p_action text default null,
  p_actor_user_id uuid default null,
  p_from date default null,
  p_to date default null,
  p_before timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 25
)
returns table (items jsonb, has_more boolean)
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 25), 100));
  v_from timestamptz;
  v_to timestamptz;
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  -- Mesmo erro para "workspace de outra pessoa" e "workspace que não existe".
  if not private.has_workspace_role(
    p_workspace_id, array['owner', 'admin']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  if (p_before is null) <> (p_before_id is null) then
    raise exception 'invalid_cursor';
  end if;

  if p_action is not null
     and (char_length(p_action) > 80 or p_action !~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$') then
    raise exception 'invalid_filter';
  end if;

  if (p_from is not null and not isfinite(p_from))
     or (p_to is not null and not isfinite(p_to))
     or (p_from is not null and p_to is not null and p_from > p_to) then
    raise exception 'invalid_period';
  end if;

  -- Dias inteiros no fuso do escritório: [início de p_from, início do dia
  -- seguinte a p_to).
  if p_from is not null then
    v_from := p_from::timestamp at time zone 'America/Sao_Paulo';
  end if;
  if p_to is not null then
    v_to := (p_to + 1)::timestamp at time zone 'America/Sao_Paulo';
  end if;

  return query
  with page as (
    select a.id, a.created_at, a.action, a.actor_user_id, a.metadata
    from public.audit_logs a
    where a.workspace_id = p_workspace_id
      and (p_action is null or a.action = p_action)
      and (p_actor_user_id is null or a.actor_user_id = p_actor_user_id)
      and (v_from is null or a.created_at >= v_from)
      and (v_to is null or a.created_at < v_to)
      -- Comparação de linha (created_at, id): desempata registros do mesmo
      -- instante pelo id, sem pular nem repetir entre páginas.
      and (p_before is null or (a.created_at, a.id) < (p_before, p_before_id))
    order by a.created_at desc, a.id desc
    limit v_limit + 1
  ),
  shown as (
    select p.id, p.created_at, p.action, p.actor_user_id, p.metadata
    from page p
    order by p.created_at desc, p.id desc
    limit v_limit
  )
  select
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', s.id,
            'created_at', s.created_at,
            'action', s.action,
            'actor_user_id', s.actor_user_id,
            'actor_name', nullif(btrim(coalesce(nullif(btrim(ua.full_name), ''), ua.email)), ''),
            'target_name', nullif(btrim(coalesce(nullif(btrim(ut.full_name), ''), ut.email)), ''),
            'details', private.audit_log_safe_details(s.metadata)
          )
          order by s.created_at desc, s.id desc
        )
        from shown s
        left join public.users ua on ua.id = s.actor_user_id
        -- Pessoa-alvo: só para as duas ações cujo alvo é um membro da equipe,
        -- e só se o valor gravado tiver formato de uuid.
        left join public.users ut on ut.id = (
          case
            when s.action = 'workspace.ownership_transferred'
                 and (s.metadata ->> 'new_owner_user_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then (s.metadata ->> 'new_owner_user_id')::uuid
            when s.action = 'membership.removed'
                 and (s.metadata ->> 'removed_user_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then (s.metadata ->> 'removed_user_id')::uuid
          end
        )
      ),
      '[]'::jsonb
    ),
    (select count(*) from page) > v_limit;
end;
$body$;

comment on function public.list_audit_log(uuid, text, uuid, date, date, timestamptz, uuid, integer) is
  'Trilha de auditoria sanitizada (owner/admin). Nunca devolve metadata crua; paginação por cursor (created_at, id). Workspace alheio = inexistente (insufficient_permission).';

revoke all on function public.list_audit_log(uuid, text, uuid, date, date, timestamptz, uuid, integer) from public, anon;
grant execute on function public.list_audit_log(uuid, text, uuid, date, date, timestamptz, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------
-- transfer_workspace_ownership
-- ---------------------------------------------------------------------

create function public.transfer_workspace_ownership(
  p_workspace_id uuid,
  p_target_membership_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_current public.memberships;
  v_target public.memberships;
  v_updated integer;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  -- Trava as duas linhas que a troca altera (a de quem transfere e a do
  -- destinatário), SEMPRE na mesma ordem (id): duas transferências
  -- simultâneas esperam uma pela outra em vez de se cruzarem. Depois da
  -- espera, as leituras abaixo enxergam o que a outra transação gravou.
  perform 1
  from public.memberships m
  where m.workspace_id = p_workspace_id
    and (m.user_id = v_actor or m.id = p_target_membership_id)
  order by m.id
  for update;

  -- Quem chama precisa ser owner ATIVO deste workspace. Para quem não
  -- participa do workspace (ou ele não existe), o erro é o mesmo.
  select * into v_current
  from public.memberships m
  where m.workspace_id = p_workspace_id
    and m.user_id = v_actor
    and m.status = 'active';

  if v_current.id is null or v_current.role <> 'owner' then
    raise exception 'insufficient_permission';
  end if;

  -- O destinatário é procurado DENTRO deste workspace: membership de outro
  -- workspace e membership inexistente são o mesmo caso.
  select * into v_target
  from public.memberships m
  where m.id = p_target_membership_id
    and m.workspace_id = p_workspace_id;

  if v_target.id is null then
    raise exception 'membership_not_found';
  end if;

  if v_target.user_id = v_actor then
    raise exception 'cannot_transfer_to_self';
  end if;

  if v_target.status <> 'active' then
    raise exception 'membership_not_active';
  end if;

  -- Uma única instrução: o destinatário vira owner e quem transferiu vira
  -- admin juntos. Não há instante, nem para outra transação, em que o
  -- workspace esteja sem owner.
  update public.memberships m
  set role = case
    when m.id = v_target.id then 'owner'::public.membership_role
    else 'admin'::public.membership_role
  end
  where m.id in (v_current.id, v_target.id);

  get diagnostics v_updated = row_count;
  if v_updated <> 2 then
    raise exception 'ownership_transfer_failed';
  end if;

  -- Garantia final (a transação inteira é desfeita se falhar): existe owner
  -- ativo no workspace.
  if not exists (
    select 1
    from public.memberships m
    where m.workspace_id = p_workspace_id
      and m.role = 'owner'
      and m.status = 'active'
  ) then
    raise exception 'ownership_transfer_failed';
  end if;

  -- UMA linha de auditoria, só com ids e papéis (nada de e-mail ou nome).
  -- v_target guarda a linha de ANTES da atualização.
  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    p_workspace_id, v_actor, 'workspace.ownership_transferred', 'workspace', p_workspace_id,
    jsonb_build_object(
      'new_owner_user_id', v_target.user_id,
      'new_owner_previous_role', v_target.role,
      'previous_owner_new_role', 'admin'
    )
  );
end;
$body$;

comment on function public.transfer_workspace_ownership(uuid, uuid) is
  'Owner ativo transfere a posse a outro membro ativo do mesmo workspace: destinatário vira owner e quem transferiu vira admin, atomicamente. Uma linha de auditoria, sem dado pessoal.';

revoke all on function public.transfer_workspace_ownership(uuid, uuid) from public, anon;
grant execute on function public.transfer_workspace_ownership(uuid, uuid) to authenticated;
