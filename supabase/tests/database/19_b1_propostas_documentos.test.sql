-- pgTAP — B1: geração de PDF, versionamento e envio real de proposta.
--
-- Funcionalidade nova: não existe "defeito anterior" a reproduzir aqui —
-- cada asserção descreve a garantia que a fase promete (correções 1–7 do
-- desenho revisado da B1), não uma regressão histórica.
--
-- Funções de escrita (begin/finalize/fail_proposal_document,
-- queue/mark_proposal_email_sent/failed) são exclusivas do service_role —
-- chamadas aqui SEM troca de role (a conexão de teste já tem privilégio
-- total, mesmo padrão de claim_outbox_batch em 18_a11_*.test.sql); a prova
-- de que `authenticated` NÃO consegue chamá-las é feita à parte, com
-- `set local role authenticated` + `throws_ok(..., '42501', ...)`.

begin;
select plan(51);

-- Usuários fixos do seed (supabase/seed.sql, auth.users) — mesma
-- convenção de todo o resto da suíte pgTAP (cada arquivo roda isolado em
-- begin/rollback, então reaproveitar os mesmos ids entre arquivos nunca
-- colide).
\set dono    '20000000-0000-0000-0000-000000000001'
\set adv     '20000000-0000-0000-0000-000000000002'
\set adv2    '20000000-0000-0000-0000-000000000003'
\set vendas  '20000000-0000-0000-0000-000000000004'
\set leitor  '20000000-0000-0000-0000-000000000005'

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select (create_workspace_with_owner('Teste B1', 'teste-b1-propostas')).id as ws \gset
reset role;

insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws'::uuid, :'adv', 'lawyer', 'active'),
  (:'ws'::uuid, :'adv2', 'lawyer', 'active'),
  (:'ws'::uuid, :'vendas', 'sales', 'active'),
  (:'ws'::uuid, :'leitor', 'viewer', 'active');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select (create_contact(:'ws'::uuid, 'pf', 'Cliente B1', null, null, null)).id as contact \gset
select create_lead(:'ws'::uuid, (:'contact')::uuid, 'Trabalhista', 'Lead B1', '{}'::text[], 'media', :'adv'::uuid) as lead \gset
select create_opportunity(:'lead'::uuid) as opp \gset
select create_proposal(:'opp'::uuid, 500000, 'fixed') as proposal \gset
reset role;

-- ---------------------------------------------------------------------
-- 1) Grants — nada disto é chamável por anon/authenticated (correção 3)
-- ---------------------------------------------------------------------

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('proposal_documents', 'proposal_email_sends')
     and c.relrowsecurity and c.relforcerowsecurity),
  2, 'RLS habilitada E forçada em proposal_documents e proposal_email_sends'
);

select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('proposal_documents', 'proposal_email_sends')
     and grantee in ('anon', 'authenticated')),
  0, 'Nenhum privilégio de TABELA para anon/authenticated — tudo por função'
);

select is(
  (select count(*)::int
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   cross join (values ('anon'), ('authenticated')) r(role_name)
   where n.nspname = 'public'
     and p.proname in ('begin_proposal_document', 'finalize_proposal_document', 'fail_proposal_document',
                       'queue_proposal_email', 'mark_proposal_email_sent', 'mark_proposal_email_failed')
     and has_function_privilege(r.role_name, p.oid, 'EXECUTE')),
  0, 'anon/authenticated não têm EXECUTE em nenhuma função de escrita — não forjável por RPC (correção 3)'
);

select ok(
  has_function_privilege('service_role', 'public.begin_proposal_document(uuid, uuid)', 'EXECUTE'),
  'service_role tem EXECUTE em begin_proposal_document'
);

select ok(
  has_function_privilege('authenticated', 'public.list_proposal_documents(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.get_proposal_document_for_download(uuid)', 'EXECUTE'),
  'authenticated tem EXECUTE nas funções de LEITURA (projeção por papel resolve o resto)'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select throws_ok(
  $$select begin_proposal_document('00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid)$$,
  '42501', null,
  'Isolamento: authenticated não executa begin_proposal_document (permissão negada, exclusiva do service_role)'
);
reset role;

-- ---------------------------------------------------------------------
-- 2) begin → integridade contra storage.objects (correção 5)
-- ---------------------------------------------------------------------

select is(
  (select count(*)::int from public.proposal_documents where proposal_id = :'proposal'::uuid),
  0, 'Nenhum documento existe antes do primeiro begin'
);

select document_id, version, storage_path from begin_proposal_document(:'proposal'::uuid, :'dono'::uuid) \gset doc1_
select is(:'doc1_version'::int, 1, 'Primeira geração recebe versão 1');
select is(
  (select status from public.proposal_documents where id = :'doc1_document_id'::uuid),
  'pending', 'Documento nasce pending'
);

-- finalize SEM o objeto existir em storage.objects: nunca vira ready.
select throws_ok(
  format('select finalize_proposal_document(%L::uuid, %L, %s, %L::uuid)',
    :'doc1_document_id', repeat('a', 64), 100, :'dono'),
  'document_object_missing_or_size_mismatch',
  'finalize recusa marcar ready sem o arquivo existir no Storage (correção 5)'
);
select is(
  (select status from public.proposal_documents where id = :'doc1_document_id'::uuid),
  'pending', 'Documento continua pending após finalize recusado — nunca ready sem arquivo'
);

-- Simula o upload real (mesmo bucket/nome que begin reservou).
insert into storage.objects (bucket_id, name, metadata)
select 'proposal-documents', storage_path, jsonb_build_object('size', 12345)
from public.proposal_documents where id = :'doc1_document_id'::uuid;

select finalize_proposal_document(:'doc1_document_id'::uuid, repeat('a', 64), 12345, :'dono'::uuid);
select is(
  (select status from public.proposal_documents where id = :'doc1_document_id'::uuid),
  'ready', 'finalize confirma ready depois que o objeto existe com o tamanho certo'
);

-- Nunca sobrescreve um documento já ready (correção 5).
select throws_ok(
  format('select finalize_proposal_document(%L::uuid, %L, %s, %L::uuid)',
    :'doc1_document_id', repeat('b', 64), 999, :'dono'),
  'document_not_pending',
  'Uma segunda finalização da mesma linha é recusada — nunca sobrescreve checksum/tamanho'
);
select is(
  (select checksum_sha256 from public.proposal_documents where id = :'doc1_document_id'::uuid),
  repeat('a', 64), 'Checksum permanece o da primeira finalização, intocado'
);

-- ---------------------------------------------------------------------
-- 3) Versionamento — nunca sobrescreve, cada geração é uma linha nova
--    (correção 1)
-- ---------------------------------------------------------------------

select document_id, version, storage_path from begin_proposal_document(:'proposal'::uuid, :'dono'::uuid) \gset doc2_
select is(:'doc2_version'::int, 2, 'Segunda geração recebe versão 2, não reaproveita a 1');
select isnt(:'doc2_document_id'::uuid, :'doc1_document_id'::uuid, 'Versão 2 é uma linha nova, não a mesma da versão 1');

-- ---------------------------------------------------------------------
-- 4) Papel: geração/download exigem enxergar o valor exato — sales/
--    viewer ficam de fora (correção 4)
-- ---------------------------------------------------------------------

select throws_ok(
  format('select begin_proposal_document(%L::uuid, %L::uuid)', :'proposal', :'vendas'),
  'insufficient_permission',
  '`sales` não gera documento — só enxerga a faixa, o PDF carrega o valor exato'
);
select throws_ok(
  format('select begin_proposal_document(%L::uuid, %L::uuid)', :'proposal', :'leitor'),
  'insufficient_permission',
  '`viewer` não gera documento'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'vendas', 'role', 'authenticated')::text, true);
select is(
  (select bool_and((elem ->> 'canDownload')::boolean = false)
   from jsonb_array_elements(list_proposal_documents(:'proposal'::uuid)) elem),
  true, '`sales` lista os documentos (sabe que existem) mas nenhum vem com canDownload=true'
);
select throws_ok(
  format('select get_proposal_document_for_download(%L::uuid)', :'doc1_document_id'),
  'document_not_found',
  '`sales` não obtém storage_path — get_proposal_document_for_download recusa (nunca 403, sempre not_found)'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select ok(
  get_proposal_document_for_download(:'doc1_document_id'::uuid) ? 'storagePath',
  '`owner` obtém storagePath normalmente'
);
reset role;

-- advogado NÃO atribuído a este lead: lead_accessible_to_role bloqueia,
-- mesmo padrão de get_lead/get_proposal.
select throws_ok(
  format('select begin_proposal_document(%L::uuid, %L::uuid)', :'proposal', :'adv2'),
  'lead_not_found',
  'Advogado não atribuído ao lead não gera documento — alcance "seus + sem responsável" (A4/A5) vale aqui também'
);

-- ---------------------------------------------------------------------
-- 5) Envio real: identificação mínima do escritório e destinatário
--    conhecido (correção 6) — nada obrigatório além disso
-- ---------------------------------------------------------------------

select throws_ok(
  format('select queue_proposal_email(%L::uuid, %L::uuid, %L, gen_random_uuid(), %L::uuid)',
    :'proposal', :'doc1_document_id', 'cliente@example.com', :'dono'),
  'workspace_profile_incomplete',
  'Sem razão social preenchida, envio real é recusado (correção 6) — geração de PDF não foi afetada por isso'
);

update public.workspaces set legal_name = 'Escritório Teste B1' where id = :'ws'::uuid;

select throws_ok(
  format('select queue_proposal_email(%L::uuid, %L::uuid, %L, gen_random_uuid(), %L::uuid)',
    :'proposal', :'doc1_document_id', 'nao-cadastrado@example.com', :'dono'),
  'recipient_email_not_found',
  'Destinatário precisa ser um e-mail JÁ conhecido do contato — nunca texto livre (correção 6)'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select add_contact_email(:'contact'::uuid, 'cliente@example.com', true);
reset role;

-- ---------------------------------------------------------------------
-- 6) Idempotência do envio: mesma chave nunca cria uma segunda linha
--    (correção 1)
-- ---------------------------------------------------------------------

\set intent1 '30000000-0000-0000-0000-000000000001'

select send_id, status, is_new from queue_proposal_email(:'proposal'::uuid, :'doc1_document_id'::uuid, 'cliente@example.com', :'intent1'::uuid, :'dono'::uuid) \gset q1_
select is(:'q1_is_new'::boolean, true, 'Primeira chamada com esta chave cria a linha (is_new=true)');
select is(:'q1_status'::text, 'queued'::text, 'Linha nasce queued — clicar não é ter enviado (correção 5/2)');

select send_id, status, is_new from queue_proposal_email(:'proposal'::uuid, :'doc1_document_id'::uuid, 'cliente@example.com', :'intent1'::uuid, :'dono'::uuid) \gset q2_
select is(:'q2_is_new'::boolean, false, 'Repetir a MESMA chave nunca cria uma segunda linha (correção 1)');
select is(:'q2_send_id'::uuid, :'q1_send_id'::uuid, 'Repetir a mesma chave devolve o MESMO send_id');

select is(
  (select count(*)::int from public.proposal_email_sends where idempotency_key = :'intent1'::uuid),
  1, 'Só existe UMA linha para esta chave, mesmo com duas chamadas'
);

-- mark_proposal_email_sent/failed: exclusivo do service_role, "accepted"
-- nunca "sent"/"delivered" (correções 2 e 3).
set local role authenticated;
select throws_ok(
  format('select mark_proposal_email_sent(%L::uuid, %L)', :'q1_send_id', 'msg_falso'),
  '42501', null,
  'Isolamento: authenticated (mesmo sendo o autor do envio) não forja mark_proposal_email_sent'
);
select throws_ok(
  $$select mark_proposal_email_sent('00000000-0000-0000-0000-000000000000'::uuid, 'msg_falso')$$,
  '42501', null,
  'Isolamento: authenticated não executa mark_proposal_email_sent — não forjável por RPC (correção 3)'
);
reset role;

select mark_proposal_email_sent(:'q1_send_id'::uuid, 'resend_msg_id_1');
select is(
  (select status from public.proposal_email_sends where id = :'q1_send_id'::uuid),
  'accepted', 'Depois da confirmação do provedor, status vira accepted (nunca "sent"/"delivered")'
);
select is(
  (select caused_status_transition from public.proposal_email_sends where id = :'q1_send_id'::uuid),
  true, 'Primeiro envio bem-sucedido é marcado como responsável pela transição rascunho→enviada'
);
select is(
  (select status from public.proposals where id = :'proposal'::uuid),
  'enviada', 'proposals.status avança para enviada no primeiro envio real aceito'
);

-- Idempotente: chamar de novo não reescreve nem duplica efeito.
select mark_proposal_email_sent(:'q1_send_id'::uuid, 'outro_id_que_deveria_ser_ignorado');
select is(
  (select provider_message_id from public.proposal_email_sends where id = :'q1_send_id'::uuid),
  'resend_msg_id_1', 'Segunda chamada a mark_proposal_email_sent é no-op — não reescreve provider_message_id'
);

-- ---------------------------------------------------------------------
-- 7) Timeline: reenvio ganha linha própria, primeiro envio não duplica
--    (correção 7)
-- ---------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select items from get_lead_timeline(:'lead'::uuid, array['proposta'], null, null, 30) \gset tf1_
reset role;

select is(
  (select count(*)::int from jsonb_array_elements(:'tf1_items'::jsonb) e where e ->> 'event_type' = 'proposta'),
  1, 'Depois do PRIMEIRO envio, existe só UM evento "proposta" — nenhuma linha duplicada para o mesmo fato'
);

-- Segundo envio (reenvio de v1 já ready) — proposal já está 'enviada',
-- então NÃO deveria mexer em proposals.status de novo, e DEVE ganhar
-- linha própria na timeline (é fato novo, não representado em outro lugar).
\set intent2 '30000000-0000-0000-0000-000000000002'
select send_id, status, is_new from queue_proposal_email(:'proposal'::uuid, :'doc1_document_id'::uuid, 'cliente@example.com', :'intent2'::uuid, :'dono'::uuid) \gset q3_
select mark_proposal_email_sent(:'q3_send_id'::uuid, 'resend_msg_id_2');

select is(
  (select caused_status_transition from public.proposal_email_sends where id = :'q3_send_id'::uuid),
  false, 'Reenvio (proposta já enviada) NÃO é marcado como causador de transição'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select items from get_lead_timeline(:'lead'::uuid, array['proposta'], null, null, 30) \gset tf2_
reset role;

select is(
  (select count(*)::int from jsonb_array_elements(:'tf2_items'::jsonb) e where e ->> 'event_type' = 'proposta'),
  2, 'Depois do REENVIO, existem DOIS eventos "proposta": o original + o reenvio, sem duplicar o primeiro'
);

-- ---------------------------------------------------------------------
-- 8) Proposta decidida: versões antigas continuam, nenhuma versão nova
--    (correção 4 — revisão comercial é proposta nova, não reescrita)
-- ---------------------------------------------------------------------

-- `proposals` não tem GRANT de tabela nenhum para authenticated (mesmo
-- padrão de toda tabela de negócio desta base) — lock_version só é
-- lido aqui como superusuário de teste, antes de trocar de role.
select lock_version from public.proposals where id = :'proposal'::uuid \gset current_

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select decide_proposal(:'proposal'::uuid, :'current_lock_version'::bigint, 'aceita', null);
reset role;

select throws_ok(
  format('select begin_proposal_document(%L::uuid, %L::uuid)', :'proposal', :'dono'),
  'proposal_decided_no_new_document',
  'Depois de aceita, nenhuma versão nova de documento — revisão comercial é proposta nova (correção 4)'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select is(
  (select count(*)::int from jsonb_array_elements(list_proposal_documents(:'proposal'::uuid)) e),
  2, 'As duas versões já geradas (v1 ready, v2 pending) continuam listadas depois da decisão'
);
select ok(
  get_proposal_document_for_download(:'doc1_document_id'::uuid) ? 'storagePath',
  'v1, já ready antes da decisão, continua baixável depois de aceita — nada é revogado'
);
reset role;

-- ---------------------------------------------------------------------
-- 9) Perfil jurídico do escritório — GRANT de coluna (correção pós-
--    validação hospedada). Diferente do resto deste arquivo, ISTO
--    reproduz um defeito real: a policy `workspaces_update` (A2) nunca
--    teve o GRANT de tabela que a torna utilizável — `authenticated` só
--    tinha SELECT em `workspaces`. `updateWorkspaceLegalProfileAction`
--    (Configurações → Escritório) falhava com "permission denied for
--    table workspaces" em qualquer ambiente real, apesar de RLS e CI
--    verdes — só apareceu ao validar contra o banco hospedado com sessão
--    `authenticated` de verdade, não como superusuário de teste.
-- ---------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
update public.workspaces set
  legal_name = 'Escritório Teste B1 Ltda.',
  cnpj = '12345678000199',
  oab_uf = 'SP',
  oab_number = '999999',
  address_line = 'Rua de Teste, 1',
  address_city = 'São Paulo',
  address_uf = 'SP',
  address_zip = '01000000'
where id = :'ws'::uuid;
reset role;

select is(
  (select jsonb_build_object(
     'legal_name', legal_name, 'cnpj', cnpj, 'oab_uf', oab_uf, 'oab_number', oab_number,
     'address_line', address_line, 'address_city', address_city, 'address_uf', address_uf, 'address_zip', address_zip
   ) from public.workspaces where id = :'ws'::uuid),
  jsonb_build_object(
    'legal_name', 'Escritório Teste B1 Ltda.', 'cnpj', '12345678000199', 'oab_uf', 'SP', 'oab_number', '999999',
    'address_line', 'Rua de Teste, 1', 'address_city', 'São Paulo', 'address_uf', 'SP', 'address_zip', '01000000'
  ),
  '`owner`, autenticado, salva o perfil jurídico e lê exatamente os mesmos valores de volta'
);

-- Demais papéis do MESMO workspace (nenhum é owner/admin — regra de
-- workspace_legal_profile.manage em src/lib/roles.ts): RLS filtra a
-- linha, UPDATE afeta 0 linhas, sem exceção.
--
-- `with ... update ... returning` precisa ser o comando de MAIS ALTO
-- NÍVEL da instrução — Postgres recusa uma CTE de escrita aninhada dentro
-- do argumento de uma função (aqui, dentro de `is(...)`). Por isso cada
-- tentativa vira uma instrução própria, capturada por \gset, e só depois
-- comparada com `is()`.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'adv', 'role', 'authenticated')::text, true);
with upd as (update public.workspaces set legal_name = 'Tentativa Advogado' where id = :'ws'::uuid returning 1)
select count(*)::int as n from upd \gset lawyer_upd_
reset role;
select is(:'lawyer_upd_n'::int, 0, '`lawyer` não altera o perfil do escritório');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'adv2', 'role', 'authenticated')::text, true);
with upd as (update public.workspaces set legal_name = 'Tentativa Advogado 2' where id = :'ws'::uuid returning 1)
select count(*)::int as n from upd \gset lawyer2_upd_
reset role;
select is(:'lawyer2_upd_n'::int, 0, '`lawyer` (segundo, sem vínculo com o lead) também não altera o perfil do escritório');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'vendas', 'role', 'authenticated')::text, true);
with upd as (update public.workspaces set legal_name = 'Tentativa Vendas' where id = :'ws'::uuid returning 1)
select count(*)::int as n from upd \gset sales_upd_
reset role;
select is(:'sales_upd_n'::int, 0, '`sales` não altera o perfil do escritório');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'leitor', 'role', 'authenticated')::text, true);
with upd as (update public.workspaces set legal_name = 'Tentativa Viewer' where id = :'ws'::uuid returning 1)
select count(*)::int as n from upd \gset viewer_upd_
reset role;
select is(:'viewer_upd_n'::int, 0, '`viewer` não altera o perfil do escritório');

select is(
  (select legal_name from public.workspaces where id = :'ws'::uuid),
  'Escritório Teste B1 Ltda.', 'Nenhuma das 4 tentativas bloqueadas alterou o valor salvo pelo owner'
);

-- Isolamento entre workspaces: adv2 é OWNER de um segundo workspace, mas
-- isso não vaza nenhum poder sobre o workspace 1 — a policy avalia o
-- papel de adv2 DENTRO da linha alvo (ws), não em qualquer workspace.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'adv2', 'role', 'authenticated')::text, true);
select (create_workspace_with_owner('Teste B1 — Outro Workspace', 'teste-b1-outro-workspace')).id as ws2 \gset
with upd as (update public.workspaces set legal_name = 'Vazamento entre tenants' where id = :'ws'::uuid returning 1)
select count(*)::int as n from upd \gset isolation_upd_
reset role;
select is(:'isolation_upd_n'::int, 0, 'Isolamento: ser owner do workspace 2 não dá poder de alterar o perfil do workspace 1');

-- GRANT é só nas 8 colunas do perfil — name/slug/created_by continuam
-- inacessíveis a `authenticated`, mesmo para quem É owner/admin da linha.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select throws_ok(
  format('update public.workspaces set name = %L where id = %L::uuid', 'Nome Trocado', :'ws'),
  '42501', null,
  '`owner` não pode alterar workspaces.name diretamente — sem GRANT nessa coluna'
);
select throws_ok(
  format('update public.workspaces set slug = %L where id = %L::uuid', 'slug-trocado', :'ws'),
  '42501', null,
  '`owner` não pode alterar workspaces.slug diretamente — sem GRANT nessa coluna'
);
select throws_ok(
  format('update public.workspaces set created_by = %L::uuid where id = %L::uuid', :'adv', :'ws'),
  '42501', null,
  '`owner` não pode alterar workspaces.created_by diretamente — sem GRANT nessa coluna'
);
reset role;

select * from finish();
rollback;
