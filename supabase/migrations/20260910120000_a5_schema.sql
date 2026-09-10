-- A5 — Pipeline e oportunidades: schema base.
--
-- Convenções mantidas (A2–A4): toda tabela carrega workspace_id NOT NULL;
-- todo índice composto começa por workspace_id; RLS na próxima migration;
-- updated_at por trigger; auditoria nas funções de negócio.
--
-- Decisão de vínculo (aprovada): um lead pode ter VÁRIAS oportunidades —
-- cada oportunidade é uma negociação distinta. `opportunities.lead_id` é
-- obrigatório; não existe "oportunidade órfã".
--
-- Decisão de integridade entre pipeline/etapa/oportunidade (aprovada):
-- a etapa precisa pertencer ao MESMO pipeline da oportunidade — expresso
-- no banco via FK composta (pipeline_id, stage_id), não só validado na
-- aplicação. Isso exige que `pipeline_stages` tenha UNIQUE(pipeline_id, id)
-- além da PK simples.
--
-- Decisão de valor financeiro (aprovada, item 5 do pedido da A5): mesmo
-- tratamento de `leads`/`lead_values` na A4 — `opportunities` guarda
-- `value_cents`, mas a tabela fica com RLS deny-all (próxima migration),
-- acessível só via RPC que projeta o campo pelo papel de quem chama.

create type public.opportunity_status as enum ('open', 'won', 'lost');

-- Nomes técnicos; os rótulos em português ("Valor fixo", "Êxito",
-- "Fixo + êxito" — do protótipo aprovado) vivem na camada de apresentação.
create type public.fee_model as enum ('fixed', 'contingency', 'fixed_contingency');

-- Tipos FECHADOS de requisito de avanço (mesmo princípio de
-- custom_field_definitions do plano: lista fechada, não EAV ilimitado) —
-- batem exatamente com os 4 tipos do protótipo aprovado (Pipeline.dc.html):
-- campo de texto curto, área de texto, data, e checkbox.
create type public.stage_requirement_type as enum ('text', 'textarea', 'date', 'checkbox');

-- Fundação mínima de clients/client_handoffs (antecipada da A8, só o
-- necessário para o aceite de ganho da A5 — sem tela de Clientes).
create type public.client_status as enum ('ativo', 'encerrado', 'suspenso');
create type public.handoff_status as enum ('pendente', 'concluido', 'falhou');

-- Necessário para a FK composta de opportunities.lead_id abaixo (mesmo
-- padrão já usado em contacts na A4): garante, no banco, que a oportunidade
-- e o lead pai estão no MESMO workspace.
alter table public.leads
  add constraint leads_workspace_id_id_key unique (workspace_id, id);

-- ---------------------------------------------------------------------
-- pipelines — um workspace pode ter mais de um funil no futuro (a A5 só
-- exige compatibilidade com isso, sem forçar a decisão "um funil por área
-- jurídica" agora). Todo workspace novo ganha exatamente um pipeline
-- padrão, criado dentro de create_workspace_with_owner() (mais abaixo).
-- ---------------------------------------------------------------------

create table public.pipelines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  is_default boolean not null default false,
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Necessária para a FK composta de opportunities.pipeline_id.
  constraint pipelines_workspace_id_id_key unique (workspace_id, id)
);

comment on table public.pipelines is
  'Funil comercial. Um workspace pode ter mais de um (estrutura pronta para funis por área jurídica), mas hoje só o padrão é criado.';

create index pipelines_workspace_id_idx on public.pipelines (workspace_id);

-- No máximo um pipeline padrão por workspace — evita ambiguidade em "o
-- funil padrão" quando/se a UI de múltiplos funis existir.
create unique index pipelines_one_default_per_workspace_idx
  on public.pipelines (workspace_id) where is_default;

create trigger pipelines_set_updated_at
  before update on public.pipelines
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- pipeline_stages — as etapas de um pipeline, configuráveis por
-- workspace. `position` é a ordem de exibição; `is_won`/`is_lost` marcam
-- etapas terminais (nenhuma etapa do funil padrão é terminal — ganhar/
-- perder é uma AÇÃO, não uma coluna, conforme o protótipo aprovado).
-- ---------------------------------------------------------------------

create table public.pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  pipeline_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  position integer not null check (position >= 0),
  color text check (color is null or color ~ '^#[0-9A-Fa-f]{6}$'),
  is_won boolean not null default false,
  is_lost boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pipeline_stages_pipeline_same_workspace_fkey
    foreign key (workspace_id, pipeline_id) references public.pipelines (workspace_id, id) on delete cascade,
  -- Necessária para a FK composta de opportunities.stage_id — é isto que
  -- GARANTE no banco que uma etapa só é aceita se pertencer ao pipeline
  -- que a oportunidade também referencia (não basta o mesmo workspace).
  constraint pipeline_stages_pipeline_id_id_key unique (pipeline_id, id),
  -- Necessária para a FK composta de stage_requirements.stage_id (por
  -- workspace, não por pipeline — stage_requirements não referencia
  -- pipeline_id diretamente).
  constraint pipeline_stages_workspace_id_id_key unique (workspace_id, id),
  -- Uma etapa não pode ser simultaneamente terminal de ganho E de perda.
  constraint pipeline_stages_not_won_and_lost check (not (is_won and is_lost))
);

comment on table public.pipeline_stages is
  'Etapas configuráveis de um pipeline. Excluir uma etapa ocupada, ou alterar is_won/is_lost de forma que deixe oportunidades existentes inconsistentes, é bloqueado nas funções de negócio (não aqui, para poder devolver mensagem específica).';

create index pipeline_stages_workspace_id_idx on public.pipeline_stages (workspace_id);
create index pipeline_stages_pipeline_id_idx on public.pipeline_stages (workspace_id, pipeline_id);

-- Posição única dentro do pipeline — evita duas etapas empatadas na
-- mesma coluna do kanban.
create unique index pipeline_stages_pipeline_position_idx
  on public.pipeline_stages (pipeline_id, position);

create trigger pipeline_stages_set_updated_at
  before update on public.pipeline_stages
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- stage_requirements — requisitos configuráveis para avançar PARA uma
-- etapa (bloqueio no servidor, não só na UI — StageAdvanceDialog do
-- protótipo). 4 tipos fechados, mesmos do protótipo aprovado.
-- ---------------------------------------------------------------------

create table public.stage_requirements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  stage_id uuid not null,
  label text not null check (char_length(btrim(label)) between 1 and 160),
  field_type public.stage_requirement_type not null,
  hint text check (hint is null or char_length(hint) <= 200),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stage_requirements_stage_same_workspace_fkey
    foreign key (workspace_id, stage_id)
    references public.pipeline_stages (workspace_id, id) on delete cascade,
  -- Necessária para a FK composta de opportunity_requirement_values.requirement_id.
  constraint stage_requirements_workspace_id_id_key unique (workspace_id, id)
);

comment on table public.stage_requirements is
  'Requisito que precisa estar preenchido para uma oportunidade AVANÇAR para esta etapa — bloqueio checado no servidor em move_opportunity_stage().';

create index stage_requirements_workspace_id_idx on public.stage_requirements (workspace_id);
create index stage_requirements_stage_id_idx on public.stage_requirements (workspace_id, stage_id);

create trigger stage_requirements_set_updated_at
  before update on public.stage_requirements
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- lost_reasons — motivo de perda, configurável por workspace (correção
-- 12 do plano). Seed padrão com os 5 motivos do protótipo aprovado.
-- ---------------------------------------------------------------------

create table public.lost_reasons (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  label text not null check (char_length(btrim(label)) between 1 and 160),
  position integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  -- Necessária para a FK composta de opportunities.lost_reason_id.
  constraint lost_reasons_workspace_id_id_key unique (workspace_id, id)
);

comment on table public.lost_reasons is
  'Motivo de perda configurável por workspace. Desativado (active=false), não excluído, se já estiver em uso — mesmo espírito de "não apagar etapa ocupada".';

create index lost_reasons_workspace_id_idx on public.lost_reasons (workspace_id);

create unique index lost_reasons_one_label_per_workspace_idx
  on public.lost_reasons (workspace_id, lower(btrim(label)));

-- ---------------------------------------------------------------------
-- opportunities — o núcleo da A5. RLS deny-all (próxima migration):
-- mesmo tratamento de dado financeiro sensível que `leads`/`lead_values`
-- tiveram na A4, acessível só via RPC com projeção por papel.
-- ---------------------------------------------------------------------

create table public.opportunities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  lead_id uuid not null,
  pipeline_id uuid not null,
  stage_id uuid not null,
  value_cents bigint check (value_cents is null or value_cents >= 0),
  fee_model public.fee_model,
  probability smallint check (probability is null or probability between 0 and 100),
  forecast_date date,
  stage_entered_at timestamptz not null default now(),
  status public.opportunity_status not null default 'open',
  lost_reason_id uuid,
  lost_note text check (lost_note is null or char_length(lost_note) <= 2000),
  -- Só a DATA pretendida de retomada de contato — nenhuma atividade,
  -- tarefa ou lembrete real é criado a partir disto (não existe fonte de
  -- atividades antes da A6; prometer isso agora seria enganoso).
  lost_followup_date date,
  signed_at date,
  won_at timestamptz,
  -- Controle de concorrência otimista (mesmo padrão da A4): incrementado
  -- atomicamente a cada UPDATE bem-sucedido, nunca lido e regravado sem
  -- passar pelo WHERE que o compara.
  lock_version bigint not null default 0,
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint opportunities_lead_same_workspace_fkey
    foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete restrict,
  constraint opportunities_pipeline_same_workspace_fkey
    foreign key (workspace_id, pipeline_id) references public.pipelines (workspace_id, id) on delete restrict,
  -- A GARANTIA pedida: a etapa só é aceita se pertencer ao MESMO pipeline
  -- que esta oportunidade referencia (não só o mesmo workspace).
  constraint opportunities_stage_belongs_to_pipeline_fkey
    foreign key (pipeline_id, stage_id) references public.pipeline_stages (pipeline_id, id) on delete restrict,
  constraint opportunities_lost_reason_same_workspace_fkey
    foreign key (workspace_id, lost_reason_id) references public.lost_reasons (workspace_id, id) on delete restrict,
  -- Campos de perda só fazem sentido com status = 'lost'; won_at só com
  -- status = 'won'. Não é a proteção principal (as funções de negócio
  -- também checam), mas fecha a porta a um UPDATE direto inconsistente
  -- por qualquer via que porventura tenha acesso de escrita.
  constraint opportunities_lost_fields_consistency check (
    (status = 'lost' and lost_reason_id is not null) or
    (status <> 'lost' and lost_reason_id is null and lost_note is null and lost_followup_date is null)
  ),
  constraint opportunities_won_at_consistency check (
    (status = 'won' and won_at is not null) or (status <> 'won' and won_at is null)
  ),
  -- Necessária para as FKs compostas de opportunity_requirement_values,
  -- stage_transitions e client_handoffs, todas via (workspace_id, opportunity_id).
  constraint opportunities_workspace_id_id_key unique (workspace_id, id)
);

comment on table public.opportunities is
  'Negociação distinta ligada a um lead — um lead pode ter várias. Valor e demais campos financeiros nunca saem direto da tabela: sempre projetados por papel em get_opportunity()/list_opportunities().';

create index opportunities_workspace_id_idx on public.opportunities (workspace_id);
create index opportunities_lead_id_idx on public.opportunities (workspace_id, lead_id);
create index opportunities_pipeline_id_idx on public.opportunities (workspace_id, pipeline_id);
create index opportunities_stage_id_idx on public.opportunities (workspace_id, stage_id);
create index opportunities_status_idx on public.opportunities (workspace_id, status);

create trigger opportunities_set_updated_at
  before update on public.opportunities
  for each row execute function private.set_updated_at();

create trigger opportunities_set_created_by
  before insert on public.opportunities
  for each row execute function private.set_created_by_to_current_user();

-- ---------------------------------------------------------------------
-- opportunity_requirement_values — valor preenchido de um requisito de
-- etapa, por oportunidade. Um valor por (oportunidade, requisito).
-- ---------------------------------------------------------------------

create table public.opportunity_requirement_values (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  opportunity_id uuid not null,
  requirement_id uuid not null,
  value_text text check (value_text is null or char_length(value_text) <= 2000),
  value_bool boolean,
  filled_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint opportunity_requirement_values_opportunity_same_workspace_fkey
    foreign key (workspace_id, opportunity_id) references public.opportunities (workspace_id, id) on delete cascade,
  constraint opportunity_requirement_values_requirement_same_workspace_fkey
    foreign key (workspace_id, requirement_id) references public.stage_requirements (workspace_id, id) on delete cascade,
  constraint opportunity_requirement_values_unique unique (opportunity_id, requirement_id)
);

comment on table public.opportunity_requirement_values is
  'Resposta preenchida para um requisito de avanço, por oportunidade. value_text serve texto/textarea/data (ISO); value_bool serve checkbox.';

create index opportunity_requirement_values_workspace_id_idx on public.opportunity_requirement_values (workspace_id);
create index opportunity_requirement_values_opportunity_id_idx on public.opportunity_requirement_values (workspace_id, opportunity_id);

create trigger opportunity_requirement_values_set_updated_at
  before update on public.opportunity_requirement_values
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- stage_transitions — histórico append-only de movimentação. Sem policy
-- de UPDATE/DELETE nenhuma (nem deny explícita — RLS force + nenhuma
-- policy dessas ações já barra por padrão; a próxima migração ainda
-- adiciona as deny por clareza, mesmo padrão de audit_logs).
-- ---------------------------------------------------------------------

create table public.stage_transitions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  opportunity_id uuid not null,
  from_stage_id uuid,
  to_stage_id uuid not null,
  actor_user_id uuid not null references auth.users (id) on delete restrict,
  occurred_at timestamptz not null default now(),
  seconds_in_previous_stage bigint check (seconds_in_previous_stage is null or seconds_in_previous_stage >= 0),
  constraint stage_transitions_opportunity_same_workspace_fkey
    foreign key (workspace_id, opportunity_id) references public.opportunities (workspace_id, id) on delete cascade
);

comment on table public.stage_transitions is
  'Histórico append-only de mudança de etapa — inserido na MESMA transação que move_opportunity_stage(), nunca por fora.';

create index stage_transitions_workspace_id_idx on public.stage_transitions (workspace_id);
create index stage_transitions_opportunity_id_idx on public.stage_transitions (workspace_id, opportunity_id);

-- ---------------------------------------------------------------------
-- clients / client_handoffs — fundação MÍNIMA antecipada da A8, só o
-- necessário para o aceite de ganho da A5 (aprovado explicitamente).
-- Sem tela de Clientes, sem gestão de atendimento — só a estrutura que
-- win_opportunity() precisa para criar/vincular o cliente e registrar o
-- handoff pendente, atomicamente, sem duplicar em tentativa repetida.
-- ---------------------------------------------------------------------

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  contact_id uuid not null,
  owner_user_id uuid references auth.users (id) on delete set null,
  status public.client_status not null default 'ativo',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clients_contact_same_workspace_fkey
    foreign key (workspace_id, contact_id) references public.contacts (workspace_id, id) on delete restrict,
  -- Necessária para a FK composta de client_handoffs.client_id.
  constraint clients_workspace_id_id_key unique (workspace_id, id)
);

comment on table public.clients is
  'Fundação mínima antecipada da A8 — só o necessário para win_opportunity() criar/vincular ao ganhar uma oportunidade. Tela de Clientes e gestão completa ficam para a A8.';

create index clients_workspace_id_idx on public.clients (workspace_id);
create index clients_contact_id_idx on public.clients (workspace_id, contact_id);

-- No máximo um client ATIVO por contato — é isto que permite
-- win_opportunity() decidir de forma não ambígua entre "criar novo" e
-- "reaproveitar existente" ao ganhar uma segunda oportunidade do mesmo
-- contato.
create unique index clients_one_active_per_contact_idx
  on public.clients (workspace_id, contact_id) where status = 'ativo';

create trigger clients_set_updated_at
  before update on public.clients
  for each row execute function private.set_updated_at();

create table public.client_handoffs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  client_id uuid not null,
  opportunity_id uuid not null,
  target_system text,
  status public.handoff_status not null default 'pendente',
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_handoffs_client_same_workspace_fkey
    foreign key (workspace_id, client_id) references public.clients (workspace_id, id) on delete cascade,
  constraint client_handoffs_opportunity_same_workspace_fkey
    foreign key (workspace_id, opportunity_id) references public.opportunities (workspace_id, id) on delete cascade,
  -- Idempotência: uma oportunidade só gera UM handoff, mesmo que
  -- win_opportunity() seja chamada de novo (duplo clique, retry de rede).
  constraint client_handoffs_one_per_opportunity unique (opportunity_id)
);

comment on table public.client_handoffs is
  'Handoff pendente para o sistema de gestão jurídica, gerado ao ganhar uma oportunidade. Sem integração real nesta fase — status fica pendente e a tela diz isso, sem simular criação de processo externo.';

create index client_handoffs_workspace_id_idx on public.client_handoffs (workspace_id);
create index client_handoffs_client_id_idx on public.client_handoffs (workspace_id, client_id);

create trigger client_handoffs_set_updated_at
  before update on public.client_handoffs
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- create_workspace_with_owner — estendida para criar o pipeline padrão
-- (as 8 etapas do protótipo aprovado, Pipeline.dc.html) e os motivos de
-- perda padrão, na MESMA transação que cria o workspace e a membership
-- do owner. Nenhum workspace novo nasce sem funil.
-- ---------------------------------------------------------------------

create or replace function public.create_workspace_with_owner(p_name text, p_slug text)
returns public.workspaces
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_workspace public.workspaces;
  v_actor uuid := auth.uid();
  v_pipeline_id uuid;
  v_stage_name text;
  v_position integer := 0;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  insert into public.workspaces (name, slug)
  values (btrim(p_name), lower(btrim(p_slug)))
  returning * into v_workspace;

  insert into public.memberships (workspace_id, user_id, role, status)
  values (v_workspace.id, v_actor, 'owner', 'active');

  insert into public.pipelines (workspace_id, name, is_default, created_by)
  values (v_workspace.id, 'Comercial', true, v_actor)
  returning id into v_pipeline_id;

  foreach v_stage_name in array array[
    'Fazer primeiro contato',
    'Qualificar oportunidade',
    'Verificar aderência e conflito',
    'Agendar consulta',
    'Realizar consulta',
    'Enviar proposta',
    'Negociar honorários',
    'Aguardar assinatura'
  ]
  loop
    insert into public.pipeline_stages (workspace_id, pipeline_id, name, position)
    values (v_workspace.id, v_pipeline_id, v_stage_name, v_position);
    v_position := v_position + 1;
  end loop;

  insert into public.lost_reasons (workspace_id, label, position)
  values
    (v_workspace.id, 'Honorários acima do orçamento', 0),
    (v_workspace.id, 'Escolheu outro escritório', 1),
    (v_workspace.id, 'Sem viabilidade jurídica', 2),
    (v_workspace.id, 'Cliente desistiu', 3),
    (v_workspace.id, 'Sem retorno do cliente', 4);

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_workspace.id, v_actor, 'workspace.created', 'workspace', v_workspace.id,
    jsonb_build_object('name', v_workspace.name, 'slug', v_workspace.slug)
  );

  return v_workspace;
end;
$body$;

-- ---------------------------------------------------------------------
-- Backfill: workspaces criados ANTES desta migration (A2/A3/A4) não
-- passaram pela função acima — precisam do mesmo pipeline padrão e dos
-- mesmos motivos de perda, ou ficariam sem funil algum. Idempotente
-- (verifica is_default antes de inserir), seguro rodar mais de uma vez.
-- ---------------------------------------------------------------------

do $$
declare
  v_workspace record;
  v_pipeline_id uuid;
  v_stage_name text;
  v_position integer;
  v_system_actor uuid;
begin
  for v_workspace in select id from public.workspaces loop
    if exists (select 1 from public.pipelines where workspace_id = v_workspace.id and is_default) then
      continue;
    end if;

    select user_id into v_system_actor
    from public.memberships
    where workspace_id = v_workspace.id and role = 'owner'
    order by created_at asc
    limit 1;

    if v_system_actor is null then
      continue;
    end if;

    insert into public.pipelines (workspace_id, name, is_default, created_by)
    values (v_workspace.id, 'Comercial', true, v_system_actor)
    returning id into v_pipeline_id;

    v_position := 0;
    foreach v_stage_name in array array[
      'Fazer primeiro contato',
      'Qualificar oportunidade',
      'Verificar aderência e conflito',
      'Agendar consulta',
      'Realizar consulta',
      'Enviar proposta',
      'Negociar honorários',
      'Aguardar assinatura'
    ]
    loop
      insert into public.pipeline_stages (workspace_id, pipeline_id, name, position)
      values (v_workspace.id, v_pipeline_id, v_stage_name, v_position);
      v_position := v_position + 1;
    end loop;

    insert into public.lost_reasons (workspace_id, label, position)
    values
      (v_workspace.id, 'Honorários acima do orçamento', 0),
      (v_workspace.id, 'Escolheu outro escritório', 1),
      (v_workspace.id, 'Sem viabilidade jurídica', 2),
      (v_workspace.id, 'Cliente desistiu', 3),
      (v_workspace.id, 'Sem retorno do cliente', 4);
  end loop;
end;
$$;
