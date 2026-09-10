-- A6 — Atividades e agenda interna: schema base.
--
-- Convenções mantidas (A2–A5): toda tabela carrega workspace_id NOT NULL;
-- todo índice composto começa por workspace_id; RLS na próxima migration;
-- updated_at por trigger; concorrência otimista via lock_version (padrão
-- da A5, mais robusto que o updated_at-compare da A4); auditoria nas
-- funções de negócio.
--
-- Vínculo (decisão desta fase, dentro do escopo pedido): toda atividade
-- pertence a um LEAD (lead_id not null) — é o lead, não a oportunidade,
-- que define o alcance por registro ("seus + sem responsável" herdado de
-- private.lead_accessible_to_role, mesma função já usada por leads e
-- oportunidades). O vínculo com oportunidade (opportunity_id) é
-- OPCIONAL: nem toda atividade nasce de uma negociação em andamento (ex.:
-- qualificar um lead antes de existir oportunidade), mas quando uma
-- oportunidade é informada, o banco garante — por FK composta, não só na
-- aplicação — que ela pertence ao MESMO lead informado (coerência entre
-- vínculos, pedida explicitamente).
--
-- Data/hora (decisão desta fase): due_at é sempre um instante real
-- (timestamptz), nunca uma string solta. has_time diferencia um
-- COMPROMISSO com horário marcado (due_at é o instante exato) de uma
-- atividade que só tem DATA (due_at é normalizado para o fim do dia,
-- 23:59:59, no fuso America/Sao_Paulo — sempre calculado no SERVIDOR,
-- nunca no fuso da máquina local, ver create_activity()/
-- reschedule_activity() na próxima migration). Isso permite uma única
-- regra de "atrasada" (due_at < now()) que funciona igual para os dois
-- casos, sem duplicar lógica de fronteira de dia.
--
-- Atividade automática por etapa (decisão desta fase, item 4 do pedido):
-- configuração MÍNIMA — no máximo UMA regra por etapa (não uma lista),
-- guardando só o essencial (tipo, título literal — sem motor de
-- templates, prazo relativo em horas, regra de responsável fechada em
-- duas opções). source_stage_transition_id referencia a transição que
-- gerou a atividade; um índice único parcial nessa coluna é quem garante
-- "uma única criação por transição", mesmo em reenvio ou corrida — reforço
-- redundante ao fato de que stage_transitions já nasce único por
-- movimentação bem-sucedida (lock_version otimista em
-- move_opportunity_stage, A5).

create type public.activity_type as enum ('call', 'meeting', 'task', 'email', 'deadline');

-- Sem 'cancelled': o escopo desta fase pede "criar, visualizar, editar e
-- excluir" (exclusão é DELETE de verdade, não um status) e "concluir,
-- reagendar e transferir responsável" — não uma máquina de estados maior.
create type public.activity_status as enum ('pending', 'done');

-- Origem: 'manual' (criada por alguém pela tela) ou 'stage_rule' (criada
-- por move_opportunity_stage() ao aplicar uma regra configurada). Nunca
-- um motor de automação genérico — só esta trilha específica.
create type public.activity_source as enum ('manual', 'stage_rule');

-- Regra de responsável da atividade automática: 'unassigned' (nasce sem
-- responsável) ou 'lead_owner' (herda o responsável do lead no momento da
-- transição — que pode, ele mesmo, ser nulo; nesse caso a atividade nasce
-- sem responsável do mesmo jeito, não é um erro).
create type public.activity_assignee_rule as enum ('unassigned', 'lead_owner');

-- ---------------------------------------------------------------------
-- Pré-requisitos para as FKs compostas de coerência entre vínculos
-- (mesma técnica já usada nas fases anteriores: ALTER TABLE ADD
-- CONSTRAINT numa tabela existente, para uma unique key que a fase
-- anterior não precisava).
-- ---------------------------------------------------------------------

-- Necessária para activities.opportunity_id garantir, no banco, que a
-- oportunidade informada pertence ao MESMO lead_id também informado —
-- não só ao mesmo workspace.
alter table public.opportunities
  add constraint opportunities_workspace_id_id_lead_id_key unique (workspace_id, id, lead_id);

-- Necessária para activities.source_stage_transition_id (mesma workspace
-- que a atividade que ele originou).
alter table public.stage_transitions
  add constraint stage_transitions_workspace_id_id_key unique (workspace_id, id);

-- ---------------------------------------------------------------------
-- stage_auto_activity_rules — configuração mínima por etapa. Tabela de
-- configuração não sensível (mesma categoria de stage_requirements):
-- SELECT direto por workspace, mutação só por RPC (próxima migration).
-- ---------------------------------------------------------------------

create table public.stage_auto_activity_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  stage_id uuid not null,
  activity_type public.activity_type not null,
  title text not null check (char_length(btrim(title)) between 1 and 160),
  -- Prazo relativo ao momento da transição, em horas — de 0 (mesmo
  -- instante) a 30 dias (720h), faixa generosa o bastante sem permitir
  -- valor absurdo digitado errado.
  due_offset_hours integer not null default 24 check (due_offset_hours between 0 and 720),
  assignee_rule public.activity_assignee_rule not null default 'lead_owner',
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stage_auto_activity_rules_stage_same_workspace_fkey
    foreign key (workspace_id, stage_id)
    references public.pipeline_stages (workspace_id, id) on delete cascade,
  -- Necessária para a FK composta de activities.source_rule_id.
  constraint stage_auto_activity_rules_workspace_id_id_key unique (workspace_id, id),
  -- Configuração MÍNIMA: no máximo uma regra por etapa (não uma lista) —
  -- editar substitui a regra existente, excluir remove por completo.
  constraint stage_auto_activity_rules_one_per_stage unique (stage_id)
);

comment on table public.stage_auto_activity_rules is
  'No máximo uma regra de atividade automática por etapa. Aplicada só em movimentação bem-sucedida (move_opportunity_stage) — movimento recusado, requisito pendente ou conflito não chegam aqui, porque a exceção aborta a transação inteira antes deste ponto.';

create index stage_auto_activity_rules_workspace_id_idx on public.stage_auto_activity_rules (workspace_id);

create trigger stage_auto_activity_rules_set_updated_at
  before update on public.stage_auto_activity_rules
  for each row execute function private.set_updated_at();

create trigger stage_auto_activity_rules_set_created_by
  before insert on public.stage_auto_activity_rules
  for each row execute function private.set_created_by_to_current_user();

-- ---------------------------------------------------------------------
-- activities — o núcleo da A6. RLS deny-all (próxima migration): mesmo
-- tratamento de escopo por registro que leads/opportunities, herdado do
-- lead pai via private.lead_accessible_to_role().
-- ---------------------------------------------------------------------

create table public.activities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  lead_id uuid not null,
  opportunity_id uuid,
  type public.activity_type not null,
  title text not null check (char_length(btrim(title)) between 1 and 160),
  notes text check (notes is null or char_length(notes) <= 2000),
  -- Responsável: nulo = "sem responsável" (mesmo modelo de leads.assigned_to).
  assigned_to uuid references auth.users (id) on delete set null,
  priority public.lead_priority not null default 'media',
  due_at timestamptz not null,
  has_time boolean not null default true,
  status public.activity_status not null default 'pending',
  completed_at timestamptz,
  source public.activity_source not null default 'manual',
  source_stage_transition_id uuid,
  source_rule_id uuid,
  lock_version bigint not null default 0,
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint activities_lead_same_workspace_fkey
    foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade,
  -- A GARANTIA de coerência entre vínculos pedida: a oportunidade só é
  -- aceita se pertencer ao MESMO lead_id que a atividade também
  -- referencia (MATCH SIMPLE do Postgres já não aplica a checagem quando
  -- opportunity_id é nulo, então uma atividade sem oportunidade nunca
  -- esbarra nesta FK).
  constraint activities_opportunity_same_lead_fkey
    foreign key (workspace_id, opportunity_id, lead_id)
    references public.opportunities (workspace_id, id, lead_id) on delete cascade,
  constraint activities_source_transition_same_workspace_fkey
    foreign key (workspace_id, source_stage_transition_id)
    references public.stage_transitions (workspace_id, id) on delete set null,
  constraint activities_source_rule_same_workspace_fkey
    foreign key (workspace_id, source_rule_id)
    references public.stage_auto_activity_rules (workspace_id, id) on delete set null,
  constraint activities_status_consistency check (
    (status = 'done' and completed_at is not null) or (status = 'pending' and completed_at is null)
  ),
  constraint activities_source_consistency check (
    (source = 'manual' and source_stage_transition_id is null and source_rule_id is null) or
    (source = 'stage_rule' and source_stage_transition_id is not null and source_rule_id is not null)
  ),
  constraint activities_workspace_id_id_key unique (workspace_id, id)
);

comment on table public.activities is
  'Tarefa/compromisso vinculado a um lead (obrigatório) e, opcionalmente, a uma oportunidade específica dele. Alcance por registro herdado do lead pai — mesma regra "seus + sem responsável" de leads/oportunidades, não um responsável próprio de acesso (assigned_to é só quem deve executar, não quem pode ver).';

create index activities_workspace_id_idx on public.activities (workspace_id);
create index activities_lead_id_idx on public.activities (workspace_id, lead_id);
create index activities_opportunity_id_idx on public.activities (workspace_id, opportunity_id);
create index activities_assigned_to_idx on public.activities (workspace_id, assigned_to);
create index activities_status_due_at_idx on public.activities (workspace_id, status, due_at);

-- Idempotência da atividade automática: no máximo UMA atividade por
-- transição de etapa, mesmo em reenvio ou chamada concorrente.
create unique index activities_one_per_transition_idx
  on public.activities (source_stage_transition_id)
  where source_stage_transition_id is not null;

create trigger activities_set_updated_at
  before update on public.activities
  for each row execute function private.set_updated_at();

create trigger activities_set_created_by
  before insert on public.activities
  for each row execute function private.set_created_by_to_current_user();
