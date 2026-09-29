-- B1 — Propostas: schema de proposal_documents.
--
-- Uma versão de PDF gerada para uma proposta. Append-only e imutável
-- depois de status='ready': regenerar cria uma linha nova (versão N+1),
-- nunca sobrescreve storage_path/checksum de uma linha já pronta —
-- "versão enviada" continua identificável mesmo depois de existir uma
-- versão mais recente (decisão revisada da B1, item 1).
--
-- Duas fases (begin_proposal_document → upload no Storage →
-- finalize_proposal_document), para nunca haver uma linha 'ready' sem
-- arquivo íntegro no Storage (item 3): a linha nasce 'pending' e só vira
-- 'ready' depois que finalize_proposal_document confirma, consultando
-- storage.objects, que o objeto existe com o tamanho esperado.
--
-- RLS deny-all para authenticated, mesmo padrão de proposal_number_counters
-- (A9): todo acesso passa pelas funções SECURITY DEFINER da próxima
-- migration, e as que ALTERAM estado (begin/finalize/fail) são GRANT só
-- para service_role — nenhum usuário autenticado consegue forjar um
-- resultado de geração por RPC direta (item 3), porque a permissão de
-- EXECUTE dessas funções nem existe para o papel `authenticated`.

create type public.proposal_document_status as enum ('pending', 'ready', 'failed');

create table public.proposal_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  proposal_id uuid not null,
  version integer not null check (version >= 1),
  status public.proposal_document_status not null default 'pending',
  -- Caminho no bucket privado `proposal-documents`:
  -- workspace/<workspace_id>/proposal/<proposal_id>/v<version>.pdf —
  -- determinístico e único por design (a unique abaixo é só o cinto e a
  -- suspensório contra um bug que tente reusar caminho).
  storage_path text not null,
  checksum_sha256 text,
  byte_size bigint check (byte_size is null or byte_size > 0),
  error_code text,
  requested_by uuid not null references auth.users (id) on delete restrict,
  requested_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint proposal_documents_proposal_same_workspace_fkey
    foreign key (workspace_id, proposal_id) references public.proposals (workspace_id, id) on delete cascade,
  constraint proposal_documents_proposal_version_key unique (proposal_id, version),
  constraint proposal_documents_storage_path_key unique (storage_path),
  -- Campos de "pronto" só existem quando pronto; nunca um ready sem
  -- checksum/tamanho, nunca um pending com eles já preenchidos.
  constraint proposal_documents_status_fields_consistent check (
    (status = 'pending' and checksum_sha256 is null and byte_size is null and resolved_at is null and error_code is null)
    or (status = 'ready' and checksum_sha256 is not null and byte_size is not null and resolved_at is not null and error_code is null)
    or (status = 'failed' and resolved_at is not null)
  )
);

comment on table public.proposal_documents is
  'PDF gerado por versão de proposta (B1) — append-only, imutável depois de ready. Sem GRANT nenhum para authenticated: leitura via list_proposal_documents/get_proposal_document_for_download (SECURITY DEFINER, projeção por papel), escrita via begin/finalize/fail_proposal_document (SECURITY DEFINER, GRANT só a service_role).';

create index proposal_documents_workspace_id_idx on public.proposal_documents (workspace_id);
create index proposal_documents_proposal_id_idx on public.proposal_documents (workspace_id, proposal_id);

alter table public.proposal_documents enable row level security;
alter table public.proposal_documents force row level security;

create policy proposal_documents_select_deny on public.proposal_documents for select to authenticated using (false);
create policy proposal_documents_insert_deny on public.proposal_documents for insert to authenticated with check (false);
create policy proposal_documents_update_deny on public.proposal_documents for update to authenticated using (false);
create policy proposal_documents_delete_deny on public.proposal_documents for delete to authenticated using (false);

revoke all on table public.proposal_documents from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- proposal_email_sends — um envio real por e-mail, ou tentativa dele.
--
-- 'queued' nasce só com a intenção registrada — clicar não é enviar
-- (item 5). Só vira 'accepted' depois que o Resend confirma recebimento
-- da mensagem; o nome deliberadamente NÃO é 'sent'/'delivered' — a API
-- aceitar não prova que a caixa do cliente recebeu (item 2). Confirmação
-- de entrega de verdade exigiria processar webhook do provedor, fora do
-- escopo desta fase.
--
-- idempotency_key vem do cliente (gerado uma vez por intenção de envio,
-- reaproveitado em qualquer reenvio da MESMA chamada/clique — item 1) e é
-- também o valor mandado no cabeçalho de idempotência da API do Resend,
-- que a documentação do provedor honra por 24h.
--
-- caused_status_transition marca exatamente qual linha foi responsável
-- por rascunho→enviada em proposals — a MESMA transição que já existia
-- desde a A9 (send_proposal, registro manual). Isso é o que evita duplicar
-- o mesmo fato na timeline (item 7): o primeiro envio bem-sucedido já
-- aparece através da linha existente de "proposta" (que já reage a
-- sent_at); só reenvios SUBSEQUENTES (versão corrigida, cópia após
-- decisão) ganham uma linha própria na timeline, porque não são
-- representados em nenhum outro lugar.

create type public.proposal_email_send_status as enum ('queued', 'accepted', 'failed');

create table public.proposal_email_sends (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  proposal_id uuid not null,
  document_id uuid not null,
  to_email text not null check (
    to_email = lower(btrim(to_email)) and to_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  requested_by uuid not null references auth.users (id) on delete restrict,
  requested_at timestamptz not null default now(),
  status public.proposal_email_send_status not null default 'queued',
  provider_message_id text,
  error_code text,
  resolved_at timestamptz,
  caused_status_transition boolean not null default false,
  idempotency_key uuid not null,
  constraint proposal_email_sends_proposal_same_workspace_fkey
    foreign key (workspace_id, proposal_id) references public.proposals (workspace_id, id) on delete cascade,
  constraint proposal_email_sends_document_same_workspace_fkey
    foreign key (workspace_id, document_id) references public.proposal_documents (workspace_id, id) on delete restrict,
  constraint proposal_email_sends_idempotency_key_key unique (idempotency_key),
  constraint proposal_email_sends_status_fields_consistent check (
    (status = 'queued' and provider_message_id is null and error_code is null and resolved_at is null)
    or (status = 'accepted' and provider_message_id is not null and error_code is null and resolved_at is not null)
    or (status = 'failed' and provider_message_id is null and resolved_at is not null)
  )
);

comment on table public.proposal_email_sends is
  'Envio real de proposta por e-mail (B1) — cada linha é uma intenção de envio, nunca sobrescrita. "accepted" significa que o Resend aceitou a mensagem, não que o cliente a recebeu (ver docs/decisoes/b1-propostas.md). Escrita de resultado (accepted/failed) só por service_role — não forjável por RPC de usuário autenticado.';

create index proposal_email_sends_workspace_id_idx on public.proposal_email_sends (workspace_id);
create index proposal_email_sends_proposal_id_idx on public.proposal_email_sends (workspace_id, proposal_id);
create index proposal_email_sends_document_id_idx on public.proposal_email_sends (document_id);

alter table public.proposal_email_sends enable row level security;
alter table public.proposal_email_sends force row level security;

create policy proposal_email_sends_select_deny on public.proposal_email_sends for select to authenticated using (false);
create policy proposal_email_sends_insert_deny on public.proposal_email_sends for insert to authenticated with check (false);
create policy proposal_email_sends_update_deny on public.proposal_email_sends for update to authenticated using (false);
create policy proposal_email_sends_delete_deny on public.proposal_email_sends for delete to authenticated using (false);

revoke all on table public.proposal_email_sends from public, anon, authenticated;
