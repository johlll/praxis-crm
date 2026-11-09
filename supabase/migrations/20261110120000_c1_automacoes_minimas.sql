-- C1 mínima — automações internas do CRM: regras, simulação obrigatória,
-- eventos registrados junto da operação de origem, execução idempotente e
-- histórico. Migration NOVA e forward-only: três tabelas, triggers de captura
-- de evento, funções privadas e as RPCs da tela de Automações. Nenhuma função,
-- policy, grant ou tabela existente é alterada; a única mudança em objeto
-- existente é o valor novo `automation` em `public.activity_source` (abaixo).
--
-- O que existe (e só isto):
--   * Gatilhos: lead criado; oportunidade mudou de etapa.
--   * Condições: só campos padrão (prioridade e área do lead; etapa de destino
--     e, opcionalmente, de origem). Colunas tipadas e fechadas — não há SQL,
--     JavaScript, expressão nem JSON livre.
--   * Ação: UMA, criar atividade de acompanhamento (título, prazo em dias,
--     prioridade, responsável = usuário específico ou responsável atual do
--     lead). Nenhum envio de WhatsApp, e-mail ou notificação.
--
-- Eventos. `automation_events` é gravada por trigger (AFTER INSERT em `leads`
-- e em `stage_transitions`), portanto na MESMA transação da operação de origem:
-- ou os dois existem ou nenhum. O trigger só insere uma linha — não avalia
-- regra nem cria atividade —, e só quando existe regra ATIVA para aquele
-- gatilho no workspace (quem não usa automação não acumula evento).
--
-- Execução. Um processador (`private.automation_process`) faz duas etapas
-- independentes: (1) transforma cada evento pendente em uma execução por regra
-- compatível; (2) roda as execuções vencidas. A unicidade (evento, regra)
-- garante que reprocessar um evento nunca duplica a atividade; cada execução
-- roda numa subtransação própria, então a falha de uma regra não desfaz outra
-- nem a operação de origem (que já foi confirmada antes de o processador
-- existir). Falha tem no máximo 4 tentativas (espera de 1, 5 e 30 minutos) e
-- depois vira `dead_letter`, terminal e consultável. Só CÓDIGOS fechados são
-- gravados (CHECK na coluna): nunca payload, dado pessoal ou mensagem de erro
-- do banco.
--
-- Regra alterada, pausada ou arquivada. Qualquer mudança de gatilho,
-- condição ou ação incrementa `version` e invalida a simulação; se a regra
-- estava ativa, passa a pausada. Uma execução guarda a versão com que nasceu e
-- é CANCELADA se a regra deixou de estar ativa ou mudou antes de rodar. Evento
-- anterior à ativação da regra nunca a dispara.
--
-- Simulação. Só lê leads/etapas (janela de 30 dias) e devolve contagem e uma
-- prévia sem identificação (nada de nome, CPF, telefone, e-mail ou conversa).
-- O ÚNICO efeito é carimbar na própria regra a versão simulada. Uma regra só
-- pode estar ativa com simulação da versão atual (CHECK na tabela).
--
-- Acesso. As três tabelas têm RLS habilitada e FORÇADA, sem policy e sem grant:
-- tudo passa pelas funções abaixo. Gerir regras: owner e admin; consultar
-- regras e histórico: também manager.

-- ---------------------------------------------------------------------
-- Origem da atividade
-- ---------------------------------------------------------------------
-- A atividade criada por uma regra nasce com source = 'automation' (nunca
-- 'manual'). Os quatro valores anteriores e as atividades já existentes não
-- mudam. O valor novo só é USADO dentro do corpo de `private.automation_run_execution`
-- (plpgsql avalia o literal na execução, nunca na criação da função), portanto
-- não há uso na mesma transação em que ele é adicionado — o que o PostgreSQL
-- proíbe. Nada nesta migration executa o processador.

alter type public.activity_source add value 'automation';

comment on type public.activity_source is
  'Origem da atividade: manual, automática por regra de etapa (A6), pela primeira mensagem de WhatsApp de um contato novo (A7), pela captação de um formulário público próprio (A11) ou criada por uma regra de Automações (C1).';

-- A CHECK de consistência da origem (A6/A7/A11) recusaria a linha nova: ganha
-- UM ramo, o da automação (sem nenhuma coluna de rastreabilidade — o vínculo
-- fica em automation_executions.activity_id). Os quatro ramos anteriores são
-- copiados byte a byte; nenhuma atividade existente passa a valer menos nem
-- mais. O ramo novo compara `source::text` porque o literal do enum recém
-- adicionado não pode ser referenciado na transação que o adiciona.
alter table public.activities
  drop constraint activities_source_consistency;

alter table public.activities
  add constraint activities_source_consistency check (
    (source = 'manual' and source_stage_transition_id is null and source_rule_id is null and source_conversation_message_id is null and source_webhook_event_id is null) or
    (source = 'stage_rule' and source_stage_transition_id is not null and source_conversation_message_id is null and source_webhook_event_id is null) or
    (source = 'whatsapp_inbound' and source_conversation_message_id is not null and source_stage_transition_id is null and source_rule_id is null and source_webhook_event_id is null) or
    (source = 'form_intake' and source_webhook_event_id is not null and source_stage_transition_id is null and source_rule_id is null and source_conversation_message_id is null) or
    (source::text = 'automation' and source_stage_transition_id is null and source_rule_id is null and source_conversation_message_id is null and source_webhook_event_id is null)
  );

comment on constraint activities_source_consistency on public.activities is
  'Cada source exige sua própria coluna de rastreabilidade (e só ela): stage_rule -> source_stage_transition_id; whatsapp_inbound -> source_conversation_message_id; form_intake -> source_webhook_event_id; automation e manual -> nenhuma (a automação se liga pela execução).';

-- ---------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------

create table public.automation_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'archived')),
  trigger_type text not null check (trigger_type in ('lead_created', 'opportunity_stage_changed')),
  -- Condições (todas opcionais, exceto a etapa de destino do gatilho de etapa).
  cond_priority public.lead_priority,
  cond_legal_area text check (cond_legal_area is null or char_length(btrim(cond_legal_area)) between 1 and 120),
  -- Sem FK para pipeline_stages de propósito: apagar uma etapa (A5) não pode
  -- ser bloqueada nem apagar a regra; uma etapa removida simplesmente nunca
  -- casa. O valor é validado na criação/edição.
  cond_to_stage_id uuid,
  cond_from_stage_id uuid,
  -- Ação: criar atividade de acompanhamento.
  action_title text not null check (char_length(btrim(action_title)) between 1 and 160),
  action_due_days integer not null check (action_due_days between 0 and 90),
  action_priority public.lead_priority not null default 'media',
  action_assignee_mode text not null check (action_assignee_mode in ('lead_owner', 'user')),
  action_assignee_user_id uuid,
  -- Versão da configuração (gatilho, condições, ação) e simulação carimbada.
  version integer not null default 1,
  simulated_version integer,
  simulated_at timestamptz,
  simulated_count integer check (simulated_count is null or simulated_count >= 0),
  activated_at timestamptz,
  created_by uuid not null references auth.users (id) on delete restrict,
  updated_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint automation_rules_workspace_id_id_key unique (workspace_id, id),
  constraint automation_rules_trigger_shape check (
    (trigger_type = 'lead_created' and cond_to_stage_id is null and cond_from_stage_id is null)
    or (
      trigger_type = 'opportunity_stage_changed'
      and cond_to_stage_id is not null
      and cond_priority is null
      and cond_legal_area is null
    )
  ),
  constraint automation_rules_assignee_shape check (
    (action_assignee_mode = 'lead_owner' and action_assignee_user_id is null)
    or (action_assignee_mode = 'user' and action_assignee_user_id is not null)
  ),
  -- Defesa no banco: nenhuma regra fica ativa sem simulação da versão atual.
  -- (is not null explícito: CHECK trata NULL como aprovado, e `NULL = version` é NULL.)
  constraint automation_rules_active_needs_current_simulation check (
    status <> 'active'
    or (simulated_version is not null and simulated_version = version and activated_at is not null)
  )
);

comment on table public.automation_rules is
  'Regras de automação interna (C1). Uma ação por regra: criar atividade de acompanhamento. Só ativa com simulação da versão atual.';

create index automation_rules_workspace_idx on public.automation_rules (workspace_id, status);

create trigger automation_rules_set_updated_at
  before update on public.automation_rules
  for each row execute function private.set_updated_at();

create table public.automation_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  event_type text not null check (event_type in ('lead_created', 'opportunity_stage_changed')),
  lead_id uuid not null,
  opportunity_id uuid,
  transition_id uuid,
  from_stage_id uuid,
  to_stage_id uuid,
  -- Retrato do que as condições leem, no instante do evento.
  lead_priority public.lead_priority,
  lead_legal_area text,
  actor_user_id uuid,
  status text not null default 'pending' check (status in ('pending', 'processed')),
  occurred_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint automation_events_workspace_id_id_key unique (workspace_id, id),
  constraint automation_events_shape check (
    (event_type = 'lead_created' and opportunity_id is null and transition_id is null and to_stage_id is null)
    or (
      event_type = 'opportunity_stage_changed'
      and opportunity_id is not null
      and transition_id is not null
      and to_stage_id is not null
    )
  ),
  constraint automation_events_lead_fkey
    foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade,
  constraint automation_events_opportunity_fkey
    foreign key (workspace_id, opportunity_id, lead_id)
    references public.opportunities (workspace_id, id, lead_id) on delete cascade
);

comment on table public.automation_events is
  'Evento de origem (lead criado / mudança de etapa), gravado por trigger na mesma transação da operação. Só ids e o retrato mínimo das condições; nenhum dado pessoal.';

-- Um evento por origem, mesmo que o trigger dispare duas vezes.
create unique index automation_events_lead_created_once
  on public.automation_events (lead_id) where event_type = 'lead_created';
create unique index automation_events_transition_once
  on public.automation_events (transition_id) where transition_id is not null;
create index automation_events_pending_idx
  on public.automation_events (occurred_at, id) where status = 'pending';

create table public.automation_executions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  rule_id uuid not null,
  event_id uuid not null,
  -- Versão da regra com que a execução nasceu; mudou depois, não executa.
  rule_version integer not null,
  state text not null default 'pending' check (state in ('pending', 'succeeded', 'cancelled', 'dead_letter')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 4),
  next_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  -- Só códigos fechados: a coluna não aceita texto livre nem mensagem de erro.
  error_code text check (
    error_code is null
    or error_code in (
      'assignee_not_member', 'assignee_no_access', 'target_not_found',
      'rule_inactive', 'rule_changed', 'unexpected_error'
    )
  ),
  activity_id uuid,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint automation_executions_rule_fkey
    foreign key (workspace_id, rule_id) references public.automation_rules (workspace_id, id) on delete cascade,
  constraint automation_executions_event_fkey
    foreign key (workspace_id, event_id) references public.automation_events (workspace_id, id) on delete cascade,
  constraint automation_executions_activity_fkey
    foreign key (workspace_id, activity_id) references public.activities (workspace_id, id)
    on delete set null (activity_id),
  -- No máximo um efeito por evento + regra (a regra tem uma única ação).
  constraint automation_executions_once_per_event_rule unique (event_id, rule_id),
  constraint automation_executions_state_shape check (
    (state = 'pending' and finished_at is null and activity_id is null)
    or (state = 'succeeded' and finished_at is not null and error_code is null)
    or (state in ('cancelled', 'dead_letter') and finished_at is not null and error_code is not null)
  )
);

comment on table public.automation_executions is
  'Execução de uma regra para um evento: estado, tentativas e código sanitizado. dead_letter é terminal.';

create index automation_executions_due_idx
  on public.automation_executions (next_attempt_at, id) where state = 'pending';
create index automation_executions_history_idx
  on public.automation_executions (workspace_id, created_at desc, id desc);

alter table public.automation_rules enable row level security;
alter table public.automation_rules force row level security;
revoke all on table public.automation_rules from public, anon, authenticated;

alter table public.automation_events enable row level security;
alter table public.automation_events force row level security;
revoke all on table public.automation_events from public, anon, authenticated;

alter table public.automation_executions enable row level security;
alter table public.automation_executions force row level security;
revoke all on table public.automation_executions from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Captura de evento (triggers). Só inserem uma linha; nunca avaliam regra.
-- ---------------------------------------------------------------------

create function private.automation_capture_lead_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $body$
begin
  if exists (
    select 1 from public.automation_rules r
    where r.workspace_id = new.workspace_id and r.status = 'active' and r.trigger_type = 'lead_created'
  ) then
    insert into public.automation_events (
      workspace_id, event_type, lead_id, lead_priority, lead_legal_area, actor_user_id
    )
    values (new.workspace_id, 'lead_created', new.id, new.priority, new.legal_area, new.created_by);
  end if;
  return null;
end;
$body$;

create function private.automation_capture_stage_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $body$
begin
  if new.from_stage_id is not null and exists (
    select 1 from public.automation_rules r
    where r.workspace_id = new.workspace_id and r.status = 'active' and r.trigger_type = 'opportunity_stage_changed'
  ) then
    insert into public.automation_events (
      workspace_id, event_type, lead_id, opportunity_id, transition_id,
      from_stage_id, to_stage_id, actor_user_id, occurred_at
    )
    select new.workspace_id, 'opportunity_stage_changed', o.lead_id, new.opportunity_id, new.id,
           new.from_stage_id, new.to_stage_id, new.actor_user_id, new.occurred_at
    from public.opportunities o
    where o.id = new.opportunity_id and o.workspace_id = new.workspace_id;
  end if;
  return null;
end;
$body$;

revoke all on function private.automation_capture_lead_created() from public, anon, authenticated;
revoke all on function private.automation_capture_stage_change() from public, anon, authenticated;

create trigger automation_capture_lead_created
  after insert on public.leads
  for each row execute function private.automation_capture_lead_created();

create trigger automation_capture_stage_change
  after insert on public.stage_transitions
  for each row execute function private.automation_capture_stage_change();

-- ---------------------------------------------------------------------
-- Funções privadas de apoio
-- ---------------------------------------------------------------------

-- Prazo em dias: a atividade é só de DATA (fim do dia, America/Sao_Paulo),
-- como create_activity() faz quando não há horário.
create function private.automation_due_at(p_days integer)
returns timestamptz
language sql
stable
set search_path = ''
as $body$
  select (((now() at time zone 'America/Sao_Paulo')::date + p_days)::text || ' 23:59:59')::timestamp
    at time zone 'America/Sao_Paulo';
$body$;

-- O responsável da atividade é válido? Devolve o código do problema ou null.
-- Reaproveita a regra da A6 (membro ativo E com acesso ao lead).
create function private.automation_assignee_problem(
  p_workspace_id uuid,
  p_lead_assigned_to uuid,
  p_candidate uuid
)
returns text
language plpgsql
security definer
stable
set search_path = ''
as $body$
begin
  perform private.check_activity_assignee(p_workspace_id, p_lead_assigned_to, p_candidate);
  return null;
exception
  when others then
    return case sqlerrm
      when 'assignee_not_a_member' then 'assignee_not_member'
      when 'activity_assignee_no_access' then 'assignee_no_access'
      else 'unexpected_error'
    end;
end;
$body$;

-- Valida a estrutura fechada da regra. Não grava nada.
create function private.automation_validate_rule(
  p_workspace_id uuid,
  p_name text,
  p_trigger_type text,
  p_action_title text,
  p_action_due_days integer,
  p_action_priority public.lead_priority,
  p_action_assignee_mode text,
  p_action_assignee_user_id uuid,
  p_cond_priority public.lead_priority,
  p_cond_legal_area text,
  p_cond_to_stage_id uuid,
  p_cond_from_stage_id uuid
)
returns void
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_terminal boolean;
begin
  if p_name is null or char_length(btrim(p_name)) not between 1 and 120
     or p_action_title is null or char_length(btrim(p_action_title)) not between 1 and 160
     or p_action_due_days is null or p_action_due_days not between 0 and 90
     or p_action_priority is null
     or p_trigger_type is null or p_trigger_type not in ('lead_created', 'opportunity_stage_changed')
     or (p_cond_legal_area is not null and char_length(btrim(p_cond_legal_area)) not between 1 and 120) then
    raise exception 'invalid_automation_rule';
  end if;

  if p_trigger_type = 'lead_created' then
    if p_cond_to_stage_id is not null or p_cond_from_stage_id is not null then
      raise exception 'invalid_automation_rule';
    end if;
  else
    if p_cond_to_stage_id is null or p_cond_priority is not null or p_cond_legal_area is not null then
      raise exception 'invalid_automation_rule';
    end if;

    select s.is_won or s.is_lost into v_terminal
    from public.pipeline_stages s
    where s.id = p_cond_to_stage_id and s.workspace_id = p_workspace_id;
    -- Etapa de outro workspace, inexistente ou terminal (ganho/perdido): nunca dispara.
    if v_terminal is null or v_terminal then
      raise exception 'invalid_automation_stage';
    end if;

    if p_cond_from_stage_id is not null and not exists (
      select 1 from public.pipeline_stages s where s.id = p_cond_from_stage_id and s.workspace_id = p_workspace_id
    ) then
      raise exception 'invalid_automation_stage';
    end if;
  end if;

  if p_action_assignee_mode = 'lead_owner' then
    if p_action_assignee_user_id is not null then
      raise exception 'invalid_automation_rule';
    end if;
  elsif p_action_assignee_mode = 'user' then
    if p_action_assignee_user_id is null or not exists (
      select 1 from public.memberships m
      where m.workspace_id = p_workspace_id and m.user_id = p_action_assignee_user_id and m.status = 'active'
    ) then
      raise exception 'invalid_automation_assignee';
    end if;
  else
    raise exception 'invalid_automation_rule';
  end if;
end;
$body$;

-- Workspace da regra, já com a autorização: quem não é membro desse workspace
-- recebe "não encontrada" (recurso alheio = inexistente); membro sem o papel
-- recebe insufficient_permission. p_manage = owner/admin; senão, + manager.
create function private.automation_rule_workspace(p_rule_id uuid, p_manage boolean)
returns uuid
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.automation_rules r where r.id = p_rule_id;

  if v_workspace_id is null or not private.has_workspace_role(
    v_workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]
  ) then
    raise exception 'automation_rule_not_found';
  end if;

  if not private.has_workspace_role(
    v_workspace_id,
    case
      when p_manage then array['owner', 'admin']::public.membership_role[]
      else array['owner', 'admin', 'manager']::public.membership_role[]
    end
  ) then
    raise exception 'insufficient_permission';
  end if;

  return v_workspace_id;
end;
$body$;

revoke all on function private.automation_due_at(integer) from public, anon, authenticated;
revoke all on function private.automation_assignee_problem(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function private.automation_validate_rule(
  uuid, text, text, text, integer, public.lead_priority, text, uuid, public.lead_priority, text, uuid, uuid
) from public, anon, authenticated;
revoke all on function private.automation_rule_workspace(uuid, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Execução de UMA execução. Subtransação própria: o que dá errado aqui nunca
-- desfaz outra execução, outro evento nem a operação de origem.
-- ---------------------------------------------------------------------

create function private.automation_run_execution(p_execution_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  c_max_attempts constant integer := 4;
  v_ex public.automation_executions;
  v_rule public.automation_rules;
  v_event public.automation_events;
  v_lead public.leads;
  v_assignee uuid;
  v_activity_id uuid;
  v_problem text;
begin
  select * into v_ex from public.automation_executions where id = p_execution_id and state = 'pending' for update;
  if v_ex.id is null then
    return;
  end if;

  select * into v_rule from public.automation_rules where id = v_ex.rule_id;

  -- Regra pausada, arquivada ou alterada depois de a execução nascer: não executa.
  if v_rule.status is distinct from 'active' or v_rule.version <> v_ex.rule_version then
    update public.automation_executions
      set state = 'cancelled',
          error_code = case when v_rule.status is distinct from 'active' then 'rule_inactive' else 'rule_changed' end,
          finished_at = now()
      where id = v_ex.id;
    return;
  end if;

  select * into v_event from public.automation_events where id = v_ex.event_id;
  select * into v_lead from public.leads where id = v_event.lead_id and workspace_id = v_ex.workspace_id;

  if v_lead.id is null or (
    v_event.opportunity_id is not null
    and not exists (
      select 1 from public.opportunities o
      where o.id = v_event.opportunity_id and o.workspace_id = v_ex.workspace_id and o.lead_id = v_lead.id
    )
  ) then
    update public.automation_executions
      set state = 'cancelled', error_code = 'target_not_found', finished_at = now()
      where id = v_ex.id;
    return;
  end if;

  v_assignee := case when v_rule.action_assignee_mode = 'user' then v_rule.action_assignee_user_id else v_lead.assigned_to end;
  v_problem := private.automation_assignee_problem(v_ex.workspace_id, v_lead.assigned_to, v_assignee);

  if v_problem is null then
    begin
      insert into public.activities (
        workspace_id, lead_id, opportunity_id, type, title, notes, assigned_to, priority,
        due_at, has_time, status, source, created_by
      )
      values (
        v_ex.workspace_id, v_lead.id, v_event.opportunity_id, 'task', v_rule.action_title,
        'Criada pela automação "' || v_rule.name || '".', v_assignee, v_rule.action_priority,
        private.automation_due_at(v_rule.action_due_days), false, 'pending', 'automation',
        coalesce(v_event.actor_user_id, v_rule.created_by)
      )
      returning id into v_activity_id;

      insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
      values (
        v_ex.workspace_id, null, 'activity.auto_created', 'activity', v_activity_id,
        jsonb_build_object('rule_id', v_rule.id)
      );

      update public.automation_executions
        set state = 'succeeded', attempt_count = attempt_count + 1, last_attempt_at = now(),
            error_code = null, activity_id = v_activity_id, finished_at = now()
        where id = v_ex.id;
      return;
    exception
      when others then
        -- Nada da mensagem do banco é guardado: só o código fechado.
        v_problem := 'unexpected_error';
    end;
  end if;

  -- Falha: tentativa registrada; esgotado o limite, dead_letter (terminal).
  update public.automation_executions
    set attempt_count = attempt_count + 1,
        last_attempt_at = now(),
        error_code = v_problem,
        state = case when attempt_count + 1 >= c_max_attempts then 'dead_letter' else 'pending' end,
        finished_at = case when attempt_count + 1 >= c_max_attempts then now() end,
        next_attempt_at = now() + case attempt_count + 1
          when 1 then interval '1 minute'
          when 2 then interval '5 minutes'
          else interval '30 minutes'
        end
    where id = v_ex.id;
end;
$body$;

revoke all on function private.automation_run_execution(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Processador. p_workspace_id nulo = todos os workspaces (só o job do sistema).
-- ---------------------------------------------------------------------

create function private.automation_process(p_workspace_id uuid, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 200));
  v_event record;
  v_ex record;
  v_events integer := 0;
  v_executions integer := 0;
begin
  -- Etapa 1: evento pendente -> uma execução por regra ativa e compatível.
  for v_event in
    select e.*
    from public.automation_events e
    where e.status = 'pending' and (p_workspace_id is null or e.workspace_id = p_workspace_id)
    order by e.occurred_at, e.id
    limit v_limit
    for update skip locked
  loop
    insert into public.automation_executions (workspace_id, rule_id, event_id, rule_version)
    select r.workspace_id, r.id, v_event.id, r.version
    from public.automation_rules r
    where r.workspace_id = v_event.workspace_id
      and r.status = 'active'
      and r.trigger_type = v_event.event_type
      -- Evento anterior à ativação da regra nunca a dispara.
      and r.activated_at <= v_event.occurred_at
      and (
        (
          v_event.event_type = 'lead_created'
          and (r.cond_priority is null or r.cond_priority = v_event.lead_priority)
          and (
            r.cond_legal_area is null
            or lower(btrim(r.cond_legal_area)) = lower(btrim(coalesce(v_event.lead_legal_area, '')))
          )
        )
        or (
          v_event.event_type = 'opportunity_stage_changed'
          and r.cond_to_stage_id = v_event.to_stage_id
          and (r.cond_from_stage_id is null or r.cond_from_stage_id = v_event.from_stage_id)
        )
      )
    on conflict (event_id, rule_id) do nothing;

    update public.automation_events set status = 'processed', processed_at = now() where id = v_event.id;
    v_events := v_events + 1;
  end loop;

  -- Etapa 2: execuções vencidas.
  for v_ex in
    select x.id
    from public.automation_executions x
    where x.state = 'pending' and x.next_attempt_at <= now()
      and (p_workspace_id is null or x.workspace_id = p_workspace_id)
    order by x.next_attempt_at, x.id
    limit v_limit
    for update skip locked
  loop
    perform private.automation_run_execution(v_ex.id);
    v_executions := v_executions + 1;
  end loop;

  return jsonb_build_object('events', v_events, 'executions', v_executions);
end;
$body$;

revoke all on function private.automation_process(uuid, integer) from public, anon, authenticated;

-- Qualquer membro ativo do workspace pode pedir o processamento DO PRÓPRIO
-- workspace (é o que as telas fazem logo depois de criar um lead ou mover uma
-- etapa). Idempotente: processar duas vezes nunca duplica nada.
create function public.process_automation_events(p_workspace_id uuid, p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  if not private.has_workspace_role(
    p_workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  return private.automation_process(p_workspace_id, p_limit);
end;
$body$;

-- Rodada do sistema (rota de cron), todos os workspaces. Só service_role.
create function public.process_automation_events_system(p_limit integer default 50)
returns jsonb
language sql
security definer
set search_path = ''
as $body$
  select private.automation_process(null, p_limit);
$body$;

revoke all on function public.process_automation_events(uuid, integer) from public, anon;
grant execute on function public.process_automation_events(uuid, integer) to authenticated;
revoke all on function public.process_automation_events_system(integer) from public, anon, authenticated;
grant execute on function public.process_automation_events_system(integer) to service_role;

-- ---------------------------------------------------------------------
-- Regras: criar, editar, simular, mudar de estado.
-- ---------------------------------------------------------------------

create function public.create_automation_rule(
  p_workspace_id uuid,
  p_name text,
  p_trigger_type text,
  p_action_title text,
  p_action_due_days integer,
  p_action_priority public.lead_priority,
  p_action_assignee_mode text,
  p_action_assignee_user_id uuid default null,
  p_cond_priority public.lead_priority default null,
  p_cond_legal_area text default null,
  p_cond_to_stage_id uuid default null,
  p_cond_from_stage_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_area text := nullif(btrim(coalesce(p_cond_legal_area, '')), '');
  v_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if not private.has_workspace_role(p_workspace_id, array['owner', 'admin']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  perform private.automation_validate_rule(
    p_workspace_id, p_name, p_trigger_type, p_action_title, p_action_due_days, p_action_priority,
    p_action_assignee_mode, p_action_assignee_user_id, p_cond_priority, v_area, p_cond_to_stage_id, p_cond_from_stage_id
  );

  insert into public.automation_rules (
    workspace_id, name, trigger_type, cond_priority, cond_legal_area, cond_to_stage_id, cond_from_stage_id,
    action_title, action_due_days, action_priority, action_assignee_mode, action_assignee_user_id,
    created_by, updated_by
  )
  values (
    p_workspace_id, btrim(p_name), p_trigger_type, p_cond_priority, v_area, p_cond_to_stage_id, p_cond_from_stage_id,
    btrim(p_action_title), p_action_due_days, p_action_priority, p_action_assignee_mode, p_action_assignee_user_id,
    v_actor, v_actor
  )
  returning id into v_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (p_workspace_id, v_actor, 'automation.rule_created', 'automation_rule', v_id, '{}'::jsonb);

  return v_id;
end;
$body$;

create function public.update_automation_rule(
  p_rule_id uuid,
  p_name text,
  p_trigger_type text,
  p_action_title text,
  p_action_due_days integer,
  p_action_priority public.lead_priority,
  p_action_assignee_mode text,
  p_action_assignee_user_id uuid default null,
  p_cond_priority public.lead_priority default null,
  p_cond_legal_area text default null,
  p_cond_to_stage_id uuid default null,
  p_cond_from_stage_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_workspace_id uuid;
  v_rule public.automation_rules;
  v_area text := nullif(btrim(coalesce(p_cond_legal_area, '')), '');
  v_changed boolean;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  v_workspace_id := private.automation_rule_workspace(p_rule_id, true);

  select * into v_rule from public.automation_rules where id = p_rule_id for update;

  if v_rule.status = 'archived' then
    raise exception 'automation_rule_archived';
  end if;

  perform private.automation_validate_rule(
    v_workspace_id, p_name, p_trigger_type, p_action_title, p_action_due_days, p_action_priority,
    p_action_assignee_mode, p_action_assignee_user_id, p_cond_priority, v_area, p_cond_to_stage_id, p_cond_from_stage_id
  );

  v_changed := (
    v_rule.trigger_type, v_rule.cond_priority, v_rule.cond_legal_area, v_rule.cond_to_stage_id,
    v_rule.cond_from_stage_id, v_rule.action_title, v_rule.action_due_days, v_rule.action_priority,
    v_rule.action_assignee_mode, v_rule.action_assignee_user_id
  ) is distinct from (
    p_trigger_type, p_cond_priority, v_area, p_cond_to_stage_id,
    p_cond_from_stage_id, btrim(p_action_title), p_action_due_days, p_action_priority,
    p_action_assignee_mode, p_action_assignee_user_id
  );

  -- Mudou gatilho, condição ou ação: nova versão, simulação anterior invalidada
  -- e, se estava ativa, a regra pausa até ser simulada e ativada de novo.
  update public.automation_rules
    set name = btrim(p_name),
        trigger_type = p_trigger_type,
        cond_priority = p_cond_priority,
        cond_legal_area = v_area,
        cond_to_stage_id = p_cond_to_stage_id,
        cond_from_stage_id = p_cond_from_stage_id,
        action_title = btrim(p_action_title),
        action_due_days = p_action_due_days,
        action_priority = p_action_priority,
        action_assignee_mode = p_action_assignee_mode,
        action_assignee_user_id = p_action_assignee_user_id,
        version = case when v_changed then version + 1 else version end,
        status = case when v_changed and status = 'active' then 'paused' else status end,
        updated_by = v_actor
    where id = p_rule_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_workspace_id, v_actor, 'automation.rule_updated', 'automation_rule', p_rule_id, '{}'::jsonb);
end;
$body$;

-- Simulação: só lê. Devolve contagem e uma prévia SEM identificação (data,
-- prioridade, área e se o responsável seria válido). Único efeito: carimbar a
-- versão simulada na própria regra.
create function public.simulate_automation_rule(p_rule_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  c_window_days constant integer := 30;
  v_actor uuid := auth.uid();
  v_workspace_id uuid;
  v_rule public.automation_rules;
  v_since timestamptz := now() - make_interval(days => c_window_days);
  v_count integer;
  v_sample jsonb := '[]'::jsonb;
  v_invalid integer := 0;
  v_row record;
  v_assignee uuid;
  v_problem text;
  v_due date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  v_workspace_id := private.automation_rule_workspace(p_rule_id, true);

  select * into v_rule from public.automation_rules where id = p_rule_id for update;

  if v_rule.status = 'archived' then
    raise exception 'automation_rule_archived';
  end if;

  if v_rule.trigger_type = 'lead_created' then
    select count(*) into v_count
    from public.leads l
    where l.workspace_id = v_workspace_id and l.created_at >= v_since
      and (v_rule.cond_priority is null or l.priority = v_rule.cond_priority)
      and (v_rule.cond_legal_area is null or lower(btrim(l.legal_area)) = lower(btrim(v_rule.cond_legal_area)));
  else
    select count(*) into v_count
    from public.stage_transitions t
    where t.workspace_id = v_workspace_id and t.occurred_at >= v_since
      and t.to_stage_id = v_rule.cond_to_stage_id
      and (v_rule.cond_from_stage_id is null or t.from_stage_id = v_rule.cond_from_stage_id);
  end if;

  for v_row in
    select * from (
      select l.created_at as happened_at, l.priority, l.legal_area, l.assigned_to
      from public.leads l
      where v_rule.trigger_type = 'lead_created'
        and l.workspace_id = v_workspace_id and l.created_at >= v_since
        and (v_rule.cond_priority is null or l.priority = v_rule.cond_priority)
        and (v_rule.cond_legal_area is null or lower(btrim(l.legal_area)) = lower(btrim(v_rule.cond_legal_area)))
      union all
      select t.occurred_at, l.priority, l.legal_area, l.assigned_to
      from public.stage_transitions t
      join public.opportunities o on o.id = t.opportunity_id and o.workspace_id = t.workspace_id
      join public.leads l on l.id = o.lead_id and l.workspace_id = o.workspace_id
      where v_rule.trigger_type = 'opportunity_stage_changed'
        and t.workspace_id = v_workspace_id and t.occurred_at >= v_since
        and t.to_stage_id = v_rule.cond_to_stage_id
        and (v_rule.cond_from_stage_id is null or t.from_stage_id = v_rule.cond_from_stage_id)
    ) s
    order by s.happened_at desc
    limit 5
  loop
    v_assignee := case when v_rule.action_assignee_mode = 'user' then v_rule.action_assignee_user_id else v_row.assigned_to end;
    v_problem := private.automation_assignee_problem(v_workspace_id, v_row.assigned_to, v_assignee);
    if v_problem is not null then
      v_invalid := v_invalid + 1;
    end if;
    v_sample := v_sample || jsonb_build_array(jsonb_build_object(
      'date', (v_row.happened_at at time zone 'America/Sao_Paulo')::date,
      'priority', v_row.priority,
      'legal_area', v_row.legal_area,
      'due_date', v_due + v_rule.action_due_days,
      'assignee', case
        when v_problem is not null then 'invalid'
        when v_assignee is null then 'none'
        else 'ok'
      end
    ));
  end loop;

  update public.automation_rules
    set simulated_version = version, simulated_at = now(), simulated_count = v_count
    where id = p_rule_id;

  return jsonb_build_object(
    'version', v_rule.version,
    'window_days', c_window_days,
    'match_count', v_count,
    'sample', v_sample,
    'sample_invalid', v_invalid
  );
end;
$body$;

create function public.set_automation_rule_status(p_rule_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_workspace_id uuid;
  v_rule public.automation_rules;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  v_workspace_id := private.automation_rule_workspace(p_rule_id, true);

  select * into v_rule from public.automation_rules where id = p_rule_id for update;

  if p_status = 'active' and v_rule.status in ('draft', 'paused') then
    -- Só com simulação da versão ATUAL (o CHECK da tabela repete a regra).
    if v_rule.simulated_version is distinct from v_rule.version then
      raise exception 'automation_simulation_required';
    end if;
    update public.automation_rules
      set status = 'active', activated_at = now(), updated_by = v_actor
      where id = p_rule_id;
    insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
    values (v_workspace_id, v_actor, 'automation.rule_activated', 'automation_rule', p_rule_id, '{}'::jsonb);
  elsif p_status = 'paused' and v_rule.status = 'active' then
    update public.automation_rules set status = 'paused', updated_by = v_actor where id = p_rule_id;
    insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
    values (v_workspace_id, v_actor, 'automation.rule_paused', 'automation_rule', p_rule_id, '{}'::jsonb);
  elsif p_status = 'archived' and v_rule.status in ('draft', 'active', 'paused') then
    update public.automation_rules set status = 'archived', updated_by = v_actor where id = p_rule_id;
    insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
    values (v_workspace_id, v_actor, 'automation.rule_archived', 'automation_rule', p_rule_id, '{}'::jsonb);
  else
    raise exception 'invalid_automation_transition';
  end if;
end;
$body$;

-- ---------------------------------------------------------------------
-- Leituras (owner, admin e manager). Devolvem só colunas de configuração e
-- códigos fechados: nenhum dado de lead, contato ou conversa.
-- ---------------------------------------------------------------------

create function public.list_automation_rules(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  if not private.has_workspace_role(
    p_workspace_id, array['owner', 'admin', 'manager']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id,
      'name', r.name,
      'status', r.status,
      'trigger_type', r.trigger_type,
      'cond_priority', r.cond_priority,
      'cond_legal_area', r.cond_legal_area,
      'cond_to_stage_id', r.cond_to_stage_id,
      'cond_from_stage_id', r.cond_from_stage_id,
      'action_title', r.action_title,
      'action_due_days', r.action_due_days,
      'action_priority', r.action_priority,
      'action_assignee_mode', r.action_assignee_mode,
      'action_assignee_user_id', r.action_assignee_user_id,
      'version', r.version,
      'simulation_current', r.simulated_version is not distinct from r.version,
      'simulated_at', r.simulated_at,
      'simulated_count', r.simulated_count,
      'activated_at', r.activated_at,
      'created_at', r.created_at,
      'updated_at', r.updated_at
    ) order by (r.status = 'archived'), r.created_at desc, r.id)
    from public.automation_rules r
    where r.workspace_id = p_workspace_id
  ), '[]'::jsonb);
end;
$body$;

create function public.list_automation_executions(
  p_workspace_id uuid,
  p_rule_id uuid default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  if not private.has_workspace_role(
    p_workspace_id, array['owner', 'admin', 'manager']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  return coalesce((
    select jsonb_agg(h.item order by h.created_at desc, h.id desc)
    from (
      select x.id, x.created_at,
        jsonb_build_object(
          'id', x.id,
          'rule_id', x.rule_id,
          'rule_name', r.name,
          'event_type', e.event_type,
          'state', x.state,
          'attempt_count', x.attempt_count,
          'last_attempt_at', x.last_attempt_at,
          'next_attempt_at', case when x.state = 'pending' then x.next_attempt_at end,
          'error_code', x.error_code,
          'activity_id', x.activity_id,
          'created_at', x.created_at,
          'finished_at', x.finished_at
        ) as item
      from public.automation_executions x
      join public.automation_rules r on r.workspace_id = x.workspace_id and r.id = x.rule_id
      join public.automation_events e on e.workspace_id = x.workspace_id and e.id = x.event_id
      where x.workspace_id = p_workspace_id
        and (p_rule_id is null or x.rule_id = p_rule_id)
      order by x.created_at desc, x.id desc
      limit greatest(1, least(coalesce(p_limit, 50), 100))
    ) h
  ), '[]'::jsonb);
end;
$body$;

revoke all on function public.create_automation_rule(
  uuid, text, text, text, integer, public.lead_priority, text, uuid, public.lead_priority, text, uuid, uuid
) from public, anon;
grant execute on function public.create_automation_rule(
  uuid, text, text, text, integer, public.lead_priority, text, uuid, public.lead_priority, text, uuid, uuid
) to authenticated;

revoke all on function public.update_automation_rule(
  uuid, text, text, text, integer, public.lead_priority, text, uuid, public.lead_priority, text, uuid, uuid
) from public, anon;
grant execute on function public.update_automation_rule(
  uuid, text, text, text, integer, public.lead_priority, text, uuid, public.lead_priority, text, uuid, uuid
) to authenticated;

revoke all on function public.simulate_automation_rule(uuid) from public, anon;
grant execute on function public.simulate_automation_rule(uuid) to authenticated;

revoke all on function public.set_automation_rule_status(uuid, text) from public, anon;
grant execute on function public.set_automation_rule_status(uuid, text) to authenticated;

revoke all on function public.list_automation_rules(uuid) from public, anon;
grant execute on function public.list_automation_rules(uuid) to authenticated;

revoke all on function public.list_automation_executions(uuid, uuid, integer) from public, anon;
grant execute on function public.list_automation_executions(uuid, uuid, integer) to authenticated;
