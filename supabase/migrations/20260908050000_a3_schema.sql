-- A3 — Contatos, identidade e deduplicação: schema base.
--
-- Convenções da A2 mantidas: toda tabela carrega workspace_id NOT NULL;
-- todo índice composto começa por workspace_id; RLS habilitada e FORÇADA
-- em toda tabela (próxima migration); updated_at por trigger.
--
-- Decisões registradas antes desta migration:
--   docs/decisoes/a3-criptografia.md — cifra AES-256-GCM + blind index
--     HMAC-SHA256 contextualizado por workspace, calculados em Node (nunca
--     em SQL/pgcrypto), key_version por linha.
--   docs/decisoes/a3-duplicidades.md — sinais determinísticos, sem ML,
--     sem mesclagem automática.

-- pg_trgm: só para o sinal de nome+cidade parecidos (similarity()).
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------

create type public.contact_type as enum ('pf', 'pj');

create type public.contact_channel as enum ('whatsapp', 'email', 'telefone', 'presencial');

create type public.consent_legal_basis as enum (
  'consentimento',
  'legitimo_interesse',
  'execucao_de_contrato',
  'obrigacao_legal',
  'outro'
);

create type public.duplicate_tier as enum ('strong', 'review', 'low');

create type public.duplicate_status as enum ('pending', 'merged', 'dismissed');

-- ---------------------------------------------------------------------
-- contacts
-- ---------------------------------------------------------------------

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  type public.contact_type not null,
  name text not null check (char_length(btrim(name)) between 1 and 160),
  city text check (city is null or char_length(btrim(city)) between 1 and 120),
  uf char(2) check (uf is null or uf ~ '^[A-Z]{2}$'),
  preferred_channel public.contact_channel,
  -- Mesclagem "soft": a linha nunca é apagada, só passa a apontar para a
  -- vencedora. Toda leitura de listagem filtra `merged_into_contact_id is
  -- null` — ver merge_contacts() na migration de funções de negócio.
  merged_into_contact_id uuid references public.contacts (id) on delete set null,
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.contacts is
  'Contato (PF/PJ). Mesclagem é soft (merged_into_contact_id), nunca DELETE.';

create index contacts_workspace_id_idx on public.contacts (workspace_id)
  where merged_into_contact_id is null;

-- Índice trigram para o sinal de nome+cidade parecidos (a3-duplicidades.md).
create index contacts_name_trgm_idx on public.contacts
  using gin (name extensions.gin_trgm_ops);

create trigger contacts_set_updated_at
  before update on public.contacts
  for each row execute function private.set_updated_at();

create trigger contacts_set_created_by
  before insert on public.contacts
  for each row execute function private.set_created_by_to_current_user();

-- ---------------------------------------------------------------------
-- contact_phones / contact_emails — N por contato, sem unicidade de valor
-- (telefone de família, e-mail administrativo compartilhado são casos
-- reais — ver a3-duplicidades.md sobre por que isso não é prova de
-- identidade sozinho).
-- ---------------------------------------------------------------------

create table public.contact_phones (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  -- E.164 (+5511999999999) — normalizado no servidor antes de gravar,
  -- nunca confiado como já normalizado vindo do cliente.
  value_normalized text not null check (value_normalized ~ '^\+[1-9][0-9]{7,14}$'),
  is_primary boolean not null default false,
  verified_at timestamptz,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.contact_phones is
  'Telefones de um contato. Índice não único de propósito — ver a3-duplicidades.md.';

create index contact_phones_workspace_id_value_idx
  on public.contact_phones (workspace_id, value_normalized);

create index contact_phones_contact_id_idx on public.contact_phones (contact_id);

create trigger contact_phones_set_updated_at
  before update on public.contact_phones
  for each row execute function private.set_updated_at();

create table public.contact_emails (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  value_normalized text not null check (
    value_normalized = lower(btrim(value_normalized))
    and value_normalized ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  is_primary boolean not null default false,
  verified_at timestamptz,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.contact_emails is
  'E-mails de um contato. Índice não único de propósito — ver a3-duplicidades.md.';

create index contact_emails_workspace_id_value_idx
  on public.contact_emails (workspace_id, value_normalized);

create index contact_emails_contact_id_idx on public.contact_emails (contact_id);

create trigger contact_emails_set_updated_at
  before update on public.contact_emails
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- contact_identifiers — identidade externa confiável (ex.: wa_id da Meta).
-- Único caminho que reaproveita contato automaticamente sem ser mesclagem.
-- Schema pronto nesta fase; nenhum fluxo desta fase ainda escreve aqui —
-- entra quando a integração real existir (fase futura).
-- ---------------------------------------------------------------------

create table public.contact_identifiers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  provider text not null,
  external_id text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, provider, external_id)
);

comment on table public.contact_identifiers is
  'Identidade externa confiável (provider+external_id). Reaproveita contato sem mesclagem.';

-- ---------------------------------------------------------------------
-- contact_sensitive — CPF/CNPJ cifrado (AES-256-GCM) + blind index
-- (HMAC-SHA256, contextualizado por workspace). Nunca o valor em claro.
-- 1:1 com contacts — a PK é a própria FK.
-- ---------------------------------------------------------------------

create table public.contact_sensitive (
  contact_id uuid primary key references public.contacts (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- iv (12B) || authTag (16B) || ciphertext — formato único, decifrado só
  -- em Node (src/server/crypto/contact-sensitive.ts), nunca em SQL.
  cpf_cnpj_ciphertext bytea not null,
  cpf_cnpj_blind_index bytea not null,
  key_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.contact_sensitive is
  'CPF/CNPJ cifrado. Nunca lido/escrito direto pelo cliente — só via função SECURITY DEFINER, sem GRANT de tabela nenhum.';

create index contact_sensitive_workspace_id_blind_index_idx
  on public.contact_sensitive (workspace_id, cpf_cnpj_blind_index);

create trigger contact_sensitive_set_updated_at
  before update on public.contact_sensitive
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- contact_consents — schema e contratos de acesso desta fase; SEM tela
-- própria e SEM criação automática ao cadastrar/importar um contato
-- (ausência de registro não significa consentimento — decisão explícita
-- do usuário, não lacuna).
-- ---------------------------------------------------------------------

create table public.contact_consents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  channel public.contact_channel not null,
  legal_basis public.consent_legal_basis not null,
  purpose text not null check (char_length(btrim(purpose)) between 1 and 300),
  granted_at timestamptz,
  revoked_at timestamptz,
  evidence_source text,
  accepted_text text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (revoked_at is null or granted_at is null or revoked_at >= granted_at)
);

comment on table public.contact_consents is
  'Consentimento por canal/finalidade. Nunca criado automaticamente — ausência não significa consentimento.';

create index contact_consents_contact_id_idx on public.contact_consents (contact_id);

create trigger contact_consents_set_updated_at
  before update on public.contact_consents
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- duplicate_candidates — sugestão, nunca mesclagem automática. `signals`
-- guarda o motivo por extenso; `priority` é só ordenação de fila, nunca
-- probabilidade — ver a3-duplicidades.md.
-- ---------------------------------------------------------------------

create table public.duplicate_candidates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  contact_a_id uuid not null references public.contacts (id) on delete cascade,
  contact_b_id uuid not null references public.contacts (id) on delete cascade,
  signals jsonb not null default '[]'::jsonb,
  tier public.duplicate_tier not null,
  priority int not null,
  status public.duplicate_status not null default 'pending',
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (contact_a_id <> contact_b_id)
);

comment on table public.duplicate_candidates is
  'Sugestão de duplicidade — revisão humana decide. priority é só ordem de fila, nunca probabilidade de identidade.';

-- Um único par por workspace, independente da ordem (a,b) — least/greatest
-- funciona em uuid (tem operadores de ordem). Evita (A,B) e (B,A) duplicados.
create unique index duplicate_candidates_workspace_pair_idx
  on public.duplicate_candidates (
    workspace_id,
    least(contact_a_id, contact_b_id),
    greatest(contact_a_id, contact_b_id)
  );

create index duplicate_candidates_workspace_status_priority_idx
  on public.duplicate_candidates (workspace_id, status, priority desc);

create trigger duplicate_candidates_set_updated_at
  before update on public.duplicate_candidates
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- contact_merges — snapshot MINIMIZADO para desfazer (nunca cópia
-- integral de dado pessoal): o que mudou no contato vencedor e quais
-- linhas foram reparentadas, com o `updated_at` de cada uma no momento da
-- mesclagem — usado para detectar edição posterior e recusar desfazer
-- silenciosamente (ver merge_contacts()/unmerge_contact()).
-- ---------------------------------------------------------------------

create table public.contact_merges (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kept_contact_id uuid not null references public.contacts (id) on delete cascade,
  merged_contact_id uuid not null references public.contacts (id) on delete cascade,
  candidate_id uuid references public.duplicate_candidates (id) on delete set null,
  -- Só os campos escalares que mudaram no vencedor: {"name": {"previous": "...", "previous_updated_at": "..."}}
  kept_contact_previous_values jsonb not null default '{}'::jsonb,
  -- Linhas reparentadas de merged_contact_id para kept_contact_id:
  -- [{"table": "contact_phones", "id": "...", "previous_updated_at": "..."}]
  moved_rows jsonb not null default '[]'::jsonb,
  merged_by uuid not null references auth.users (id) on delete restrict,
  merged_at timestamptz not null default now(),
  undone_by uuid references auth.users (id) on delete set null,
  undone_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.contact_merges is
  'Snapshot minimizado de cada mesclagem — o suficiente para desfazer, nunca cópia integral de dado pessoal.';

create index contact_merges_workspace_id_idx on public.contact_merges (workspace_id, merged_at desc);

-- ---------------------------------------------------------------------
-- sensitive_data_access — quem revelou qual campo de qual contato, quando
-- e (quando aplicável) por quê. NUNCA o valor revelado. Append-only, mesmo
-- padrão de audit_logs.
-- ---------------------------------------------------------------------

create table public.sensitive_data_access (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  actor_user_id uuid references auth.users (id) on delete set null,
  field text not null,
  reason text,
  created_at timestamptz not null default now()
);

comment on table public.sensitive_data_access is
  'Trilha de revelação de campo sensível. Nunca guarda o valor revelado. Append-only.';

create index sensitive_data_access_workspace_id_created_at_idx
  on public.sensitive_data_access (workspace_id, created_at desc);
