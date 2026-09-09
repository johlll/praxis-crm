-- A4 — Leads: schema base.
--
-- Convenções mantidas (A2/A3): toda tabela carrega workspace_id NOT NULL;
-- todo índice composto começa por workspace_id; RLS habilitada e FORÇADA
-- na próxima migration; updated_at por trigger.
--
-- Decisão: o valor estimado de honorários (`estimated_value_cents`) mora
-- numa tabela separada (`lead_values`), sem NENHUM grant direto — mesmo
-- padrão de `contact_sensitive` na A3. Não é dado cifrado (não é CPF),
-- mas precisa da mesma defesa: nenhuma via de acesso direta à Data API
-- pode expor o valor a um papel que não deveria vê-lo, e Postgres GRANT
-- é por papel do BANCO (authenticated), não por papel da APLICAÇÃO
-- (owner/viewer/etc. vivem em `memberships`, não em papéis do Postgres)
-- — então a única forma de diferenciar por papel de aplicação é forçar
-- toda leitura por uma função que checa o papel internamente. Ver
-- docs/decisoes/a4-leads.md.

create type public.lead_priority as enum ('baixa', 'media', 'alta');

-- Status mínimo de propósito nesta fase: nenhum conceito de pipeline/
-- estágio/ganho/perdido ainda — isso é da A5 (`opportunities`), que não
-- existe. "arquivado" é só "não está mais ativo", sem presumir o motivo.
create type public.lead_status as enum ('ativo', 'arquivado');

-- Necessário para a FK composta abaixo (garantir, no banco, que
-- leads.contact_id pertence ao mesmo workspace_id de leads — não confiar
-- só na validação da aplicação). contacts.id já é único (PK); esta
-- constraint adicional só formaliza o par para a FK composta funcionar.
alter table public.contacts
  add constraint contacts_workspace_id_id_key unique (workspace_id, id);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  contact_id uuid not null,
  legal_area text not null check (char_length(btrim(legal_area)) between 1 and 120),
  summary text check (summary is null or char_length(btrim(summary)) <= 2000),
  tags text[] not null default '{}'::text[]
    check (array_length(tags, 1) is null or array_length(tags, 1) <= 15),
  priority public.lead_priority not null default 'media',
  status public.lead_status not null default 'ativo',
  -- Responsável: membro ativo do mesmo workspace, checado em create_lead()/
  -- assign_lead() (não dá para expressar "membership ativa" em CHECK/FK).
  assigned_to uuid references auth.users (id) on delete set null,
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leads_contact_same_workspace_fkey
    foreign key (workspace_id, contact_id) references public.contacts (workspace_id, id) on delete restrict
);

comment on table public.leads is
  'Oportunidade comercial vinculada a um contato. Um contato pode ter vários leads (não duplica o cadastro da pessoa/empresa). Nunca guarda CPF nem o valor de honorários — ver lead_values.';

create index leads_workspace_id_idx on public.leads (workspace_id);
create index leads_contact_id_idx on public.leads (workspace_id, contact_id);
create index leads_assigned_to_idx on public.leads (workspace_id, assigned_to);
create index leads_status_idx on public.leads (workspace_id, status);

create trigger leads_set_updated_at
  before update on public.leads
  for each row execute function private.set_updated_at();

create trigger leads_set_created_by
  before insert on public.leads
  for each row execute function private.set_created_by_to_current_user();

-- ---------------------------------------------------------------------
-- lead_values — valor estimado de honorários, isolado, sem GRANT nenhum
-- (ver comentário no topo do arquivo). Um-para-um com leads.
-- ---------------------------------------------------------------------

create table public.lead_values (
  lead_id uuid primary key references public.leads (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- Inteiro em centavos — nunca float, nunca numeric impreciso. Nulo é
  -- "não informado", nunca zero como sentinela.
  estimated_value_cents bigint check (estimated_value_cents is null or estimated_value_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.lead_values is
  'Valor estimado de honorários, separado de leads de propósito: zero grant direto, só acessível via função que projeta o campo pelo papel de quem chama (exato, faixa, ou ausente).';

create index lead_values_workspace_id_idx on public.lead_values (workspace_id);

create trigger lead_values_set_updated_at
  before update on public.lead_values
  for each row execute function private.set_updated_at();
