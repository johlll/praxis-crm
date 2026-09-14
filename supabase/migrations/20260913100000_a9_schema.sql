-- A9 — Perfil 360º do lead: schema novo.
--
-- Três tabelas novas, todas penduradas em LEAD (mesma decisão da A6 para
-- activities: é o lead que define o alcance por registro, nunca a
-- oportunidade sozinha) — private.lead_accessible_to_role() é reaproveitada
-- sem mudança para as três. Nenhuma tabela nova permite SELECT/INSERT/
-- UPDATE/DELETE direto do cliente: RLS habilitada e FORÇADA, policies de
-- negação total, toda leitura/escrita passa por função SECURITY DEFINER
-- (próxima migration).
--
-- Ver docs/decisoes/a9-perfil-360.md para o raciocínio completo (inclusive
-- por que "atribuição de marketing" NÃO tem tabela nesta fase — adiado
-- para a A11 — e por que "verificação de conflito" é um registro manual
-- mínimo, não uma busca automática).

create type public.proposal_status as enum ('rascunho', 'enviada', 'aceita', 'recusada');

create type public.proposal_channel as enum ('email', 'whatsapp');

create type public.conflict_check_status as enum (
  'nao_verificado', 'sem_conflito', 'conflito_identificado', 'em_analise'
);

-- ---------------------------------------------------------------------
-- proposals — metadados apenas (número, valor, modelo, status, datas).
-- SEM document_path e SEM geração de PDF nesta fase (emenda 2 do plano:
-- isso é exclusivo da B1). Sempre presa a uma oportunidade E ao lead dela
-- (denormalizado, mesmo padrão de activities.lead_id) para a checagem de
-- alcance ficar idêntica à de atividades, sem reinventar.
-- ---------------------------------------------------------------------

create table public.proposals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  lead_id uuid not null,
  opportunity_id uuid not null,
  number text not null check (char_length(btrim(number)) between 1 and 40),
  value_cents bigint not null check (value_cents >= 0),
  fee_model public.fee_model not null,
  status public.proposal_status not null default 'rascunho',
  sent_channels public.proposal_channel[] not null default '{}'::public.proposal_channel[],
  sent_at timestamptz,
  decided_at timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 2000),
  lock_version bigint not null default 0,
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint proposals_lead_same_workspace_fkey
    foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade,
  constraint proposals_opportunity_same_workspace_fkey
    foreign key (workspace_id, opportunity_id) references public.opportunities (workspace_id, id) on delete cascade,
  constraint proposals_workspace_id_number_key unique (workspace_id, number),
  constraint proposals_sent_fields_consistent check (
    (status = 'rascunho' and sent_at is null and sent_channels = '{}'::public.proposal_channel[])
    or (status <> 'rascunho' and sent_at is not null)
  ),
  constraint proposals_decided_fields_consistent check (
    (status in ('rascunho', 'enviada') and decided_at is null)
    or (status in ('aceita', 'recusada') and decided_at is not null)
  )
);

comment on table public.proposals is
  'Proposta de honorários — só metadados (número, valor, modelo, status, datas). Sem PDF/document_path: geração de documento é exclusiva da fase B1.';

create index proposals_workspace_id_idx on public.proposals (workspace_id);
create index proposals_lead_id_idx on public.proposals (workspace_id, lead_id);
create index proposals_opportunity_id_idx on public.proposals (workspace_id, opportunity_id);

create trigger proposals_set_updated_at
  before update on public.proposals
  for each row execute function private.set_updated_at();

alter table public.proposals enable row level security;
alter table public.proposals force row level security;

create policy proposals_select_deny on public.proposals for select to authenticated using (false);
create policy proposals_insert_deny on public.proposals for insert to authenticated with check (false);
create policy proposals_update_deny on public.proposals for update to authenticated using (false);
create policy proposals_delete_deny on public.proposals for delete to authenticated using (false);

-- ---------------------------------------------------------------------
-- conflict_checks — 1 registro por lead (upsert), preenchido manualmente.
-- Sem busca automática contra clientes/partes adversas: não foi pedido e
-- exigiria um motor de comparação que não existe (ver a9-perfil-360.md §1).
-- ---------------------------------------------------------------------

create table public.conflict_checks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  lead_id uuid not null,
  status public.conflict_check_status not null default 'nao_verificado',
  note text check (note is null or char_length(note) <= 2000),
  checked_by uuid references auth.users (id) on delete set null,
  checked_at timestamptz,
  lock_version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conflict_checks_lead_same_workspace_fkey
    foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade,
  constraint conflict_checks_one_per_lead unique (lead_id),
  constraint conflict_checks_checked_fields_consistent check (
    (status = 'nao_verificado' and checked_at is null)
    or (status <> 'nao_verificado' and checked_at is not null and checked_by is not null)
  )
);

comment on table public.conflict_checks is
  'Verificação de conflito de interesse — registro manual único por lead, sem busca automática. Decisão registrada em docs/decisoes/a9-perfil-360.md §1.';

create index conflict_checks_workspace_id_idx on public.conflict_checks (workspace_id);

create trigger conflict_checks_set_updated_at
  before update on public.conflict_checks
  for each row execute function private.set_updated_at();

alter table public.conflict_checks enable row level security;
alter table public.conflict_checks force row level security;

create policy conflict_checks_select_deny on public.conflict_checks for select to authenticated using (false);
create policy conflict_checks_insert_deny on public.conflict_checks for insert to authenticated with check (false);
create policy conflict_checks_update_deny on public.conflict_checks for update to authenticated using (false);
create policy conflict_checks_delete_deny on public.conflict_checks for delete to authenticated using (false);

-- ---------------------------------------------------------------------
-- lead_notes — anotação livre do composer, append-only (sem editar/
-- excluir nesta fase, mesmo espírito de stage_transitions).
-- ---------------------------------------------------------------------

create table public.lead_notes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  lead_id uuid not null,
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint lead_notes_lead_same_workspace_fkey
    foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade
);

comment on table public.lead_notes is
  'Anotação livre do composer do Perfil 360 — append-only, sem editar/excluir nesta fase.';

create index lead_notes_workspace_id_idx on public.lead_notes (workspace_id);
create index lead_notes_lead_id_idx on public.lead_notes (workspace_id, lead_id);

alter table public.lead_notes enable row level security;
alter table public.lead_notes force row level security;

create policy lead_notes_select_deny on public.lead_notes for select to authenticated using (false);
create policy lead_notes_insert_deny on public.lead_notes for insert to authenticated with check (false);
create policy lead_notes_update_deny on public.lead_notes for update to authenticated using (false);
create policy lead_notes_delete_deny on public.lead_notes for delete to authenticated using (false);
