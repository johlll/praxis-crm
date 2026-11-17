-- Conversas + IA — PR 1: fundação das trilhas de status (sem IA, sem tela nova).
--
-- Decisões em docs/decisoes/conversas-ia-fundacao.md. Resumo:
--
--   - Três trilhas SEPARADAS:
--       attendance       → situação do atendimento, na CONVERSA;
--       case_progress    → andamento do caso/serviço, na OPORTUNIDADE GANHA
--                          (a oportunidade é a unidade de caso/serviço; nunca
--                          o cliente inteiro);
--       commercial_stage → etapa do Kanban, na oportunidade. O estado continua
--                          em opportunities.stage_id e o histórico continua em
--                          stage_transitions (fonte canônica). Aqui ficam só o
--                          controle de pausa e o marco/versão da trilha.
--   - "nao_informado" é a condição explícita de dado legado: nenhuma conversa ou
--     oportunidade antiga é interpretada como "novo" ou "em análise".
--   - Controle persistido para pausar/retomar FUTURAS alterações automáticas por
--     trilha e alvo. Pausar não impede a edição manual autorizada.
--   - Toda mudança (manual, nesta PR) incrementa a versão da trilha; a correção
--     manual também grava o marco de evidência (manual_decided_at). Avaliações
--     futuras feitas sobre versão ou marco antigos ficam inválidas. Retomar também
--     incrementa a versão.
--   - Histórico próprio das trilhas novas (antes/depois, autor, horário, versão,
--     evidência e idempotência). Nesta PR todo autor é humano (actor_kind='user').
--     stage_transitions NÃO muda (actor_user_id continua obrigatório).
--   - Evidência = referência a mensagens, validada no servidor (escritório,
--     conversa, alcance do papel e alvo). Nenhum texto de mensagem é copiado; a
--     referência cai em cascata quando a mensagem é apagada (retenção/anonimização).
--   - Nenhuma escrita aqui envia mensagem, chama serviço externo ou cria atividade.
--
-- Migration ADITIVA: três enums, três tabelas deny-all, funções novas, um gatilho
-- novo em stage_transitions (só atualiza o controle da trilha comercial) e
-- `create or replace` de duas funções de leitura existentes, com a MESMA
-- assinatura: list_conversation_messages (passa a devolver origem, classificação
-- e tipo de conteúdo) e private.privacy_export_payload (C3a, duas seções novas).

-- ---------------------------------------------------------------------
-- 1) Vocabulários
-- ---------------------------------------------------------------------

create type public.conversation_attendance_status as enum (
  'nao_informado', 'novo', 'aguardando_escritorio', 'aguardando_cliente', 'encerrado'
);

create type public.case_progress_status as enum (
  'nao_informado', 'aguardando_documentos', 'documentos_recebidos', 'em_analise',
  'aguardando_cliente', 'aguardando_terceiros', 'em_execucao', 'concluido', 'suspenso'
);

create type public.status_track_kind as enum ('attendance', 'case_progress', 'commercial_stage');

-- ---------------------------------------------------------------------
-- 2) Estado e controle por trilha e alvo
--
-- Uma linha por (conversa) na trilha attendance e por (oportunidade, trilha) nas
-- trilhas da oportunidade. A linha nasce na primeira escrita; sem linha, a leitura
-- devolve o padrão (nao_informado, versão 0, sem pausa, sem marco).
-- ---------------------------------------------------------------------

create table public.status_tracks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  track public.status_track_kind not null,
  conversation_id uuid,
  opportunity_id uuid,
  attendance_status public.conversation_attendance_status,
  case_progress_status public.case_progress_status,
  version bigint not null default 0 check (version >= 0),
  automation_paused boolean not null default false,
  automation_paused_at timestamptz,
  automation_paused_by uuid references auth.users (id) on delete restrict,
  -- Marco de evidência: momento da última decisão humana sobre o ESTADO da trilha.
  manual_decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint status_tracks_workspace_id_id_key unique (workspace_id, id),
  constraint status_tracks_conversation_same_workspace_fkey
    foreign key (workspace_id, conversation_id) references public.conversations (workspace_id, id) on delete cascade,
  constraint status_tracks_opportunity_same_workspace_fkey
    foreign key (workspace_id, opportunity_id) references public.opportunities (workspace_id, id) on delete cascade,
  constraint status_tracks_target_shape check (
    (track = 'attendance' and conversation_id is not null and opportunity_id is null
       and attendance_status is not null and case_progress_status is null)
    or (track = 'case_progress' and opportunity_id is not null and conversation_id is null
       and case_progress_status is not null and attendance_status is null)
    or (track = 'commercial_stage' and opportunity_id is not null and conversation_id is null
       and attendance_status is null and case_progress_status is null)
  ),
  constraint status_tracks_pause_consistency check (
    (automation_paused and automation_paused_at is not null and automation_paused_by is not null)
    or (not automation_paused and automation_paused_at is null and automation_paused_by is null)
  )
);

create unique index status_tracks_conversation_key on public.status_tracks (conversation_id)
  where conversation_id is not null;
create unique index status_tracks_opportunity_track_key on public.status_tracks (opportunity_id, track)
  where opportunity_id is not null;

comment on table public.status_tracks is
  'Conversas + IA (PR 1): estado e controle por trilha e alvo. attendance na conversa; case_progress e commercial_stage na oportunidade (o estado comercial continua em opportunities.stage_id e o histórico em stage_transitions). Sem linha = padrão (nao_informado, versão 0, sem pausa).';

-- ---------------------------------------------------------------------
-- 3) Histórico das trilhas novas
-- ---------------------------------------------------------------------

create table public.status_track_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  track_id uuid not null,
  event text not null check (event in ('status_changed', 'automation_paused', 'automation_resumed')),
  from_status text,
  to_status text,
  from_version bigint not null check (from_version >= 0),
  to_version bigint not null,
  -- Nesta PR só existe autor humano. O aplicador automático (PR futura) amplia
  -- esta regra junto com a própria autoria.
  actor_kind text not null default 'user' check (actor_kind in ('user')),
  actor_user_id uuid not null references auth.users (id) on delete restrict,
  -- Quantas mensagens foram referenciadas no momento da mudança (um número, não
  -- identifica ninguém); as referências em si ficam na tabela de evidência e
  -- caem em cascata com a mensagem.
  evidence_count integer not null default 0 check (evidence_count between 0 and 20),
  idempotency_key uuid,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint status_track_events_workspace_id_id_key unique (workspace_id, id),
  constraint status_track_events_track_same_workspace_fkey
    foreign key (workspace_id, track_id) references public.status_tracks (workspace_id, id) on delete cascade,
  constraint status_track_events_version_step check (to_version = from_version + 1),
  constraint status_track_events_status_codes check (
    (from_status is null or from_status in (
      'nao_informado', 'novo', 'aguardando_escritorio', 'aguardando_cliente', 'encerrado',
      'aguardando_documentos', 'documentos_recebidos', 'em_analise', 'aguardando_terceiros',
      'em_execucao', 'concluido', 'suspenso'))
    and (to_status is null or to_status in (
      'novo', 'aguardando_escritorio', 'aguardando_cliente', 'encerrado',
      'aguardando_documentos', 'documentos_recebidos', 'em_analise', 'aguardando_terceiros',
      'em_execucao', 'concluido', 'suspenso'))
  ),
  constraint status_track_events_shape check (
    (event = 'status_changed' and from_status is not null and to_status is not null and from_status <> to_status)
    or (event <> 'status_changed' and from_status is null and to_status is null and evidence_count = 0)
  )
);

create unique index status_track_events_idempotency_key on public.status_track_events (workspace_id, idempotency_key)
  where idempotency_key is not null;
create index status_track_events_track_idx on public.status_track_events (track_id, occurred_at desc, id desc);

comment on table public.status_track_events is
  'Conversas + IA (PR 1): histórico das trilhas attendance e case_progress (mudanças de estado) e da pausa/retomada das três trilhas. Mudanças de etapa comercial NÃO entram aqui: a fonte canônica é stage_transitions.';

create table public.status_track_event_evidence (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  event_id uuid not null,
  message_id uuid not null,
  primary key (event_id, message_id),
  constraint status_track_event_evidence_event_fkey
    foreign key (workspace_id, event_id) references public.status_track_events (workspace_id, id) on delete cascade,
  -- Em cascata com a mensagem: quando a retenção/anonimização apaga a conversa
  -- (e, com ela, as mensagens), a referência some junto. Nenhum texto é copiado.
  constraint status_track_event_evidence_message_fkey
    foreign key (workspace_id, message_id) references public.messages (workspace_id, id) on delete cascade
);

create index status_track_event_evidence_message_idx on public.status_track_event_evidence (message_id);

comment on table public.status_track_event_evidence is
  'Conversas + IA (PR 1): mensagens referenciadas como evidência de uma mudança de trilha. Só ids; cai em cascata com a mensagem.';

alter table public.status_tracks enable row level security;
alter table public.status_tracks force row level security;
revoke all on table public.status_tracks from public, anon, authenticated;

alter table public.status_track_events enable row level security;
alter table public.status_track_events force row level security;
revoke all on table public.status_track_events from public, anon, authenticated;

alter table public.status_track_event_evidence enable row level security;
alter table public.status_track_event_evidence force row level security;
revoke all on table public.status_track_event_evidence from public, anon, authenticated;

create trigger status_tracks_set_updated_at before update on public.status_tracks
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- 4) Integridade: alvo imutável e esqueleto anonimizado imutável (C3b)
--
-- Mesma regra da C3b: depois de contacts.anonymized_at, nada novo entra no
-- esqueleto preservado (aqui, as trilhas da oportunidade). Só DELETE (cascata)
-- passa. As trilhas da conversa nem chegam a existir depois da anonimização,
-- porque a conversa é apagada.
-- ---------------------------------------------------------------------

create function private.status_tracks_integrity_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_conversation_id uuid;
  v_opportunity_id uuid;
  v_contact_id uuid;
begin
  if tg_table_name = 'status_tracks' then
    if tg_op = 'UPDATE' and (
      new.workspace_id is distinct from old.workspace_id
      or new.track is distinct from old.track
      or new.conversation_id is distinct from old.conversation_id
      or new.opportunity_id is distinct from old.opportunity_id
    ) then
      raise exception 'status_track_target_immutable';
    end if;
    v_conversation_id := new.conversation_id;
    v_opportunity_id := new.opportunity_id;
  elsif tg_table_name = 'status_track_events' then
    if tg_op = 'UPDATE' then
      raise exception 'status_track_history_immutable';
    end if;
    select t.conversation_id, t.opportunity_id into v_conversation_id, v_opportunity_id
    from public.status_tracks t where t.id = new.track_id;
  else
    if tg_op = 'UPDATE' then
      raise exception 'status_track_history_immutable';
    end if;
    select t.conversation_id, t.opportunity_id into v_conversation_id, v_opportunity_id
    from public.status_track_events e
    join public.status_tracks t on t.id = e.track_id
    where e.id = new.event_id;
  end if;

  if v_opportunity_id is not null and private.privacy_opportunity_anonymized(v_opportunity_id) then
    raise exception 'contact_anonymized';
  end if;
  if v_conversation_id is not null then
    select c.contact_id into v_contact_id from public.conversations c where c.id = v_conversation_id;
    if v_contact_id is not null and private.privacy_contact_anonymized(v_contact_id) then
      raise exception 'contact_anonymized';
    end if;
  end if;
  return new;
end;
$body$;

revoke all on function private.status_tracks_integrity_guard() from public, anon, authenticated, service_role;

create trigger status_tracks_integrity_guard before insert or update on public.status_tracks
  for each row execute function private.status_tracks_integrity_guard();
create trigger status_track_events_integrity_guard before insert or update on public.status_track_events
  for each row execute function private.status_tracks_integrity_guard();
create trigger status_track_event_evidence_integrity_guard before insert or update on public.status_track_event_evidence
  for each row execute function private.status_tracks_integrity_guard();

-- ---------------------------------------------------------------------
-- 5) Trilha comercial: toda movimentação registrada em stage_transitions é,
--    hoje, uma decisão humana (actor_user_id obrigatório). Ela incrementa a
--    versão da trilha e grava o marco, invalidando avaliações antigas. O
--    histórico continua só em stage_transitions; este gatilho não grava evento.
--    O aplicador automático (PR futura) terá de distinguir a própria autoria
--    antes de tratar uma movimentação como decisão humana.
-- ---------------------------------------------------------------------

create function private.status_tracks_on_stage_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $body$
begin
  insert into public.status_tracks (workspace_id, track, opportunity_id, version, manual_decided_at)
  values (new.workspace_id, 'commercial_stage', new.opportunity_id, 1, new.occurred_at)
  on conflict (opportunity_id, track) where opportunity_id is not null
  do update set version = public.status_tracks.version + 1,
                manual_decided_at = greatest(coalesce(public.status_tracks.manual_decided_at, excluded.manual_decided_at),
                                             excluded.manual_decided_at);
  return null;
end;
$body$;

revoke all on function private.status_tracks_on_stage_transition() from public, anon, authenticated, service_role;

create trigger stage_transitions_status_track after insert on public.stage_transitions
  for each row execute function private.status_tracks_on_stage_transition();

-- ---------------------------------------------------------------------
-- 6) Funções internas
-- ---------------------------------------------------------------------

-- Papel ativo do ator no workspace (nulo se não for membro ativo).
create function private.status_track_actor_role(p_workspace_id uuid, p_actor uuid)
returns public.membership_role
language sql
stable
security definer
set search_path = ''
as $body$
  select m.role from public.memberships m
  where m.workspace_id = p_workspace_id and m.user_id = p_actor and m.status = 'active';
$body$;

revoke all on function private.status_track_actor_role(uuid, uuid) from public, anon, authenticated, service_role;

-- Cria (se faltar) e TRAVA a linha da trilha. Duas primeiras escritas
-- simultâneas: o índice único decide, a segunda espera a trava e relê.
create function private.status_track_lock(
  p_workspace_id uuid,
  p_track public.status_track_kind,
  p_conversation_id uuid,
  p_opportunity_id uuid
)
returns public.status_tracks
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_row public.status_tracks;
begin
  insert into public.status_tracks (workspace_id, track, conversation_id, opportunity_id, attendance_status, case_progress_status)
  values (
    p_workspace_id, p_track,
    case when p_track = 'attendance' then p_conversation_id end,
    case when p_track <> 'attendance' then p_opportunity_id end,
    case when p_track = 'attendance' then 'nao_informado'::public.conversation_attendance_status end,
    case when p_track = 'case_progress' then 'nao_informado'::public.case_progress_status end
  )
  on conflict do nothing;

  if p_track = 'attendance' then
    select * into v_row from public.status_tracks
    where conversation_id = p_conversation_id and workspace_id = p_workspace_id
    for update;
  else
    select * into v_row from public.status_tracks
    where opportunity_id = p_opportunity_id and track = p_track and workspace_id = p_workspace_id
    for update;
  end if;

  if v_row.id is null then
    raise exception 'status_track_unavailable';
  end if;
  return v_row;
end;
$body$;

revoke all on function private.status_track_lock(uuid, public.status_track_kind, uuid, uuid) from public, anon, authenticated, service_role;

-- Evidência: até 20 mensagens distintas, todas do workspace, de conversas no
-- alcance do papel do ator e do alvo certo:
--   attendance                     → mensagens DA PRÓPRIA conversa;
--   case_progress/commercial_stage → mensagens de conversas do MESMO contato do
--                                    lead da oportunidade.
-- Qualquer id fora disso recusa a operação inteira, com um código único
-- (nunca diz qual id falhou nem por quê).
create function private.status_track_validate_evidence(
  p_workspace_id uuid,
  p_role public.membership_role,
  p_actor uuid,
  p_track public.status_track_kind,
  p_conversation_id uuid,
  p_contact_id uuid,
  p_message_ids uuid[]
)
returns uuid[]
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_ids uuid[] := coalesce(p_message_ids, '{}'::uuid[]);
  v_ok integer;
begin
  if cardinality(v_ids) = 0 then
    return v_ids;
  end if;
  if cardinality(v_ids) > 20
     or array_position(v_ids, null) is not null
     or (select count(distinct x) from unnest(v_ids) x) <> cardinality(v_ids) then
    raise exception 'invalid_evidence';
  end if;

  select count(*) into v_ok
  from public.messages m
  join public.conversations c on c.id = m.conversation_id and c.workspace_id = m.workspace_id
  left join public.leads l on l.id = c.lead_id and l.workspace_id = c.workspace_id
  where m.id = any(v_ids)
    and m.workspace_id = p_workspace_id
    and private.conversation_accessible_to_role(p_role, c.lead_id, l.assigned_to, p_actor)
    and case
          when p_track = 'attendance' then m.conversation_id = p_conversation_id
          else p_contact_id is not null and c.contact_id = p_contact_id
        end;

  if v_ok <> cardinality(v_ids) then
    raise exception 'invalid_evidence';
  end if;
  return v_ids;
end;
$body$;

revoke all on function private.status_track_validate_evidence(uuid, public.membership_role, uuid, public.status_track_kind, uuid, uuid, uuid[])
  from public, anon, authenticated, service_role;

-- Projeção pública de uma linha de trilha (estado atual).
create function private.status_track_state_json(p_row public.status_tracks)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $body$
  select jsonb_build_object(
    'track_id', p_row.id,
    'track', p_row.track,
    'conversation_id', p_row.conversation_id,
    'opportunity_id', p_row.opportunity_id,
    'status', coalesce(p_row.attendance_status::text, p_row.case_progress_status::text),
    'version', p_row.version,
    'automation_paused', p_row.automation_paused,
    'automation_paused_at', p_row.automation_paused_at,
    'automation_paused_by', p_row.automation_paused_by,
    'automation_paused_by_name', (
      select nullif(btrim(coalesce(nullif(btrim(u.full_name), ''), u.email)), '')
      from public.users u where u.id = p_row.automation_paused_by),
    'manual_decided_at', p_row.manual_decided_at
  );
$body$;

revoke all on function private.status_track_state_json(public.status_tracks) from public, anon, authenticated, service_role;

-- Repetição de uma mudança com a mesma chave de idempotência. Devolve nulo
-- quando a chave nunca foi usada; devolve o resultado gravado quando o pedido
-- é o MESMO (trilha, alvo, estado novo e conjunto de evidências); qualquer
-- divergência é idempotency_conflict — a chave nunca muda de significado.
create function private.status_track_replay(
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

revoke all on function private.status_track_replay(uuid, uuid, uuid, text, uuid[]) from public, anon, authenticated, service_role;

-- Grava o evento de mudança de estado e suas evidências.
create function private.status_track_record_change(
  p_row public.status_tracks,
  p_from text,
  p_to text,
  p_actor uuid,
  p_evidence uuid[],
  p_key uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_event_id uuid;
begin
  begin
    insert into public.status_track_events (
      workspace_id, track_id, event, from_status, to_status, from_version, to_version,
      actor_kind, actor_user_id, evidence_count, idempotency_key
    ) values (
      p_row.workspace_id, p_row.id, 'status_changed', p_from, p_to, p_row.version - 1, p_row.version,
      'user', p_actor, cardinality(p_evidence), p_key
    )
    returning id into v_event_id;
  exception when unique_violation then
    -- Mesma chave usada (ao mesmo tempo) para OUTRO alvo.
    raise exception 'idempotency_conflict';
  end;

  insert into public.status_track_event_evidence (workspace_id, event_id, message_id)
  select p_row.workspace_id, v_event_id, x from unnest(p_evidence) x;

  return v_event_id;
end;
$body$;

revoke all on function private.status_track_record_change(public.status_tracks, text, text, uuid, uuid[], uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 7) Correção manual da situação do atendimento (conversa)
--
-- Permissão: conversation.attendance_edit (owner, admin, manager, lawyer, sales),
-- com o alcance da conversa. Não é a permissão de envio: poder responder não
-- implica poder corrigir o andamento jurídico (case.progress_edit, abaixo).
-- ---------------------------------------------------------------------

create function public.set_conversation_attendance_status(
  p_conversation_id uuid,
  p_status public.conversation_attendance_status,
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
  v_conv public.conversations;
  v_assigned uuid;
  v_row public.status_tracks;
  v_evidence uuid[];
  v_replay jsonb;
  v_from text;
  v_event_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_conv from public.conversations where id = p_conversation_id;
  if v_conv.id is null then
    raise exception 'conversation_not_found';
  end if;

  v_role := private.status_track_actor_role(v_conv.workspace_id, v_actor);
  if v_role is null then
    raise exception 'insufficient_permission';
  end if;
  select assigned_to into v_assigned from public.leads where id = v_conv.lead_id;
  if not private.conversation_accessible_to_role(v_role, v_conv.lead_id, v_assigned, v_actor) then
    raise exception 'conversation_not_found';
  end if;
  if v_role not in ('owner', 'admin', 'manager', 'lawyer', 'sales') then
    raise exception 'insufficient_permission';
  end if;

  if p_status is null or p_status = 'nao_informado' then
    raise exception 'invalid_status';
  end if;
  if p_expected_version is null or p_expected_version < 0 then
    raise exception 'invalid_version';
  end if;

  v_evidence := private.status_track_validate_evidence(
    v_conv.workspace_id, v_role, v_actor, 'attendance', v_conv.id, null, p_evidence_message_ids);

  v_row := private.status_track_lock(v_conv.workspace_id, 'attendance', v_conv.id, null);

  -- Depois da trava: duas repetições simultâneas da mesma chave se enfileiram aqui.
  v_replay := private.status_track_replay(v_conv.workspace_id, p_idempotency_key, v_row.id, p_status::text, v_evidence);
  if v_replay is not null then
    return v_replay;
  end if;

  if v_row.version <> p_expected_version then
    raise exception 'track_conflict';
  end if;
  if v_row.attendance_status = p_status then
    raise exception 'status_unchanged';
  end if;

  v_from := v_row.attendance_status::text;
  update public.status_tracks
  set attendance_status = p_status, version = version + 1, manual_decided_at = clock_timestamp()
  where id = v_row.id
  returning * into v_row;

  v_event_id := private.status_track_record_change(v_row, v_from, p_status::text, v_actor, v_evidence, p_idempotency_key);

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_conv.workspace_id, v_actor, 'conversation.attendance_changed', 'conversation', v_conv.id,
          jsonb_build_object('track', 'attendance', 'from_status', v_from, 'to_status', p_status::text,
                             'version', v_row.version, 'evidence_count', cardinality(v_evidence)));

  return private.status_track_state_json(v_row)
    || jsonb_build_object('event_id', v_event_id, 'event_version', v_row.version, 'replayed', false);
end;
$body$;

comment on function public.set_conversation_attendance_status(uuid, public.conversation_attendance_status, bigint, uuid[], uuid) is
  'Conversas + IA (PR 1): correção manual da situação do atendimento. Versão esperada obrigatória (track_conflict), evidência validada no servidor, chave de idempotência opcional. Não envia mensagem nem chama serviço externo.';

revoke all on function public.set_conversation_attendance_status(uuid, public.conversation_attendance_status, bigint, uuid[], uuid) from public, anon;
grant execute on function public.set_conversation_attendance_status(uuid, public.conversation_attendance_status, bigint, uuid[], uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 8) Correção manual do andamento do caso/serviço (oportunidade GANHA)
--
-- Permissão nova case.progress_edit (owner, admin, manager, lawyer), com o
-- alcance do lead. Atendimento (sales) e visualizador não alteram andamento.
-- ---------------------------------------------------------------------

create function public.set_opportunity_case_progress(
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

  v_from := v_row.case_progress_status::text;
  update public.status_tracks
  set case_progress_status = p_status, version = version + 1, manual_decided_at = clock_timestamp()
  where id = v_row.id
  returning * into v_row;

  v_event_id := private.status_track_record_change(v_row, v_from, p_status::text, v_actor, v_evidence, p_idempotency_key);

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_opp.workspace_id, v_actor, 'opportunity.case_progress_changed', 'opportunity', v_opp.id,
          jsonb_build_object('track', 'case_progress', 'from_status', v_from, 'to_status', p_status::text,
                             'version', v_row.version, 'evidence_count', cardinality(v_evidence)));

  return private.status_track_state_json(v_row)
    || jsonb_build_object('event_id', v_event_id, 'event_version', v_row.version, 'replayed', false);
end;
$body$;

comment on function public.set_opportunity_case_progress(uuid, public.case_progress_status, bigint, uuid[], uuid) is
  'Conversas + IA (PR 1): correção manual do andamento do caso/serviço de uma oportunidade GANHA. Versão esperada obrigatória, evidência validada (conversas do mesmo contato, no alcance do papel), chave de idempotência opcional.';

revoke all on function public.set_opportunity_case_progress(uuid, public.case_progress_status, bigint, uuid[], uuid) from public, anon;
grant execute on function public.set_opportunity_case_progress(uuid, public.case_progress_status, bigint, uuid[], uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 9) Pausar / retomar FUTURAS alterações automáticas por trilha e alvo
--
-- Quem pode corrigir a trilha manualmente pode pausá-la:
--   attendance       → conversation.attendance_edit, na conversa;
--   case_progress    → case.progress_edit, em oportunidade ganha;
--   commercial_stage → opportunity.edit, em oportunidade aberta.
-- Pausar e retomar incrementam a versão (avaliações antigas ficam inválidas) e
-- entram no histórico. A pausa nunca bloqueia a correção manual.
-- ---------------------------------------------------------------------

create function public.set_status_track_automation(
  p_track public.status_track_kind,
  p_target_id uuid,
  p_paused boolean,
  p_expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_workspace_id uuid;
  v_conv public.conversations;
  v_opp public.opportunities;
  v_assigned uuid;
  v_row public.status_tracks;
  v_event_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;
  if p_track is null or p_target_id is null or p_paused is null then
    raise exception 'invalid_request';
  end if;
  if p_expected_version is null or p_expected_version < 0 then
    raise exception 'invalid_version';
  end if;

  if p_track = 'attendance' then
    select * into v_conv from public.conversations where id = p_target_id;
    if v_conv.id is null then
      raise exception 'conversation_not_found';
    end if;
    v_workspace_id := v_conv.workspace_id;
    v_role := private.status_track_actor_role(v_workspace_id, v_actor);
    if v_role is null then
      raise exception 'insufficient_permission';
    end if;
    select assigned_to into v_assigned from public.leads where id = v_conv.lead_id;
    if not private.conversation_accessible_to_role(v_role, v_conv.lead_id, v_assigned, v_actor) then
      raise exception 'conversation_not_found';
    end if;
    if v_role not in ('owner', 'admin', 'manager', 'lawyer', 'sales') then
      raise exception 'insufficient_permission';
    end if;
    v_row := private.status_track_lock(v_workspace_id, 'attendance', v_conv.id, null);
  else
    select * into v_opp from public.opportunities where id = p_target_id;
    if v_opp.id is null then
      raise exception 'opportunity_not_found';
    end if;
    v_workspace_id := v_opp.workspace_id;
    v_role := private.status_track_actor_role(v_workspace_id, v_actor);
    if v_role is null then
      raise exception 'insufficient_permission';
    end if;
    select assigned_to into v_assigned from public.leads where id = v_opp.lead_id and workspace_id = v_workspace_id;
    if not private.lead_accessible_to_role(v_role, v_assigned, v_actor) then
      raise exception 'opportunity_not_found';
    end if;
    if p_track = 'case_progress' then
      if v_role not in ('owner', 'admin', 'manager', 'lawyer') then
        raise exception 'insufficient_permission';
      end if;
      if v_opp.status <> 'won' then
        raise exception 'opportunity_not_won';
      end if;
    else
      if v_role not in ('owner', 'admin', 'manager', 'lawyer', 'sales') then
        raise exception 'insufficient_permission';
      end if;
      if v_opp.status <> 'open' then
        raise exception 'opportunity_closed';
      end if;
    end if;
    v_row := private.status_track_lock(v_workspace_id, p_track, null, v_opp.id);
  end if;

  if v_row.version <> p_expected_version then
    raise exception 'track_conflict';
  end if;
  if p_paused and v_row.automation_paused then
    raise exception 'automation_already_paused';
  end if;
  if not p_paused and not v_row.automation_paused then
    raise exception 'automation_not_paused';
  end if;

  update public.status_tracks
  set automation_paused = p_paused,
      automation_paused_at = case when p_paused then clock_timestamp() end,
      automation_paused_by = case when p_paused then v_actor end,
      version = version + 1
  where id = v_row.id
  returning * into v_row;

  insert into public.status_track_events (
    workspace_id, track_id, event, from_version, to_version, actor_kind, actor_user_id
  ) values (
    v_workspace_id, v_row.id, case when p_paused then 'automation_paused' else 'automation_resumed' end,
    v_row.version - 1, v_row.version, 'user', v_actor
  )
  returning id into v_event_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_workspace_id, v_actor,
          case when p_paused then 'status_track.automation_paused' else 'status_track.automation_resumed' end,
          case when p_track = 'attendance' then 'conversation' else 'opportunity' end, p_target_id,
          jsonb_build_object('track', p_track::text, 'version', v_row.version));

  return private.status_track_state_json(v_row)
    || jsonb_build_object('event_id', v_event_id, 'event_version', v_row.version, 'replayed', false);
end;
$body$;

comment on function public.set_status_track_automation(public.status_track_kind, uuid, boolean, bigint) is
  'Conversas + IA (PR 1): pausa/retomada persistida das FUTURAS alterações automáticas de uma trilha e alvo. Incrementa a versão e entra no histórico; nunca bloqueia a correção manual.';

revoke all on function public.set_status_track_automation(public.status_track_kind, uuid, boolean, bigint) from public, anon;
grant execute on function public.set_status_track_automation(public.status_track_kind, uuid, boolean, bigint) to authenticated;

-- ---------------------------------------------------------------------
-- 10) Leitura: estado atual de uma trilha
--
-- Leitura com o mesmo alcance da conversa/oportunidade (todos os papéis
-- membros, advogado com "seus + sem responsável"). Sem linha = padrão.
-- case_progress de oportunidade não ganha: applicable=false, status nulo.
-- ---------------------------------------------------------------------

create function private.status_track_target(
  p_track public.status_track_kind,
  p_target_id uuid,
  p_actor uuid,
  out workspace_id uuid,
  out role public.membership_role,
  out conversation_id uuid,
  out opportunity_id uuid,
  out opportunity_status public.opportunity_status,
  out contact_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_conv public.conversations;
  v_opp public.opportunities;
  v_lead public.leads;
  v_assigned uuid;
begin
  if p_track = 'attendance' then
    select * into v_conv from public.conversations c where c.id = p_target_id;
    if v_conv.id is null then
      raise exception 'conversation_not_found';
    end if;
    workspace_id := v_conv.workspace_id;
    role := private.status_track_actor_role(v_conv.workspace_id, p_actor);
    if role is null then
      raise exception 'insufficient_permission';
    end if;
    select l.assigned_to into v_assigned from public.leads l where l.id = v_conv.lead_id;
    if not private.conversation_accessible_to_role(role, v_conv.lead_id, v_assigned, p_actor) then
      raise exception 'conversation_not_found';
    end if;
    conversation_id := v_conv.id;
    contact_id := v_conv.contact_id;
  else
    select * into v_opp from public.opportunities o where o.id = p_target_id;
    if v_opp.id is null then
      raise exception 'opportunity_not_found';
    end if;
    workspace_id := v_opp.workspace_id;
    role := private.status_track_actor_role(v_opp.workspace_id, p_actor);
    if role is null then
      raise exception 'insufficient_permission';
    end if;
    select * into v_lead from public.leads l where l.id = v_opp.lead_id and l.workspace_id = v_opp.workspace_id;
    if not private.lead_accessible_to_role(role, v_lead.assigned_to, p_actor) then
      raise exception 'opportunity_not_found';
    end if;
    opportunity_id := v_opp.id;
    opportunity_status := v_opp.status;
    contact_id := v_lead.contact_id;
  end if;
end;
$body$;

revoke all on function private.status_track_target(public.status_track_kind, uuid, uuid) from public, anon, authenticated, service_role;

create function public.get_status_track(p_track public.status_track_kind, p_target_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_target record;
  v_row public.status_tracks;
  v_stage_id uuid;
  v_stage_name text;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;
  if p_track is null or p_target_id is null then
    raise exception 'invalid_request';
  end if;

  select * into v_target from private.status_track_target(p_track, p_target_id, v_actor);

  if p_track = 'attendance' then
    select * into v_row from public.status_tracks t where t.conversation_id = v_target.conversation_id;
  else
    select * into v_row from public.status_tracks t where t.opportunity_id = v_target.opportunity_id and t.track = p_track;
  end if;

  if p_track = 'commercial_stage' then
    select s.id, s.name into v_stage_id, v_stage_name
    from public.opportunities o join public.pipeline_stages s on s.id = o.stage_id and s.pipeline_id = o.pipeline_id
    where o.id = v_target.opportunity_id;
  end if;

  return jsonb_build_object(
    'track', p_track,
    'conversation_id', v_target.conversation_id,
    'opportunity_id', v_target.opportunity_id,
    'applicable', p_track <> 'case_progress' or v_target.opportunity_status = 'won',
    'has_record', v_row.id is not null,
    'status', case
      when p_track = 'attendance' then coalesce(v_row.attendance_status::text, 'nao_informado')
      when p_track = 'case_progress' and v_target.opportunity_status = 'won'
        then coalesce(v_row.case_progress_status::text, 'nao_informado')
    end,
    'stage_id', v_stage_id,
    'stage_name', v_stage_name,
    'version', coalesce(v_row.version, 0),
    'automation_paused', coalesce(v_row.automation_paused, false),
    'automation_paused_at', v_row.automation_paused_at,
    'automation_paused_by_name', (
      select nullif(btrim(coalesce(nullif(btrim(u.full_name), ''), u.email)), '')
      from public.users u where u.id = v_row.automation_paused_by),
    'manual_decided_at', v_row.manual_decided_at
  );
end;
$body$;

comment on function public.get_status_track(public.status_track_kind, uuid) is
  'Conversas + IA (PR 1): estado atual de uma trilha (status, versão, pausa e marco de evidência). Sem registro = nao_informado, versão 0.';

revoke all on function public.get_status_track(public.status_track_kind, uuid) from public, anon;
grant execute on function public.get_status_track(public.status_track_kind, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 11) Leitura: histórico de uma trilha (cursor (occurred_at, id))
--
-- A evidência volta só como referência (mensagem, conversa, direção, origem,
-- classificação, tipo e data), sem texto, e só das conversas que QUEM LÊ
-- alcança; as demais contam em evidence_hidden. Referências apagadas pela
-- retenção contam em evidence_removed (evidence_count menos as que restam).
-- Para commercial_stage aqui só aparecem pausa e retomada: as movimentações
-- estão em stage_transitions.
-- ---------------------------------------------------------------------

create function public.list_status_track_history(
  p_track public.status_track_kind,
  p_target_id uuid,
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
  v_track_id uuid;
  v_limit integer;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;
  if p_track is null or p_target_id is null then
    raise exception 'invalid_request';
  end if;
  if (p_before is null) <> (p_before_id is null) then
    raise exception 'invalid_cursor';
  end if;

  select * into v_target from private.status_track_target(p_track, p_target_id, v_actor);

  if p_track = 'attendance' then
    select t.id into v_track_id from public.status_tracks t where t.conversation_id = v_target.conversation_id;
  else
    select t.id into v_track_id from public.status_tracks t where t.opportunity_id = v_target.opportunity_id and t.track = p_track;
  end if;

  v_limit := greatest(1, least(coalesce(p_limit, 30), 100));

  return query
  with page as (
    select e.*
    from public.status_track_events e
    where v_track_id is not null
      and e.track_id = v_track_id
      and (p_before is null or (e.occurred_at, e.id) < (p_before, p_before_id))
    order by e.occurred_at desc, e.id desc
    limit v_limit + 1
  ),
  shown as (
    select * from page order by occurred_at desc, id desc limit v_limit
  ),
  ev as (
    select
      ee.event_id,
      m.id as message_id,
      m.conversation_id,
      m.direction,
      m.origin,
      m.sender_classification,
      m.content_kind,
      m.created_at,
      private.conversation_accessible_to_role(v_target.role, c.lead_id, l.assigned_to, v_actor) as visible
    from public.status_track_event_evidence ee
    join public.messages m on m.id = ee.message_id and m.workspace_id = ee.workspace_id
    join public.conversations c on c.id = m.conversation_id and c.workspace_id = m.workspace_id
    left join public.leads l on l.id = c.lead_id and l.workspace_id = c.workspace_id
    where ee.event_id in (select id from shown)
  )
  select
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', s.id,
            'event', s.event,
            'from_status', s.from_status,
            'to_status', s.to_status,
            'from_version', s.from_version,
            'to_version', s.to_version,
            'actor_kind', s.actor_kind,
            'actor_user_id', s.actor_user_id,
            'actor_name', (
              select nullif(btrim(coalesce(nullif(btrim(u.full_name), ''), u.email)), '')
              from public.users u where u.id = s.actor_user_id),
            'occurred_at', s.occurred_at,
            'evidence_count', s.evidence_count,
            'evidence', coalesce((
              select jsonb_agg(jsonb_build_object(
                'message_id', ev.message_id, 'conversation_id', ev.conversation_id, 'direction', ev.direction,
                'origin', ev.origin, 'sender_classification', ev.sender_classification,
                'content_kind', ev.content_kind, 'created_at', ev.created_at)
                order by ev.created_at, ev.message_id)
              from ev where ev.event_id = s.id and ev.visible), '[]'::jsonb),
            'evidence_hidden', (select count(*) from ev where ev.event_id = s.id and not ev.visible),
            'evidence_removed', s.evidence_count - (select count(*) from ev where ev.event_id = s.id)
          )
          order by s.occurred_at desc, s.id desc
        )
        from shown s
      ),
      '[]'::jsonb
    ),
    (select count(*) from page) > v_limit;
end;
$body$;

comment on function public.list_status_track_history(public.status_track_kind, uuid, timestamptz, uuid, integer) is
  'Conversas + IA (PR 1): histórico de uma trilha, paginado por (occurred_at, id). Evidência só por referência e só das conversas que quem lê alcança. Movimentações comerciais continuam em stage_transitions.';

revoke all on function public.list_status_track_history(public.status_track_kind, uuid, timestamptz, uuid, integer) from public, anon;
grant execute on function public.list_status_track_history(public.status_track_kind, uuid, timestamptz, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------
-- 12) Oportunidade em foco na conversa — SEM escrita
--
-- O foco é estado da interface (vai na URL), separado do vínculo persistido
-- conversations.opportunity_id, que os fluxos existentes (revisão de vínculo,
-- retenção, exportação, perfil 360) continuam usando sem mudança. As duas
-- funções só leem e validam: opções = oportunidades dos leads do MESMO contato
-- da conversa, no alcance do papel; nada é transferido para o caso escolhido.
-- ---------------------------------------------------------------------

create function private.conversation_case_item(
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
    'created_at', o.created_at
  )
  from public.opportunities o
  join public.leads l on l.id = o.lead_id and l.workspace_id = o.workspace_id
  join public.pipeline_stages s on s.id = o.stage_id and s.pipeline_id = o.pipeline_id
  left join public.status_tracks t on t.opportunity_id = o.id and t.track = 'case_progress'
  where o.id = p_opportunity_id;
$body$;

revoke all on function private.conversation_case_item(uuid, uuid) from public, anon, authenticated, service_role;

create function public.list_conversation_case_options(p_conversation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_target record;
  v_conv public.conversations;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_target from private.status_track_target('attendance', p_conversation_id, v_actor);
  select * into v_conv from public.conversations where id = v_target.conversation_id;

  return jsonb_build_object(
    'conversation_id', v_conv.id,
    'contact_resolved', v_conv.contact_id is not null,
    'linked_opportunity_id', v_conv.opportunity_id,
    'items', coalesce((
      select jsonb_agg(private.conversation_case_item(o.id, v_conv.opportunity_id)
                       order by (o.id = v_conv.opportunity_id) desc,
                                case o.status when 'open' then 0 when 'won' then 1 else 2 end,
                                o.created_at desc, o.id)
      from public.opportunities o
      join public.leads l on l.id = o.lead_id and l.workspace_id = o.workspace_id
      where v_conv.contact_id is not null
        and o.workspace_id = v_conv.workspace_id
        and l.contact_id = v_conv.contact_id
        and private.lead_accessible_to_role(v_target.role, l.assigned_to, v_actor)
    ), '[]'::jsonb)
  );
end;
$body$;

comment on function public.list_conversation_case_options(uuid) is
  'Conversas + IA (PR 1): oportunidades que podem ficar em foco numa conversa (leads do mesmo contato, no alcance do papel). Só leitura; o vínculo persistido não muda.';

revoke all on function public.list_conversation_case_options(uuid) from public, anon;
grant execute on function public.list_conversation_case_options(uuid) to authenticated;

create function public.get_conversation_case(p_conversation_id uuid, p_opportunity_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_target record;
  v_conv public.conversations;
  v_ok boolean;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;
  if p_opportunity_id is null then
    raise exception 'case_not_selectable';
  end if;

  select * into v_target from private.status_track_target('attendance', p_conversation_id, v_actor);
  select * into v_conv from public.conversations where id = v_target.conversation_id;

  select exists (
    select 1
    from public.opportunities o
    join public.leads l on l.id = o.lead_id and l.workspace_id = o.workspace_id
    where o.id = p_opportunity_id
      and v_conv.contact_id is not null
      and o.workspace_id = v_conv.workspace_id
      and l.contact_id = v_conv.contact_id
      and private.lead_accessible_to_role(v_target.role, l.assigned_to, v_actor)
  ) into v_ok;

  -- Outro contato, outro workspace, fora do alcance, inexistente ou conversa sem
  -- contato resolvido: o mesmo código, sem revelar qual.
  if not v_ok then
    raise exception 'case_not_selectable';
  end if;

  return private.conversation_case_item(p_opportunity_id, v_conv.opportunity_id)
    || jsonb_build_object('conversation_id', v_conv.id, 'linked_opportunity_id', v_conv.opportunity_id);
end;
$body$;

comment on function public.get_conversation_case(uuid, uuid) is
  'Conversas + IA (PR 1): valida e devolve a oportunidade escolhida como foco de uma conversa (mesmo contato, no alcance do papel). Só leitura: não altera conversations.opportunity_id nem transfere mensagens ou evidências.';

revoke all on function public.get_conversation_case(uuid, uuid) from public, anon;
grant execute on function public.get_conversation_case(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 13) Mensagens: origem, classificação e tipo de conteúdo na leitura
--
-- Mesma assinatura, mesmo alcance e mesma paginação; só três chaves novas por
-- item. Os valores saem como gravados: "chatbot" exige correlação positiva na
-- gravação (B3 §15.10) e mesmo assim não identifica a Vitória; sem correlação a
-- classificação continua "unresolved". `create or replace` preserva a ACL.
-- ---------------------------------------------------------------------

create or replace function public.list_conversation_messages(
  p_conversation_id uuid,
  p_before timestamptz default null,
  p_limit integer default 30,
  p_before_id uuid default null
)
returns table (items jsonb, has_more boolean)
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_conv public.conversations;
  v_lead_assigned_to uuid;
  v_limit integer;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_conv from public.conversations where id = p_conversation_id;
  if v_conv.id is null then
    raise exception 'conversation_not_found';
  end if;

  if not private.has_workspace_role(
    v_conv.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_conv.workspace_id and user_id = v_actor and status = 'active';

  select assigned_to into v_lead_assigned_to from public.leads where id = v_conv.lead_id;

  if not private.conversation_accessible_to_role(v_role, v_conv.lead_id, v_lead_assigned_to, v_actor) then
    raise exception 'conversation_not_found';
  end if;

  if p_before is not null and p_before_id is null then
    raise exception 'invalid_cursor';
  end if;

  v_limit := greatest(1, least(coalesce(p_limit, 30), 100));

  return query
  with page as (
    select m.*
    from public.messages m
    where m.conversation_id = p_conversation_id
      and (
        p_before is null
        -- Comparação de linha (created_at, id): desempata mensagens com o
        -- MESMO created_at pelo id, sem o que uma página podia pular ou
        -- repetir mensagens empatadas no timestamp entre duas buscas.
        or (m.created_at, m.id) < (p_before, p_before_id)
      )
    order by m.created_at desc, m.id desc
    limit v_limit
  ),
  cursor_point as (
    select created_at, id from page order by created_at asc, id asc limit 1
  ),
  older_count as (
    select count(*) as n
    from public.messages m, cursor_point cp
    where m.conversation_id = p_conversation_id
      and (m.created_at, m.id) < (cp.created_at, cp.id)
  )
  select
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', p.id, 'direction', p.direction, 'body_text', p.body_text, 'status', p.status,
            'status_updated_at', p.status_updated_at, 'error_reason', p.error_reason,
            'sent_by', p.sent_by, 'created_at', p.created_at, 'wa_message_id', p.wa_message_id,
            'origin', p.origin, 'sender_classification', p.sender_classification,
            'content_kind', p.content_kind
          )
          order by p.created_at asc, p.id asc
        )
        from page p
      ),
      '[]'::jsonb
    ),
    coalesce((select n from older_count), 0) > 0;
end;
$body$;

-- ---------------------------------------------------------------------
-- 14) Exportação do titular (C3a): duas seções novas
--
-- Mesma função, mesma assinatura e as mesmas seções anteriores, byte a byte;
-- entram `status_tracks` (estado atual das trilhas das conversas e oportunidades
-- do titular) e `status_track_history` (eventos, com os ids das mensagens de
-- evidência). Como no restante da C3a: sem usuário interno (quem pausou ou
-- decidiu) e sem chave de idempotência.
-- ---------------------------------------------------------------------

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
    ), '[]'::jsonb)
  );
$body$;
