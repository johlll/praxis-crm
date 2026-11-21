-- Conversas + IA — painel do caso: DOCUMENTOS POR CASO.
--
-- Decisões em docs/decisoes/conversas-documentos-caso.md. Resumo:
--
--   - Um documento pertence à OPORTUNIDADE (o caso), nunca ao contato inteiro: dois casos do mesmo contato
--     têm documentos independentes. Não exige número interno, caso ganho nem roteiro.
--   - Arquivo no bucket PRIVADO `case-documents` (PDF, JPEG e PNG, até 10 MiB), sem NENHUMA policy de Storage
--     para anon/authenticated: o acesso passa só por estas funções (quem pode o quê) e pelo cliente de serviço
--     isolado do servidor (src/server/case-documents/admin/), como nas propostas (B1). O caminho do objeto é
--     gerado AQUI (`<escritório>/<caso>/<documento>`), nunca pelo navegador; o nome original é só exibição.
--   - Envio em duas fases: `begin_case_document` reserva a linha (pendente) e o caminho; o navegador sobe o
--     arquivo direto ao Storage com um link de envio para aquele caminho (sem sobrescrita); o servidor baixa o
--     objeto, confere a assinatura do conteúdo (PDF/JPEG/PNG — não é antivírus), calcula o hash e
--     `finalize_case_document` só torna o documento visível depois de conferir, no mesmo Postgres
--     (storage.objects), que o objeto existe com aquele tamanho. Falha → `abandon_case_document` apaga a linha
--     pendente; o objeto que tiver sobrado vai para a fila de limpeza (nunca fica órfão sem registro).
--   - Recebimento FECHADO até a ativação do backup dos documentos: `public.case_document_upload_gate`
--     nasce fechado e só abre com a referência do registro da ativação (etapa operacional futura, fora desta
--     migration). Fechado, `begin` e `finalize` recusam com `case_documents_upload_disabled`. O servidor tem uma
--     segunda trava (variável de ambiente, ausente = fechado). Nenhuma exceção por escritório.
--   - Conferência humana explícita: `recebido` (ao subir) → `conferido` ou `com_pendencia` (observação
--     obrigatória), com quem e quando; versão própria contra sobrescrita silenciosa. Não é aprovação jurídica.
--     Não toca andamento, roteiro, atendimento, etapa comercial, automações nem integrações.
--   - Remoção controlada em duas fases (motivo em código fechado, auditada): `begin_case_document_removal`
--     marca `removing` (some da lista para abrir), o servidor apaga o objeto e
--     `finalize_case_document_removal` só apaga a linha depois de conferir que o objeto saiu. Exclusão
--     administrativa (cascata do escritório/lead/caso) põe o caminho na fila de limpeza
--     (`case_document_storage_cleanup`), consumida pelo servidor.
--   - Permissões: leitura e abertura = quem enxerga o caso (visualizador incluído); envio = owner, admin,
--     manager, lawyer, sales; conferência e remoção = owner, admin, manager, lawyer. Alcance do lead e
--     escritório sempre conferidos aqui.
--   - Privacidade: exportação do titular com os METADADOS (sem o conteúdo dos arquivos); contato com documento
--     de caso não é anonimizado (`case_document_present`), como já acontece com o PDF de proposta — os
--     arquivos precisam ser removidos antes; depois da anonimização, nada novo entra.
--
-- Migration ADITIVA: bucket, tabelas novas deny-all, funções novas e `create or replace`, com a MESMA
-- assinatura, de private.privacy_export_payload (uma seção nova; as anteriores ficam iguais) e
-- private.privacy_retention_assess (um código de bloqueio a mais; o resto fica igual).

-- =====================================================================
-- 1) Bucket privado
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('case-documents', 'case-documents', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

-- =====================================================================
-- 2) Portão do recebimento (fechado por padrão)
-- =====================================================================

create table public.case_document_upload_gate (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  -- Referência do registro da ativação do backup dos documentos (obrigatória para abrir).
  backup_activation_ref text,
  changed_at timestamptz not null default now(),
  constraint case_document_upload_gate_ref check (
    not enabled or (backup_activation_ref is not null and char_length(btrim(backup_activation_ref)) between 1 and 200)
  )
);

comment on table public.case_document_upload_gate is
  'Documentos por caso: portão GLOBAL do recebimento de arquivos. Nasce fechado; abrir exige a referência do registro da ativação e do teste de recuperação do backup dos documentos (docs/decisoes/conversas-documentos-caso.md). Sem exceção por escritório.';

insert into public.case_document_upload_gate (singleton, enabled) values (true, false) on conflict do nothing;
-- Deny-all para os papéis de API (como as demais tabelas): só a operação (postgres) abre ou fecha.
alter table public.case_document_upload_gate enable row level security;
alter table public.case_document_upload_gate force row level security;
revoke all on table public.case_document_upload_gate from public, anon, authenticated, service_role;

create function private.case_document_upload_open()
returns boolean
language sql
stable
security definer
set search_path = ''
as $body$
  select coalesce((select g.enabled from public.case_document_upload_gate g where g.singleton), false);
$body$;

revoke all on function private.case_document_upload_open() from public, anon, authenticated, service_role;

-- =====================================================================
-- 3) Tabelas
-- =====================================================================

create table public.case_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  opportunity_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'ready', 'removing')),
  original_name text not null check (char_length(original_name) between 1 and 180),
  declared_type text not null check (declared_type in ('application/pdf', 'image/jpeg', 'image/png')),
  declared_size bigint not null check (declared_size between 1 and 10485760),
  -- Preenchidos na finalização, depois da conferência do conteúdo no servidor.
  content_type text check (content_type in ('application/pdf', 'image/jpeg', 'image/png')),
  byte_size bigint check (byte_size between 1 and 10485760),
  checksum_sha256 text check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text not null,
  review_status text not null default 'recebido' check (review_status in ('recebido', 'conferido', 'com_pendencia')),
  review_note text check (review_note is null or char_length(review_note) between 1 and 1000),
  reviewed_by uuid references auth.users (id) on delete restrict,
  reviewed_at timestamptz,
  review_version integer not null default 0 check (review_version >= 0),
  uploaded_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  finalized_at timestamptz,
  idempotency_key uuid not null,
  request_fingerprint text not null,
  removal_reason text check (removal_reason in ('enviado_por_engano', 'duplicado', 'arquivo_errado', 'solicitacao_do_titular', 'outro')),
  removal_requested_by uuid references auth.users (id) on delete restrict,
  removal_requested_at timestamptz,
  constraint case_documents_opportunity_fkey
    foreign key (workspace_id, opportunity_id) references public.opportunities (workspace_id, id) on delete cascade,
  constraint case_documents_idempotency_key unique (workspace_id, idempotency_key),
  constraint case_documents_storage_path_key unique (storage_path),
  constraint case_documents_storage_path_shape check (
    storage_path = workspace_id::text || '/' || opportunity_id::text || '/' || id::text
  ),
  constraint case_documents_ready_fields check (
    status = 'pending'
    or (content_type is not null and byte_size is not null and checksum_sha256 is not null and finalized_at is not null)
  ),
  constraint case_documents_ready_type check (content_type is null or content_type = declared_type),
  constraint case_documents_review_fields check (
    (review_status = 'recebido' and reviewed_by is null and reviewed_at is null and review_note is null)
    or (review_status = 'conferido' and reviewed_by is not null and reviewed_at is not null)
    or (review_status = 'com_pendencia' and reviewed_by is not null and reviewed_at is not null and review_note is not null)
  ),
  constraint case_documents_review_only_ready check (review_status = 'recebido' or status <> 'pending'),
  constraint case_documents_removal_fields check (
    (status = 'removing') = (removal_reason is not null and removal_requested_at is not null)
  )
);

create index case_documents_opportunity_idx on public.case_documents (opportunity_id, finalized_at desc, id desc);
create index case_documents_pending_idx on public.case_documents (created_at) where status in ('pending', 'removing');
create index case_documents_uploaded_by_idx on public.case_documents (uploaded_by);
create index case_documents_reviewed_by_idx on public.case_documents (reviewed_by) where reviewed_by is not null;
create index case_documents_removal_by_idx on public.case_documents (removal_requested_by) where removal_requested_by is not null;

comment on table public.case_documents is
  'Painel do caso: documentos recebidos de um caso (oportunidade). Arquivo no bucket privado case-documents; metadados, conferência humana (recebido/conferido/com pendência) e remoção controlada. Nunca do contato inteiro.';

alter table public.case_documents enable row level security;
alter table public.case_documents force row level security;
revoke all on table public.case_documents from public, anon, authenticated, service_role;

-- Fila de limpeza de objetos do Storage cuja linha deixou de existir (remoção interrompida, envio abandonado,
-- exclusão administrativa em cascata). Sem FK de propósito: sobrevive à exclusão do escritório.
create table public.case_document_storage_cleanup (
  id uuid primary key default gen_random_uuid(),
  bucket text not null default 'case-documents' check (bucket = 'case-documents'),
  storage_path text not null unique,
  workspace_id uuid not null,
  document_id uuid not null,
  reason text not null check (reason in ('remocao', 'envio_abandonado', 'exclusao')),
  enqueued_at timestamptz not null default clock_timestamp(),
  attempts integer not null default 0 check (attempts >= 0),
  claimed_until timestamptz
);

comment on table public.case_document_storage_cleanup is
  'Documentos por caso: objetos do Storage a apagar porque o registro saiu. Consumida pelo servidor (case_document_cleanup_claim/complete), que só tira a linha depois de conferir que o objeto não existe mais.';

alter table public.case_document_storage_cleanup enable row level security;
alter table public.case_document_storage_cleanup force row level security;
revoke all on table public.case_document_storage_cleanup from public, anon, authenticated, service_role;

-- =====================================================================
-- 4) Integridade
-- =====================================================================

create function private.case_document_object_exists(p_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $body$
  select exists (select 1 from storage.objects o where o.bucket_id = 'case-documents' and o.name = p_path);
$body$;

revoke all on function private.case_document_object_exists(text) from public, anon, authenticated, service_role;

-- Campos de identidade não mudam; transições de estado fechadas; depois da anonimização, nada novo entra.
create function private.case_document_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $body$
begin
  if tg_op = 'UPDATE' then
    if new.workspace_id <> old.workspace_id or new.opportunity_id <> old.opportunity_id
       or new.storage_path <> old.storage_path or new.uploaded_by <> old.uploaded_by
       or new.created_at <> old.created_at or new.original_name <> old.original_name
       or new.declared_type <> old.declared_type or new.declared_size <> old.declared_size
       or new.idempotency_key <> old.idempotency_key or new.request_fingerprint <> old.request_fingerprint then
      raise exception 'case_document_immutable';
    end if;
    if old.status = 'ready' and (new.content_type is distinct from old.content_type
       or new.byte_size is distinct from old.byte_size or new.checksum_sha256 is distinct from old.checksum_sha256
       or new.finalized_at is distinct from old.finalized_at) then
      raise exception 'case_document_immutable';
    end if;
    if not ((old.status = new.status)
            or (old.status = 'pending' and new.status = 'ready')
            or (old.status = 'ready' and new.status = 'removing')) then
      raise exception 'case_document_invalid_transition';
    end if;
  end if;
  if private.privacy_opportunity_anonymized(new.opportunity_id) then
    raise exception 'contact_anonymized';
  end if;
  return new;
end;
$body$;

revoke all on function private.case_document_guard() from public, anon, authenticated, service_role;

create trigger case_documents_guard before insert or update on public.case_documents
  for each row execute function private.case_document_guard();

-- Linha saiu e o objeto ainda existe (remoção ainda não concluída, envio abandonado, cascata administrativa):
-- o caminho vai para a fila de limpeza. Nunca um objeto sem registro em algum lugar.
create function private.case_document_enqueue_cleanup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $body$
begin
  if private.case_document_object_exists(old.storage_path) then
    insert into public.case_document_storage_cleanup (storage_path, workspace_id, document_id, reason)
    values (old.storage_path, old.workspace_id, old.id,
            case old.status when 'removing' then 'remocao' when 'pending' then 'envio_abandonado' else 'exclusao' end)
    on conflict (storage_path) do nothing;
  end if;
  return old;
end;
$body$;

revoke all on function private.case_document_enqueue_cleanup() from public, anon, authenticated, service_role;

create trigger case_documents_enqueue_cleanup after delete on public.case_documents
  for each row execute function private.case_document_enqueue_cleanup();

-- Defesa em profundidade: as duas entradas da anonimização avaliam antes (e a avaliação já bloqueia com
-- `case_document_present`), mas a marca do contato anonimizado nunca é gravada enquanto houver documento de caso.
-- A marca é a última escrita da anonimização: recusar aqui desfaz a operação inteira.
create function private.case_document_block_anonymization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $body$
begin
  if old.anonymized_at is null and new.anonymized_at is not null and exists (
    select 1
    from public.case_documents d
    join public.opportunities o on o.id = d.opportunity_id and o.workspace_id = d.workspace_id
    join public.leads l on l.id = o.lead_id and l.workspace_id = o.workspace_id
    where l.workspace_id = new.workspace_id and l.contact_id = new.id
  ) then
    raise exception 'case_document_present';
  end if;
  return new;
end;
$body$;

revoke all on function private.case_document_block_anonymization() from public, anon, authenticated, service_role;

create trigger contacts_case_documents_anonymization_guard before update of anonymized_at on public.contacts
  for each row execute function private.case_document_block_anonymization();

-- =====================================================================
-- 5) Alcance e projeção
-- =====================================================================

-- Oportunidade no alcance do ator (escritório + alcance do lead); fora do alcance/outro escritório/inexistente →
-- opportunity_not_found. Mesma regra das observações por caso.
create function private.case_document_target(p_opportunity_id uuid, p_actor uuid)
returns table (o_workspace_id uuid, o_opportunity_id uuid, o_role public.membership_role)
language plpgsql
stable
security definer
set search_path = ''
as $body$
begin
  return query select * from private.case_note_target(p_opportunity_id, p_actor);
end;
$body$;

revoke all on function private.case_document_target(uuid, uuid) from public, anon, authenticated, service_role;

-- Documento no alcance do ator (pelo caso). Fora do alcance → document_not_found.
create function private.case_document_for_actor(p_document_id uuid, p_actor uuid, p_lock boolean default false)
returns public.case_documents
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_doc public.case_documents;
  v_target record;
begin
  if p_actor is null then
    raise exception 'authentication_required';
  end if;
  if p_document_id is null then
    raise exception 'invalid_request';
  end if;
  if p_lock then
    select * into v_doc from public.case_documents where id = p_document_id for update;
  else
    select * into v_doc from public.case_documents where id = p_document_id;
  end if;
  if v_doc.id is null then
    raise exception 'document_not_found';
  end if;
  begin
    select * into v_target from private.case_note_target(v_doc.opportunity_id, p_actor);
  exception when others then
    raise exception 'document_not_found';
  end;
  return v_doc;
end;
$body$;

revoke all on function private.case_document_for_actor(uuid, uuid, boolean) from public, anon, authenticated, service_role;

create function private.case_document_actor_role(p_document public.case_documents, p_actor uuid)
returns public.membership_role
language sql
stable
security definer
set search_path = ''
as $body$
  select private.status_track_actor_role(p_document.workspace_id, p_actor);
$body$;

revoke all on function private.case_document_actor_role(public.case_documents, uuid) from public, anon, authenticated, service_role;

-- Projeção pública (sem caminho, hash nem chave): nome, tipo, tamanho, autor, data e conferência.
create function private.case_document_json(p_doc public.case_documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $body$
  select jsonb_build_object(
    'id', p_doc.id,
    'opportunity_id', p_doc.opportunity_id,
    'status', p_doc.status,
    'name', p_doc.original_name,
    'content_type', coalesce(p_doc.content_type, p_doc.declared_type),
    'byte_size', coalesce(p_doc.byte_size, p_doc.declared_size),
    'uploaded_by_name', private.user_display_name(p_doc.uploaded_by),
    'uploaded_at', coalesce(p_doc.finalized_at, p_doc.created_at),
    'review_status', p_doc.review_status,
    'review_note', p_doc.review_note,
    'reviewed_by_name', private.user_display_name(p_doc.reviewed_by),
    'reviewed_at', p_doc.reviewed_at,
    'review_version', p_doc.review_version,
    'removal_requested_at', p_doc.removal_requested_at
  );
$body$;

revoke all on function private.case_document_json(public.case_documents) from public, anon, authenticated, service_role;

-- Nome só para exibição: sem controles nem marcas de direção, sem caminho, espaços normalizados, até 180.
create function private.case_document_clean_name(p_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $body$
declare
  v text := coalesce(p_name, '');
begin
  v := regexp_replace(v, '^.*[/\\]', '');
  v := regexp_replace(v, '\s+', ' ', 'g');
  v := btrim(regexp_replace(v, '[\u0001-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]', '', 'g'));
  if char_length(v) > 180 then
    v := left(v, 180);
  end if;
  if v = '' or v in ('.', '..') then
    v := 'documento';
  end if;
  return v;
end;
$body$;

revoke all on function private.case_document_clean_name(text) from public, anon, authenticated, service_role;

-- =====================================================================
-- 6) Envio em duas fases (só service_role; o ATOR vem do servidor, que já conferiu a sessão)
-- =====================================================================

create function public.begin_case_document(
  p_opportunity_id uuid,
  p_actor_user_id uuid,
  p_name text,
  p_declared_type text,
  p_declared_size bigint,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_target record;
  v_name text;
  v_fp text;
  v_id uuid := gen_random_uuid();
  v_doc public.case_documents;
begin
  if not private.case_document_upload_open() then
    raise exception 'case_documents_upload_disabled';
  end if;
  select * into v_target from private.case_document_target(p_opportunity_id, p_actor_user_id);
  if v_target.o_role not in ('owner', 'admin', 'manager', 'lawyer', 'sales') then
    raise exception 'insufficient_permission';
  end if;
  if p_idempotency_key is null then
    raise exception 'invalid_request';
  end if;
  if p_declared_type is null or p_declared_type not in ('application/pdf', 'image/jpeg', 'image/png') then
    raise exception 'case_document_type_not_allowed';
  end if;
  if p_declared_size is null or p_declared_size < 1 then
    raise exception 'case_document_empty';
  end if;
  if p_declared_size > 10485760 then
    raise exception 'case_document_too_large';
  end if;

  -- Serializa com a anonimização (que trava a oportunidade FOR UPDATE): espera e relê.
  perform 1 from public.opportunities where id = p_opportunity_id for share;
  if private.privacy_opportunity_anonymized(p_opportunity_id) then
    raise exception 'contact_anonymized';
  end if;

  v_name := private.case_document_clean_name(p_name);
  v_fp := md5(concat_ws('|', p_opportunity_id, v_name, p_declared_type, p_declared_size));

  insert into public.case_documents (
    id, workspace_id, opportunity_id, original_name, declared_type, declared_size, storage_path,
    uploaded_by, idempotency_key, request_fingerprint)
  values (
    v_id, v_target.o_workspace_id, p_opportunity_id, v_name, p_declared_type, p_declared_size,
    v_target.o_workspace_id::text || '/' || p_opportunity_id::text || '/' || v_id::text,
    p_actor_user_id, p_idempotency_key, v_fp)
  on conflict (workspace_id, idempotency_key) do nothing
  returning * into v_doc;

  if v_doc.id is null then
    select * into v_doc from public.case_documents
    where workspace_id = v_target.o_workspace_id and idempotency_key = p_idempotency_key;
    if v_doc.id is null or v_doc.opportunity_id <> p_opportunity_id or v_doc.request_fingerprint <> v_fp
       or v_doc.uploaded_by <> p_actor_user_id then
      raise exception 'idempotency_conflict';
    end if;
    if v_doc.status = 'removing' then
      raise exception 'idempotency_conflict';
    end if;
    return jsonb_build_object('document_id', v_doc.id, 'storage_path', v_doc.storage_path,
                              'status', v_doc.status, 'replayed', true,
                              'document', private.case_document_json(v_doc));
  end if;

  return jsonb_build_object('document_id', v_doc.id, 'storage_path', v_doc.storage_path,
                            'status', v_doc.status, 'replayed', false,
                            'document', private.case_document_json(v_doc));
end;
$body$;

comment on function public.begin_case_document(uuid, uuid, text, text, bigint, uuid) is
  'Documentos por caso: reserva o envio (linha pendente + caminho gerado aqui). Só service_role; portão de recebimento, papel, alcance e anonimização conferidos. Idempotente por chave.';

revoke all on function public.begin_case_document(uuid, uuid, text, text, bigint, uuid) from public, anon, authenticated;
grant execute on function public.begin_case_document(uuid, uuid, text, text, bigint, uuid) to service_role;

create function public.finalize_case_document(
  p_document_id uuid,
  p_actor_user_id uuid,
  p_content_type text,
  p_byte_size bigint,
  p_checksum_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_doc public.case_documents;
begin
  if not private.case_document_upload_open() then
    raise exception 'case_documents_upload_disabled';
  end if;
  v_doc := private.case_document_for_actor(p_document_id, p_actor_user_id, true);
  if v_doc.uploaded_by <> p_actor_user_id then
    raise exception 'document_not_found';
  end if;
  if v_doc.status = 'ready' then
    -- Repetição da finalização: devolve o que já está gravado, sem trocar hash nem tamanho.
    if v_doc.checksum_sha256 = p_checksum_sha256 and v_doc.byte_size = p_byte_size then
      return private.case_document_json(v_doc) || jsonb_build_object('replayed', true);
    end if;
    raise exception 'document_not_pending';
  end if;
  if v_doc.status <> 'pending' then
    raise exception 'document_not_pending';
  end if;
  if p_content_type is null or p_content_type <> v_doc.declared_type then
    raise exception 'case_document_content_mismatch';
  end if;
  if p_byte_size is null or p_byte_size < 1 or p_byte_size > 10485760 then
    raise exception 'case_document_too_large';
  end if;
  if p_checksum_sha256 is null or p_checksum_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_request';
  end if;
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'case-documents' and o.name = v_doc.storage_path
      and coalesce((o.metadata ->> 'size')::bigint, -1) = p_byte_size
  ) then
    raise exception 'document_object_missing_or_size_mismatch';
  end if;

  update public.case_documents
  set status = 'ready', content_type = p_content_type, byte_size = p_byte_size,
      checksum_sha256 = p_checksum_sha256, finalized_at = clock_timestamp()
  where id = v_doc.id and status = 'pending'
  returning * into v_doc;

  -- Auditoria só com ids, tipo e tamanho — nunca o nome do arquivo.
  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_doc.workspace_id, p_actor_user_id, 'case_document.uploaded', 'opportunity', v_doc.opportunity_id,
          jsonb_build_object('document_id', v_doc.id, 'content_type', v_doc.content_type, 'byte_size', v_doc.byte_size));

  return private.case_document_json(v_doc) || jsonb_build_object('replayed', false);
end;
$body$;

comment on function public.finalize_case_document(uuid, uuid, text, bigint, text) is
  'Documentos por caso: torna o documento visível depois de conferir o objeto no Storage (mesmo tamanho) e o tipo detectado pelo servidor. Só service_role e só quem iniciou o envio.';

revoke all on function public.finalize_case_document(uuid, uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.finalize_case_document(uuid, uuid, text, bigint, text) to service_role;

-- Envio que falhou (arquivo inválido, upload interrompido): a linha PENDENTE sai; o objeto que existir vai
-- para a fila de limpeza (gatilho). Só quem iniciou. Idempotente: linha já ausente → false.
create function public.abandon_case_document(p_document_id uuid, p_actor_user_id uuid, p_error_code text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_doc public.case_documents;
begin
  if p_actor_user_id is null then
    raise exception 'authentication_required';
  end if;
  select * into v_doc from public.case_documents where id = p_document_id for update;
  if v_doc.id is null then
    return false;
  end if;
  if v_doc.uploaded_by <> p_actor_user_id or v_doc.status <> 'pending' then
    raise exception 'document_not_pending';
  end if;
  delete from public.case_documents where id = v_doc.id;
  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_doc.workspace_id, p_actor_user_id, 'case_document.upload_failed', 'opportunity', v_doc.opportunity_id,
          jsonb_build_object('document_id', v_doc.id,
                             'error_code', case when p_error_code ~ '^[a-z_]{1,60}$' then p_error_code else 'unknown' end));
  return true;
end;
$body$;

revoke all on function public.abandon_case_document(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.abandon_case_document(uuid, uuid, text) to service_role;

-- Envio do próprio ator ainda em andamento (ou recém-concluído): o servidor lê daqui o caminho e o tipo
-- declarado para conferir o conteúdo — nunca do navegador. Outro usuário, outro escritório ou fora do
-- alcance → document_not_found.
create function public.get_pending_case_document(p_document_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_doc public.case_documents;
begin
  v_doc := private.case_document_for_actor(p_document_id, v_actor, false);
  if v_doc.uploaded_by <> v_actor or v_doc.status not in ('pending', 'ready') then
    raise exception 'document_not_found';
  end if;
  return jsonb_build_object('storagePath', v_doc.storage_path, 'declaredType', v_doc.declared_type, 'status', v_doc.status);
end;
$body$;

revoke all on function public.get_pending_case_document(uuid) from public, anon;
grant execute on function public.get_pending_case_document(uuid) to authenticated;

-- =====================================================================
-- 7) Leitura (quem enxerga o caso)
-- =====================================================================

create function public.list_case_documents(p_opportunity_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_target record;
begin
  select * into v_target from private.case_document_target(p_opportunity_id, auth.uid());
  return jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(private.case_document_json(d) order by d.finalized_at desc nulls last, d.id desc)
      from public.case_documents d
      where d.workspace_id = v_target.o_workspace_id and d.opportunity_id = p_opportunity_id
        and d.status in ('ready', 'removing')
    ), '[]'::jsonb),
    'upload_gate_open', private.case_document_upload_open(),
    'role', v_target.o_role
  );
end;
$body$;

comment on function public.list_case_documents(uuid) is
  'Documentos por caso: documentos prontos (e os em remoção) do caso, do mais recente ao mais antigo, e se o portão de recebimento está aberto. Quem enxerga o caso lê.';

revoke all on function public.list_case_documents(uuid) from public, anon;
grant execute on function public.list_case_documents(uuid) to authenticated;

-- Caminho para o link temporário de abertura/download (60 s, gerado pelo servidor). Só documento pronto.
create function public.get_case_document_for_download(p_document_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_doc public.case_documents;
begin
  v_doc := private.case_document_for_actor(p_document_id, auth.uid(), false);
  if v_doc.status <> 'ready' then
    raise exception 'document_not_found';
  end if;
  return jsonb_build_object('storagePath', v_doc.storage_path, 'name', v_doc.original_name, 'contentType', v_doc.content_type);
end;
$body$;

revoke all on function public.get_case_document_for_download(uuid) from public, anon;
grant execute on function public.get_case_document_for_download(uuid) to authenticated;

-- =====================================================================
-- 8) Conferência humana (owner, admin, manager, lawyer), com versão contra sobrescrita silenciosa
-- =====================================================================

create function public.set_case_document_review(
  p_document_id uuid,
  p_review_status text,
  p_note text,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_doc public.case_documents;
  v_role public.membership_role;
  v_note text;
  v_from text;
begin
  v_doc := private.case_document_for_actor(p_document_id, v_actor, true);
  v_role := private.case_document_actor_role(v_doc, v_actor);
  if v_role not in ('owner', 'admin', 'manager', 'lawyer') then
    raise exception 'insufficient_permission';
  end if;
  if v_doc.status <> 'ready' then
    raise exception 'document_not_found';
  end if;
  if p_review_status is null or p_review_status not in ('recebido', 'conferido', 'com_pendencia') then
    raise exception 'invalid_request';
  end if;
  if p_expected_version is null or p_expected_version <> v_doc.review_version then
    raise exception 'case_document_review_conflict';
  end if;

  v_note := nullif(btrim(replace(coalesce(p_note, ''), E'\r\n', E'\n'), E' \t\n\r'), '');
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception 'case_document_note_too_long';
  end if;
  if p_review_status = 'com_pendencia' and v_note is null then
    raise exception 'case_document_note_required';
  end if;
  if p_review_status = 'recebido' then
    v_note := null;
  end if;

  v_from := v_doc.review_status;
  update public.case_documents
  set review_status = p_review_status,
      review_note = v_note,
      reviewed_by = case when p_review_status = 'recebido' then null else v_actor end,
      reviewed_at = case when p_review_status = 'recebido' then null else clock_timestamp() end,
      review_version = review_version + 1
  where id = v_doc.id
  returning * into v_doc;

  -- Auditoria só com códigos — a observação da pendência não entra.
  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_doc.workspace_id, v_actor, 'case_document.reviewed', 'opportunity', v_doc.opportunity_id,
          jsonb_build_object('document_id', v_doc.id, 'from', v_from, 'to', v_doc.review_status,
                             'has_note', v_doc.review_note is not null));

  return private.case_document_json(v_doc);
end;
$body$;

comment on function public.set_case_document_review(uuid, text, text, integer) is
  'Documentos por caso: registra a conferência humana (recebido/conferido/com pendência), com quem e quando. Versão obrigatória: duas conferências simultâneas nunca se sobrescrevem em silêncio. Não é aprovação jurídica e não altera andamento, roteiro, atendimento nem etapa.';

revoke all on function public.set_case_document_review(uuid, text, text, integer) from public, anon;
grant execute on function public.set_case_document_review(uuid, text, text, integer) to authenticated;

-- =====================================================================
-- 9) Remoção controlada em duas fases (só service_role)
-- =====================================================================

create function public.begin_case_document_removal(p_document_id uuid, p_actor_user_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_doc public.case_documents;
  v_role public.membership_role;
begin
  v_doc := private.case_document_for_actor(p_document_id, p_actor_user_id, true);
  v_role := private.case_document_actor_role(v_doc, p_actor_user_id);
  if v_role not in ('owner', 'admin', 'manager', 'lawyer') then
    raise exception 'insufficient_permission';
  end if;
  if p_reason is null or p_reason not in ('enviado_por_engano', 'duplicado', 'arquivo_errado', 'solicitacao_do_titular', 'outro') then
    raise exception 'invalid_request';
  end if;
  if v_doc.status = 'removing' then
    -- Retomada de uma remoção interrompida: mesmo caminho, motivo original preservado.
    return jsonb_build_object('document_id', v_doc.id, 'storage_path', v_doc.storage_path, 'replayed', true);
  end if;
  if v_doc.status <> 'ready' then
    raise exception 'document_not_found';
  end if;

  update public.case_documents
  set status = 'removing', removal_reason = p_reason, removal_requested_by = p_actor_user_id,
      removal_requested_at = clock_timestamp()
  where id = v_doc.id
  returning * into v_doc;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_doc.workspace_id, p_actor_user_id, 'case_document.removal_requested', 'opportunity', v_doc.opportunity_id,
          jsonb_build_object('document_id', v_doc.id, 'reason', p_reason));

  return jsonb_build_object('document_id', v_doc.id, 'storage_path', v_doc.storage_path, 'replayed', false);
end;
$body$;

revoke all on function public.begin_case_document_removal(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.begin_case_document_removal(uuid, uuid, text) to service_role;

-- Só apaga a linha se o objeto já saiu do Storage; senão recusa (a remoção fica pendente e visível).
-- Ator nulo = conclusão pelo processamento da fila (sistema).
create function public.finalize_case_document_removal(p_document_id uuid, p_actor_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_doc public.case_documents;
begin
  select * into v_doc from public.case_documents where id = p_document_id for update;
  if v_doc.id is null then
    return false;
  end if;
  if p_actor_user_id is not null then
    v_doc := private.case_document_for_actor(p_document_id, p_actor_user_id, true);
  end if;
  if v_doc.status <> 'removing' then
    raise exception 'document_not_removing';
  end if;
  if private.case_document_object_exists(v_doc.storage_path) then
    raise exception 'storage_object_still_present';
  end if;
  delete from public.case_documents where id = v_doc.id;
  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_doc.workspace_id, p_actor_user_id, 'case_document.removed', 'opportunity', v_doc.opportunity_id,
          jsonb_build_object('document_id', v_doc.id, 'reason', v_doc.removal_reason,
                             'content_type', v_doc.content_type, 'byte_size', v_doc.byte_size));
  return true;
end;
$body$;

revoke all on function public.finalize_case_document_removal(uuid, uuid) from public, anon, authenticated;
grant execute on function public.finalize_case_document_removal(uuid, uuid) to service_role;

-- =====================================================================
-- 10) Limpeza (só service_role): envios abandonados, remoções interrompidas e a fila
-- =====================================================================

-- Pendências de envio com mais de 3 horas (o link de envio do Storage vale 2 horas) saem; o gatilho põe o
-- objeto que existir na fila. Devolve até p_limit itens a processar, reservados por 5 minutos
-- (dois processadores nunca pegam o mesmo).
create function public.case_document_cleanup_claim(p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 100));
  v_removals jsonb;
  v_queue jsonb;
begin
  delete from public.case_documents d
  where d.id in (
    select x.id from public.case_documents x
    where x.status = 'pending' and x.created_at < clock_timestamp() - interval '3 hours'
    order by x.created_at
    limit v_limit
    for update skip locked
  );

  with picked as (
    select x.id from public.case_documents x
    where x.status = 'removing' and x.removal_requested_at < clock_timestamp() - interval '2 minutes'
    order by x.removal_requested_at
    limit v_limit
    for update skip locked
  )
  select coalesce(jsonb_agg(jsonb_build_object('document_id', d.id, 'storage_path', d.storage_path)), '[]'::jsonb)
    into v_removals
  from public.case_documents d where d.id in (select id from picked);

  with picked as (
    select q.id from public.case_document_storage_cleanup q
    where q.claimed_until is null or q.claimed_until < clock_timestamp()
    order by q.enqueued_at
    limit v_limit
    for update skip locked
  ), upd as (
    update public.case_document_storage_cleanup q
    set claimed_until = clock_timestamp() + interval '5 minutes', attempts = q.attempts + 1
    where q.id in (select id from picked)
    returning q.id, q.storage_path
  )
  select coalesce(jsonb_agg(jsonb_build_object('cleanup_id', u.id, 'storage_path', u.storage_path)), '[]'::jsonb)
    into v_queue
  from upd u;

  return jsonb_build_object('removals', v_removals, 'objects', v_queue);
end;
$body$;

revoke all on function public.case_document_cleanup_claim(integer) from public, anon, authenticated;
grant execute on function public.case_document_cleanup_claim(integer) to service_role;

-- Tira da fila só se o objeto já não existe. Devolve se saiu.
create function public.case_document_cleanup_complete(p_cleanup_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_row public.case_document_storage_cleanup;
begin
  select * into v_row from public.case_document_storage_cleanup where id = p_cleanup_id for update;
  if v_row.id is null then
    return true;
  end if;
  if private.case_document_object_exists(v_row.storage_path) then
    update public.case_document_storage_cleanup set claimed_until = null where id = v_row.id;
    return false;
  end if;
  delete from public.case_document_storage_cleanup where id = v_row.id;
  return true;
end;
$body$;

revoke all on function public.case_document_cleanup_complete(uuid) from public, anon, authenticated;
grant execute on function public.case_document_cleanup_complete(uuid) to service_role;

-- =====================================================================
-- 11) Exportação do titular (C3a): seção `case_documents`, só os metadados
--
-- `create or replace` com a mesma assinatura; todas as seções anteriores ficam iguais (conferido pelo script
-- de atualização).
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
    -- Observações por caso: só a existência (id, caso, data), como lead_notes — o texto livre interno
    -- e o autor (usuário interno) ficam fora do arquivo automático.
    'case_notes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'opportunity_id', x.opportunity_id, 'created_at', x.created_at)
        order by x.created_at, x.id)
      from public.case_notes x where x.workspace_id = p_workspace_id and x.opportunity_id in (select id from o)
    ), '[]'::jsonb),
    -- Documentos por caso: só os METADADOS (nome, tipo, tamanho, situação, conferência e datas). O conteúdo dos
    -- arquivos NÃO entra no arquivo de exportação (file_content_included = false), nem a observação interna da
    -- conferência nem quem enviou/conferiu (usuários internos).
    'case_documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'opportunity_id', x.opportunity_id, 'name', x.original_name,
        'content_type', coalesce(x.content_type, x.declared_type),
        'byte_size', coalesce(x.byte_size, x.declared_size),
        'status', x.status, 'review_status', x.review_status,
        'uploaded_at', coalesce(x.finalized_at, x.created_at), 'reviewed_at', x.reviewed_at,
        'file_content_included', false)
        order by x.created_at, x.id)
      from public.case_documents x where x.workspace_id = p_workspace_id and x.opportunity_id in (select id from o)
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

revoke all on function private.privacy_export_payload(uuid, uuid) from public, anon, authenticated, service_role;

-- =====================================================================
-- 12) Anonimização (C3b): contato com documento de caso fica bloqueado (`case_document_present`)
--
-- `create or replace` com a mesma assinatura; só o bloqueio novo foi acrescentado. A anonimização em si não
-- muda: como ela reavalia sob trava e recusa com qualquer código, nunca apaga documento por conta própria.
-- =====================================================================

create or replace function private.privacy_retention_assess(p_workspace_id uuid, p_contact_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_c public.contacts;
  v_total integer;
  v_archived integer;
  v_last timestamptz;
  v_due timestamptz;
  v_reasons text[] := '{}';
  v_lead_ids uuid[];
  v_opp_ids uuid[];
  v_activity_ids uuid[];
  v_proposal_ids uuid[];
  v_conv_ids uuid[];
  v_identity_ids uuid[];
begin
  select * into v_c from public.contacts
  where id = p_contact_id and workspace_id = p_workspace_id and merged_into_contact_id is null;
  if v_c.id is null then return null; end if;

  if v_c.anonymized_at is not null then
    return jsonb_build_object(
      'state', 'anonymized', 'eligible', false, 'reasons', '[]'::jsonb,
      'lead_count', 0, 'archived_lead_count', 0, 'retention_due_at', null, 'anonymized_at', v_c.anonymized_at);
  end if;

  select count(*), count(*) filter (where status = 'arquivado' and archived_at is not null),
         max(archived_at) filter (where status = 'arquivado'),
         coalesce(array_agg(id), '{}'::uuid[])
    into v_total, v_archived, v_last, v_lead_ids
  from public.leads where workspace_id = p_workspace_id and contact_id = p_contact_id;

  select coalesce(array_agg(id), '{}'::uuid[]) into v_opp_ids
  from public.opportunities where workspace_id = p_workspace_id and lead_id = any(v_lead_ids);
  select coalesce(array_agg(id), '{}'::uuid[]) into v_activity_ids
  from public.activities where workspace_id = p_workspace_id and lead_id = any(v_lead_ids);
  select coalesce(array_agg(id), '{}'::uuid[]) into v_proposal_ids
  from public.proposals
  where workspace_id = p_workspace_id and (lead_id = any(v_lead_ids) or opportunity_id = any(v_opp_ids));
  select coalesce(array_agg(id), '{}'::uuid[]), coalesce(array_agg(identity_id), '{}'::uuid[])
    into v_conv_ids, v_identity_ids
  from public.conversations
  where workspace_id = p_workspace_id
    and (contact_id = p_contact_id or lead_id = any(v_lead_ids) or opportunity_id = any(v_opp_ids));

  if v_total = 0 then
    v_reasons := array_append(v_reasons, 'no_lead');
  elsif v_archived < v_total then
    v_reasons := array_append(v_reasons, 'active_lead');
  else
    -- Todos arquivados: o prazo conta do marco MAIS RECENTE, e só vence com 12 meses completos.
    v_due := ((v_last at time zone 'UTC') + private.privacy_retention_interval()) at time zone 'UTC';
    if now() < v_due then v_reasons := array_append(v_reasons, 'retention_period_open'); end if;
  end if;

  if exists (select 1 from public.clients where workspace_id = p_workspace_id and contact_id = p_contact_id) then
    v_reasons := array_append(v_reasons, 'client_present');
  end if;
  if exists (
    select 1 from public.opportunities
    where workspace_id = p_workspace_id and id = any(v_opp_ids) and status in ('open', 'won')
  ) then
    v_reasons := array_append(v_reasons, 'open_or_won_opportunity');
  end if;
  -- Proposta enviada ou aceita é processo comercial sem desfecho: não se anonimiza no meio dele.
  if exists (
    select 1 from public.proposals
    where workspace_id = p_workspace_id and id = any(v_proposal_ids) and status in ('enviada', 'aceita')
  ) then
    v_reasons := array_append(v_reasons, 'open_proposal');
  end if;
  if exists (
    select 1 from public.privacy_legal_holds
    where workspace_id = p_workspace_id and contact_id = p_contact_id and status = 'active'
  ) then
    v_reasons := array_append(v_reasons, 'legal_hold_active');
  end if;
  -- Contato absorvido por mesclagem ou histórico de mesclagem: as linhas do outro contato
  -- guardam dado pessoal que esta operação não trata.
  if exists (select 1 from public.contacts where workspace_id = p_workspace_id and merged_into_contact_id = p_contact_id)
     or exists (
       select 1 from public.contact_merges
       where workspace_id = p_workspace_id and (kept_contact_id = p_contact_id or merged_contact_id = p_contact_id)
     ) then
    v_reasons := array_append(v_reasons, 'merge_history_present');
  end if;
  -- PDFs e e-mails de proposta moram em armazenamento externo: nada de apagar fora da transação.
  if exists (
    select 1 from public.proposal_documents where workspace_id = p_workspace_id and proposal_id = any(v_proposal_ids)
  ) then
    v_reasons := array_append(v_reasons, 'proposal_document_present');
  end if;
  -- Documentos de caso moram no Storage: nada de apagar fora da transação. Precisam ser removidos antes
  -- (remoção controlada), como os PDFs de proposta exigem revisão humana. Qualquer estado conta (até o envio
  -- em andamento e a remoção ainda não concluída).
  if exists (
    select 1 from public.case_documents where workspace_id = p_workspace_id and opportunity_id = any(v_opp_ids)
  ) then
    v_reasons := array_append(v_reasons, 'case_document_present');
  end if;
  -- Evento de agenda no Google guarda o título da atividade fora do banco.
  if exists (
    select 1 from public.calendar_event_links where workspace_id = p_workspace_id and activity_id = any(v_activity_ids)
  ) or exists (
    select 1 from public.calendar_effect_intents where workspace_id = p_workspace_id and activity_id = any(v_activity_ids)
  ) then
    v_reasons := array_append(v_reasons, 'calendar_link_present');
  end if;
  -- Mensagem de saída ainda em andamento: apagá-la silenciosamente perderia um envio.
  if exists (
    select 1 from public.whatsapp_outbox
    where workspace_id = p_workspace_id and conversation_id = any(v_conv_ids) and state in ('reserved', 'sending', 'uncertain')
  ) then
    v_reasons := array_append(v_reasons, 'pending_outbound_message');
  end if;
  -- Conversa de WhatsApp que só se acha pelo telefone (sem vínculo com o contato, lead ou
  -- oportunidade): pode ser da mesma pessoa, mas apagá-la seria inferência. Revisão humana.
  if private.privacy_unlinked_whatsapp(
    p_workspace_id, private.privacy_contact_phone_keys(p_workspace_id, p_contact_id), v_conv_ids, v_identity_ids
  ) then
    v_reasons := array_append(v_reasons, 'unlinked_whatsapp_conversation');
  end if;

  return jsonb_build_object(
    'state', case when cardinality(v_reasons) = 0 then 'eligible' else 'blocked' end,
    'eligible', cardinality(v_reasons) = 0,
    'reasons', to_jsonb(v_reasons),
    'lead_count', v_total,
    'archived_lead_count', v_archived,
    'retention_due_at', v_due,
    'anonymized_at', null);
end;
$body$;

revoke all on function private.privacy_retention_assess(uuid, uuid) from public, anon, authenticated, service_role;
