-- Conversas + IA — painel do caso, etapa B: identificação do caso, tipo de serviço, roteiro
-- configurável e marcos concluídos.
--
-- Decisões em docs/decisoes/conversas-painel-servico.md. Resumo:
--
--   - NÚMERO INTERNO do caso (oportunidade), separado de qualquer número judicial: único por
--     escritório, sequencial, protegido por uma trava no contador do escritório. A identidade
--     técnica continua sendo o UUID da oportunidade. A migration NÃO numera nada: casos antigos
--     recebem número só por atribuição explícita; daqui em diante, ganhar uma oportunidade lhe
--     dá o próximo número (gatilho no ganho). Número nunca muda nem é reaproveitado.
--   - CATÁLOGO por escritório: tipos de serviço com etapas ordenadas, editáveis por quem
--     configura (owner, admin, manager). Os modelos sugeridos ficam no código e só entram no
--     catálogo por escolha explícita (create_service_type com o código da sugestão).
--   - ROTEIRO APLICADO ao caso = CÓPIA das etapas no momento da aplicação. Alterar ou arquivar o
--     modelo nunca muda um caso que já o usa. Trocar ou remover um roteiro com conclusões exige
--     confirmação explícita, e as conclusões do roteiro anterior ficam no histórico.
--   - O roteiro pertence à oportunidade GANHA e faz parte da MESMA trilha `case_progress`: uma
--     versão só, uma trava só e uma pausa só para o andamento do serviço inteiro (estado e
--     roteiro). Regras de convivência (o banco recusa qualquer combinação contraditória):
--       I1. andamento `concluido` ⇒ todas as etapas do roteiro ativo concluídas;
--       I2. a etapa atual, quando existe, é uma etapa PENDENTE do roteiro ativo;
--       I3. no máximo um roteiro ativo por caso.
--     Concluir uma etapa nunca é inferido: nem pela posição, nem por escolher uma etapa posterior
--     como atual, nem por arquivo recebido. Nenhuma operação daqui muda a situação do atendimento
--     ou a etapa comercial.
--   - Cada operação é uma decisão humana: incrementa a versão da trilha, grava o marco
--     (manual_decided_at), registra um evento imutável (quem, quando, alvo) e aceita chave de
--     idempotência. Quando uma operação muda também o andamento (reabrir uma etapa de um caso
--     concluído), as duas mudanças acontecem na mesma transação e entram nos dois históricos.
--   - Uma chave de idempotência por escritório vale para um único pedido em TODOS os históricos da
--     trilha (situação do atendimento, andamento e roteiro): registro único compartilhado,
--     preenchido por gatilho nas duas tabelas de histórico, sem depender de leitura cruzada.
--   - Exportação do titular (C3a): três seções novas. Anonimização (C3b): os registros novos são
--     esqueleto (códigos, datas, nomes de etapa do catálogo, nada de texto livre do caso) e ficam
--     imutáveis depois da anonimização, como o restante do esqueleto.
--
-- Migration ADITIVA: tabelas novas deny-all, funções novas, um gatilho novo em `opportunities`
-- (só atribui o número no ganho), gatilhos de registro da chave em `status_track_events` (com a
-- cópia das chaves já gravadas, sem alterar linha antiga) e `create or replace`, com a MESMA
-- assinatura, de private.status_track_replay (consulta o registro), set_opportunity_case_progress
-- (regra I1), private.conversation_case_item (chaves novas) e private.privacy_export_payload
-- (seções novas; as anteriores ficam iguais).

-- =====================================================================
-- 1) Número interno do caso
-- =====================================================================

create table public.case_number_counters (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  last_value integer not null default 0 check (last_value >= 0),
  updated_at timestamptz not null default now()
);

comment on table public.case_number_counters is
  'Painel do caso (etapa B): último número interno de caso usado por escritório. A linha é travada a cada atribuição; o número nunca volta nem é reaproveitado.';

create table public.opportunity_case_numbers (
  opportunity_id uuid primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  number integer not null check (number > 0),
  -- manual = atribuição explícita (casos antigos ou antes do ganho); win = no ganho da oportunidade.
  assigned_via text not null check (assigned_via in ('manual', 'win')),
  assigned_by uuid references auth.users (id) on delete restrict,
  assigned_at timestamptz not null default clock_timestamp(),
  constraint opportunity_case_numbers_number_key unique (workspace_id, number),
  constraint opportunity_case_numbers_opportunity_fkey
    foreign key (workspace_id, opportunity_id) references public.opportunities (workspace_id, id) on delete cascade,
  constraint opportunity_case_numbers_manual_actor check (assigned_via <> 'manual' or assigned_by is not null)
);

comment on table public.opportunity_case_numbers is
  'Painel do caso (etapa B): número interno do caso (oportunidade), único por escritório e separado de qualquer número judicial. Sem linha = caso sem número (nada é inventado). Imutável.';

-- =====================================================================
-- 2) Catálogo: tipos de serviço e etapas-modelo
-- =====================================================================

create table public.service_types (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80 and name = btrim(name)),
  -- Código do modelo sugerido de onde a cópia saiu (só rastreio; a cópia é do escritório).
  suggestion_code text check (suggestion_code ~ '^[a-z0-9_]{1,40}$'),
  version integer not null default 1 check (version >= 1),
  archived_at timestamptz,
  archived_by uuid references auth.users (id) on delete restrict,
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint service_types_workspace_id_id_key unique (workspace_id, id),
  constraint service_types_archive_consistency check ((archived_at is null) = (archived_by is null))
);

create unique index service_types_active_name_key on public.service_types (workspace_id, lower(name))
  where archived_at is null;

comment on table public.service_types is
  'Painel do caso (etapa B): catálogo de tipos de serviço do escritório. Editar ou arquivar um tipo nunca muda os casos que já o aplicaram (o caso guarda a própria cópia das etapas).';

create table public.service_type_steps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  service_type_id uuid not null,
  position integer not null check (position between 1 and 30),
  name text not null check (char_length(name) between 1 and 80 and name = btrim(name)),
  constraint service_type_steps_position_key unique (service_type_id, position),
  constraint service_type_steps_type_fkey
    foreign key (workspace_id, service_type_id) references public.service_types (workspace_id, id) on delete cascade
);

comment on table public.service_type_steps is
  'Painel do caso (etapa B): etapas-modelo de um tipo de serviço, em ordem. Só servem de molde: aplicar o tipo a um caso COPIA as etapas.';

-- =====================================================================
-- 3) Roteiro aplicado ao caso, etapas copiadas e histórico
-- =====================================================================

create table public.case_service_plans (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  opportunity_id uuid not null,
  -- Tipo de origem (para mostrar que o modelo mudou depois); o nome e a versão ficam copiados.
  service_type_id uuid,
  service_type_name text not null check (char_length(service_type_name) between 1 and 80),
  service_type_version integer not null check (service_type_version >= 1),
  status text not null default 'active' check (status in ('active', 'replaced', 'removed')),
  -- Etapa em que o serviço está agora (I2: pendente e deste roteiro); nula = nenhuma definida.
  current_step_id uuid,
  applied_at timestamptz not null default clock_timestamp(),
  applied_by uuid not null references auth.users (id) on delete restrict,
  ended_at timestamptz,
  ended_by uuid references auth.users (id) on delete restrict,
  constraint case_service_plans_workspace_id_id_key unique (workspace_id, id),
  constraint case_service_plans_opportunity_fkey
    foreign key (workspace_id, opportunity_id) references public.opportunities (workspace_id, id) on delete cascade,
  constraint case_service_plans_type_fkey
    foreign key (workspace_id, service_type_id) references public.service_types (workspace_id, id),
  constraint case_service_plans_end_consistency check (
    (status = 'active' and ended_at is null and ended_by is null)
    or (status <> 'active' and ended_at is not null and ended_by is not null and current_step_id is null)
  )
);

create unique index case_service_plans_one_active_key on public.case_service_plans (opportunity_id)
  where status = 'active';
create index case_service_plans_opportunity_idx on public.case_service_plans (opportunity_id, applied_at desc);
create index case_service_plans_type_idx on public.case_service_plans (service_type_id) where status = 'active';

comment on table public.case_service_plans is
  'Painel do caso (etapa B): roteiro de etapas aplicado a uma oportunidade GANHA. Um ativo por caso; trocar ou remover encerra o roteiro (replaced/removed) sem apagar nada.';

create table public.case_service_plan_steps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  plan_id uuid not null,
  position integer not null check (position between 1 and 30),
  name text not null check (char_length(name) between 1 and 80),
  -- Conclusão EFETIVAMENTE registrada (quem e quando). Nunca inferida pela posição.
  completed_at timestamptz,
  completed_by uuid references auth.users (id) on delete restrict,
  constraint case_service_plan_steps_position_key unique (plan_id, position),
  constraint case_service_plan_steps_plan_fkey
    foreign key (workspace_id, plan_id) references public.case_service_plans (workspace_id, id) on delete cascade,
  constraint case_service_plan_steps_completion_consistency check ((completed_at is null) = (completed_by is null))
);

comment on table public.case_service_plan_steps is
  'Painel do caso (etapa B): etapas COPIADAS para o roteiro do caso (nome e ordem não mudam depois). A conclusão é um registro explícito (completed_at/by); reabrir limpa a conclusão atual e o histórico guarda as duas.';

create table public.case_service_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  opportunity_id uuid not null,
  plan_id uuid not null,
  op text not null check (op in (
    'plan_applied', 'plan_replaced', 'plan_removed',
    'step_completed', 'step_reopened', 'current_step_set', 'current_step_cleared')),
  step_id uuid,
  previous_plan_id uuid,
  current_step_before uuid,
  current_step_after uuid,
  -- Só quando a MESMA operação mudou também o andamento (reabrir etapa de caso concluído).
  progress_from public.case_progress_status,
  progress_to public.case_progress_status,
  from_version bigint not null check (from_version >= 0),
  to_version bigint not null,
  -- Nesta etapa só existe autor humano; o aplicador futuro amplia a regra junto com a própria autoria.
  actor_kind text not null default 'user' check (actor_kind in ('user')),
  actor_user_id uuid not null references auth.users (id) on delete restrict,
  idempotency_key uuid,
  request_fingerprint text not null,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint case_service_events_workspace_id_id_key unique (workspace_id, id),
  constraint case_service_events_opportunity_fkey
    foreign key (workspace_id, opportunity_id) references public.opportunities (workspace_id, id) on delete cascade,
  constraint case_service_events_plan_fkey
    foreign key (workspace_id, plan_id) references public.case_service_plans (workspace_id, id) on delete cascade,
  constraint case_service_events_version_step check (to_version = from_version + 1),
  constraint case_service_events_shape check (
    (op in ('step_completed', 'step_reopened') and step_id is not null)
    or (op not in ('step_completed', 'step_reopened') and step_id is null)
  ),
  constraint case_service_events_replace_shape check ((op = 'plan_replaced') = (previous_plan_id is not null)),
  constraint case_service_events_progress_shape check (
    (progress_from is null and progress_to is null)
    or (op = 'step_reopened' and progress_from = 'concluido' and progress_to is not null
        and progress_to not in ('concluido', 'nao_informado'))
  )
);

create unique index case_service_events_idempotency_key on public.case_service_events (workspace_id, idempotency_key)
  where idempotency_key is not null;
create index case_service_events_opportunity_idx on public.case_service_events (opportunity_id, occurred_at desc, id desc);
create index case_service_events_plan_idx on public.case_service_events (plan_id);

comment on table public.case_service_events is
  'Painel do caso (etapa B): histórico imutável do roteiro do caso (aplicar, trocar, remover, concluir, reabrir e definir a etapa atual), com autor, horário, alvo, versão da trilha case_progress e chave de idempotência.';

alter table public.case_number_counters enable row level security;
alter table public.case_number_counters force row level security;
revoke all on table public.case_number_counters from public, anon, authenticated;
alter table public.opportunity_case_numbers enable row level security;
alter table public.opportunity_case_numbers force row level security;
revoke all on table public.opportunity_case_numbers from public, anon, authenticated;
alter table public.service_types enable row level security;
alter table public.service_types force row level security;
revoke all on table public.service_types from public, anon, authenticated;
alter table public.service_type_steps enable row level security;
alter table public.service_type_steps force row level security;
revoke all on table public.service_type_steps from public, anon, authenticated;
alter table public.case_service_plans enable row level security;
alter table public.case_service_plans force row level security;
revoke all on table public.case_service_plans from public, anon, authenticated;
alter table public.case_service_plan_steps enable row level security;
alter table public.case_service_plan_steps force row level security;
revoke all on table public.case_service_plan_steps from public, anon, authenticated;
alter table public.case_service_events enable row level security;
alter table public.case_service_events force row level security;
revoke all on table public.case_service_events from public, anon, authenticated;

create trigger service_types_set_updated_at before update on public.service_types
  for each row execute function private.set_updated_at();

-- =====================================================================
-- 4) Integridade: o que é histórico não muda, e o esqueleto anonimizado é imutável (C3b)
-- =====================================================================

create function private.case_service_integrity_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_opportunity_id uuid;
  v_plan_status text;
begin
  if tg_table_name = 'opportunity_case_numbers' then
    if tg_op = 'UPDATE' then
      raise exception 'case_number_immutable';
    end if;
    v_opportunity_id := new.opportunity_id;
  elsif tg_table_name = 'case_service_plans' then
    if tg_op = 'INSERT' and new.status <> 'active' then
      raise exception 'service_plan_immutable';
    end if;
    if tg_op = 'UPDATE' and (
      old.status <> 'active'
      or new.workspace_id is distinct from old.workspace_id
      or new.opportunity_id is distinct from old.opportunity_id
      or new.service_type_id is distinct from old.service_type_id
      or new.service_type_name is distinct from old.service_type_name
      or new.service_type_version is distinct from old.service_type_version
      or new.applied_at is distinct from old.applied_at
      or new.applied_by is distinct from old.applied_by
    ) then
      raise exception 'service_plan_immutable';
    end if;
    v_opportunity_id := new.opportunity_id;
  elsif tg_table_name = 'case_service_plan_steps' then
    if tg_op = 'UPDATE' and (
      new.workspace_id is distinct from old.workspace_id
      or new.plan_id is distinct from old.plan_id
      or new.position is distinct from old.position
      or new.name is distinct from old.name
    ) then
      raise exception 'service_plan_immutable';
    end if;
    select p.opportunity_id, p.status into v_opportunity_id, v_plan_status
    from public.case_service_plans p where p.id = new.plan_id;
    -- Só o roteiro ATIVO recebe conclusões; o de um roteiro encerrado é histórico.
    if v_plan_status is distinct from 'active' then
      raise exception 'service_plan_immutable';
    end if;
  else
    if tg_op = 'UPDATE' then
      raise exception 'service_history_immutable';
    end if;
    v_opportunity_id := new.opportunity_id;
  end if;

  if v_opportunity_id is not null and private.privacy_opportunity_anonymized(v_opportunity_id) then
    raise exception 'contact_anonymized';
  end if;
  return new;
end;
$body$;

revoke all on function private.case_service_integrity_guard() from public, anon, authenticated, service_role;

create trigger opportunity_case_numbers_integrity_guard before insert or update on public.opportunity_case_numbers
  for each row execute function private.case_service_integrity_guard();
create trigger case_service_plans_integrity_guard before insert or update on public.case_service_plans
  for each row execute function private.case_service_integrity_guard();
create trigger case_service_plan_steps_integrity_guard before insert or update on public.case_service_plan_steps
  for each row execute function private.case_service_integrity_guard();
create trigger case_service_events_integrity_guard before insert or update on public.case_service_events
  for each row execute function private.case_service_integrity_guard();

-- =====================================================================
-- 4b) Uma chave de idempotência por escritório entre os históricos da trilha
--
-- A situação do atendimento e o andamento gravam em status_track_events; o roteiro grava em
-- case_service_events. Cada tabela tem o próprio índice único, e dois casos diferentes usam travas
-- diferentes, então conferir uma tabela a partir da outra (leitura) não impede que duas sessões
-- gravem a MESMA chave ao mesmo tempo, uma em cada histórico. O contrato é o de sempre: uma chave,
-- dentro do escritório, representa um único pedido.
--
-- Garantia estrutural: um registro único (escritório, chave), preenchido por GATILHO em cada uma
-- das duas tabelas — qualquer escritor, atual ou futuro (o aplicador automático incluído), passa
-- por ele. A segunda gravação da mesma chave espera a primeira transação terminar: se ela
-- confirmar, recebe unique_violation (as funções devolvem idempotency_conflict); se desfizer, a
-- chave fica livre e a segunda grava. Cada operação grava UMA chave, sempre depois da trava da
-- própria trilha, e nada espera trava de trilha depois de gravar a chave: sem ciclo de espera.
--
-- A leitura antecipada (status_track_key_assert_free) só adianta a resposta quando a chave já foi
-- confirmada no outro histórico, antes da conferência de versão; quem decide é o índice único.
-- O registro só tem códigos (escritório, chave, origem, id do evento), nenhum dado pessoal; some
-- junto com o evento (exclusão em cascata da conversa ou da oportunidade) e com o escritório.
-- =====================================================================

create table public.status_track_idempotency_keys (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  idempotency_key uuid not null,
  source text not null check (source in ('status_track_events', 'case_service_events')),
  event_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint status_track_idempotency_keys_pkey primary key (workspace_id, idempotency_key)
);

create index status_track_idempotency_keys_event_idx on public.status_track_idempotency_keys (event_id);

comment on table public.status_track_idempotency_keys is
  'Painel do caso (etapa B): registro único das chaves de idempotência por escritório, comum a status_track_events (situação do atendimento e andamento) e case_service_events (roteiro). Preenchido e limpo por gatilho; a chave nunca representa dois pedidos.';

alter table public.status_track_idempotency_keys enable row level security;
alter table public.status_track_idempotency_keys force row level security;
revoke all on table public.status_track_idempotency_keys from public, anon, authenticated, service_role;

create function private.status_track_key_register()
returns trigger
language plpgsql
security definer
set search_path = ''
as $body$
begin
  if tg_op = 'INSERT' then
    insert into public.status_track_idempotency_keys (workspace_id, idempotency_key, source, event_id)
    values (new.workspace_id, new.idempotency_key, tg_table_name, new.id);
    return new;
  end if;
  delete from public.status_track_idempotency_keys
  where workspace_id = old.workspace_id and idempotency_key = old.idempotency_key and event_id = old.id;
  return old;
end;
$body$;

revoke all on function private.status_track_key_register() from public, anon, authenticated, service_role;

-- As chaves já gravadas entram no registro (a trava impede gravação nova entre a cópia e o gatilho).
-- case_service_events nasce nesta migration, vazia.
lock table public.status_track_events in share row exclusive mode;

insert into public.status_track_idempotency_keys (workspace_id, idempotency_key, source, event_id, created_at)
select e.workspace_id, e.idempotency_key, 'status_track_events', e.id, e.occurred_at
from public.status_track_events e
where e.idempotency_key is not null;

create trigger status_track_events_key_register after insert on public.status_track_events
  for each row when (new.idempotency_key is not null) execute function private.status_track_key_register();
create trigger status_track_events_key_release after delete on public.status_track_events
  for each row when (old.idempotency_key is not null) execute function private.status_track_key_register();
create trigger case_service_events_key_register after insert on public.case_service_events
  for each row when (new.idempotency_key is not null) execute function private.status_track_key_register();
create trigger case_service_events_key_release after delete on public.case_service_events
  for each row when (old.idempotency_key is not null) execute function private.status_track_key_register();

-- Resposta antecipada: a chave já foi confirmada no OUTRO histórico → idempotency_conflict.
create function private.status_track_key_assert_free(p_workspace_id uuid, p_key uuid, p_source text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $body$
begin
  if p_key is not null and exists (
    select 1 from public.status_track_idempotency_keys k
    where k.workspace_id = p_workspace_id and k.idempotency_key = p_key and k.source <> p_source) then
    raise exception 'idempotency_conflict';
  end if;
end;
$body$;

revoke all on function private.status_track_key_assert_free(uuid, uuid, text) from public, anon, authenticated, service_role;

-- Repetição nas trilhas (situação do atendimento e andamento): igual à da fundação, mais a consulta
-- ao registro compartilhado quando a chave não está em status_track_events. Com isso a situação do
-- atendimento, que não foi recriada aqui, também recusa a chave do roteiro, antes da versão.
-- `create or replace` com a mesma assinatura preserva a ACL (fechada).
create or replace function private.status_track_replay(
  p_workspace_id uuid,
  p_key uuid,
  p_track_id uuid,
  p_to_status text,
  p_evidence uuid[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_event public.status_track_events;
  v_row public.status_tracks;
  v_saved uuid[];
begin
  if p_key is null then
    return null;
  end if;
  select * into v_event from public.status_track_events
  where workspace_id = p_workspace_id and idempotency_key = p_key;
  if v_event.id is null then
    perform private.status_track_key_assert_free(p_workspace_id, p_key, 'status_track_events');
    return null;
  end if;

  select coalesce(array_agg(message_id order by message_id), '{}'::uuid[]) into v_saved
  from public.status_track_event_evidence where event_id = v_event.id;

  if v_event.track_id <> p_track_id
     or v_event.event <> 'status_changed'
     or v_event.to_status <> p_to_status
     or v_saved <> coalesce((select array_agg(x order by x) from unnest(p_evidence) x), '{}'::uuid[]) then
    raise exception 'idempotency_conflict';
  end if;

  select * into v_row from public.status_tracks where id = v_event.track_id;
  return private.status_track_state_json(v_row)
    || jsonb_build_object('event_id', v_event.id, 'event_version', v_event.to_version, 'replayed', true);
end;
$body$;

-- =====================================================================
-- 5) Número interno: atribuição (explícita ou no ganho)
-- =====================================================================

-- Trava o contador do escritório e atribui o próximo número, se a oportunidade ainda não tem um.
-- Duas atribuições simultâneas da mesma oportunidade: a segunda espera a trava, relê e devolve o
-- número já gravado (sem gastar outro). Devolve o registro e se foi atribuído agora.
create function private.case_number_assign(
  p_workspace_id uuid,
  p_opportunity_id uuid,
  p_via text,
  p_actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_row public.opportunity_case_numbers;
  v_next integer;
begin
  insert into public.case_number_counters (workspace_id) values (p_workspace_id) on conflict do nothing;
  perform 1 from public.case_number_counters where workspace_id = p_workspace_id for update;

  select * into v_row from public.opportunity_case_numbers where opportunity_id = p_opportunity_id;
  if v_row.opportunity_id is not null then
    return jsonb_build_object('number', v_row.number, 'assigned_via', v_row.assigned_via,
                              'assigned_at', v_row.assigned_at, 'assigned_now', false);
  end if;

  update public.case_number_counters
  set last_value = last_value + 1, updated_at = now()
  where workspace_id = p_workspace_id
  returning last_value into v_next;

  insert into public.opportunity_case_numbers (opportunity_id, workspace_id, number, assigned_via, assigned_by)
  values (p_opportunity_id, p_workspace_id, v_next, p_via, p_actor)
  returning * into v_row;

  return jsonb_build_object('number', v_row.number, 'assigned_via', v_row.assigned_via,
                            'assigned_at', v_row.assigned_at, 'assigned_now', true);
end;
$body$;

revoke all on function private.case_number_assign(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;

-- Daqui em diante, ganhar uma oportunidade lhe dá o próximo número. Não toca no win_opportunity:
-- só reage à mudança de status. Casos ganhos ANTES desta migration não são numerados por ela.
create function private.case_number_on_win()
returns trigger
language plpgsql
security definer
set search_path = ''
as $body$
begin
  perform private.case_number_assign(
    new.workspace_id, new.id, 'win',
    (select u.id from auth.users u where u.id = auth.uid()));
  return null;
end;
$body$;

revoke all on function private.case_number_on_win() from public, anon, authenticated, service_role;

create trigger opportunities_case_number_on_win after update of status on public.opportunities
  for each row when (new.status = 'won' and old.status is distinct from 'won')
  execute function private.case_number_on_win();

-- Atribuição explícita (casos antigos, ou um caso ainda aberto). Quem edita a oportunidade, no
-- alcance do lead. Repetir devolve o número já atribuído (nada muda).
create function public.assign_opportunity_case_number(p_opportunity_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_target record;
  v_result jsonb;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;
  if p_opportunity_id is null then
    raise exception 'invalid_request';
  end if;

  select * into v_target from private.status_track_target('commercial_stage', p_opportunity_id, v_actor);
  if v_target.role not in ('owner', 'admin', 'manager', 'lawyer', 'sales') then
    raise exception 'insufficient_permission';
  end if;
  if v_target.opportunity_status = 'lost' then
    raise exception 'opportunity_closed';
  end if;

  v_result := private.case_number_assign(v_target.workspace_id, p_opportunity_id, 'manual', v_actor);

  if (v_result ->> 'assigned_now')::boolean then
    insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
    values (v_target.workspace_id, v_actor, 'opportunity.case_number_assigned', 'opportunity', p_opportunity_id,
            jsonb_build_object('number', (v_result ->> 'number')::integer, 'via', 'manual'));
  end if;

  return v_result || jsonb_build_object('opportunity_id', p_opportunity_id);
end;
$body$;

comment on function public.assign_opportunity_case_number(uuid) is
  'Painel do caso (etapa B): atribui o próximo número interno a um caso sem número (aberto ou ganho), por escolha explícita. Repetir devolve o número existente. Número interno não é número judicial.';

revoke all on function public.assign_opportunity_case_number(uuid) from public, anon;
grant execute on function public.assign_opportunity_case_number(uuid) to authenticated;

-- =====================================================================
-- 6) Catálogo: criar, editar, arquivar e listar tipos de serviço
-- =====================================================================

-- Nome normalizado (espaços colapsados e aparados).
create function private.service_text_clean(p_value text)
returns text
language sql
immutable
set search_path = ''
as $body$
  select nullif(btrim(regexp_replace(coalesce(p_value, ''), '\s+', ' ', 'g')), '');
$body$;

revoke all on function private.service_text_clean(text) from public, anon, authenticated, service_role;

-- Etapas: de 1 a 30, cada uma com 1 a 80 caracteres, sem repetir (ignorando maiúsculas).
create function private.service_type_clean_steps(p_steps text[])
returns text[]
language plpgsql
immutable
set search_path = ''
as $body$
declare
  v_steps text[];
begin
  if p_steps is null then
    raise exception 'service_type_invalid_steps';
  end if;
  select coalesce(array_agg(private.service_text_clean(s) order by ord), '{}'::text[]) into v_steps
  from unnest(p_steps) with ordinality u(s, ord);
  if cardinality(v_steps) < 1 or cardinality(v_steps) > 30
     or array_position(v_steps, null) is not null
     or exists (select 1 from unnest(v_steps) s where char_length(s) > 80)
     or (select count(distinct lower(s)) from unnest(v_steps) s) <> cardinality(v_steps) then
    raise exception 'service_type_invalid_steps';
  end if;
  return v_steps;
end;
$body$;

revoke all on function private.service_type_clean_steps(text[]) from public, anon, authenticated, service_role;

create function private.service_type_clean_name(p_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $body$
declare
  v_name text := private.service_text_clean(p_name);
begin
  if v_name is null or char_length(v_name) > 80 then
    raise exception 'service_type_invalid_name';
  end if;
  return v_name;
end;
$body$;

revoke all on function private.service_type_clean_name(text) from public, anon, authenticated, service_role;

create function public.create_service_type(
  p_workspace_id uuid,
  p_name text,
  p_steps text[],
  p_suggestion_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_name text;
  v_steps text[];
  v_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;
  if not private.has_workspace_role(p_workspace_id, array['owner', 'admin', 'manager']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  v_name := private.service_type_clean_name(p_name);
  v_steps := private.service_type_clean_steps(p_steps);
  if p_suggestion_code is not null and p_suggestion_code !~ '^[a-z0-9_]{1,40}$' then
    raise exception 'invalid_request';
  end if;

  if (select count(*) from public.service_types where workspace_id = p_workspace_id and archived_at is null) >= 100 then
    raise exception 'service_type_limit_reached';
  end if;

  begin
    insert into public.service_types (workspace_id, name, suggestion_code, created_by)
    values (p_workspace_id, v_name, p_suggestion_code, v_actor)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'service_type_name_taken';
  end;

  insert into public.service_type_steps (workspace_id, service_type_id, position, name)
  select p_workspace_id, v_id, ord, s from unnest(v_steps) with ordinality u(s, ord);

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (p_workspace_id, v_actor, 'service_type.created', 'service_type', v_id,
          jsonb_build_object('version', 1, 'steps', cardinality(v_steps), 'from_suggestion', p_suggestion_code is not null));

  return jsonb_build_object('id', v_id, 'version', 1);
end;
$body$;

comment on function public.create_service_type(uuid, text, text[], text) is
  'Painel do caso (etapa B): cria um tipo de serviço com etapas ordenadas no catálogo do escritório (owner, admin, manager). p_suggestion_code só registra de qual modelo sugerido a cópia saiu.';

revoke all on function public.create_service_type(uuid, text, text[], text) from public, anon;
grant execute on function public.create_service_type(uuid, text, text[], text) to authenticated;

-- Edita nome e etapas do MODELO. Os casos que já aplicaram o tipo guardam a própria cópia e não
-- mudam. Versão esperada obrigatória (service_type_conflict).
create function public.update_service_type(
  p_service_type_id uuid,
  p_name text,
  p_steps text[],
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_type public.service_types;
  v_name text;
  v_steps text[];
  v_old_steps text[];
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_type from public.service_types where id = p_service_type_id for update;
  if v_type.id is null
     or not private.has_workspace_role(v_type.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]) then
    raise exception 'service_type_not_found';
  end if;
  if not private.has_workspace_role(v_type.workspace_id, array['owner', 'admin', 'manager']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;
  if v_type.archived_at is not null then
    raise exception 'service_type_archived';
  end if;
  if p_expected_version is null or p_expected_version <> v_type.version then
    raise exception 'service_type_conflict';
  end if;

  v_name := private.service_type_clean_name(p_name);
  v_steps := private.service_type_clean_steps(p_steps);
  select coalesce(array_agg(name order by position), '{}'::text[]) into v_old_steps
  from public.service_type_steps where service_type_id = v_type.id;

  if v_name = v_type.name and v_steps = v_old_steps then
    return jsonb_build_object('id', v_type.id, 'version', v_type.version, 'changed', false);
  end if;

  begin
    update public.service_types set name = v_name, version = version + 1
    where id = v_type.id
    returning * into v_type;
  exception when unique_violation then
    raise exception 'service_type_name_taken';
  end;

  delete from public.service_type_steps where service_type_id = v_type.id;
  insert into public.service_type_steps (workspace_id, service_type_id, position, name)
  select v_type.workspace_id, v_type.id, ord, s from unnest(v_steps) with ordinality u(s, ord);

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_type.workspace_id, v_actor, 'service_type.updated', 'service_type', v_type.id,
          jsonb_build_object('version', v_type.version, 'steps', cardinality(v_steps)));

  return jsonb_build_object('id', v_type.id, 'version', v_type.version, 'changed', true);
end;
$body$;

comment on function public.update_service_type(uuid, text, text[], integer) is
  'Painel do caso (etapa B): edita nome e etapas de um tipo de serviço. Não altera os roteiros já aplicados (cada caso guarda a sua cópia). Versão esperada obrigatória.';

revoke all on function public.update_service_type(uuid, text, text[], integer) from public, anon;
grant execute on function public.update_service_type(uuid, text, text[], integer) to authenticated;

create function public.set_service_type_archived(
  p_service_type_id uuid,
  p_archived boolean,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_type public.service_types;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;
  if p_archived is null then
    raise exception 'invalid_request';
  end if;

  select * into v_type from public.service_types where id = p_service_type_id for update;
  if v_type.id is null
     or not private.has_workspace_role(v_type.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]) then
    raise exception 'service_type_not_found';
  end if;
  if not private.has_workspace_role(v_type.workspace_id, array['owner', 'admin', 'manager']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;
  if p_expected_version is null or p_expected_version <> v_type.version then
    raise exception 'service_type_conflict';
  end if;
  if (v_type.archived_at is not null) = p_archived then
    return jsonb_build_object('id', v_type.id, 'version', v_type.version, 'archived', p_archived, 'changed', false);
  end if;

  begin
    update public.service_types
    set archived_at = case when p_archived then now() end,
        archived_by = case when p_archived then v_actor end,
        version = version + 1
    where id = v_type.id
    returning * into v_type;
  exception when unique_violation then
    raise exception 'service_type_name_taken';
  end;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_type.workspace_id, v_actor,
          case when p_archived then 'service_type.archived' else 'service_type.restored' end,
          'service_type', v_type.id, jsonb_build_object('version', v_type.version));

  return jsonb_build_object('id', v_type.id, 'version', v_type.version, 'archived', p_archived, 'changed', true);
end;
$body$;

comment on function public.set_service_type_archived(uuid, boolean, integer) is
  'Painel do caso (etapa B): arquiva ou restaura um tipo de serviço. Arquivado não pode ser aplicado a novos casos; os casos que já o usam não mudam.';

revoke all on function public.set_service_type_archived(uuid, boolean, integer) from public, anon;
grant execute on function public.set_service_type_archived(uuid, boolean, integer) to authenticated;

-- Catálogo do escritório (qualquer membro lê; os nomes aparecem nos casos).
create function public.list_service_types(p_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $body$
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;
  if not private.has_workspace_role(p_workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', t.id,
      'name', t.name,
      'version', t.version,
      'suggestion_code', t.suggestion_code,
      'archived', t.archived_at is not null,
      'archived_at', t.archived_at,
      'created_at', t.created_at,
      'updated_at', t.updated_at,
      'steps', coalesce((
        select jsonb_agg(jsonb_build_object('position', s.position, 'name', s.name) order by s.position)
        from public.service_type_steps s where s.service_type_id = t.id), '[]'::jsonb),
      -- Quantos casos usam o tipo hoje (roteiro ativo): só um número, sem identificar casos.
      'active_cases', (
        select count(*) from public.case_service_plans p
        where p.workspace_id = t.workspace_id and p.service_type_id = t.id and p.status = 'active')
    ) order by (t.archived_at is not null), lower(t.name), t.id)
    from public.service_types t
    where t.workspace_id = p_workspace_id
  ), '[]'::jsonb);
end;
$body$;

comment on function public.list_service_types(uuid) is
  'Painel do caso (etapa B): catálogo de tipos de serviço do escritório, com as etapas-modelo e quantos casos usam cada tipo agora.';

revoke all on function public.list_service_types(uuid) from public, anon;
grant execute on function public.list_service_types(uuid) to authenticated;

-- =====================================================================
-- 7) Leitura do serviço de um caso
-- =====================================================================

create function private.user_display_name(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $body$
  select nullif(btrim(coalesce(nullif(btrim(u.full_name), ''), u.email)), '')
  from public.users u where u.id = p_user_id;
$body$;

revoke all on function private.user_display_name(uuid) from public, anon, authenticated, service_role;

-- Etapas pendentes do roteiro ativo (0 sem roteiro).
create function private.case_service_pending_steps(p_opportunity_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $body$
  select count(*)::integer
  from public.case_service_plans p
  join public.case_service_plan_steps s on s.plan_id = p.id
  where p.opportunity_id = p_opportunity_id and p.status = 'active' and s.completed_at is null;
$body$;

revoke all on function private.case_service_pending_steps(uuid) from public, anon, authenticated, service_role;

-- Projeção do serviço do caso (sem checagem de alcance: quem chama já conferiu).
create function private.case_service_view(p_opportunity_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $body$
  select jsonb_build_object(
    'opportunity_id', o.id,
    'opportunity_status', o.status,
    'applicable', o.status = 'won',
    'case_number', (
      select jsonb_build_object(
        'number', n.number, 'assigned_via', n.assigned_via, 'assigned_at', n.assigned_at,
        'assigned_by_name', private.user_display_name(n.assigned_by))
      from public.opportunity_case_numbers n where n.opportunity_id = o.id),
    'version', coalesce(t.version, 0),
    'status', case when o.status = 'won' then coalesce(t.case_progress_status::text, 'nao_informado') end,
    'automation_paused', coalesce(t.automation_paused, false),
    'manual_decided_at', t.manual_decided_at,
    'plan', (
      select jsonb_build_object(
        'id', p.id,
        'service_type_id', p.service_type_id,
        'service_type_name', p.service_type_name,
        'service_type_version', p.service_type_version,
        'template_name', st.name,
        'template_version', st.version,
        'template_archived', st.archived_at is not null,
        'applied_at', p.applied_at,
        'applied_by_name', private.user_display_name(p.applied_by),
        'current_step_id', p.current_step_id,
        'has_records', exists (
          select 1 from public.case_service_events e
          where e.plan_id = p.id and e.op in ('step_completed', 'step_reopened')),
        'steps', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', s.id, 'position', s.position, 'name', s.name,
            'completed_at', s.completed_at,
            'completed_by_name', private.user_display_name(s.completed_by))
            order by s.position)
          from public.case_service_plan_steps s where s.plan_id = p.id), '[]'::jsonb))
      from public.case_service_plans p
      left join public.service_types st on st.id = p.service_type_id
      where p.opportunity_id = o.id and p.status = 'active'),
    'previous_plans', (
      select count(*) from public.case_service_plans p where p.opportunity_id = o.id and p.status <> 'active')
  )
  from public.opportunities o
  left join public.status_tracks t on t.opportunity_id = o.id and t.track = 'case_progress'
  where o.id = p_opportunity_id;
$body$;

revoke all on function private.case_service_view(uuid) from public, anon, authenticated, service_role;

create function public.get_case_service(p_opportunity_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_target record;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;
  if p_opportunity_id is null then
    raise exception 'invalid_request';
  end if;
  -- Mesmo alcance da leitura da trilha (todos os papéis membros; advogado: seus + sem responsável).
  select * into v_target from private.status_track_target('case_progress', p_opportunity_id, v_actor);
  return private.case_service_view(p_opportunity_id);
end;
$body$;

comment on function public.get_case_service(uuid) is
  'Painel do caso (etapa B): número interno, roteiro ativo (etapas copiadas, etapa atual e conclusões registradas), andamento e versão da trilha case_progress de uma oportunidade.';

revoke all on function public.get_case_service(uuid) from public, anon;
grant execute on function public.get_case_service(uuid) to authenticated;

create function public.list_case_service_history(
  p_opportunity_id uuid,
  p_before timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 30
)
returns table (items jsonb, has_more boolean)
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_target record;
  v_limit integer;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;
  if p_opportunity_id is null then
    raise exception 'invalid_request';
  end if;
  if (p_before is null) <> (p_before_id is null) then
    raise exception 'invalid_cursor';
  end if;
  select * into v_target from private.status_track_target('case_progress', p_opportunity_id, v_actor);

  v_limit := greatest(1, least(coalesce(p_limit, 30), 100));

  return query
  with page as (
    select e.*
    from public.case_service_events e
    where e.opportunity_id = p_opportunity_id
      and (p_before is null or (e.occurred_at, e.id) < (p_before, p_before_id))
    order by e.occurred_at desc, e.id desc
    limit v_limit + 1
  ),
  shown as (
    select * from page order by occurred_at desc, id desc limit v_limit
  )
  select
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'op', s.op,
        'plan_id', s.plan_id,
        'plan_name', (select p.service_type_name from public.case_service_plans p where p.id = s.plan_id),
        'previous_plan_name', (select p.service_type_name from public.case_service_plans p where p.id = s.previous_plan_id),
        'step_id', s.step_id,
        'step_name', (select x.name from public.case_service_plan_steps x where x.id = s.step_id),
        'step_position', (select x.position from public.case_service_plan_steps x where x.id = s.step_id),
        'current_step_before_name', (select x.name from public.case_service_plan_steps x where x.id = s.current_step_before),
        'current_step_after_name', (select x.name from public.case_service_plan_steps x where x.id = s.current_step_after),
        'progress_from', s.progress_from,
        'progress_to', s.progress_to,
        'from_version', s.from_version,
        'to_version', s.to_version,
        'actor_kind', s.actor_kind,
        'actor_name', private.user_display_name(s.actor_user_id),
        'occurred_at', s.occurred_at
      ) order by s.occurred_at desc, s.id desc)
      from shown s
    ), '[]'::jsonb),
    (select count(*) from page) > v_limit;
end;
$body$;

comment on function public.list_case_service_history(uuid, timestamptz, uuid, integer) is
  'Painel do caso (etapa B): histórico do roteiro do caso, paginado por (occurred_at, id), com autor, alvo e versão. As mudanças do andamento continuam em list_status_track_history.';

revoke all on function public.list_case_service_history(uuid, timestamptz, uuid, integer) from public, anon;
grant execute on function public.list_case_service_history(uuid, timestamptz, uuid, integer) to authenticated;

-- =====================================================================
-- 8) Escritas do roteiro (todas humanas, na trilha case_progress)
-- =====================================================================

-- Regras de convivência conferidas depois de toda escrita (defesa em profundidade: as funções já
-- recusam antes, com códigos próprios).
create function private.case_service_assert(p_opportunity_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_plan public.case_service_plans;
  v_status public.case_progress_status;
begin
  select * into v_plan from public.case_service_plans where opportunity_id = p_opportunity_id and status = 'active';
  if v_plan.id is null then
    return;
  end if;
  select case_progress_status into v_status
  from public.status_tracks where opportunity_id = p_opportunity_id and track = 'case_progress';
  -- I1: concluído só com todas as etapas concluídas.
  if v_status = 'concluido' and private.case_service_pending_steps(p_opportunity_id) > 0 then
    raise exception 'service_state_invalid';
  end if;
  -- I2: etapa atual pendente e deste roteiro.
  if v_plan.current_step_id is not null and not exists (
    select 1 from public.case_service_plan_steps s
    where s.id = v_plan.current_step_id and s.plan_id = v_plan.id and s.completed_at is null) then
    raise exception 'service_state_invalid';
  end if;
end;
$body$;

revoke all on function private.case_service_assert(uuid) from public, anon, authenticated, service_role;

-- Começo comum: autenticação, alcance, permissão (case.progress_edit), oportunidade ganha, trava
-- da trilha case_progress, repetição pela chave e versão esperada. Com a chave já usada para o
-- MESMO pedido, devolve o estado atual como repetição (nada é gravado de novo).
create function private.case_service_begin(
  p_opportunity_id uuid,
  p_expected_version bigint,
  p_key uuid,
  p_fingerprint text,
  out o_track public.status_tracks,
  out o_replay jsonb,
  out o_actor uuid
)
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_target record;
  v_event public.case_service_events;
begin
  o_actor := auth.uid();
  if o_actor is null then
    raise exception 'authentication_required';
  end if;
  if p_opportunity_id is null then
    raise exception 'invalid_request';
  end if;

  select * into v_target from private.status_track_target('case_progress', p_opportunity_id, o_actor);
  if v_target.role not in ('owner', 'admin', 'manager', 'lawyer') then
    raise exception 'insufficient_permission';
  end if;
  if v_target.opportunity_status <> 'won' then
    raise exception 'opportunity_not_won';
  end if;
  if p_expected_version is null or p_expected_version < 0 then
    raise exception 'invalid_version';
  end if;
  o_track := private.status_track_lock(v_target.workspace_id, 'case_progress', null, p_opportunity_id);

  -- Depois da trava: duas repetições simultâneas da mesma chave se enfileiram aqui.
  if p_key is not null then
    select * into v_event from public.case_service_events
    where workspace_id = v_target.workspace_id and idempotency_key = p_key;
    if v_event.id is not null then
      if v_event.opportunity_id <> p_opportunity_id or v_event.request_fingerprint <> p_fingerprint then
        raise exception 'idempotency_conflict';
      end if;
      o_replay := private.case_service_view(p_opportunity_id)
        || jsonb_build_object('event_id', v_event.id, 'event_version', v_event.to_version, 'replayed', true);
      return;
    end if;
    -- A chave já confirmada no outro histórico (situação do atendimento ou andamento): conflito, antes
    -- da versão. A gravação simultânea é decidida pelo registro único (seção 4b).
    perform private.status_track_key_assert_free(v_target.workspace_id, p_key, 'case_service_events');
  end if;

  if o_track.version <> p_expected_version then
    raise exception 'track_conflict';
  end if;
end;
$body$;

revoke all on function private.case_service_begin(uuid, bigint, uuid, text) from public, anon, authenticated, service_role;

-- Fim comum: incrementa a versão da trilha e o marco da decisão humana, muda o andamento quando a
-- operação exige (com o evento no histórico da trilha), grava o evento do roteiro, confere as
-- regras de convivência e audita (só códigos).
create function private.case_service_commit(
  p_track public.status_tracks,
  p_actor uuid,
  p_op text,
  p_plan_id uuid,
  p_step_id uuid,
  p_previous_plan_id uuid,
  p_current_before uuid,
  p_current_after uuid,
  p_progress_to public.case_progress_status,
  p_key uuid,
  p_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_row public.status_tracks;
  v_from public.case_progress_status := p_track.case_progress_status;
  v_event_id uuid;
begin
  update public.status_tracks
  set version = version + 1,
      manual_decided_at = clock_timestamp(),
      case_progress_status = coalesce(p_progress_to, case_progress_status)
  where id = p_track.id
  returning * into v_row;

  if p_progress_to is not null then
    insert into public.status_track_events (
      workspace_id, track_id, event, from_status, to_status, from_version, to_version,
      actor_kind, actor_user_id, evidence_count
    ) values (
      v_row.workspace_id, v_row.id, 'status_changed', v_from::text, p_progress_to::text, v_row.version - 1, v_row.version,
      'user', p_actor, 0
    );
  end if;

  begin
    insert into public.case_service_events (
      workspace_id, opportunity_id, plan_id, op, step_id, previous_plan_id,
      current_step_before, current_step_after, progress_from, progress_to,
      from_version, to_version, actor_kind, actor_user_id, idempotency_key, request_fingerprint
    ) values (
      v_row.workspace_id, v_row.opportunity_id, p_plan_id, p_op, p_step_id, p_previous_plan_id,
      p_current_before, p_current_after,
      case when p_progress_to is not null then v_from end, p_progress_to,
      v_row.version - 1, v_row.version, 'user', p_actor, p_key, p_fingerprint
    )
    returning id into v_event_id;
  exception when unique_violation then
    -- Mesma chave usada (ao mesmo tempo) em outro caso ou no outro histórico (registro único, seção 4b).
    raise exception 'idempotency_conflict';
  end;

  perform private.case_service_assert(v_row.opportunity_id);

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_row.workspace_id, p_actor, 'opportunity.case_service_changed', 'opportunity', v_row.opportunity_id,
          jsonb_strip_nulls(jsonb_build_object(
            'op', p_op, 'version', v_row.version,
            'progress_from', case when p_progress_to is not null then v_from::text end,
            'progress_to', p_progress_to::text)));

  return private.case_service_view(v_row.opportunity_id)
    || jsonb_build_object('event_id', v_event_id, 'event_version', v_row.version, 'replayed', false);
end;
$body$;

revoke all on function private.case_service_commit(public.status_tracks, uuid, text, uuid, uuid, uuid, uuid, uuid, public.case_progress_status, uuid, text)
  from public, anon, authenticated, service_role;

-- Cria o roteiro ativo COPIANDO as etapas do modelo (com trava de leitura no tipo: a cópia é de uma
-- versão inteira, nunca de uma edição pela metade). Devolve (plano, etapa atual escolhida).
create function private.case_service_create_plan(
  p_workspace_id uuid,
  p_opportunity_id uuid,
  p_service_type_id uuid,
  p_actor uuid,
  p_current_position integer,
  out o_plan_id uuid,
  out o_current_step_id uuid
)
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_type public.service_types;
  v_steps integer;
begin
  select * into v_type from public.service_types
  where id = p_service_type_id and workspace_id = p_workspace_id
  for share;
  if v_type.id is null then
    raise exception 'service_type_not_found';
  end if;
  if v_type.archived_at is not null then
    raise exception 'service_type_archived';
  end if;
  select count(*) into v_steps from public.service_type_steps where service_type_id = v_type.id;
  if v_steps = 0 then
    raise exception 'service_type_invalid_steps';
  end if;
  if p_current_position is not null and (p_current_position < 1 or p_current_position > v_steps) then
    raise exception 'invalid_request';
  end if;

  insert into public.case_service_plans (
    workspace_id, opportunity_id, service_type_id, service_type_name, service_type_version, applied_by
  ) values (
    p_workspace_id, p_opportunity_id, v_type.id, v_type.name, v_type.version, p_actor
  )
  returning id into o_plan_id;

  insert into public.case_service_plan_steps (workspace_id, plan_id, position, name)
  select p_workspace_id, o_plan_id, row_number() over (order by s.position), s.name
  from public.service_type_steps s where s.service_type_id = v_type.id;

  if p_current_position is not null then
    select id into o_current_step_id from public.case_service_plan_steps
    where plan_id = o_plan_id and position = p_current_position;
    update public.case_service_plans set current_step_id = o_current_step_id where id = o_plan_id;
  end if;
end;
$body$;

revoke all on function private.case_service_create_plan(uuid, uuid, uuid, uuid, integer) from public, anon, authenticated, service_role;

-- Já houve conclusão registrada neste roteiro (mesmo que depois reaberta)?
create function private.case_service_plan_has_records(p_plan_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $body$
  select exists (
    select 1 from public.case_service_events e
    where e.plan_id = p_plan_id and e.op in ('step_completed', 'step_reopened'));
$body$;

revoke all on function private.case_service_plan_has_records(uuid) from public, anon, authenticated, service_role;

-- Aplicar um roteiro a um caso ganho sem roteiro. Caso concluído recusa (as etapas novas ficariam
-- pendentes num serviço dado como concluído). A etapa atual inicial é escolha explícita (ou nenhuma).
create function public.apply_case_service_plan(
  p_opportunity_id uuid,
  p_service_type_id uuid,
  p_expected_version bigint,
  p_current_step_position integer default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_begin record;
  v_new record;
  v_fp text := md5(concat_ws('|', 'apply', p_opportunity_id, p_service_type_id, coalesce(p_current_step_position::text, '-')));
begin
  select * into v_begin from private.case_service_begin(p_opportunity_id, p_expected_version, p_idempotency_key, v_fp);
  if v_begin.o_replay is not null then
    return v_begin.o_replay;
  end if;

  if exists (select 1 from public.case_service_plans where opportunity_id = p_opportunity_id and status = 'active') then
    raise exception 'service_plan_exists';
  end if;
  if (v_begin.o_track).case_progress_status = 'concluido' then
    raise exception 'case_concluded';
  end if;

  select * into v_new from private.case_service_create_plan(
    (v_begin.o_track).workspace_id, p_opportunity_id, p_service_type_id, v_begin.o_actor, p_current_step_position);

  return private.case_service_commit(
    v_begin.o_track, v_begin.o_actor, 'plan_applied', v_new.o_plan_id, null, null,
    null, v_new.o_current_step_id, null, p_idempotency_key, v_fp);
end;
$body$;

comment on function public.apply_case_service_plan(uuid, uuid, bigint, integer, uuid) is
  'Painel do caso (etapa B): aplica um tipo de serviço a uma oportunidade ganha, copiando as etapas. Versão da trilha case_progress obrigatória; chave de idempotência opcional.';

revoke all on function public.apply_case_service_plan(uuid, uuid, bigint, integer, uuid) from public, anon;
grant execute on function public.apply_case_service_plan(uuid, uuid, bigint, integer, uuid) to authenticated;

-- Trocar o roteiro: o anterior fica encerrado (replaced) com as conclusões dele; com registros, só
-- com confirmação explícita (p_acknowledge_records).
create function public.replace_case_service_plan(
  p_opportunity_id uuid,
  p_service_type_id uuid,
  p_expected_version bigint,
  p_acknowledge_records boolean default false,
  p_current_step_position integer default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_begin record;
  v_old public.case_service_plans;
  v_new record;
  v_fp text := md5(concat_ws('|', 'replace', p_opportunity_id, p_service_type_id,
                             coalesce(p_acknowledge_records, false)::text, coalesce(p_current_step_position::text, '-')));
begin
  select * into v_begin from private.case_service_begin(p_opportunity_id, p_expected_version, p_idempotency_key, v_fp);
  if v_begin.o_replay is not null then
    return v_begin.o_replay;
  end if;

  select * into v_old from public.case_service_plans where opportunity_id = p_opportunity_id and status = 'active';
  if v_old.id is null then
    raise exception 'service_plan_missing';
  end if;
  if (v_begin.o_track).case_progress_status = 'concluido' then
    raise exception 'case_concluded';
  end if;
  if private.case_service_plan_has_records(v_old.id) and not coalesce(p_acknowledge_records, false) then
    raise exception 'service_plan_has_records';
  end if;

  update public.case_service_plans
  set status = 'replaced', ended_at = clock_timestamp(), ended_by = v_begin.o_actor, current_step_id = null
  where id = v_old.id;

  select * into v_new from private.case_service_create_plan(
    (v_begin.o_track).workspace_id, p_opportunity_id, p_service_type_id, v_begin.o_actor, p_current_step_position);

  return private.case_service_commit(
    v_begin.o_track, v_begin.o_actor, 'plan_replaced', v_new.o_plan_id, null, v_old.id,
    v_old.current_step_id, v_new.o_current_step_id, null, p_idempotency_key, v_fp);
end;
$body$;

comment on function public.replace_case_service_plan(uuid, uuid, bigint, boolean, integer, uuid) is
  'Painel do caso (etapa B): troca o roteiro do caso por uma cópia nova (o anterior fica no histórico, com as conclusões). Roteiro com conclusões exige p_acknowledge_records.';

revoke all on function public.replace_case_service_plan(uuid, uuid, bigint, boolean, integer, uuid) from public, anon;
grant execute on function public.replace_case_service_plan(uuid, uuid, bigint, boolean, integer, uuid) to authenticated;

-- Remover o roteiro: o caso volta a não ter roteiro; o removido fica no histórico com as conclusões.
create function public.remove_case_service_plan(
  p_opportunity_id uuid,
  p_expected_version bigint,
  p_acknowledge_records boolean default false,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_begin record;
  v_old public.case_service_plans;
  v_fp text := md5(concat_ws('|', 'remove', p_opportunity_id, coalesce(p_acknowledge_records, false)::text));
begin
  select * into v_begin from private.case_service_begin(p_opportunity_id, p_expected_version, p_idempotency_key, v_fp);
  if v_begin.o_replay is not null then
    return v_begin.o_replay;
  end if;

  select * into v_old from public.case_service_plans where opportunity_id = p_opportunity_id and status = 'active';
  if v_old.id is null then
    raise exception 'service_plan_missing';
  end if;
  if private.case_service_plan_has_records(v_old.id) and not coalesce(p_acknowledge_records, false) then
    raise exception 'service_plan_has_records';
  end if;

  update public.case_service_plans
  set status = 'removed', ended_at = clock_timestamp(), ended_by = v_begin.o_actor, current_step_id = null
  where id = v_old.id;

  return private.case_service_commit(
    v_begin.o_track, v_begin.o_actor, 'plan_removed', v_old.id, null, null,
    v_old.current_step_id, null, null, p_idempotency_key, v_fp);
end;
$body$;

comment on function public.remove_case_service_plan(uuid, bigint, boolean, uuid) is
  'Painel do caso (etapa B): remove o roteiro ativo do caso, sem apagar nada (fica no histórico). Roteiro com conclusões exige p_acknowledge_records. O andamento não muda.';

revoke all on function public.remove_case_service_plan(uuid, bigint, boolean, uuid) from public, anon;
grant execute on function public.remove_case_service_plan(uuid, bigint, boolean, uuid) to authenticated;

-- Registrar a conclusão de uma etapa pendente do roteiro ativo. Se ela é a etapa atual, a etapa
-- atual passa a ser a informada em p_next_current_step_id (avançar) ou nenhuma — nunca fica numa
-- etapa concluída. Concluir uma etapa NÃO conclui as anteriores e NÃO muda o andamento.
create function public.complete_case_service_step(
  p_opportunity_id uuid,
  p_step_id uuid,
  p_expected_version bigint,
  p_next_current_step_id uuid default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_begin record;
  v_plan public.case_service_plans;
  v_step public.case_service_plan_steps;
  v_next public.case_service_plan_steps;
  v_after uuid;
  v_fp text := md5(concat_ws('|', 'complete', p_opportunity_id, p_step_id, coalesce(p_next_current_step_id::text, '-')));
begin
  select * into v_begin from private.case_service_begin(p_opportunity_id, p_expected_version, p_idempotency_key, v_fp);
  if v_begin.o_replay is not null then
    return v_begin.o_replay;
  end if;

  select * into v_plan from public.case_service_plans where opportunity_id = p_opportunity_id and status = 'active';
  if v_plan.id is null then
    raise exception 'service_plan_missing';
  end if;
  select * into v_step from public.case_service_plan_steps where id = p_step_id and plan_id = v_plan.id;
  if v_step.id is null then
    raise exception 'service_step_not_found';
  end if;
  if v_step.completed_at is not null then
    raise exception 'service_step_already_completed';
  end if;

  if v_plan.current_step_id is not distinct from v_step.id then
    if p_next_current_step_id is not null then
      select * into v_next from public.case_service_plan_steps where id = p_next_current_step_id and plan_id = v_plan.id;
      if v_next.id is null then
        raise exception 'service_step_not_found';
      end if;
      if v_next.id = v_step.id or v_next.completed_at is not null then
        raise exception 'service_step_completed';
      end if;
    end if;
    v_after := p_next_current_step_id;
  else
    if p_next_current_step_id is not null then
      raise exception 'invalid_request';
    end if;
    v_after := v_plan.current_step_id;
  end if;

  update public.case_service_plan_steps
  set completed_at = clock_timestamp(), completed_by = v_begin.o_actor
  where id = v_step.id;
  if v_after is distinct from v_plan.current_step_id then
    update public.case_service_plans set current_step_id = v_after where id = v_plan.id;
  end if;

  return private.case_service_commit(
    v_begin.o_track, v_begin.o_actor, 'step_completed', v_plan.id, v_step.id, null,
    v_plan.current_step_id, v_after, null, p_idempotency_key, v_fp);
end;
$body$;

comment on function public.complete_case_service_step(uuid, uuid, bigint, uuid, uuid) is
  'Painel do caso (etapa B): registra a conclusão de UMA etapa do roteiro ativo (quem e quando). Não conclui outras etapas nem muda o andamento. Etapa atual concluída avança para p_next_current_step_id ou fica sem etapa atual.';

revoke all on function public.complete_case_service_step(uuid, uuid, bigint, uuid, uuid) from public, anon;
grant execute on function public.complete_case_service_step(uuid, uuid, bigint, uuid, uuid) to authenticated;

-- Reabrir uma etapa concluída (correção): a conclusão atual sai, o histórico guarda a conclusão e a
-- reabertura. Num caso CONCLUÍDO, reabrir exige escolher o novo andamento (p_progress_status), e as
-- duas mudanças acontecem juntas — senão o caso ficaria concluído com etapa pendente.
create function public.reopen_case_service_step(
  p_opportunity_id uuid,
  p_step_id uuid,
  p_expected_version bigint,
  p_make_current boolean default false,
  p_progress_status public.case_progress_status default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_begin record;
  v_plan public.case_service_plans;
  v_step public.case_service_plan_steps;
  v_after uuid;
  v_progress public.case_progress_status;
  v_fp text := md5(concat_ws('|', 'reopen', p_opportunity_id, p_step_id, coalesce(p_make_current, false)::text,
                             coalesce(p_progress_status::text, '-')));
begin
  select * into v_begin from private.case_service_begin(p_opportunity_id, p_expected_version, p_idempotency_key, v_fp);
  if v_begin.o_replay is not null then
    return v_begin.o_replay;
  end if;

  select * into v_plan from public.case_service_plans where opportunity_id = p_opportunity_id and status = 'active';
  if v_plan.id is null then
    raise exception 'service_plan_missing';
  end if;
  select * into v_step from public.case_service_plan_steps where id = p_step_id and plan_id = v_plan.id;
  if v_step.id is null then
    raise exception 'service_step_not_found';
  end if;
  if v_step.completed_at is null then
    raise exception 'service_step_not_completed';
  end if;

  if (v_begin.o_track).case_progress_status = 'concluido' then
    if p_progress_status is null or p_progress_status in ('concluido', 'nao_informado') then
      raise exception 'service_reopen_status_required';
    end if;
    v_progress := p_progress_status;
  elsif p_progress_status is not null then
    -- Fora de um caso concluído, o andamento muda pela correção do andamento, não por aqui.
    raise exception 'invalid_request';
  end if;

  v_after := case when coalesce(p_make_current, false) then v_step.id else v_plan.current_step_id end;

  update public.case_service_plan_steps set completed_at = null, completed_by = null where id = v_step.id;
  if v_after is distinct from v_plan.current_step_id then
    update public.case_service_plans set current_step_id = v_after where id = v_plan.id;
  end if;

  return private.case_service_commit(
    v_begin.o_track, v_begin.o_actor, 'step_reopened', v_plan.id, v_step.id, null,
    v_plan.current_step_id, v_after, v_progress, p_idempotency_key, v_fp);
end;
$body$;

comment on function public.reopen_case_service_step(uuid, uuid, bigint, boolean, public.case_progress_status, uuid) is
  'Painel do caso (etapa B): reabre uma etapa concluída preservando o histórico. Em caso concluído exige o novo andamento e muda os dois estados na mesma transação.';

revoke all on function public.reopen_case_service_step(uuid, uuid, bigint, boolean, public.case_progress_status, uuid) from public, anon;
grant execute on function public.reopen_case_service_step(uuid, uuid, bigint, boolean, public.case_progress_status, uuid) to authenticated;

-- Definir a etapa atual (só uma etapa PENDENTE do roteiro ativo) ou limpar (nula). Escolher uma
-- etapa posterior NÃO conclui as anteriores; voltar a uma etapa concluída exige reabri-la.
create function public.set_case_service_current_step(
  p_opportunity_id uuid,
  p_step_id uuid,
  p_expected_version bigint,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_begin record;
  v_plan public.case_service_plans;
  v_step public.case_service_plan_steps;
  v_fp text := md5(concat_ws('|', 'current', p_opportunity_id, coalesce(p_step_id::text, '-')));
begin
  select * into v_begin from private.case_service_begin(p_opportunity_id, p_expected_version, p_idempotency_key, v_fp);
  if v_begin.o_replay is not null then
    return v_begin.o_replay;
  end if;

  select * into v_plan from public.case_service_plans where opportunity_id = p_opportunity_id and status = 'active';
  if v_plan.id is null then
    raise exception 'service_plan_missing';
  end if;
  if p_step_id is not null then
    select * into v_step from public.case_service_plan_steps where id = p_step_id and plan_id = v_plan.id;
    if v_step.id is null then
      raise exception 'service_step_not_found';
    end if;
    if v_step.completed_at is not null then
      raise exception 'service_step_completed';
    end if;
  end if;
  if v_plan.current_step_id is not distinct from p_step_id then
    raise exception 'service_step_unchanged';
  end if;

  update public.case_service_plans set current_step_id = p_step_id where id = v_plan.id;

  return private.case_service_commit(
    v_begin.o_track, v_begin.o_actor,
    case when p_step_id is null then 'current_step_cleared' else 'current_step_set' end,
    v_plan.id, null, null, v_plan.current_step_id, p_step_id, null, p_idempotency_key, v_fp);
end;
$body$;

comment on function public.set_case_service_current_step(uuid, uuid, bigint, uuid) is
  'Painel do caso (etapa B): define a etapa atual do roteiro (uma etapa pendente) ou limpa. Não conclui nem reabre etapas e não muda o andamento.';

revoke all on function public.set_case_service_current_step(uuid, uuid, bigint, uuid) from public, anon;
grant execute on function public.set_case_service_current_step(uuid, uuid, bigint, uuid) to authenticated;

-- =====================================================================
-- 9) Correção do andamento: mesma função, mesma assinatura, mais a regra I1
--
-- Igual à da fundação, com duas diferenças: (a) `concluido` é recusado enquanto o roteiro ativo
-- tiver etapa pendente (service_steps_pending) — concluir o serviço exige as etapas concluídas;
-- (b) a chave de idempotência não pode ter sido usada no histórico do roteiro — garantido pelo
-- registro único da seção 4b (status_track_replay o consulta; a gravação simultânea esbarra no índice). Sair de `concluido` (reabrir o serviço) segue permitido e não
-- reabre etapa nenhuma. `create or replace` preserva a ACL.
-- =====================================================================

create or replace function public.set_opportunity_case_progress(
  p_opportunity_id uuid,
  p_status public.case_progress_status,
  p_expected_version bigint,
  p_evidence_message_ids uuid[] default '{}'::uuid[],
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_opp public.opportunities;
  v_lead public.leads;
  v_row public.status_tracks;
  v_evidence uuid[];
  v_replay jsonb;
  v_from text;
  v_event_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_opp from public.opportunities where id = p_opportunity_id;
  if v_opp.id is null then
    raise exception 'opportunity_not_found';
  end if;

  v_role := private.status_track_actor_role(v_opp.workspace_id, v_actor);
  if v_role is null then
    raise exception 'insufficient_permission';
  end if;
  select * into v_lead from public.leads where id = v_opp.lead_id and workspace_id = v_opp.workspace_id;
  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'opportunity_not_found';
  end if;
  if v_role not in ('owner', 'admin', 'manager', 'lawyer') then
    raise exception 'insufficient_permission';
  end if;

  if v_opp.status <> 'won' then
    raise exception 'opportunity_not_won';
  end if;
  if p_status is null or p_status = 'nao_informado' then
    raise exception 'invalid_status';
  end if;
  if p_expected_version is null or p_expected_version < 0 then
    raise exception 'invalid_version';
  end if;
  v_evidence := private.status_track_validate_evidence(
    v_opp.workspace_id, v_role, v_actor, 'case_progress', null, v_lead.contact_id, p_evidence_message_ids);

  v_row := private.status_track_lock(v_opp.workspace_id, 'case_progress', null, v_opp.id);

  v_replay := private.status_track_replay(v_opp.workspace_id, p_idempotency_key, v_row.id, p_status::text, v_evidence);
  if v_replay is not null then
    return v_replay;
  end if;

  if v_row.version <> p_expected_version then
    raise exception 'track_conflict';
  end if;
  if v_row.case_progress_status = p_status then
    raise exception 'status_unchanged';
  end if;
  -- I1: o serviço só é dado como concluído com todas as etapas do roteiro ativo concluídas.
  if p_status = 'concluido' and private.case_service_pending_steps(v_opp.id) > 0 then
    raise exception 'service_steps_pending';
  end if;

  v_from := v_row.case_progress_status::text;
  update public.status_tracks
  set case_progress_status = p_status, version = version + 1, manual_decided_at = clock_timestamp()
  where id = v_row.id
  returning * into v_row;

  v_event_id := private.status_track_record_change(v_row, v_from, p_status::text, v_actor, v_evidence, p_idempotency_key);

  perform private.case_service_assert(v_opp.id);

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_opp.workspace_id, v_actor, 'opportunity.case_progress_changed', 'opportunity', v_opp.id,
          jsonb_build_object('track', 'case_progress', 'from_status', v_from, 'to_status', p_status::text,
                             'version', v_row.version, 'evidence_count', cardinality(v_evidence)));

  return private.status_track_state_json(v_row)
    || jsonb_build_object('event_id', v_event_id, 'event_version', v_row.version, 'replayed', false);
end;
$body$;

-- =====================================================================
-- 10) Item de caso (lista, painel e foco): mesmas chaves, mais número interno e roteiro
--
-- `create or replace` com a mesma assinatura: list_conversation_case_options, get_conversation_case
-- e list_conversation_inbox passam a devolver, em cada caso, o número interno (ou nulo) e, para
-- oportunidade ganha com roteiro ativo, o tipo de serviço, a etapa atual e as contagens. Nada é
-- inventado: sem número, `case_number` é nulo; sem roteiro, os campos do roteiro são nulos.
-- =====================================================================

create or replace function private.conversation_case_item(
  p_opportunity_id uuid,
  p_linked_opportunity_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $body$
  select jsonb_build_object(
    'opportunity_id', o.id,
    'lead_id', o.lead_id,
    'legal_area', l.legal_area,
    'lead_status', l.status,
    'status', o.status,
    'stage_id', o.stage_id,
    'stage_name', s.name,
    'is_linked', o.id = p_linked_opportunity_id,
    'case_progress_status', case when o.status = 'won'
      then coalesce(t.case_progress_status::text, 'nao_informado') end,
    'created_at', o.created_at,
    'case_number', n.number,
    'service_type_name', case when o.status = 'won' then sp.service_type_name end,
    'service_step_name', case when o.status = 'won' then cur.name end,
    'service_step_position', case when o.status = 'won' then cur.position end,
    'service_steps_total', case when o.status = 'won' and sp.id is not null
      then (select count(*) from public.case_service_plan_steps x where x.plan_id = sp.id) end,
    'service_steps_completed', case when o.status = 'won' and sp.id is not null
      then (select count(*) from public.case_service_plan_steps x where x.plan_id = sp.id and x.completed_at is not null) end
  )
  from public.opportunities o
  join public.leads l on l.id = o.lead_id and l.workspace_id = o.workspace_id
  join public.pipeline_stages s on s.id = o.stage_id and s.pipeline_id = o.pipeline_id
  left join public.status_tracks t on t.opportunity_id = o.id and t.track = 'case_progress'
  left join public.opportunity_case_numbers n on n.opportunity_id = o.id
  left join public.case_service_plans sp on sp.opportunity_id = o.id and sp.status = 'active'
  left join public.case_service_plan_steps cur on cur.id = sp.current_step_id
  where o.id = p_opportunity_id;
$body$;

-- =====================================================================
-- 11) Exportação do titular (C3a): três seções novas
--
-- Mesma função, mesma assinatura e as mesmas seções anteriores, byte a byte (cópia da versão da
-- fundação, a última publicada); entram case_numbers, case_service_plans e case_service_history.
-- =====================================================================

create or replace function private.privacy_export_payload(p_workspace_id uuid, p_contact_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $body$
  with
    c as (
      select * from public.contacts
      where id = p_contact_id and workspace_id = p_workspace_id and merged_into_contact_id is null
    ),
    l as (
      select * from public.leads
      where workspace_id = p_workspace_id and contact_id in (select id from c)
    ),
    o as (
      select * from public.opportunities
      where workspace_id = p_workspace_id and lead_id in (select id from l)
    ),
    cl as (
      select * from public.clients
      where workspace_id = p_workspace_id and contact_id in (select id from c)
    ),
    p as (
      select * from public.proposals
      where workspace_id = p_workspace_id
        and (lead_id in (select id from l) or opportunity_id in (select id from o))
    ),
    cv as (
      select * from public.conversations
      where workspace_id = p_workspace_id
        and (contact_id in (select id from c)
             or lead_id in (select id from l)
             or opportunity_id in (select id from o))
    ),
    m as (
      select * from public.messages
      where workspace_id = p_workspace_id and conversation_id in (select id from cv)
    ),
    t as (
      select * from public.touchpoints
      where workspace_id = p_workspace_id
        and (contact_id in (select id from c)
             or lead_id in (select id from l)
             or opportunity_id in (select id from o))
    )
  select jsonb_build_object(
    'contact', (
      select jsonb_build_object(
        'id', c.id, 'name', c.name, 'type', c.type, 'city', c.city, 'uf', c.uf,
        'preferred_channel', c.preferred_channel, 'created_at', c.created_at, 'updated_at', c.updated_at)
      from c
    ),
    'phones', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'value', x.value_normalized, 'is_primary', x.is_primary, 'source', x.source,
        'verified_at', x.verified_at, 'created_at', x.created_at) order by x.created_at, x.id)
      from public.contact_phones x where x.workspace_id = p_workspace_id and x.contact_id in (select id from c)
    ), '[]'::jsonb),
    'emails', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'value', x.value_normalized, 'is_primary', x.is_primary, 'source', x.source,
        'verified_at', x.verified_at, 'created_at', x.created_at) order by x.created_at, x.id)
      from public.contact_emails x where x.workspace_id = p_workspace_id and x.contact_id in (select id from c)
    ), '[]'::jsonb),
    'identifiers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'provider', x.provider, 'external_id', x.external_id, 'created_at', x.created_at)
        order by x.created_at, x.id)
      from public.contact_identifiers x where x.workspace_id = p_workspace_id and x.contact_id in (select id from c)
    ), '[]'::jsonb),
    '_sensitive', (
      select jsonb_build_object('ciphertext_base64', encode(s.cpf_cnpj_ciphertext, 'base64'), 'key_version', s.key_version)
      from public.contact_sensitive s where s.workspace_id = p_workspace_id and s.contact_id in (select id from c)
    ),
    'consents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'purpose_code', x.purpose_code, 'purpose', x.purpose, 'channel', x.channel,
        'legal_basis', x.legal_basis, 'accepted_text', x.accepted_text, 'evidence_source', x.evidence_source,
        'granted_at', x.granted_at, 'revoked_at', x.revoked_at, 'created_at', x.created_at)
        order by x.created_at, x.id)
      from public.contact_consents x where x.workspace_id = p_workspace_id and x.contact_id in (select id from c)
    ), '[]'::jsonb),
    'consent_evidence', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'consent_id', x.contact_consent_id, 'decision', x.decision, 'decided_at', x.decided_at,
        'purpose_code', x.purpose_code, 'purpose', x.purpose, 'legal_basis', x.legal_basis,
        'channel', x.channel, 'text_version', x.text_version, 'created_at', x.created_at)
        order by x.decided_at, x.id)
      from public.consent_evidence x where x.workspace_id = p_workspace_id and x.contact_id in (select id from c)
    ), '[]'::jsonb),
    'leads', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'legal_area', x.legal_area, 'priority', x.priority, 'status', x.status,
        'estimated_value_cents', (select v.estimated_value_cents from public.lead_values v where v.lead_id = x.id),
        'created_at', x.created_at, 'updated_at', x.updated_at) order by x.created_at, x.id)
      from l x
    ), '[]'::jsonb),
    'opportunities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'lead_id', x.lead_id,
        'pipeline', (select pl.name from public.pipelines pl where pl.id = x.pipeline_id),
        'stage', (select ps.name from public.pipeline_stages ps where ps.id = x.stage_id),
        'status', x.status, 'value_cents', x.value_cents, 'fee_model', x.fee_model,
        'probability', x.probability, 'forecast_date', x.forecast_date, 'signed_at', x.signed_at,
        'won_at', x.won_at, 'stage_entered_at', x.stage_entered_at,
        'lost_reason', (select lr.label from public.lost_reasons lr where lr.id = x.lost_reason_id),
        'lost_followup_date', x.lost_followup_date,
        'created_at', x.created_at, 'updated_at', x.updated_at) order by x.created_at, x.id)
      from o x
    ), '[]'::jsonb),
    'opportunity_requirements', coalesce((
      select jsonb_agg(jsonb_build_object(
        'opportunity_id', x.opportunity_id,
        'label', (select sr.label from public.stage_requirements sr where sr.id = x.requirement_id),
        'value_bool', x.value_bool, 'filled_at', x.filled_at)
        order by x.opportunity_id, x.id)
      from public.opportunity_requirement_values x
      where x.workspace_id = p_workspace_id and x.opportunity_id in (select id from o)
    ), '[]'::jsonb),
    'stage_history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'opportunity_id', x.opportunity_id,
        'from_stage', (select ps.name from public.pipeline_stages ps where ps.id = x.from_stage_id),
        'to_stage', (select ps.name from public.pipeline_stages ps where ps.id = x.to_stage_id),
        'occurred_at', x.occurred_at, 'seconds_in_previous_stage', x.seconds_in_previous_stage)
        order by x.occurred_at, x.id)
      from public.stage_transitions x
      where x.workspace_id = p_workspace_id and x.opportunity_id in (select id from o)
    ), '[]'::jsonb),
    'activities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'lead_id', x.lead_id, 'opportunity_id', x.opportunity_id, 'type', x.type,
        'status', x.status, 'priority', x.priority,
        'due_at', x.due_at, 'has_time', x.has_time, 'completed_at', x.completed_at,
        'source', x.source, 'created_at', x.created_at) order by x.created_at, x.id)
      from public.activities x
      where x.workspace_id = p_workspace_id
        and (x.lead_id in (select id from l) or x.opportunity_id in (select id from o))
    ), '[]'::jsonb),
    'clients', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'status', x.status, 'created_at', x.created_at, 'updated_at', x.updated_at)
        order by x.created_at, x.id)
      from cl x
    ), '[]'::jsonb),
    'client_handoffs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'client_id', x.client_id, 'opportunity_id', x.opportunity_id, 'status', x.status,
        'target_system', x.target_system, 'attempts', x.attempts, 'completed_at', x.completed_at,
        'created_at', x.created_at) order by x.created_at, x.id)
      from public.client_handoffs x
      where x.workspace_id = p_workspace_id and x.client_id in (select id from cl)
    ), '[]'::jsonb),
    'proposals', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'lead_id', x.lead_id, 'opportunity_id', x.opportunity_id, 'number', x.number,
        'status', x.status, 'fee_model', x.fee_model, 'value_cents', x.value_cents,
        'sent_at', x.sent_at, 'sent_channels', x.sent_channels, 'decided_at', x.decided_at,
        'created_at', x.created_at) order by x.created_at, x.id)
      from p x
    ), '[]'::jsonb),
    -- Só metadados do documento: nada de caminho de armazenamento, checksum ou conteúdo binário.
    'proposal_documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'proposal_id', x.proposal_id, 'version', x.version, 'status', x.status,
        'byte_size', x.byte_size, 'requested_at', x.requested_at, 'resolved_at', x.resolved_at)
        order by x.requested_at, x.id)
      from public.proposal_documents x
      where x.workspace_id = p_workspace_id and x.proposal_id in (select id from p)
    ), '[]'::jsonb),
    'proposal_email_sends', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'proposal_id', x.proposal_id, 'document_id', x.document_id,
        'status', x.status, 'requested_at', x.requested_at, 'resolved_at', x.resolved_at)
        order by x.requested_at, x.id)
      from public.proposal_email_sends x
      where x.workspace_id = p_workspace_id and x.proposal_id in (select id from p)
    ), '[]'::jsonb),
    'lead_notes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'lead_id', x.lead_id, 'created_at', x.created_at)
        order by x.created_at, x.id)
      from public.lead_notes x where x.workspace_id = p_workspace_id and x.lead_id in (select id from l)
    ), '[]'::jsonb),
    'conflict_checks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'lead_id', x.lead_id, 'status', x.status,
        'checked_at', x.checked_at, 'created_at', x.created_at) order by x.created_at, x.id)
      from public.conflict_checks x where x.workspace_id = p_workspace_id and x.lead_id in (select id from l)
    ), '[]'::jsonb),
    -- Sem link_candidate_*: essas listas apontam para OUTROS contatos e leads.
    'conversations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'lead_id', x.lead_id, 'opportunity_id', x.opportunity_id, 'wa_id', x.wa_id,
        'identity_id', x.identity_id, 'created_at', x.created_at, 'last_message_at', x.last_message_at)
        order by x.created_at, x.id)
      from cv x
    ), '[]'::jsonb),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'conversation_id', x.conversation_id, 'direction', x.direction,
        'content_kind', x.content_kind, 'body_text', x.body_text, 'origin', x.origin,
        'sender_classification', x.sender_classification, 'provider', x.provider, 'status', x.status,
        'status_updated_at', x.status_updated_at, 'created_at', x.created_at,
        'cost', jsonb_build_object(
          'amount', x.provider_cost_amount, 'billable_amount', x.provider_cost_billable_amount,
          'category', x.provider_cost_category, 'currency', x.provider_cost_currency,
          'finality', x.provider_cost_finality)) order by x.created_at, x.id)
      from m x
    ), '[]'::jsonb),
    'message_status_events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'message_id', x.message_id, 'status', x.status, 'event_at', x.event_wa_timestamp,
        'received_at', x.received_at, 'error_code', x.error_code) order by x.received_at, x.id)
      from public.message_status_events x
      where x.workspace_id = p_workspace_id and x.message_id in (select id from m)
    ), '[]'::jsonb),
    -- Sem bsuid_ciphertext, bsuid_blind_index e bsuid_key_version.
    'whatsapp_identities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'phone', x.phone_e164, 'provider', x.provider, 'environment', x.environment,
        'created_at', x.created_at) order by x.created_at, x.id)
      from public.whatsapp_identities x
      where x.workspace_id = p_workspace_id and x.id in (select identity_id from cv where identity_id is not null)
    ), '[]'::jsonb),
    'attribution_touchpoints', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'lead_id', x.lead_id, 'opportunity_id', x.opportunity_id, 'channel', x.channel,
        'source', x.source, 'medium', x.medium, 'campaign', x.campaign, 'term', x.term,
        'content', x.content, 'landing_url', x.landing_url, 'referrer', x.referrer,
        'gclid', x.gclid, 'fbclid', x.fbclid, 'consent_id', x.consent_evidence_id,
        'occurred_at', x.occurred_at, 'received_at', x.received_at) order by x.occurred_at, x.id)
      from t x
    ), '[]'::jsonb),
    'attribution_links', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'touchpoint_id', x.touchpoint_id, 'opportunity_id', x.opportunity_id,
        'action', x.action, 'created_at', x.created_at) order by x.created_at, x.id)
      from public.touchpoint_demand_links x
      where x.workspace_id = p_workspace_id and x.touchpoint_id in (select id from t)
    ), '[]'::jsonb),
    -- Sem token_hash.
    'continuity_references', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'lead_id', x.lead_id, 'opportunity_id', x.opportunity_id, 'purpose', x.purpose,
        'created_at', x.created_at, 'expires_at', x.expires_at, 'last_used_at', x.last_used_at,
        'used_count', x.used_count, 'revoked_at', x.revoked_at) order by x.created_at, x.id)
      from public.continuity_references x
      where x.workspace_id = p_workspace_id
        and (x.contact_id in (select id from c) or x.lead_id in (select id from l))
    ), '[]'::jsonb),
    -- C4: valores de contato, leads, oportunidades e clientes do titular, inclusive de
    -- definições arquivadas (arquivar preserva o valor). Seleção única sai pelo RÓTULO.
    'custom_fields', coalesce((
      select jsonb_agg(jsonb_build_object(
        'entity_type', d.entity_type,
        'record_id', coalesce(v.contact_id, v.lead_id, v.opportunity_id, v.client_id),
        'field', d.name, 'field_type', d.field_type, 'archived', d.archived_at is not null,
        'value', case d.field_type
          when 'text' then to_jsonb(v.value_text)
          when 'number' then to_jsonb(v.value_number)
          when 'date' then to_jsonb(v.value_date)
          when 'boolean' then to_jsonb(v.value_boolean)
          else to_jsonb((select co.label from public.custom_field_options co where co.id = v.option_id))
        end) order by d.entity_type, d.name, v.id)
      from public.custom_field_values v
      join public.custom_field_definitions d on d.workspace_id = v.workspace_id and d.id = v.definition_id
      where v.workspace_id = p_workspace_id
        and (v.contact_id in (select id from c)
             or v.lead_id in (select id from l)
             or v.opportunity_id in (select id from o)
             or v.client_id in (select id from cl))
    ), '[]'::jsonb),
    -- Conversas + IA (PR 1): trilhas das conversas e oportunidades do titular.
    -- Sem automation_paused_by (usuário interno).
    'status_tracks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'track', x.track, 'conversation_id', x.conversation_id, 'opportunity_id', x.opportunity_id,
        'status', coalesce(x.attendance_status::text, x.case_progress_status::text), 'version', x.version,
        'automation_paused', x.automation_paused, 'automation_paused_at', x.automation_paused_at,
        'manual_decided_at', x.manual_decided_at, 'created_at', x.created_at, 'updated_at', x.updated_at)
        order by x.created_at, x.id)
      from public.status_tracks x
      where x.workspace_id = p_workspace_id
        and (x.conversation_id in (select id from cv) or x.opportunity_id in (select id from o))
    ), '[]'::jsonb),
    -- Sem actor_user_id (usuário interno) e sem idempotency_key.
    'status_track_history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'track_id', e.track_id, 'track', x.track, 'conversation_id', x.conversation_id,
        'opportunity_id', x.opportunity_id, 'event', e.event, 'from_status', e.from_status,
        'to_status', e.to_status, 'from_version', e.from_version, 'to_version', e.to_version,
        'actor_kind', e.actor_kind, 'occurred_at', e.occurred_at, 'evidence_count', e.evidence_count,
        'evidence_message_ids', coalesce((
          select jsonb_agg(ee.message_id order by ee.message_id)
          from public.status_track_event_evidence ee
          where ee.event_id = e.id and ee.workspace_id = p_workspace_id), '[]'::jsonb))
        order by e.occurred_at, e.id)
      from public.status_track_events e
      join public.status_tracks x on x.id = e.track_id and x.workspace_id = e.workspace_id
      where e.workspace_id = p_workspace_id
        and (x.conversation_id in (select id from cv) or x.opportunity_id in (select id from o))
    ), '[]'::jsonb),
    -- Painel do caso (etapa B): número interno, roteiros (com as etapas copiadas e as conclusões) e o
    -- histórico do roteiro das oportunidades do titular. Sem usuário interno (quem atribuiu, aplicou,
    -- concluiu ou decidiu) e sem chave de idempotência, como no restante da C3a.
    'case_numbers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'opportunity_id', x.opportunity_id, 'number', x.number, 'assigned_via', x.assigned_via,
        'assigned_at', x.assigned_at) order by x.assigned_at, x.opportunity_id)
      from public.opportunity_case_numbers x
      where x.workspace_id = p_workspace_id and x.opportunity_id in (select id from o)
    ), '[]'::jsonb),
    'case_service_plans', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'opportunity_id', x.opportunity_id, 'service_type', x.service_type_name,
        'service_type_version', x.service_type_version, 'status', x.status,
        'current_step_id', x.current_step_id, 'applied_at', x.applied_at, 'ended_at', x.ended_at,
        'steps', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', s.id, 'position', s.position, 'name', s.name, 'completed_at', s.completed_at)
            order by s.position)
          from public.case_service_plan_steps s
          where s.plan_id = x.id and s.workspace_id = p_workspace_id), '[]'::jsonb))
        order by x.applied_at, x.id)
      from public.case_service_plans x
      where x.workspace_id = p_workspace_id and x.opportunity_id in (select id from o)
    ), '[]'::jsonb),
    'case_service_history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'opportunity_id', x.opportunity_id, 'plan_id', x.plan_id, 'op', x.op,
        'step_id', x.step_id, 'previous_plan_id', x.previous_plan_id,
        'current_step_before', x.current_step_before, 'current_step_after', x.current_step_after,
        'progress_from', x.progress_from, 'progress_to', x.progress_to,
        'from_version', x.from_version, 'to_version', x.to_version, 'actor_kind', x.actor_kind,
        'occurred_at', x.occurred_at) order by x.occurred_at, x.id)
      from public.case_service_events x
      where x.workspace_id = p_workspace_id and x.opportunity_id in (select id from o)
    ), '[]'::jsonb)
  );
$body$;
