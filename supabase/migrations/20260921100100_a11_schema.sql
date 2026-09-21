-- A11 — Formulários próprios e atribuição multitoque: schema.
--
-- Contrato completo em docs/decisoes/a11-ingestao-atribuicao.md. Toda
-- tabela desta fase carrega workspace_id, índices começando pelo
-- workspace quando aplicável, RLS habilitada E forçada (migration
-- seguinte) e privilégios mínimos (nenhum GRANT de CRUD direto — todo
-- caminho de escrita passa por função SECURITY DEFINER).
--
-- Nada aqui inventa `is_active` em pipelines ou etapas: o ciclo de vida
-- desligável é do FORMULÁRIO (form_endpoints.status), não do pipeline.

-- ---------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------

create type public.form_endpoint_status as enum ('active', 'disabled');

-- Modo de captação declarado pelo endpoint:
--   'new_intake'  — toda submissão é captação NOVA e explícita: nasce
--                   demanda nova mesmo quando a identidade resolve a
--                   pessoa (regra §7 do contrato).
--   'continuity'  — a submissão PODE trazer uma referência de
--                   continuidade; com referência válida, anexa à demanda
--                   existente; sem ela, cai na regra de captação nova.
create type public.form_capture_mode as enum ('new_intake', 'continuity');

create type public.webhook_event_status as enum (
  'received',              -- gravado, ainda não publicado/processado
  'processing',            -- worker segurou o evento (lock transacional)
  'processed',             -- efeitos comerciais aplicados
  'failed',                -- tentativa falhou, ainda elegível a retry
  'dead',                  -- esgotou as tentativas
  'expired_unprocessed',   -- venceu a retenção sem nunca ter sido processado
  'purged'                 -- processado e depois limpo pela retenção
);

create type public.outbox_state as enum ('pending', 'publishing', 'published', 'failed', 'abandoned');

create type public.touchpoint_link_action as enum ('assign', 'unassign');

create type public.consent_decision as enum ('granted', 'refused');

-- ---------------------------------------------------------------------
-- form_endpoints — configuração do formulário público, por workspace
-- ---------------------------------------------------------------------

create table public.form_endpoints (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),

  -- Destino da demanda criada. IDs SEMPRE explícitos: `pipelines.
  -- is_default` pode pré-selecionar na interface, nunca ser resolvido no
  -- processamento (um default trocado depois mudaria o destino de um
  -- formulário já publicado sem ninguém decidir isso).
  pipeline_id uuid not null,
  stage_id uuid not null,
  legal_area text not null check (char_length(btrim(legal_area)) between 1 and 120),

  -- Atividade inicial da demanda nova.
  initial_activity_type public.activity_type not null,
  -- Minutos corridos a partir do recebimento. Obrigatório: nenhum
  -- formulário real herda automaticamente o valor do seed fictício.
  initial_activity_due_minutes integer not null
    check (initial_activity_due_minutes between 1 and 43200),

  capture_mode public.form_capture_mode not null,

  -- Versão do contrato público aceito por este endpoint. O navegador
  -- envia a versão; divergência é recusada com erro genérico.
  contract_version integer not null default 1 check (contract_version >= 1),

  -- Configuração das respostas permitidas: lista fechada de campos que o
  -- formulário aceita. Validada por Zod na aplicação ANTES de gravar e
  -- de novo no processamento — o banco só garante a forma mínima.
  answers_config jsonb not null default '{"fields": []}'::jsonb
    check (jsonb_typeof(answers_config -> 'fields') = 'array'),

  -- Turnstile: action e hostnames esperados deste endpoint (conferidos
  -- contra a resposta do siteverify, não só `success`).
  turnstile_action text not null check (char_length(btrim(turnstile_action)) between 1 and 60),
  allowed_hostnames text[] not null
    check (array_length(allowed_hostnames, 1) between 1 and 20),

  -- Ciclo de vida PRÓPRIO do endpoint (independente de pipeline/etapa).
  status public.form_endpoint_status not null default 'active',
  disabled_at timestamptz,
  disabled_by uuid references auth.users (id) on delete set null,

  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint form_endpoints_pipeline_same_workspace_fkey
    foreign key (workspace_id, pipeline_id) references public.pipelines (workspace_id, id) on delete restrict,
  -- A etapa precisa pertencer ao MESMO pipeline (não só ao mesmo
  -- workspace) — mesma garantia que opportunities já tem.
  constraint form_endpoints_stage_belongs_to_pipeline_fkey
    foreign key (pipeline_id, stage_id) references public.pipeline_stages (pipeline_id, id) on delete restrict,
  constraint form_endpoints_disabled_consistency check (
    (status = 'disabled' and disabled_at is not null) or
    (status = 'active' and disabled_at is null and disabled_by is null)
  ),
  constraint form_endpoints_workspace_id_id_key unique (workspace_id, id)
);

create index form_endpoints_workspace_idx on public.form_endpoints (workspace_id, created_at desc);

comment on table public.form_endpoints is
  'Configuração de um formulário público próprio (A11). Desativar aqui derruba a captação sem apagar nenhum evento já recebido.';

-- ---------------------------------------------------------------------
-- form_endpoint_keys — chave pública opaca, com rotação e revogação
--
-- A chave vive na PRÓPRIA tabela (e não como coluna de form_endpoints)
-- porque rotação exige histórico: a chave anterior precisa continuar
-- existindo, marcada como revogada, para que uma página antiga que ainda
-- a use receba a recusa genérica em vez de cair num endpoint válido.
-- Uma única chave ATIVA por endpoint (índice parcial abaixo).
-- ---------------------------------------------------------------------

create table public.form_endpoint_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  form_endpoint_id uuid not null,
  -- Opaca: 32 bytes aleatórios em base64url, gerados na aplicação.
  -- Única GLOBALMENTE — a URL pública é só a chave, sem workspace.
  public_key text not null unique check (public_key ~ '^[A-Za-z0-9_-]{24,64}$'),
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint form_endpoint_keys_endpoint_same_workspace_fkey
    foreign key (workspace_id, form_endpoint_id) references public.form_endpoints (workspace_id, id) on delete cascade
);

create unique index form_endpoint_keys_one_active_idx
  on public.form_endpoint_keys (form_endpoint_id) where revoked_at is null;
create index form_endpoint_keys_workspace_idx on public.form_endpoint_keys (workspace_id, form_endpoint_id);

-- ---------------------------------------------------------------------
-- webhook_events — evento bruto recebido, cifrado, idempotente
-- ---------------------------------------------------------------------

create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  form_endpoint_id uuid not null,

  -- Chave idempotente: (workspace_id, form_endpoint_id, source_event_id).
  -- source_event_id é gerado no NAVEGADOR (crypto.randomUUID) uma vez por
  -- submissão e reutilizado em todo retry da MESMA submissão.
  source_event_id uuid not null,
  -- SHA-256 da representação canônica do conteúdo de NEGÓCIO (sem token
  -- do Turnstile, IP, cabeçalhos ou timestamps do servidor).
  content_hash bytea not null check (octet_length(content_hash) = 32),
  -- Protocolo público opaco: é o ÚNICO identificador que a resposta
  -- pública devolve. Nunca o id interno.
  public_protocol text not null unique check (public_protocol ~ '^[A-Za-z0-9_-]{16,64}$'),

  -- Payload bruto cifrado (AES-256-GCM), em colunas separadas.
  -- Nulos depois da limpeza de retenção (tombstone).
  payload_ciphertext bytea,
  payload_iv bytea check (payload_iv is null or octet_length(payload_iv) = 12),
  payload_auth_tag bytea check (payload_auth_tag is null or octet_length(payload_auth_tag) = 16),
  payload_algorithm text,
  payload_key_version text,
  -- Diagnóstico SEM PII (contagens, comprimentos, domínio do e-mail, DDD,
  -- códigos). Temporário: eliminado na retenção.
  payload_sanitized jsonb,

  -- Datas (ver §3 do contrato): declarada, atribuída pelo banco,
  -- persistência e a usada em ordenação/atribuição.
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  normalized_occurred_at timestamptz not null,
  normalization_code text not null,

  status public.webhook_event_status not null default 'received',
  attempts integer not null default 0 check (attempts >= 0),
  last_error_code text,

  -- Referências resultantes: preservadas na tombstone (não são PII).
  result_contact_id uuid,
  result_lead_id uuid,
  result_opportunity_id uuid,
  result_touchpoint_id uuid,
  result_activity_id uuid,

  -- Retenção e alertas.
  expires_at timestamptz not null,
  processed_at timestamptz,
  purged_at timestamptz,
  -- Instante a partir do qual um evento sem processamento é considerado
  -- TRAVADO (limite determinístico e testável, não heurística).
  stuck_after timestamptz not null,
  stuck_alerted_at timestamptz,
  expiring_alerted_at timestamptz,

  created_at timestamptz not null default now(),

  constraint webhook_events_endpoint_same_workspace_fkey
    foreign key (workspace_id, form_endpoint_id) references public.form_endpoints (workspace_id, id) on delete restrict,
  -- A chave idempotente sobrevive à limpeza: a linha permanece como
  -- tombstone, só o conteúdo pessoal é eliminado.
  constraint webhook_events_idempotency_key unique (workspace_id, form_endpoint_id, source_event_id),
  constraint webhook_events_workspace_id_id_key unique (workspace_id, id),
  constraint webhook_events_processed_consistency check (
    (status = 'processed' and processed_at is not null) or status <> 'processed'
  )
);

create index webhook_events_workspace_status_idx
  on public.webhook_events (workspace_id, status, received_at desc);
-- Varreduras dos jobs (retenção/alerta) são GLOBAIS por natureza: o cron
-- roda fora de qualquer workspace.
create index webhook_events_expires_idx on public.webhook_events (expires_at) where purged_at is null;
create index webhook_events_stuck_idx on public.webhook_events (stuck_after)
  where processed_at is null and stuck_alerted_at is null;

comment on table public.webhook_events is
  'Evento público recebido por /api/forms/[endpointKey] (A11): payload bruto cifrado, chave idempotente preservada mesmo após a retenção (tombstone).';

-- ---------------------------------------------------------------------
-- outbox — garantia de que nada se perde entre o commit e o Inngest
-- ---------------------------------------------------------------------

create table public.outbox (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- Uma outbox por evento: a unicidade é o que garante "duas requisições
  -- simultâneas iguais → um evento e UMA outbox".
  webhook_event_id uuid not null unique,
  event_type text not null check (char_length(btrim(event_type)) between 1 and 80),
  state public.outbox_state not null default 'pending',
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error_code text,
  published_at timestamptz,
  -- Controle seguro de concorrência: o reconciliador marca a linha antes
  -- de publicar (com `for update skip locked`), e um lock expirado volta
  -- a ser elegível.
  locked_at timestamptz,
  lock_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint outbox_event_same_workspace_fkey
    foreign key (workspace_id, webhook_event_id) references public.webhook_events (workspace_id, id) on delete cascade,
  constraint outbox_published_consistency check (
    (state = 'published' and published_at is not null) or state <> 'published'
  )
);

create index outbox_pending_idx on public.outbox (next_attempt_at)
  where state in ('pending', 'publishing', 'failed');

-- ---------------------------------------------------------------------
-- touchpoints — append-only, uma interação NUNCA sobrescreve outra
-- ---------------------------------------------------------------------

create table public.touchpoints (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  contact_id uuid not null,
  -- Lead e oportunidade quando CONHECIDOS na origem. Eventos de captação
  -- nova gravam a oportunidade diretamente aqui (§7 do contrato) — é
  -- isso que torna a conversão verificável sem depender da cadeia.
  lead_id uuid,
  opportunity_id uuid,
  webhook_event_id uuid,

  occurred_at timestamptz,
  received_at timestamptz not null,
  normalized_occurred_at timestamptz not null,

  channel text not null check (char_length(btrim(channel)) between 1 and 40),
  source text, medium text, campaign text, content text, term text,
  gclid text, fbclid text,
  landing_url text, referrer text,
  form_endpoint_id uuid,
  consent_evidence_id uuid,

  -- Ordem da interação dentro do contato (1, 2, 3...). Atribuída dentro
  -- da transação do worker; nunca reciclada.
  position integer not null check (position >= 1),

  created_at timestamptz not null default now(),

  constraint touchpoints_contact_same_workspace_fkey
    foreign key (workspace_id, contact_id) references public.contacts (workspace_id, id) on delete restrict,
  constraint touchpoints_lead_same_workspace_fkey
    foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete restrict,
  -- A oportunidade precisa pertencer ao MESMO lead que o touchpoint
  -- referencia (mesma garantia de activities na A6).
  constraint touchpoints_opportunity_same_lead_fkey
    foreign key (workspace_id, opportunity_id, lead_id)
    references public.opportunities (workspace_id, id, lead_id) on delete restrict,
  constraint touchpoints_event_same_workspace_fkey
    foreign key (workspace_id, webhook_event_id) references public.webhook_events (workspace_id, id) on delete restrict,
  constraint touchpoints_endpoint_same_workspace_fkey
    foreign key (workspace_id, form_endpoint_id) references public.form_endpoints (workspace_id, id) on delete restrict,
  constraint touchpoints_workspace_id_id_key unique (workspace_id, id),
  -- Oportunidade sem lead seria um vínculo impossível de checar.
  constraint touchpoints_opportunity_requires_lead check (opportunity_id is null or lead_id is not null)
);

create index touchpoints_contact_idx
  on public.touchpoints (workspace_id, contact_id, normalized_occurred_at, received_at, id);
create index touchpoints_opportunity_idx
  on public.touchpoints (workspace_id, opportunity_id, normalized_occurred_at, received_at, id)
  where opportunity_id is not null;
create unique index touchpoints_event_unique_idx
  on public.touchpoints (webhook_event_id) where webhook_event_id is not null;

comment on table public.touchpoints is
  'Interação registrada (A11), append-only: nunca sobrescreve outra. A atribuição usa normalized_occurred_at, com received_at e id como desempate determinístico.';

-- ---------------------------------------------------------------------
-- touchpoint_demand_links — correção de vínculo, append-only e versionada
--
-- Invariantes garantidas pelo BANCO (não só pela RPC):
--   * uma única RAIZ por touchpoint          (índice parcial)
--   * supersedes_id usado no máximo uma vez  (índice parcial)
--   * predecessor do MESMO touchpoint/workspace (FK composta)
--   * nenhuma linha sucede a si mesma        (check)
-- Raiz única + sucessão única = cadeia linear, logo UMA ponta vigente.
-- ---------------------------------------------------------------------

create table public.touchpoint_demand_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  touchpoint_id uuid not null,
  -- Nulo em 'unassign': o touchpoint passa a não ter demanda atribuída.
  opportunity_id uuid,
  action public.touchpoint_link_action not null,
  supersedes_id uuid,
  reason text check (reason is null or char_length(btrim(reason)) between 1 and 500),
  actor_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),

  constraint touchpoint_demand_links_touchpoint_same_workspace_fkey
    foreign key (workspace_id, touchpoint_id) references public.touchpoints (workspace_id, id) on delete cascade,
  constraint touchpoint_demand_links_opportunity_same_workspace_fkey
    foreign key (workspace_id, opportunity_id) references public.opportunities (workspace_id, id) on delete restrict,
  -- Predecessor obrigatoriamente do mesmo touchpoint E workspace.
  constraint touchpoint_demand_links_supersedes_same_chain_fkey
    foreign key (workspace_id, touchpoint_id, supersedes_id)
    references public.touchpoint_demand_links (workspace_id, touchpoint_id, id) on delete restrict,
  constraint touchpoint_demand_links_chain_key unique (workspace_id, touchpoint_id, id),
  constraint touchpoint_demand_links_no_self_cycle check (supersedes_id is distinct from id),
  constraint touchpoint_demand_links_action_consistency check (
    (action = 'assign' and opportunity_id is not null) or
    (action = 'unassign' and opportunity_id is null)
  )
);

create unique index touchpoint_demand_links_one_root_idx
  on public.touchpoint_demand_links (touchpoint_id) where supersedes_id is null;
create unique index touchpoint_demand_links_supersedes_once_idx
  on public.touchpoint_demand_links (supersedes_id) where supersedes_id is not null;
create index touchpoint_demand_links_workspace_idx
  on public.touchpoint_demand_links (workspace_id, touchpoint_id, created_at);

comment on table public.touchpoint_demand_links is
  'Cadeia versionada de correção do vínculo entre touchpoint e oportunidade (A11). Append-only: o histórico nunca é apagado, só a ponta vigente vale.';

-- ---------------------------------------------------------------------
-- continuity_references — token opaco guardado SÓ por hash
--
-- Telefone e e-mail NÃO são referências de continuidade (contrato §8):
-- são sinais fracos que levantam candidato a duplicidade, nunca
-- identidade.
-- ---------------------------------------------------------------------

create table public.continuity_references (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- SHA-256 do token aleatório. O token em claro existe uma única vez, no
  -- momento da emissão, e nunca é persistido.
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  contact_id uuid not null,
  lead_id uuid not null,
  opportunity_id uuid,
  purpose text not null check (char_length(btrim(purpose)) between 1 and 80),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  used_count integer not null default 0 check (used_count >= 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),

  constraint continuity_references_contact_same_workspace_fkey
    foreign key (workspace_id, contact_id) references public.contacts (workspace_id, id) on delete cascade,
  constraint continuity_references_lead_same_workspace_fkey
    foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade,
  constraint continuity_references_opportunity_same_lead_fkey
    foreign key (workspace_id, opportunity_id, lead_id)
    references public.opportunities (workspace_id, id, lead_id) on delete cascade,
  constraint continuity_references_workspace_id_id_key unique (workspace_id, id)
);

create index continuity_references_contact_idx
  on public.continuity_references (workspace_id, contact_id);

-- ---------------------------------------------------------------------
-- consent_evidence — evidência append-only, versionada
--
-- NÃO substitui contact_consents (contrato da A7 preservado inteiro,
-- inclusive o gate de envio por purpose_code). Acrescenta a prova do que
-- foi aceito, quando, em qual formulário e sob qual texto.
-- ---------------------------------------------------------------------

-- contact_consents ganha a FK composta que consent_evidence precisa
-- referenciar por (workspace_id, id). Só um UNIQUE novo — nenhuma coluna
-- muda, nenhum dado é reescrito.
alter table public.contact_consents
  add constraint contact_consents_workspace_id_id_key unique (workspace_id, id);

create table public.consent_evidence (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  contact_id uuid not null,
  -- Vínculo com o registro vigente de contact_consents, quando existir.
  contact_consent_id uuid,
  decision public.consent_decision not null,
  purpose_code public.consent_purpose not null,
  purpose text not null check (char_length(btrim(purpose)) between 1 and 300),
  legal_basis public.consent_legal_basis not null,
  channel public.contact_channel not null,
  -- Versão e hash do texto aceito: prova de QUAL texto foi apresentado.
  text_version text check (text_version is null or char_length(btrim(text_version)) between 1 and 40),
  text_hash bytea check (text_hash is null or octet_length(text_hash) = 32),
  decided_at timestamptz not null,
  form_endpoint_id uuid,
  webhook_event_id uuid,
  -- Evidência mínima, sem PII: códigos, versões, flags.
  evidence jsonb not null default '{}'::jsonb,
  -- HMAC do IP (nunca o IP). Só preenchido quando a política do endpoint
  -- permitir; nulo é o padrão.
  ip_hmac bytea check (ip_hmac is null or octet_length(ip_hmac) = 32),
  supersedes_id uuid,
  created_at timestamptz not null default now(),

  constraint consent_evidence_contact_same_workspace_fkey
    foreign key (workspace_id, contact_id) references public.contacts (workspace_id, id) on delete cascade,
  constraint consent_evidence_consent_same_workspace_fkey
    foreign key (workspace_id, contact_consent_id) references public.contact_consents (workspace_id, id) on delete set null,
  constraint consent_evidence_endpoint_same_workspace_fkey
    foreign key (workspace_id, form_endpoint_id) references public.form_endpoints (workspace_id, id) on delete restrict,
  constraint consent_evidence_event_same_workspace_fkey
    foreign key (workspace_id, webhook_event_id) references public.webhook_events (workspace_id, id) on delete restrict,
  constraint consent_evidence_supersedes_same_workspace_fkey
    foreign key (workspace_id, supersedes_id) references public.consent_evidence (workspace_id, id) on delete restrict,
  constraint consent_evidence_workspace_id_id_key unique (workspace_id, id),
  constraint consent_evidence_no_self_cycle check (supersedes_id is distinct from id)
);

create unique index consent_evidence_supersedes_once_idx
  on public.consent_evidence (supersedes_id) where supersedes_id is not null;
create index consent_evidence_contact_idx
  on public.consent_evidence (workspace_id, contact_id, decided_at desc);

-- touchpoints.consent_evidence_id só pode ser criado depois de
-- consent_evidence existir.
alter table public.touchpoints
  add constraint touchpoints_consent_evidence_same_workspace_fkey
  foreign key (workspace_id, consent_evidence_id)
  references public.consent_evidence (workspace_id, id) on delete set null;
