-- pgTAP — A11: ingestão pública, outbox, worker, atribuição e retenção.
--
-- Escritório criado DENTRO desta transação (now() congelado), com
-- resultados esperados conhecidos. Nada depende do seed.
--
-- Funcionalidade nova: não existe "defeito anterior" a reproduzir aqui —
-- cada asserção descreve a garantia que a fase promete, não uma
-- regressão histórica inventada.

begin;
select plan(127);

\set otavio '20000000-0000-0000-0000-000000000014'
\set lucas  '20000000-0000-0000-0000-000000000011'
\set sofia  '20000000-0000-0000-0000-000000000012'

-- -----------------------------------------------------------------
-- Setup
-- -----------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select (create_workspace_with_owner('Teste A11', 'teste-a11-formularios')).id as ws \gset
reset role;

insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws'::uuid, :'lucas', 'lawyer', 'active'),
  (:'ws'::uuid, :'sofia', 'sales', 'active');

select id as pipeline from public.pipelines where workspace_id = :'ws'::uuid and is_default \gset
select id as stage0 from public.pipeline_stages where pipeline_id = :'pipeline'::uuid and position = 0 \gset
select id as stage1 from public.pipeline_stages where pipeline_id = :'pipeline'::uuid and position = 1 \gset

-- Etapa terminal, para provar que ela é recusada como etapa inicial.
update public.pipeline_stages set is_won = true
where pipeline_id = :'pipeline'::uuid and position = 7;
select id as stage_won from public.pipeline_stages where pipeline_id = :'pipeline'::uuid and position = 7 \gset

-- -----------------------------------------------------------------
-- 1) RLS forçada e grants mínimos nas tabelas novas
-- -----------------------------------------------------------------

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('form_endpoints','form_endpoint_keys','webhook_events','outbox',
                       'touchpoints','touchpoint_demand_links','continuity_references','consent_evidence')
     and c.relrowsecurity and c.relforcerowsecurity),
  8, 'RLS habilitada E forçada nas oito tabelas novas'
);

select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('form_endpoints','form_endpoint_keys','webhook_events','outbox',
                        'touchpoints','touchpoint_demand_links','continuity_references','consent_evidence')
     and grantee in ('anon','authenticated')),
  0, 'Nenhum privilégio de tabela para anon/authenticated: tudo passa por função'
);

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('ingest_form_event','process_form_event','resolve_form_endpoint',
                       'claim_outbox_batch','purge_expired_webhook_events','get_webhook_event_payload')
     and (not p.prosecdef
          or not exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg where cfg like 'search_path=%'))),
  0, 'Funções de ingestão são SECURITY DEFINER com search_path travado'
);

-- O Supabase concede EXECUTE a anon e authenticated em toda função nova
-- do schema public; `revoke ... from public` não retira essas concessões.
-- As funções de ingestão, fila, payload e retenção são exclusivas do
-- service_role (rota pública e jobs), e nenhuma função da A11 é de anon.
select is(
  (select count(*)::int
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   cross join (values ('anon'), ('authenticated')) r(role_name)
   where n.nspname = 'public'
     and p.proname in ('ingest_form_event','process_form_event','resolve_form_endpoint',
                       'claim_outbox_batch','mark_outbox_published','mark_outbox_failed',
                       'mark_webhook_event_failed','get_webhook_event_payload',
                       'purge_expired_webhook_events','flag_stuck_webhook_events',
                       'flag_expiring_webhook_events')
     and has_function_privilege(r.role_name, p.oid, 'EXECUTE')),
  0, 'anon e authenticated NÃO chamam ingestão, fila, payload nem retenção (pulariam Turnstile e rate limit)'
);

select is(
  (select count(*)::int
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('create_form_endpoint','update_form_endpoint','set_form_endpoint_status',
                       'rotate_form_endpoint_key','list_form_endpoints','correct_touchpoint_demand_link',
                       'get_lead_attribution','get_dashboard_attribution')
     and has_function_privilege('anon', p.oid, 'EXECUTE')),
  0, 'anon não chama nenhuma função de configuração ou atribuição'
);

-- -----------------------------------------------------------------
-- 2) Configuração do endpoint
-- -----------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);

select throws_ok(
  format($$select create_form_endpoint(%L::uuid, 'Terminal', %L::uuid, %L::uuid, 'Cível', 'call', 60,
           'new_intake', 'formulario', array['exemplo.test'], 'chave-etapa-terminal-aaaaaaaa')$$,
         :'ws', :'pipeline', :'stage_won'),
  'stage_is_terminal',
  'Etapa de ganho é recusada como etapa inicial do formulário'
);

select create_form_endpoint(
  :'ws'::uuid, 'Captação site', :'pipeline'::uuid, :'stage0'::uuid, 'Trabalhista',
  'call', 60, 'new_intake', 'formulario', array['exemplo.test'], 'chave-publica-aaaaaaaaaaaa'
) as created \gset

reset role;
select id as endpoint from public.form_endpoints where workspace_id = :'ws'::uuid \gset

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'sofia', 'role', 'authenticated')::text, true);
select throws_ok(
  format($$select set_form_endpoint_status(%L::uuid, 'disabled')$$, :'endpoint'),
  'insufficient_permission',
  'Atendimento não configura endpoint (owner/admin apenas)'
);
reset role;

select isnt(
  (select resolve_form_endpoint('chave-publica-aaaaaaaaaaaa')), null,
  'Chave ativa resolve o endpoint'
);
select is(
  (select resolve_form_endpoint('chave-que-nao-existe-aaaa')), null,
  'Chave inexistente devolve NULL (a rota traduz no mesmo erro genérico)'
);

-- -----------------------------------------------------------------
-- 3) Ingestão e idempotência
-- -----------------------------------------------------------------

reset role;
\set uuid1 'aaaaaaaa-0000-4000-8000-000000000001'
-- Hashes de 32 bytes montados em SQL: dentro de um set do psql a barra
-- invertida seguida de x11 vira escape e o valor ficaria com 33 bytes.
select decode(repeat('11', 32), 'hex') as hash1, decode(repeat('22', 32), 'hex') as hash2 \gset

select ingest_form_event(
  :'endpoint'::uuid, :'uuid1'::uuid, :'hash1'::bytea, 'proto-aaaaaaaaaaaaaaaa',
  '\xdeadbeef'::bytea, '\x000000000000000000000000'::bytea, '\x00000000000000000000000000000000'::bytea,
  'aes-256-gcm', '1', '{"answers_count": 2}'::jsonb, now()
) as ing1 \gset

select is((:'ing1'::jsonb ->> 'created')::boolean, true, 'Primeira ingestão cria o evento');

select ingest_form_event(
  :'endpoint'::uuid, :'uuid1'::uuid, :'hash1'::bytea, 'proto-OUTRO-PROTOCOLO',
  '\xdeadbeef'::bytea, '\x000000000000000000000000'::bytea, '\x00000000000000000000000000000000'::bytea,
  'aes-256-gcm', '1', '{"answers_count": 2}'::jsonb, now()
) as ing2 \gset

select is((:'ing2'::jsonb ->> 'created')::boolean, false,
  'Mesma chave + mesmo hash: NÃO cria evento novo');
select is(:'ing2'::jsonb ->> 'protocol', :'ing1'::jsonb ->> 'protocol',
  'Repetição devolve o MESMO protocolo (resposta pública idêntica)');

select is(
  (select count(*)::int from public.outbox o
   join public.webhook_events w on w.id = o.webhook_event_id
   where w.source_event_id = :'uuid1'::uuid),
  1, 'Repetição não enfileira segunda outbox: um evento, uma outbox'
);

select throws_ok(
  format($$select ingest_form_event(%L::uuid, %L::uuid, %L::bytea, 'proto-conflito-aaaaaaa',
           '\xdeadbeef'::bytea, '\x000000000000000000000000'::bytea,
           '\x00000000000000000000000000000000'::bytea, 'aes-256-gcm', '1', '{}'::jsonb, now())$$,
         :'endpoint', :'uuid1', :'hash2'),
  'idempotency_payload_conflict',
  'Mesma chave com conteúdo DIFERENTE é recusada'
);

-- Normalização temporal (contrato §3).
select ingest_form_event(
  :'endpoint'::uuid, 'aaaaaaaa-0000-4000-8000-000000000002'::uuid, :'hash1'::bytea, 'proto-futuro-aaaaaaaa',
  '\xde'::bytea, '\x000000000000000000000000'::bytea, '\x00000000000000000000000000000000'::bytea,
  'aes-256-gcm', '1', '{}'::jsonb, now() + interval '2 hours'
);
select is(
  (select normalization_code from public.webhook_events
   where source_event_id = 'aaaaaaaa-0000-4000-8000-000000000002'::uuid),
  'future_clamped', 'Data muito no futuro é normalizada para o recebimento'
);
select ok(
  (select normalized_occurred_at <= received_at from public.webhook_events
   where source_event_id = 'aaaaaaaa-0000-4000-8000-000000000002'::uuid),
  'Data normalizada nunca fica à frente do recebimento'
);

select ingest_form_event(
  :'endpoint'::uuid, 'aaaaaaaa-0000-4000-8000-000000000003'::uuid, :'hash1'::bytea, 'proto-velho-aaaaaaaaa',
  '\xde'::bytea, '\x000000000000000000000000'::bytea, '\x00000000000000000000000000000000'::bytea,
  'aes-256-gcm', '1', '{}'::jsonb, now() - interval '3 days'
);
select is(
  (select normalization_code from public.webhook_events
   where source_event_id = 'aaaaaaaa-0000-4000-8000-000000000003'::uuid),
  'stale_clamped', 'Data muito no passado é normalizada para o recebimento'
);

select ingest_form_event(
  :'endpoint'::uuid, 'aaaaaaaa-0000-4000-8000-000000000004'::uuid, :'hash1'::bytea, 'proto-ok-aaaaaaaaaaaa',
  '\xde'::bytea, '\x000000000000000000000000'::bytea, '\x00000000000000000000000000000000'::bytea,
  'aes-256-gcm', '1', '{}'::jsonb, now() - interval '2 minutes'
);
select is(
  (select normalization_code from public.webhook_events
   where source_event_id = 'aaaaaaaa-0000-4000-8000-000000000004'::uuid),
  'ok', 'Data recente é preservada'
);

-- -----------------------------------------------------------------
-- 4) Worker: transação de negócio completa
-- -----------------------------------------------------------------

select id as event1 from public.webhook_events where source_event_id = :'uuid1'::uuid \gset

select process_form_event(:'event1'::uuid, jsonb_build_object(
  'contact', jsonb_build_object('name', 'Visitante Um', 'type', 'pf',
                                'email', 'visitante@exemplo.test', 'phone_e164', '+5511988887777'),
  'attribution', jsonb_build_object('channel', 'formulario', 'source', 'google', 'campaign', 'marca'),
  'consent', jsonb_build_object('decision', 'granted', 'channel', 'email',
                                'legal_basis', 'consentimento', 'purpose', 'Contato pelo site'),
  'summary', 'Preciso de ajuda'
)) as proc1 \gset

select is((:'proc1'::jsonb ->> 'new_demand')::boolean, true, 'Captação nova abre demanda nova');
select isnt((:'proc1'::jsonb ->> 'contact_id'), null, 'Worker criou o contato');
select isnt((:'proc1'::jsonb ->> 'opportunity_id'), null, 'Worker criou a oportunidade');
select isnt((:'proc1'::jsonb ->> 'activity_id'), null, 'Demanda nova cria a atividade inicial');

select is(
  (select status::text from public.webhook_events where id = :'event1'::uuid),
  'processed', 'Evento marcado como processado'
);

select is(
  (select count(*)::int from public.touchpoints where webhook_event_id = :'event1'::uuid),
  1, 'Um touchpoint por evento'
);
select ok(
  (select opportunity_id is not null from public.touchpoints where webhook_event_id = :'event1'::uuid),
  'Captação nova grava o touchpoint JÁ com a oportunidade (origem direta)'
);

select is(
  (select purpose_code::text from public.consent_evidence where webhook_event_id = :'event1'::uuid),
  'formulario_contato', 'Consentimento do formulário usa finalidade PRÓPRIA'
);
select is(
  (select count(*)::int from public.contact_consents
   where contact_id = (:'proc1'::jsonb ->> 'contact_id')::uuid
     and purpose_code = 'whatsapp_atendimento'),
  0, 'Formulário NUNCA cria consentimento de WhatsApp (finalidades separadas)'
);

-- Segunda execução do MESMO evento: nenhum efeito novo.
select process_form_event(:'event1'::uuid, '{}'::jsonb) as proc_again \gset
select is((:'proc_again'::jsonb ->> 'already_processed')::boolean, true,
  'Worker concorrente encontra o evento já processado');
select is(
  (select count(*)::int from public.touchpoints where webhook_event_id = :'event1'::uuid),
  1, 'Reprocessar não duplica touchpoint'
);
select is(
  (select count(*)::int from public.leads where workspace_id = :'ws'::uuid),
  1, 'Reprocessar não duplica lead'
);

-- -----------------------------------------------------------------
-- 5) Um lead com DUAS oportunidades: nenhuma empresta origem à outra
-- -----------------------------------------------------------------

select (:'proc1'::jsonb ->> 'lead_id') as lead1 \gset
select (:'proc1'::jsonb ->> 'opportunity_id') as opp1 \gset
select (:'proc1'::jsonb ->> 'contact_id') as contact1 \gset

insert into public.opportunities (workspace_id, lead_id, pipeline_id, stage_id, created_by)
values (:'ws'::uuid, :'lead1'::uuid, :'pipeline'::uuid, :'stage1'::uuid, :'otavio')
returning id as opp2 \gset

select is(
  (select count(*)::int from private.opportunity_eligible_touchpoints(:'opp2'::uuid)),
  0, 'Touchpoint da outra oportunidade do MESMO lead não é elegível aqui'
);
select is(
  (select count(*)::int from private.opportunity_eligible_touchpoints(:'opp1'::uuid)),
  1, 'O touchpoint continua elegível na oportunidade onde nasceu'
);

select id as tp1 from public.touchpoints where webhook_event_id = :'event1'::uuid \gset

select is(
  (select first_touch_id from private.opportunity_attribution(:'opp1'::uuid)),
  :'tp1'::uuid, 'Primeiro toque da oportunidade de origem'
);
select is(
  (select conversion_id from private.opportunity_attribution(:'opp1'::uuid)),
  :'tp1'::uuid, 'Conversão aceita vínculo ORIGINAL direto'
);
select is(
  (select first_touch_id from private.opportunity_attribution(:'opp2'::uuid)),
  null, 'Sem touchpoint elegível, a atribuição é "não atribuído"'
);

-- -----------------------------------------------------------------
-- 6) Correção de vínculo: cadeia, conversão e concorrência
-- -----------------------------------------------------------------

select id as link1 from public.touchpoint_demand_links where touchpoint_id = :'tp1'::uuid \gset

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'sofia', 'role', 'authenticated')::text, true);
select throws_ok(
  format($$select correct_touchpoint_demand_link(%L::uuid, %L::uuid, 'unassign')$$, :'tp1', :'link1'),
  'insufficient_permission',
  'Atendimento não corrige vínculo de atribuição'
);

select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);

-- Transferir para a segunda oportunidade do mesmo lead.
select correct_touchpoint_demand_link(:'tp1'::uuid, :'link1'::uuid, 'assign', :'opp2'::uuid, 'correção') as corr1 \gset
reset role;

select is(
  (select private.touchpoint_effective_opportunity(:'tp1'::uuid)),
  :'opp2'::uuid, 'A ponta vigente passa a valer'
);
select is(
  (select first_touch_id from private.opportunity_attribution(:'opp2'::uuid)),
  :'tp1'::uuid, 'Touchpoint corrigido participa do PRIMEIRO toque do destino'
);
select is(
  (select conversion_id from private.opportunity_attribution(:'opp2'::uuid)),
  null, 'Touchpoint apenas corrigido NÃO participa da conversão'
);
select is(
  (select first_touch_id from private.opportunity_attribution(:'opp1'::uuid)),
  null, 'A oportunidade de origem perde o touchpoint transferido'
);
select is(
  (select conversion_id from private.opportunity_attribution(:'opp1'::uuid)),
  null, 'Conversão da origem também cai quando a ponta vigente aponta para outra'
);

-- Conflito de versão: corrigir a partir da ponta ANTIGA.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select throws_ok(
  format($$select correct_touchpoint_demand_link(%L::uuid, %L::uuid, 'unassign')$$, :'tp1', :'link1'),
  'link_version_conflict',
  'Duas correções da mesma versão: a segunda recebe conflito'
);

-- unassign vigente torna o touchpoint não atribuído. A leitura da ponta
-- é feita fora da sessão: authenticated não tem acesso à tabela (de
-- propósito; a correção só acontece pela RPC).
reset role;
select id as link2 from public.touchpoint_demand_links
where touchpoint_id = :'tp1'::uuid and supersedes_id = :'link1'::uuid \gset
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select correct_touchpoint_demand_link(:'tp1'::uuid, :'link2'::uuid, 'unassign');
reset role;

select is(
  (select private.touchpoint_effective_opportunity(:'tp1'::uuid)), null,
  'unassign vigente deixa o touchpoint sem demanda'
);
select is(
  (select count(*)::int from private.opportunity_eligible_touchpoints(:'opp2'::uuid)),
  0, 'Depois do unassign, nada é elegível no destino anterior'
);
select is(
  (select count(*)::int from public.touchpoint_demand_links where touchpoint_id = :'tp1'::uuid),
  3, 'Histórico preservado: três versões na cadeia, nenhuma apagada'
);

-- Invariantes estruturais da cadeia.
select throws_ok(
  format($$insert into public.touchpoint_demand_links (workspace_id, touchpoint_id, opportunity_id, action)
           values (%L::uuid, %L::uuid, %L::uuid, 'assign')$$, :'ws', :'tp1', :'opp1'),
  '23505',
  null,
  'Uma única RAIZ por touchpoint (índice parcial único)'
);
select throws_ok(
  format($$insert into public.touchpoint_demand_links
             (workspace_id, touchpoint_id, opportunity_id, action, supersedes_id)
           values (%L::uuid, %L::uuid, %L::uuid, 'assign', %L::uuid)$$,
         :'ws', :'tp1', :'opp1', :'link1'),
  '23505',
  null,
  'supersedes_id só pode ser usado UMA vez (uma ponta vigente)'
);

-- -----------------------------------------------------------------
-- 7) Evento recebido DEPOIS do ganho nunca recebe crédito
-- -----------------------------------------------------------------

update public.opportunities
  set status = 'won', won_at = now() - interval '1 hour'
  where id = :'opp1'::uuid;

insert into public.touchpoints (
  workspace_id, contact_id, lead_id, opportunity_id, received_at,
  normalized_occurred_at, channel, position
)
values (
  :'ws'::uuid, :'contact1'::uuid, :'lead1'::uuid, :'opp1'::uuid, now(),
  -- Data DECLARADA anterior ao ganho, recebimento POSTERIOR: é o cenário
  -- que a data declarada permitiria forjar.
  now() - interval '2 hours', 'formulario', 99
)
returning id as tp_tardio \gset

select is(
  (select count(*)::int from private.opportunity_eligible_touchpoints(:'opp1'::uuid)
   where touchpoint_id = :'tp_tardio'::uuid),
  0, 'Touchpoint RECEBIDO depois do ganho não recebe crédito, mesmo declarando data anterior'
);

-- -----------------------------------------------------------------
-- 8) Continuidade: anexa sem reabrir, e não cria atividade
-- -----------------------------------------------------------------

reset role;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select create_form_endpoint(
  :'ws'::uuid, 'Continuidade', :'pipeline'::uuid, :'stage0'::uuid, 'Trabalhista',
  'call', 60, 'continuity', 'formulario', array['exemplo.test'], 'chave-continuidade-bbbbbb'
);
reset role;

select id as endpoint_cont from public.form_endpoints
where workspace_id = :'ws'::uuid and capture_mode = 'continuity' \gset

insert into public.continuity_references (
  workspace_id, token_hash, contact_id, lead_id, opportunity_id, purpose, expires_at
)
values (
  :'ws'::uuid, '\x3333333333333333333333333333333333333333333333333333333333333333'::bytea,
  :'contact1'::uuid, :'lead1'::uuid, :'opp1'::uuid, 'form_continuity', now() + interval '7 days'
);

select ingest_form_event(
  :'endpoint_cont'::uuid, 'bbbbbbbb-0000-4000-8000-000000000001'::uuid, :'hash1'::bytea,
  'proto-continuidade-aaa', '\xde'::bytea, '\x000000000000000000000000'::bytea,
  '\x00000000000000000000000000000000'::bytea, 'aes-256-gcm', '1', '{}'::jsonb, now()
);
select id as event_cont from public.webhook_events
where source_event_id = 'bbbbbbbb-0000-4000-8000-000000000001'::uuid \gset

select process_form_event(:'event_cont'::uuid, jsonb_build_object(
  'contact', jsonb_build_object('name', 'Visitante Um'),
  'continuity_token_hash', encode('\x3333333333333333333333333333333333333333333333333333333333333333'::bytea, 'base64'),
  'attribution', jsonb_build_object('channel', 'formulario', 'source', 'email')
)) as proc_cont \gset

select is((:'proc_cont'::jsonb ->> 'new_demand')::boolean, false,
  'Continuidade válida NÃO abre demanda nova');
select is((:'proc_cont'::jsonb ->> 'opportunity_id'), :'opp1',
  'Continuidade anexa à oportunidade indicada pela referência');
select is((:'proc_cont'::jsonb ->> 'activity_id'), null,
  'Continuidade não cria atividade inicial');
select is(
  (select status::text from public.opportunities where id = :'opp1'::uuid),
  'won', 'Continuidade para oportunidade ENCERRADA não a reabre'
);
select is(
  (select count(*)::int from public.leads where workspace_id = :'ws'::uuid),
  1, 'Continuidade não cria lead novo'
);

-- -----------------------------------------------------------------
-- 8b) Continuidade com FINALIDADE ERRADA é recusada — degrada para
--     captação nova, não é tratada como token inválido nem como erro:
--     é exatamente o mesmo resultado de "sem continuidade confiável".
-- -----------------------------------------------------------------

insert into public.continuity_references (
  workspace_id, token_hash, contact_id, lead_id, opportunity_id, purpose, expires_at
)
values (
  :'ws'::uuid, decode(repeat('44', 32), 'hex'),
  :'contact1'::uuid, :'lead1'::uuid, :'opp1'::uuid, 'outra_finalidade', now() + interval '7 days'
);

select ingest_form_event(
  :'endpoint_cont'::uuid, 'bbbbbbbb-0000-4000-8000-000000000002'::uuid, :'hash1'::bytea,
  'proto-continuidade-bbb', '\xde'::bytea, '\x000000000000000000000000'::bytea,
  '\x00000000000000000000000000000000'::bytea, 'aes-256-gcm', '1', '{}'::jsonb, now()
);
select id as event_cont_wrong_purpose from public.webhook_events
where source_event_id = 'bbbbbbbb-0000-4000-8000-000000000002'::uuid \gset

select process_form_event(:'event_cont_wrong_purpose'::uuid, jsonb_build_object(
  'contact', jsonb_build_object('name', 'Visitante Dois'),
  'continuity_token_hash', encode(decode(repeat('44', 32), 'hex'), 'base64'),
  'attribution', jsonb_build_object('channel', 'formulario', 'source', 'email')
)) as proc_wrong_purpose \gset

select is((:'proc_wrong_purpose'::jsonb ->> 'new_demand')::boolean, true,
  'Token com finalidade diferente de form_continuity é tratado como SEM continuidade (abre demanda nova)');
select isnt((:'proc_wrong_purpose'::jsonb ->> 'opportunity_id'), :'opp1',
  'Não reaproveita a oportunidade encerrada de uma referência com finalidade errada');
select is(
  (select used_count from public.continuity_references
   where token_hash = decode(repeat('44', 32), 'hex')),
  0, 'Referência com finalidade errada nunca é marcada como usada'
);

-- -----------------------------------------------------------------
-- 9) Retenção: tombstone e expired_unprocessed
-- -----------------------------------------------------------------

-- Evento processado que vence: vira tombstone.
update public.webhook_events set expires_at = now() - interval '1 minute' where id = :'event1'::uuid;
-- Evento NUNCA processado que vence.
select id as event_pendente from public.webhook_events
where source_event_id = 'aaaaaaaa-0000-4000-8000-000000000002'::uuid \gset
update public.webhook_events set expires_at = now() - interval '1 minute' where id = :'event_pendente'::uuid;

select purge_expired_webhook_events(100) as purge1 \gset

select is((:'purge1'::jsonb ->> 'purged')::int, 1, 'Evento processado vencido é limpo');
select is((:'purge1'::jsonb ->> 'expired_unprocessed')::int, 1,
  'Evento não processado vencido vira expired_unprocessed (nunca apagado em silêncio)');

select is(
  (select count(*)::int from public.webhook_events
   where id in (:'event1'::uuid, :'event_pendente'::uuid)
     and (payload_ciphertext is not null or payload_sanitized is not null)),
  0, 'Conteúdo pessoal eliminado nos dois caminhos'
);
select is(
  (select count(*)::int from public.webhook_events
   where id in (:'event1'::uuid, :'event_pendente'::uuid)
     and public_protocol is not null and content_hash is not null),
  2, 'Tombstone preserva protocolo e hash (chave idempotente sobrevive)'
);
select is(
  (select result_contact_id from public.webhook_events where id = :'event1'::uuid),
  :'contact1'::uuid, 'Tombstone preserva as referências resultantes'
);
select is(
  (select status::text from public.webhook_events where id = :'event_pendente'::uuid),
  'expired_unprocessed', 'Status final do evento vencido sem processamento'
);
select is(
  (select count(*)::int from public.audit_logs
   where workspace_id = :'ws'::uuid and action = 'webhook_event.expired_unprocessed'),
  1, 'Vencimento sem processamento gera auditoria (sem PII)'
);

-- Replay depois do vencimento: mesmo protocolo, nenhum evento novo.
select ingest_form_event(
  :'endpoint'::uuid, :'uuid1'::uuid, :'hash1'::bytea, 'proto-replay-aaaaaaaaa',
  '\xde'::bytea, '\x000000000000000000000000'::bytea, '\x00000000000000000000000000000000'::bytea,
  'aes-256-gcm', '1', '{}'::jsonb, now()
) as replay \gset

select is((:'replay'::jsonb ->> 'created')::boolean, false,
  'Replay depois da limpeza não cria evento novo');
select is(:'replay'::jsonb ->> 'protocol', :'ing1'::jsonb ->> 'protocol',
  'Replay depois da limpeza devolve o MESMO protocolo');

select is(
  (select (process_form_event(:'event_pendente'::uuid, '{}'::jsonb) ->> 'ineligible')::boolean),
  true, 'Evento expirado sem processamento é INELEGÍVEL para efeito comercial'
);

-- Segunda limpeza é idempotente.
select purge_expired_webhook_events(100) as purge2 \gset
select is((:'purge2'::jsonb ->> 'purged')::int, 0, 'Segunda limpeza não repete trabalho');

-- -----------------------------------------------------------------
-- 10) Evento travado e alerta antecipado
-- -----------------------------------------------------------------

select id as event_travado from public.webhook_events
where source_event_id = 'aaaaaaaa-0000-4000-8000-000000000003'::uuid \gset
update public.webhook_events set stuck_after = now() - interval '1 minute'
where id = :'event_travado'::uuid;

select flag_stuck_webhook_events(50) as stuck \gset
select is((:'stuck'::jsonb ->> 'count')::int, 1, 'Evento fora do tempo operacional é marcado como travado');
select is(
  (select count(*)::int from public.audit_logs
   where workspace_id = :'ws'::uuid and action = 'webhook_event.stuck'),
  1, 'Evento travado gera auditoria estruturada'
);
select is((select (flag_stuck_webhook_events(50) ->> 'count')::int), 0,
  'Alerta de travado não se repete (idempotente)');

-- -----------------------------------------------------------------
-- 11) Isolamento entre workspaces
-- -----------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'lucas', 'role', 'authenticated')::text, true);
-- Sem GRANT de tabela: a leitura direta é recusada (42501), não apenas
-- filtrada para zero linhas.
select throws_ok(
  'select count(*) from public.touchpoints', '42501', null,
  'Cliente autenticado não lê touchpoints direto (sem grant de tabela)'
);
select throws_ok(
  'select count(*) from public.webhook_events', '42501', null,
  'Cliente autenticado não lê webhook_events direto (sem grant de tabela)'
);
reset role;

-- -----------------------------------------------------------------
-- 12) Mesclagem reparenteia touchpoints, continuity_references e
--     consent_evidence — e desfazer devolve as três; alterar uma
--     linha reparentada antes do desfazer recusa o undo inteiro.
-- -----------------------------------------------------------------

insert into public.contacts (id, workspace_id, type, name, created_by)
values ('c1100000-0000-4000-8000-000000000001', :'ws'::uuid, 'pf', 'Duplicado', :'otavio');

update public.touchpoints set contact_id = 'c1100000-0000-4000-8000-000000000001'
where id = :'tp_tardio'::uuid;

-- Lead do contato perdedor: exigido pela FK que garante contato e lead
-- da MESMA cadeia numa continuity_reference.
insert into public.leads (id, workspace_id, contact_id, legal_area, priority, created_by)
values (
  'c1100000-0000-4000-8000-000000000010', :'ws'::uuid, 'c1100000-0000-4000-8000-000000000001',
  'Cível', 'media', :'otavio'
);

insert into public.continuity_references (
  id, workspace_id, token_hash, contact_id, lead_id, purpose, expires_at
)
values (
  'c1100000-0000-4000-8000-000000000020', :'ws'::uuid, decode(repeat('55', 32), 'hex'),
  'c1100000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000010',
  'form_continuity', now() + interval '7 days'
);

insert into public.consent_evidence (
  id, workspace_id, contact_id, decision, purpose_code, purpose, legal_basis, channel, decided_at
)
values (
  'c1100000-0000-4000-8000-000000000030', :'ws'::uuid, 'c1100000-0000-4000-8000-000000000001',
  'granted', 'formulario_contato', 'Contato pelo site', 'consentimento', 'email', now()
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select merge_contacts(:'contact1'::uuid, 'c1100000-0000-4000-8000-000000000001'::uuid);
reset role;

select is(
  (select contact_id from public.touchpoints where id = :'tp_tardio'::uuid),
  :'contact1'::uuid, 'Mesclagem reparenteia o touchpoint para o contato vencedor'
);
select is(
  (select contact_id from public.continuity_references where id = 'c1100000-0000-4000-8000-000000000020'),
  :'contact1'::uuid, 'Mesclagem reparenteia continuity_references para o contato vencedor'
);
select is(
  (select contact_id from public.consent_evidence where id = 'c1100000-0000-4000-8000-000000000030'),
  :'contact1'::uuid, 'Mesclagem reparenteia consent_evidence para o contato vencedor'
);

select id as merge1 from public.contact_merges
where kept_contact_id = :'contact1'::uuid and merged_contact_id = 'c1100000-0000-4000-8000-000000000001'
order by created_at desc limit 1 \gset

-- Desfazer devolve as três tabelas ao contato original.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select unmerge_contact(:'merge1'::uuid);
reset role;

select is(
  (select contact_id from public.continuity_references where id = 'c1100000-0000-4000-8000-000000000020'),
  'c1100000-0000-4000-8000-000000000001'::uuid, 'Desfazer devolve continuity_references ao contato original'
);
select is(
  (select contact_id from public.consent_evidence where id = 'c1100000-0000-4000-8000-000000000030'),
  'c1100000-0000-4000-8000-000000000001'::uuid, 'Desfazer devolve consent_evidence ao contato original'
);
select is(
  (select contact_id from public.touchpoints where id = :'tp_tardio'::uuid),
  'c1100000-0000-4000-8000-000000000001'::uuid, 'Desfazer devolve touchpoints ao contato original'
);

-- Mescla de novo (o contato voltou a ficar livre) e altera uma linha
-- reparentada (remove a referência de continuidade) ANTES do desfazer:
-- o undo inteiro precisa recusar, não só ignorar a linha alterada.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select merge_contacts(:'contact1'::uuid, 'c1100000-0000-4000-8000-000000000001'::uuid);
reset role;

select id as merge2 from public.contact_merges
where kept_contact_id = :'contact1'::uuid and merged_contact_id = 'c1100000-0000-4000-8000-000000000001'
order by created_at desc limit 1 \gset

delete from public.continuity_references where id = 'c1100000-0000-4000-8000-000000000020';

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select throws_ok(
  format($$select unmerge_contact(%L::uuid)$$, :'merge2'),
  'P0001', null,
  'Desfazer recusa quando uma linha reparentada (continuity_references) foi removida antes do undo'
);
reset role;

select is(
  (select contact_id from public.consent_evidence where id = 'c1100000-0000-4000-8000-000000000030'),
  :'contact1'::uuid, 'Undo recusado: consent_evidence continua no contato vencedor (nada é desfeito pela metade)'
);

-- -----------------------------------------------------------------
-- 12c) continuity_references USADA ou REVOGADA depois do merge causa
--      undo_conflict (item 6 da auditoria pós-dry-run) — antes, só a
--      EXISTÊNCIA da linha era conferida no undo (igual a uma tabela
--      append-only); usar (processar um evento com o token, pelo
--      caminho real) ou revogar a referência DEPOIS da mesclagem e ANTES
--      do desfazer passava batido, porque a linha continuava existindo.
--
--      now() é fixo durante toda a transação deste arquivo (mesmo motivo
--      documentado em 08_a3_merge.test.sql): sem backdatar manualmente
--      aqui, o updated_at gravado pela mesclagem e o gravado pela ação
--      real seriam idênticos, mascarando o cenário que só existe de
--      verdade entre duas requisições (transações) diferentes.
-- -----------------------------------------------------------------

-- Caso 1: USO depois do merge.
insert into public.contacts (id, workspace_id, type, name, created_by)
values ('c1100000-0000-4000-8000-000000000002', :'ws'::uuid, 'pf', 'Duplicado3', :'otavio');

insert into public.leads (id, workspace_id, contact_id, legal_area, priority, created_by)
values (
  'c1100000-0000-4000-8000-000000000011', :'ws'::uuid, 'c1100000-0000-4000-8000-000000000002',
  'Cível', 'media', :'otavio'
);

insert into public.continuity_references (
  id, workspace_id, token_hash, contact_id, lead_id, purpose, expires_at
)
values (
  'c1100000-0000-4000-8000-000000000021', :'ws'::uuid, decode(repeat('66', 32), 'hex'),
  'c1100000-0000-4000-8000-000000000002', 'c1100000-0000-4000-8000-000000000011',
  'form_continuity', now() + interval '7 days'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select merge_contacts(:'contact1'::uuid, 'c1100000-0000-4000-8000-000000000002'::uuid);
reset role;

select id as merge3 from public.contact_merges
where kept_contact_id = :'contact1'::uuid and merged_contact_id = 'c1100000-0000-4000-8000-000000000002'
order by created_at desc limit 1 \gset

-- USA a referência DEPOIS do merge, pelo caminho REAL (process_form_event
-- incrementa used_count/last_used_at, e o gatilho grava updated_at).
select ingest_form_event(
  :'endpoint_cont'::uuid, 'cccccccc-0000-4000-8000-000000000010'::uuid, :'hash1'::bytea,
  'proto-uso-pos-merge', '\xde'::bytea, '\x000000000000000000000000'::bytea,
  '\x00000000000000000000000000000000'::bytea, 'aes-256-gcm', '1', '{}'::jsonb, now()
);
select id as event_uso_pos_merge from public.webhook_events
where source_event_id = 'cccccccc-0000-4000-8000-000000000010'::uuid \gset

select process_form_event(:'event_uso_pos_merge'::uuid, jsonb_build_object(
  'contact', jsonb_build_object('name', 'Visitante Duplicado3'),
  'continuity_token_hash', encode(decode(repeat('66', 32), 'hex'), 'base64'),
  'attribution', jsonb_build_object('channel', 'formulario', 'source', 'email')
));

select ok(
  (select used_count > 0 from public.continuity_references where id = 'c1100000-0000-4000-8000-000000000021'),
  'Fixture: a referência foi USADA depois do merge (used_count > 0)'
);

-- Simula a passagem de tempo real entre o uso e a tentativa de desfazer
-- (mesmo objetivo de 08_a3_merge.test.sql — nunca como o app se
-- comporta). `ALTER TABLE ... DISABLE TRIGGER` não serve aqui: a FK
-- deferrable de continuity_references (§8.1 do contrato) deixa eventos
-- de gatilho PENDENTES na tabela dentro da mesma transação, e o Postgres
-- recusa alterar a definição de gatilho enquanto há evento pendente
-- (`cannot ALTER TABLE ... because it has pending trigger events`).
-- `session_replication_role = replica` desliga gatilhos de ORIGEM (todo
-- gatilho de usuário, por padrão) só para as próximas instruções da
-- SESSÃO — sem tocar a definição do gatilho, então não colide com o
-- evento pendente.
set session_replication_role = replica;
update public.continuity_references set updated_at = updated_at + interval '1 minute'
where id = 'c1100000-0000-4000-8000-000000000021';
set session_replication_role = origin;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select throws_ok(
  format($$select unmerge_contact(%L::uuid)$$, :'merge3'),
  'P0001', null,
  'Desfazer recusa quando a referência de continuidade foi USADA depois da mesclagem'
);
reset role;

-- Caso 2: REVOGAÇÃO depois do merge.
insert into public.contacts (id, workspace_id, type, name, created_by)
values ('c1100000-0000-4000-8000-000000000003', :'ws'::uuid, 'pf', 'Duplicado4', :'otavio');

insert into public.leads (id, workspace_id, contact_id, legal_area, priority, created_by)
values (
  'c1100000-0000-4000-8000-000000000012', :'ws'::uuid, 'c1100000-0000-4000-8000-000000000003',
  'Cível', 'media', :'otavio'
);

insert into public.continuity_references (
  id, workspace_id, token_hash, contact_id, lead_id, purpose, expires_at
)
values (
  'c1100000-0000-4000-8000-000000000022', :'ws'::uuid, decode(repeat('77', 32), 'hex'),
  'c1100000-0000-4000-8000-000000000003', 'c1100000-0000-4000-8000-000000000012',
  'form_continuity', now() + interval '7 days'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select merge_contacts(:'contact1'::uuid, 'c1100000-0000-4000-8000-000000000003'::uuid);
reset role;

select id as merge4 from public.contact_merges
where kept_contact_id = :'contact1'::uuid and merged_contact_id = 'c1100000-0000-4000-8000-000000000003'
order by created_at desc limit 1 \gset

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select revoke_continuity_reference('c1100000-0000-4000-8000-000000000022'::uuid);
reset role;

select isnt(
  (select revoked_at from public.continuity_references where id = 'c1100000-0000-4000-8000-000000000022'),
  null, 'Fixture: a referência foi REVOGADA depois do merge'
);

set session_replication_role = replica;
update public.continuity_references set updated_at = updated_at + interval '1 minute'
where id = 'c1100000-0000-4000-8000-000000000022';
set session_replication_role = origin;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select throws_ok(
  format($$select unmerge_contact(%L::uuid)$$, :'merge4'),
  'P0001', null,
  'Desfazer recusa quando a referência de continuidade foi REVOGADA depois da mesclagem'
);
reset role;

-- -----------------------------------------------------------------
-- 13) FKs compostas: ON DELETE SET NULL só na coluna opcional
--     (item 8 da auditoria pós-dry-run) — workspace_id NUNCA é anulado.
-- -----------------------------------------------------------------

select isnt((select contact_consent_id from public.consent_evidence where webhook_event_id = :'event1'::uuid), null,
  'Fixture: consent_evidence do evento 1 tem contact_consent_id preenchido');
select (select contact_consent_id from public.consent_evidence where webhook_event_id = :'event1'::uuid) as ce_consent_id \gset
select (select workspace_id from public.consent_evidence where webhook_event_id = :'event1'::uuid) as ce_workspace \gset

delete from public.contact_consents where id = :'ce_consent_id'::uuid;

select is(
  (select contact_consent_id from public.consent_evidence where webhook_event_id = :'event1'::uuid),
  null, 'Apagar o consentimento referenciado anula SÓ contact_consent_id em consent_evidence'
);
select is(
  (select workspace_id from public.consent_evidence where webhook_event_id = :'event1'::uuid),
  :'ce_workspace'::uuid, 'workspace_id de consent_evidence é preservado (não anulado pelo ON DELETE SET NULL)'
);

select isnt((select consent_evidence_id from public.touchpoints where id = :'tp1'::uuid), null,
  'Fixture: touchpoint 1 tem consent_evidence_id preenchido');
select (select consent_evidence_id from public.touchpoints where id = :'tp1'::uuid) as tp_consent_id \gset
select (select workspace_id from public.touchpoints where id = :'tp1'::uuid) as tp_workspace \gset

delete from public.consent_evidence where id = :'tp_consent_id'::uuid;

select is(
  (select consent_evidence_id from public.touchpoints where id = :'tp1'::uuid),
  null, 'Apagar a evidência de consentimento anula SÓ consent_evidence_id em touchpoints'
);
select is(
  (select workspace_id from public.touchpoints where id = :'tp1'::uuid),
  :'tp_workspace'::uuid, 'workspace_id de touchpoints é preservado (não anulado pelo ON DELETE SET NULL)'
);

-- -----------------------------------------------------------------
-- 14) Emissão e revogação de referência de continuidade (item 5)
-- -----------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select throws_ok(
  $$select issue_continuity_reference('00000000-0000-4000-8000-000000000000'::uuid)$$,
  'lead_not_found',
  'Lead inexistente não emite continuidade (mesma recusa de "não encontrado")'
);

select issue_continuity_reference(:'lead1'::uuid, :'opp2'::uuid, 168) as issued \gset
reset role;

select isnt(:'issued'::jsonb ->> 'token', null, 'Emissão devolve o token em claro (só nesta resposta)');
select is(
  (select count(*)::int from public.continuity_references
   where lead_id = :'lead1'::uuid and opportunity_id = :'opp2'::uuid and purpose = 'form_continuity'),
  1, 'A referência é gravada com workspace, contato, lead, oportunidade e finalidade explícitos'
);
select is(
  (select octet_length(token_hash) from public.continuity_references
   where id = (:'issued'::jsonb ->> 'id')::uuid),
  32, 'Só o HASH (32 bytes) do token é persistido'
);
select is(
  (select count(*)::int from public.continuity_references ref
   where ref.id = (:'issued'::jsonb ->> 'id')::uuid
     and extensions.digest(convert_to(:'issued'::jsonb ->> 'token', 'utf8'), 'sha256') = ref.token_hash),
  1, 'O hash gravado é o SHA-256 do TEXTO do token devolvido — a MESMA representação que o worker usa (defeito corrigido, item 1: antes o hash gravado era dos BYTES aleatórios crus, e o token devolvido nunca batia com o hash gravado)'
);

-- Uma SEGUNDA interação com o token novo acrescenta touchpoint sem
-- sobrescrever o primeiro (regra explícita do item 5 original). O hash
-- usado aqui é recalculado a partir do TOKEN REALMENTE DEVOLVIDO pela
-- RPC — exatamente como o worker calcula de verdade a partir do que o
-- visitante manda de volta — nunca lido de `token_hash` no banco (item 1
-- da auditoria pós-dry-run: ler o hash já gravado escondia a
-- incompatibilidade real entre emissão e verificação, porque comparava a
-- coluna com ela mesma em vez de reproduzir o cálculo do cliente).
select count(*)::int as touchpoints_before from public.touchpoints where contact_id = :'contact1'::uuid \gset

select ingest_form_event(
  :'endpoint_cont'::uuid, 'bbbbbbbb-0000-4000-8000-000000000003'::uuid, :'hash1'::bytea,
  'proto-continuidade-ccc', '\xde'::bytea, '\x000000000000000000000000'::bytea,
  '\x00000000000000000000000000000000'::bytea, 'aes-256-gcm', '1', '{}'::jsonb, now()
);
select id as event_issued from public.webhook_events
where source_event_id = 'bbbbbbbb-0000-4000-8000-000000000003'::uuid \gset

select encode(extensions.digest(convert_to(:'issued'::jsonb ->> 'token', 'utf8'), 'sha256'), 'base64')
  as issued_hash_b64 \gset

select process_form_event(:'event_issued'::uuid, jsonb_build_object(
  'contact', jsonb_build_object('name', 'Visitante Um'),
  'continuity_token_hash', :'issued_hash_b64',
  'attribution', jsonb_build_object('channel', 'formulario', 'source', 'referral')
)) as proc_issued \gset

select is((:'proc_issued'::jsonb ->> 'new_demand')::boolean, false,
  'Segunda interação com o token emitido acrescenta touchpoint sem abrir demanda nova');
select is(
  (select count(*)::int from public.touchpoints where contact_id = :'contact1'::uuid),
  :'touchpoints_before'::int + 1,
  'A segunda interação ACRESCENTA um touchpoint (contagem +1), nunca substitui os anteriores'
);
select is(
  (select count(*)::int from public.touchpoints where id = :'tp1'::uuid),
  1, 'O primeiro touchpoint (tp1) continua existindo, intacto, depois da segunda interação'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select revoke_continuity_reference((:'issued'::jsonb ->> 'id')::uuid);
reset role;

select isnt(
  (select revoked_at from public.continuity_references where id = (:'issued'::jsonb ->> 'id')::uuid),
  null, 'Revogação explícita marca revoked_at antes do vencimento'
);

-- -----------------------------------------------------------------
-- 15) answers_config: validação real, não decorativa (item 6)
-- -----------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select throws_ok(
  format($$select create_form_endpoint(%L::uuid, 'Campos ruins', %L::uuid, %L::uuid, 'Cível', 'call', 60,
           'new_intake', 'formulario', array['exemplo.test'], 'chave-campos-ruins-aaaaaaa',
           '{"fields":[{"key":"Chave Maiuscula","label":"x","type":"text"}]}'::jsonb)$$,
         :'ws', :'pipeline', :'stage0'),
  'answers_config_invalid: bad key Chave Maiuscula',
  'Chave de campo fora do padrão (minúsculas/números/underscore) é recusada'
);
select throws_ok(
  format($$select create_form_endpoint(%L::uuid, 'Tipo ruim', %L::uuid, %L::uuid, 'Cível', 'call', 60,
           'new_intake', 'formulario', array['exemplo.test'], 'chave-tipo-ruim-aaaaaaaaaa',
           '{"fields":[{"key":"motivo","label":"Motivo","type":"arquivo"}]}'::jsonb)$$,
         :'ws', :'pipeline', :'stage0'),
  'answers_config_invalid: bad type for motivo',
  'Tipo fora da lista fechada (text/boolean/number) é recusado'
);
select throws_ok(
  format($$select create_form_endpoint(%L::uuid, 'Chave duplicada', %L::uuid, %L::uuid, 'Cível', 'call', 60,
           'new_intake', 'formulario', array['exemplo.test'], 'chave-duplicada-aaaaaaaaaaaa',
           '{"fields":[{"key":"motivo","label":"a","type":"text"},{"key":"motivo","label":"b","type":"text"}]}'::jsonb)$$,
         :'ws', :'pipeline', :'stage0'),
  'answers_config_invalid: duplicate key motivo',
  'Duas definições com a MESMA chave são recusadas'
);

select create_form_endpoint(
  :'ws'::uuid, 'Campos válidos', :'pipeline'::uuid, :'stage0'::uuid, 'Cível', 'call', 60,
  'new_intake', 'formulario', array['exemplo.test'], 'chave-campos-validos-aaaaaaaa',
  '{"fields":[{"key":"motivo","label":"Motivo","type":"text","required":true,"maxLength":500}]}'::jsonb
);
reset role;

select is(
  (select (answers_config -> 'fields' -> 0 ->> 'key')
   from public.form_endpoints where workspace_id = :'ws'::uuid and name = 'Campos válidos'),
  'motivo', 'Configuração de campos válida é aceita e persistida'
);

-- -----------------------------------------------------------------
-- 15b) ingest_form_event recusa answers_config_snapshot CORROMPIDO
--      (item 4 da auditoria pós-dry-run) — defesa em profundidade: a
--      borda TypeScript já valida antes de chamar a RPC, mas a RPC não
--      é chamável só por ali. Um snapshot corrompido, passado direto,
--      nunca vira {fields: []} em silêncio: recusa ANTES de gravar
--      qualquer coisa, e zero eventos são processados.
-- -----------------------------------------------------------------

select count(*)::int as webhook_events_antes_do_snapshot_ruim from public.webhook_events \gset

select throws_ok(
  format($$select ingest_form_event(%L::uuid, 'cccccccc-0000-4000-8000-000000000099'::uuid, %L::bytea,
           'proto-snapshot-corrompido', '\xde'::bytea, '\x000000000000000000000000'::bytea,
           '\x00000000000000000000000000000000'::bytea, 'aes-256-gcm', '1', '{}'::jsonb, now(),
           '{"fields":[{"key":"Chave Maiuscula","label":"x","type":"text"}]}'::jsonb)$$,
         :'endpoint', :'hash1'),
  'answers_config_invalid: bad key Chave Maiuscula',
  'Snapshot corrompido inserido direto pela RPC é recusado — mesmo validador do create/update_form_endpoint'
);

select is(
  (select count(*)::int from public.webhook_events),
  :'webhook_events_antes_do_snapshot_ruim'::int,
  'Nenhum evento novo é gravado quando o snapshot é recusado (zero eventos processados)'
);

-- -----------------------------------------------------------------
-- 16) get_lead_attribution: alcance por REGISTRO, não por contato
--     (item 10 da auditoria pós-dry-run) — mesmo contato, dois leads,
--     responsáveis diferentes.
-- -----------------------------------------------------------------

\set vitor '20000000-0000-0000-0000-000000000013'
insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws'::uuid, :'vitor', 'lawyer', 'active');

-- lead1 passa a ter responsável explícito (lucas), para o alcance do
-- advogado ficar inequívoco nos dois lados do teste.
update public.leads set assigned_to = :'lucas' where id = :'lead1'::uuid;

insert into public.leads (id, workspace_id, contact_id, legal_area, priority, assigned_to, created_by)
values (
  'c1200000-0000-4000-8000-000000000001', :'ws'::uuid, :'contact1'::uuid, 'Trabalhista', 'media', :'vitor', :'otavio'
)
returning id as lead2_scope \gset

insert into public.opportunities (workspace_id, lead_id, pipeline_id, stage_id, created_by)
values (:'ws'::uuid, :'lead2_scope'::uuid, :'pipeline'::uuid, :'stage0'::uuid, :'otavio')
returning id as opp_scope \gset

insert into public.touchpoints (
  workspace_id, contact_id, lead_id, opportunity_id, received_at, normalized_occurred_at, channel, position
)
values (
  :'ws'::uuid, :'contact1'::uuid, :'lead2_scope'::uuid, :'opp_scope'::uuid, now(), now(), 'formulario', 999
)
returning id as tp_scope \gset

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'lucas', 'role', 'authenticated')::text, true);
select get_lead_attribution(:'lead1'::uuid) as attribution_lead1 \gset
reset role;

select is(
  (select jsonb_array_length(:'attribution_lead1'::jsonb -> 'sequence')),
  (select count(*)::int from public.touchpoints where lead_id = :'lead1'::uuid),
  'A sequência de get_lead_attribution(lead1) tem exatamente os touchpoints do PRÓPRIO lead'
);
select is(
  (select bool_or((elem ->> 'id') = :'tp_scope')
   from jsonb_array_elements(:'attribution_lead1'::jsonb -> 'sequence') elem),
  false,
  'A sequência do lead1 NÃO inclui o touchpoint do lead2 do MESMO contato (vazamento corrigido)'
);

-- vitor é responsável pelo lead2, não pelo lead1: não enxerga lead1.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'vitor', 'role', 'authenticated')::text, true);
select is(
  get_lead_attribution(:'lead1'::uuid), null,
  'Advogado sem acesso ao lead1 recebe null (mesma recusa de "não encontrado")'
);
select get_lead_attribution(:'lead2_scope'::uuid) as attribution_lead2 \gset
reset role;

select is(
  (select jsonb_array_length(:'attribution_lead2'::jsonb -> 'sequence')),
  1, 'A sequência do lead2 contém só o próprio touchpoint — nada do lead1 vaza para cá também'
);

-- -----------------------------------------------------------------
-- 16b) Escopo depois de CORREÇÃO entre leads (item 5 da auditoria
--      pós-dry-run) — mesmo contato, dois leads de responsáveis
--      diferentes: correct_touchpoint_demand_link só exige o MESMO
--      CONTATO, nunca o mesmo lead de origem — corrigir um touchpoint
--      para a oportunidade de OUTRO lead do mesmo contato é permitido de
--      propósito. A EXIBIÇÃO precisa migrar junto (vínculo efetivo):
--      sem isto, quem só tem acesso ao lead de origem continuava
--      recebendo o id da oportunidade — e todo o histórico da correção,
--      com nome de quem corrigiu — do lead de DESTINO, mesmo sem acesso
--      a ele.
-- -----------------------------------------------------------------

select id as tp1_link_vigente from public.touchpoint_demand_links
where touchpoint_id = :'tp1'::uuid and supersedes_id = :'link2'::uuid \gset

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select correct_touchpoint_demand_link(:'tp1'::uuid, :'tp1_link_vigente'::uuid, 'assign', :'opp_scope'::uuid,
  'item 5 — correção entre leads do mesmo contato') as corr_cross_lead \gset
reset role;

select is(
  (select private.touchpoint_effective_opportunity(:'tp1'::uuid)),
  :'opp_scope'::uuid, 'Fixture: tp1 agora tem oportunidade vigente do OUTRO lead (lead2_scope)'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'lucas', 'role', 'authenticated')::text, true);
select get_lead_attribution(:'lead1'::uuid) as attribution_lead1_depois \gset
reset role;

select is(
  (select bool_or((elem ->> 'id') = :'tp1')
   from jsonb_array_elements(:'attribution_lead1_depois'::jsonb -> 'sequence') elem),
  false,
  'Depois da correção para o OUTRO lead, tp1 SAI da sequência do lead de origem (a exibição segue o vínculo efetivo, não a origem)'
);
select is(
  (:'attribution_lead1_depois'::text like ('%' || :'opp_scope' || '%')),
  false,
  'A resposta de get_lead_attribution(lead1) para o advogado do lead1 nunca contém o id da oportunidade do lead2_scope (sem vazamento de IDs)'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'vitor', 'role', 'authenticated')::text, true);
select get_lead_attribution(:'lead2_scope'::uuid) as attribution_lead2_depois \gset
reset role;

select is(
  (select jsonb_array_length(:'attribution_lead2_depois'::jsonb -> 'sequence')),
  2, 'tp1 passa a aparecer na sequência do lead2_scope — a exibição migrou com o vínculo efetivo'
);
select is(
  (select bool_or((elem ->> 'id') = :'tp1')
   from jsonb_array_elements(:'attribution_lead2_depois'::jsonb -> 'sequence') elem),
  true,
  'vitor (responsável pelo lead2_scope) enxerga tp1 depois da correção, sem precisar de acesso ao lead1'
);

-- -----------------------------------------------------------------
-- 16c) revoke_continuity_reference: alcance por REGISTRO (item 3 da
--      auditoria pós-dry-run) — dois advogados, leads de responsáveis
--      diferentes: revogar a referência do lead ALHEIO responde como
--      "não encontrada" e não altera a linha.
-- -----------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'vitor', 'role', 'authenticated')::text, true);
select issue_continuity_reference(:'lead2_scope'::uuid, :'opp_scope'::uuid, 168) as issued_scope \gset
reset role;

select (:'issued_scope'::jsonb ->> 'id') as continuity_scope_id \gset

-- lucas é responsável pelo lead1, não pelo lead2_scope: não enxerga a
-- referência dele.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'lucas', 'role', 'authenticated')::text, true);
select throws_ok(
  format($$select revoke_continuity_reference(%L::uuid)$$, :'continuity_scope_id'),
  'continuity_reference_not_found',
  'Advogado sem acesso ao lead2_scope não revoga a referência dele (recusa como "não encontrada", nunca "proibido")'
);
reset role;

select is(
  (select revoked_at from public.continuity_references where id = :'continuity_scope_id'::uuid),
  null, 'A tentativa recusada NÃO altera a referência — ausência de alteração comprovada'
);

-- vitor, o responsável de verdade pelo lead2_scope, revoga normalmente.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'vitor', 'role', 'authenticated')::text, true);
select revoke_continuity_reference(:'continuity_scope_id'::uuid);
reset role;

select isnt(
  (select revoked_at from public.continuity_references where id = :'continuity_scope_id'::uuid),
  null, 'O responsável de verdade pelo lead consegue revogar normalmente'
);

-- -----------------------------------------------------------------
-- 17) Outbox: publicação falha → cron reclama → republica → marca
--     published (item 9 da auditoria pós-dry-run).
-- -----------------------------------------------------------------

select ingest_form_event(
  :'endpoint'::uuid, 'cccccccc-0000-4000-8000-000000000001'::uuid, :'hash2'::bytea,
  'proto-outbox-fluxo-aaaa', '\xde'::bytea, '\x000000000000000000000000'::bytea,
  '\x00000000000000000000000000000000'::bytea, 'aes-256-gcm', '1', '{}'::jsonb, now()
) as ing_outbox \gset

select is((:'ing_outbox'::jsonb ->> 'outbox_id') is not null, true,
  'ingest_form_event devolve outbox_id para o evento novo (uso interno)');

select (:'ing_outbox'::jsonb ->> 'outbox_id') as outbox_fluxo \gset

select is(
  (select state::text from public.outbox where id = :'outbox_fluxo'::uuid),
  'pending', 'Outbox nasce pending'
);

-- Reconciliador reclama (mesma RPC que o cron chama).
select claim_outbox_batch(20, 120) as claimed1 \gset
select is(
  (select count(*)::int from jsonb_array_elements(:'claimed1'::jsonb) item
   where (item ->> 'outbox_id') = :'outbox_fluxo'),
  1, 'claim_outbox_batch reclama a outbox pendente'
);
select is(
  (select state::text from public.outbox where id = :'outbox_fluxo'::uuid),
  'publishing', 'Outbox reclamada fica publishing, com lock'
);

-- Publicação (simulada) FALHA: marca failed e agenda retry imediato.
select mark_outbox_failed(:'outbox_fluxo'::uuid, 'publish_failed', 0);
select is(
  (select state::text from public.outbox where id = :'outbox_fluxo'::uuid),
  'failed', 'Falha na publicação marca a outbox como failed (elegível ao reconciliador)'
);

-- O cron reclama de novo — mesma RPC, mesmo caminho de código do
-- primeiro reclamo: republica o que falhou.
select claim_outbox_batch(20, 120) as claimed2 \gset
select is(
  (select count(*)::int from jsonb_array_elements(:'claimed2'::jsonb) item
   where (item ->> 'outbox_id') = :'outbox_fluxo'),
  1, 'Segundo reclamo (o cron) pega a outbox que falhou — republica'
);
select is(
  (select attempts from public.outbox where id = :'outbox_fluxo'::uuid),
  2, 'Cada reclamo incrementa attempts (primeira tentativa + republicação)'
);

-- Republicação (simulada) dá certo: marca published.
select mark_outbox_published(:'outbox_fluxo'::uuid);
select is(
  (select state::text from public.outbox where id = :'outbox_fluxo'::uuid),
  'published', 'Republicação bem-sucedida marca a outbox como published'
);
select isnt(
  (select published_at from public.outbox where id = :'outbox_fluxo'::uuid),
  null, 'published_at é gravado'
);

-- Depois de published, um novo reclamo NÃO pega mais esta linha.
select claim_outbox_batch(20, 120) as claimed3 \gset
select is(
  (select count(*)::int from jsonb_array_elements(:'claimed3'::jsonb) item
   where (item ->> 'outbox_id') = :'outbox_fluxo'),
  0, 'Outbox published não é mais elegível ao reconciliador'
);

select * from finish();
rollback;
