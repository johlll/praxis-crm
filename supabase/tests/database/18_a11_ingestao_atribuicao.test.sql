-- pgTAP — A11: ingestão pública, outbox, worker, atribuição e retenção.
--
-- Escritório criado DENTRO desta transação (now() congelado), com
-- resultados esperados conhecidos. Nada depende do seed.
--
-- Funcionalidade nova: não existe "defeito anterior" a reproduzir aqui —
-- cada asserção descreve a garantia que a fase promete, não uma
-- regressão histórica inventada.

begin;
select plan(52);

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

select is(
  (select count(*)::int
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('ingest_form_event','process_form_event','resolve_form_endpoint')
     and has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  0, 'authenticated NÃO pode chamar a ingestão direto (pularia Turnstile e rate limit)'
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
\set hash1 '\x1111111111111111111111111111111111111111111111111111111111111111'
\set hash2 '\x2222222222222222222222222222222222222222222222222222222222222222'

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

-- unassign vigente torna o touchpoint não atribuído.
select id as link2 from public.touchpoint_demand_links
where touchpoint_id = :'tp1'::uuid and supersedes_id = :'link1'::uuid \gset
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
  'Uma única RAIZ por touchpoint (índice parcial único)'
);
select throws_ok(
  format($$insert into public.touchpoint_demand_links
             (workspace_id, touchpoint_id, opportunity_id, action, supersedes_id)
           values (%L::uuid, %L::uuid, %L::uuid, 'assign', %L::uuid)$$,
         :'ws', :'tp1', :'opp1', :'link1'),
  '23505',
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
  'call', 60, 'continuity', 'formulario', array['exemplo.test'], 'chave-continuidade-bbbb'
);
reset role;

select id as endpoint_cont from public.form_endpoints
where workspace_id = :'ws'::uuid and capture_mode = 'continuity' \gset

insert into public.continuity_references (
  workspace_id, token_hash, contact_id, lead_id, opportunity_id, purpose, expires_at
)
values (
  :'ws'::uuid, '\x3333333333333333333333333333333333333333333333333333333333333333'::bytea,
  :'contact1'::uuid, :'lead1'::uuid, :'opp1'::uuid, 'retomada', now() + interval '7 days'
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
select is(
  (select count(*)::int from public.touchpoints), 0,
  'Cliente autenticado não lê touchpoints direto (deny-all)'
);
select is(
  (select count(*)::int from public.webhook_events), 0,
  'Cliente autenticado não lê webhook_events direto (deny-all)'
);
reset role;

-- -----------------------------------------------------------------
-- 12) Mesclagem reparenteia touchpoints
-- -----------------------------------------------------------------

insert into public.contacts (id, workspace_id, type, name, created_by)
values ('c1100000-0000-4000-8000-000000000001', :'ws'::uuid, 'pf', 'Duplicado', :'otavio');

update public.touchpoints set contact_id = 'c1100000-0000-4000-8000-000000000001'
where id = :'tp_tardio'::uuid;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select merge_contacts(:'contact1'::uuid, 'c1100000-0000-4000-8000-000000000001'::uuid);
reset role;

select is(
  (select contact_id from public.touchpoints where id = :'tp_tardio'::uuid),
  :'contact1'::uuid, 'Mesclagem reparenteia o touchpoint para o contato vencedor'
);

select * from finish();
rollback;
