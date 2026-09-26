# A11 — Formulários próprios e atribuição multitoque · Handoff

Branch `feat/a11-forms-attribution`. **As 10 migrations foram aplicadas
com sucesso no projeto hospedado `praxis-crm-dev`** e validadas ao vivo
(§10). A PR #16 (documentação da A10) **não foi mesclada**.

Contrato completo: [`docs/decisoes/a11-ingestao-atribuicao.md`](docs/decisoes/a11-ingestao-atribuicao.md).
Exemplo de integração do navegador: [`docs/decisoes/a11-exemplo-integracao.md`](docs/decisoes/a11-exemplo-integracao.md).

**Este documento passou por QUATRO rodadas de auditoria pós-dry-run.** A
primeira encontrou 12 bloqueadores (idempotência incompleta, Turnstile
vazando IP, ausência de CORS, identidade forjável, continuidade nunca
emitida, `answers_config` decorativo, consentimento sem evidência, FKs
compostas anulando `workspace_id`, outbox nunca marcada, vazamento de
escopo em `get_lead_attribution`, cobertura de merge incompleta e este
próprio documento desatualizado) — todos corrigidos e registrados em
§2.1. A segunda rodada, feita em cima da correção da primeira (commit
`fe5a05b`), encontrou mais 8 — desta vez incluindo dois defeitos que a
PRÓPRIA correção da primeira rodada introduziu (hash de continuidade
incompatível entre emissão e verificação; `idempotency_key` do Turnstile
sem formato de UUID) — corrigidos e registrados em §2.2. A terceira
rodada, feita em cima da correção da segunda (commit `8ecdec0`), encontrou
mais 2 — de novo incluindo um defeito que a PRÓPRIA correção da segunda
rodada introduziu (`listFormEndpoints()` repetindo, na LEITURA, o mesmo
antipadrão de fallback silencioso que o item 4 da segunda rodada já tinha
corrigido na ESCRITA) — corrigidos e registrados em §2.3. A quarta rodada,
feita em cima da correção da terceira (commit `c049bbd`), encontrou mais 1
— de novo uma variação do que a PRÓPRIA correção da terceira rodada não
cobriu (a projeção por alcance do item 1 da 3ª rodada tratou
`opportunity_id is null` como "sem o que vazar", mas uma entrada
`unassign` narra a desvinculação de um vínculo ANTERIOR, que pode
pertencer a outro lead) — corrigido e registrado em §2.4. Todos os 23,
somados, foram corrigidos nesta branch, sempre em migrations **ainda
pendentes** (nenhuma foi aplicada em banco hospedado).

## 1. O que foi entregue

| Bloco | Onde |
|---|---|
| Configuração de endpoints por workspace, com ciclo de vida próprio, lista de campos validada e tela de EDIÇÃO | `form_endpoints` + `form_endpoint_keys`, `/configuracoes/formularios`, `private.assert_answers_config` |
| Rota pública, com CORS estrito por origem exata (protocolo/porta conferidos) e recusa de origem não autorizada no servidor | `src/app/api/forms/[endpointKey]/route.ts`, `src/server/ingest/cors.ts` |
| Turnstile (hostname, action, sem IP, `idempotency_key` UUID determinística pelo token, token até 2048 caracteres), rate limit, honeypot, limite de corpo, schema estrito e versionado | `src/server/ingest/*` |
| Evento idempotente (hash cobre occurredAt/continuidade/consentimento), payload cifrado, diagnóstico sanitizado, `answers_config_snapshot` validado em três camadas | `webhook_events`, `ingest_form_event` |
| Outbox marcada atomicamente pela publicação inicial + Inngest (retries alinhados a `dead`) + cron reconciliador | `outbox`, `/api/inngest`, `/api/cron/outbox` |
| Worker idempotente com materialização transacional; identidade só por continuidade (token servidor, hash-only, mesma representação na emissão e na verificação) | `process_form_event`, `issue_continuity_reference`, `revoke_continuity_reference` |
| Touchpoints append-only e vínculo versionado, com atribuição de `get_lead_attribution` seguindo o vínculo EFETIVO (migra com a correção, nunca vaza para o lead de origem) | `touchpoints`, `touchpoint_demand_links` |
| Referências de continuidade (emissão/revogação reais, revogação com alcance por registro) e evidência de consentimento (com `text_hash`) | `continuity_references`, `consent_evidence` |
| Integração com mesclagem/desmesclagem (`touchpoints`, `continuity_references` com detecção de USO/REVOGAÇÃO posterior via `updated_at`, `consent_evidence`) | `20260921100800_a11_merge_integration.sql` |
| AttributionPanel no Perfil 360, com alcance por REGISTRO (não por contato), e emissão de link de continuidade (reutilizável, não "de uso único") | aba "Origem" em `/leads/[id]` |
| Primeiro/último toque e conversão no painel, com filtro de origem | `get_dashboard_attribution`, `AttributionCard` |
| Retenção de 30 dias, tombstone e `expired_unprocessed` | `purge_expired_webhook_events`, `/api/cron/retention` |

## 2.1 Primeira rodada — 12 defeitos e a correção

| # | Defeito | Correção |
|---|---|---|
| 1 | Hash de idempotência não cobria `occurredAt`, token de continuidade nem texto de consentimento | `businessContent()` passa a incluir `occurredAt`, SHA-256 do token e SHA-256 do texto aceito; exemplo de integração persiste `occurredAt` junto do `sourceEventId` |
| 2 | Turnstile recebia HMAC do IP em `remoteip` (campo é IP real) e usava `sourceEventId` como `idempotency_key` (estável entre tokens diferentes) | `remoteip` removido; `idempotency_key` derivada do token, dentro do verificador |
| 3 | `/api/forms/[endpointKey]` sem CORS — sem preflight, sem `Access-Control-Allow-Origin` | `OPTIONS` + cabeçalhos em toda resposta (sucesso e erro) para origem autorizada; nunca `"*"` |
| 4 | `externalIdentity` no corpo público permitia reivindicar QUALQUER contato do workspace | Campo removido do contrato; identidade confiável só por referência de continuidade |
| 5 | `continuity_references` existia mas nada emitia token algum | `issue_continuity_reference`/`revoke_continuity_reference`, FK que garante contato/lead da mesma cadeia, finalidade validada no processamento |
| 6 | `answers_config` só validava a FORMA (`{fields: [...]}`), não o conteúdo | `private.assert_answers_config` no banco + Zod na borda/worker, com snapshot por evento |
| 7 | `granted` sem evidência era aceito; `text_hash` nunca era calculado | Zod exige `textVersion`+`acceptedText` para `granted`; `text_hash` calculado e gravado |
| 8 | FKs compostas com `ON DELETE SET NULL` sem lista de colunas anulariam `workspace_id` | `ON DELETE SET NULL (coluna_opcional)`, sintaxe PG15+ |
| 9 | Outbox nunca marcada pela publicação inicial (nem sucesso nem falha); retries do Inngest desalinhados do limiar de `dead` | `mark_outbox_published`/`mark_outbox_failed` chamadas após a tentativa inicial; `retries: 9` alinhado a `attempts + 1 >= 10` |
| 10 | `get_lead_attribution` vazava touchpoints de OUTRO lead do mesmo contato | `sequence` escopada por `t.lead_id`, não `t.contact_id` (revisto na 2ª rodada — item 5) |
| 11 | Cobertura de merge/unmerge não cobria `continuity_references`/`consent_evidence`; relatório anterior invertia a lista de tabelas reparentadas | pgTAP cobrindo as três tabelas, undo, e conflito por alteração posterior (revisto na 2ª rodada — item 6) |
| 12 | Este documento e a descrição da PR estavam desatualizados | Reescritos |

## 2.2 Segunda rodada — 8 defeitos e a correção

Feita em cima do commit `fe5a05b` (CI verde da primeira rodada). Dois
destes defeitos (1 e 2) foram introduzidos pela PRÓPRIA correção
anterior — registrados sem eufemismo.

| # | Defeito | Correção |
|---|---|---|
| 1 | `issue_continuity_reference` gravava o hash dos BYTES aleatórios crus; o worker sempre calculou o hash do TEXTO base64url devolvido ao cliente. Toda referência emitida era inutilizável — o token nunca era reconhecido de volta | `digest(convert_to(v_token_url, 'utf8'), 'sha256')` — mesma representação (texto) dos dois lados. Teste de emissão/segunda-interação reescrito para derivar o hash do TOKEN REALMENTE DEVOLVIDO pela RPC, nunca lido de `token_hash` no banco |
| 2 | `idempotency_key` do Turnstile era SHA-256 em hex (64 caracteres) — a Cloudflare documenta o campo como UUID; `turnstileToken` aceitava até 4096 caracteres (contrato oficial: 2048) | UUID v4 determinístico derivado dos 16 primeiros bytes do SHA-256 do token; `turnstileToken` limitado a `max(2048)` |
| 3 | `revoke_continuity_reference` nunca aplicava `lead_accessible_to_role` ao lead da própria referência — um advogado sem acesso ao lead conseguia revogar (teria conseguido reemitir) a referência de outro responsável | Resolve o lead da referência e aplica a mesma checagem de `issue_continuity_reference`; fora do alcance responde `continuity_reference_not_found` |
| 4 | Config/snapshot de `answers_config` PRESENTE mas corrompido virava `{fields: []}` em silêncio, na borda e no worker — tratando corrupção como "sem campo configurado" | Três camadas recusam fechado: borda (`form_endpoint_misconfigured`), `ingest_form_event` (SQL, `assert_answers_config` no snapshot), worker (`config_snapshot_invalid`, código permanente, nunca chama `process_form_event`) |
| 5 | `get_lead_attribution` (já corrigido na 1ª rodada para escopar por `lead_id` de origem) vazava a oportunidade e o histórico do lead de DESTINO quando um touchpoint era corrigido, via `correct_touchpoint_demand_link`, para a oportunidade de OUTRO lead do mesmo contato | Escopo passou a seguir o VÍNCULO EFETIVO (`coalesce(oportunidade_vigente.lead_id, t.lead_id)`), não a origem imutável — o touchpoint "migra" de sequência junto com a correção |
| 6 | `continuity_references` é mutável (`used_count`/`last_used_at`/`revoked_at`), mas o merge só detectava a linha ter sido APAGADA — usar ou revogar a referência entre o merge e o desfazer passava batido | Coluna `updated_at` (com trigger) + mesmo mecanismo de conflito por versão que `leads`/`clients` já usam |
| 7 | CORS conferia só o `hostname` (protocolo/porta arbitrários passavam); `Origin` presente e não autorizado não era recusado no servidor — só ficava sem cabeçalho de resposta | Fora de `localhost`/`127.0.0.1`/`::1`, só HTTPS na porta padrão; `Origin` presente e fora da lista é recusado (`origin_not_allowed`, 403) ANTES de gravar qualquer coisa |
| 8 | Tela de edição de endpoint não existia (só criar/desativar/rotacionar); texto da UI de continuidade dizia "uso único", mas a referência é reutilizável — só o VALOR do token aparece uma vez | `/configuracoes/formularios` ganhou "Editar", pré-preenchido, com e2e provando persistência depois de recarregar; texto corrigido |

## 2.3 Terceira rodada — 2 defeitos e a correção

Feita em cima do commit `8ecdec0` (CI verde da segunda rodada). O item 2
é uma variação do mesmo antipadrão que o item 4 da segunda rodada já
tinha corrigido — desta vez na LEITURA, não na escrita.

| # | Defeito | Correção |
|---|---|---|
| 1 | Excluir o touchpoint fora do alcance (item 5 da 2ª rodada) não bastava: o registro do touchpoint que PERTENCE (por ter migrado de outro lead) ainda devolvia `lead_id`/`original_opportunity_id` do lead de ORIGEM, e o `history` completo — incluindo o vínculo anterior à correção, com motivo e nome de quem corrigiu, tudo do lead de origem | Projeção por alcance DENTRO da RPC: `lead_id` sempre é o lead consultado; `original_opportunity_id` só aparece quando pertence a ele; `history` só traz entradas cuja `opportunity_id` é nula ou pertence ao lead consultado — testado nos dois sentidos (transferência e desvincular depois da transferência) |
| 2 | `listFormEndpoints()` fazia fallback silencioso de `answers_config` corrompido para `{fields: []}` — a tela de edição (item 8 da 2ª rodada) nascia PREENCHIDA com esse fallback, e salvar qualquer outra alteração reenviava `{fields: []}` como a configuração "atual", apagando de verdade os campos gravados; além disso, `private.assert_answers_config()` (SQL) aceitava `maxLength` fracionário (`1.5` passava no banco, só falhava no Zod da aplicação) e media `label` sem trimar (divergindo do Zod na direção oposta) | Leitura inteira agora LANÇA `FormEndpointsLoadError` quando algum `answers_config` não passa no schema (mesmo contrato de erro das outras `*LoadError`); SQL alinhado ao Zod com `trunc()` para `maxLength` e `char_length(btrim(...))` para `label` |

## 2.4 Quarta rodada — 1 defeito e a correção

Feita em cima do commit `c049bbd` (CI verde da terceira rodada). Variação
do que a PRÓPRIA correção do item 1 da 3ª rodada deixou passar.

| # | Defeito | Correção |
|---|---|---|
| 1 | A projeção de `history` (item 1 da 3ª rodada) liberava qualquer entrada com `opportunity_id` nulo incondicionalmente, tratando "unassign" como "nunca referencia oportunidade, então não tem o que vazar" — mas o `reason`/`actor_name` de um `unassign` narram a desvinculação do vínculo ANTERIOR (a entrada que ele supersede), que pode pertencer a outro lead. Um advogado com acesso só ao lead de DESTINO de uma transferência via `correct_touchpoint_demand_link` enxergava o motivo de uma desvinculação feita no lead de ORIGEM (e vice-versa, na volta) | CTE recursiva (`chain`) caminha `touchpoint_demand_links` da raiz até a ponta carregando `owning_opportunity_id`: a própria `opportunity_id` quando não nula, ou a última vista na cadeia quando nula. O alcance de cada entrada de histórico passa a ser o de `owning_opportunity_id` (ou o lead de origem do touchpoint, se nunca houve vínculo) — nunca mais "ninguém". Testado nos dois sentidos: desvincular em A e depois transferir para B (motivo de A não aparece para B); transferir para B e depois desvincular de volta para A (motivo de B não aparece para A). pgTAP escrito ANTES da correção, confirmado falhando contra o código anterior, depois passando |

Nenhuma migration **já aplicada** foi editada em nenhuma das quatro
rodadas. Como nenhuma migration da A11 havia sido aplicada em banco
hospedado, todas as correções entraram **dentro das próprias migrations
pendentes** (não como camada nova por cima) — a lista continua com 10
arquivos, os mesmos da primeira rodada.

## 3. Decisões que o código real obrigou a tomar

Registradas por extenso em `docs/decisoes/a11-ingestao-atribuicao.md` §16.
Resumo:

1. **Bloco de origem é função separada de `get_dashboard`.** A unidade é
   oportunidade, não lead. Filtrar "leads recebidos" por origem trocaria a
   unidade no meio do caminho. O payload declara `unit` e a interface diz
   isso em português.
2. **Telefone brasileiro sem código de país** (achado por teste): prefixar
   `+` em `11988887777` produzia `+11988887777` — código de país 1 (EUA).
   `toE164BR()` só assume Brasil quando o formato é inequívoco; fora disso
   devolve `null`.
3. **Cliente do Inngest inerte na construção** (achado pelo build): exigir
   configuração no escopo do módulo derrubava o BUILD inteiro num ambiente
   sem as variáveis. A falha fechada passou para a publicação e para o
   atendimento da rota, por requisição.
4. **`touchpoints.position` pode repetir depois de uma mesclagem.** Nada
   depende disso: ordenação e atribuição usam
   `(normalized_occurred_at, received_at, id)`.
5. **FK deferrable de `continuity_references` precisou ser `INITIALLY
   DEFERRED`, não `INITIALLY IMMEDIATE`** (achado pelo CI, não só na
   revisão, na primeira rodada): a suposição inicial era que a ordem de
   `merge_contacts()`/`unmerge_contact()` (leads reparentados antes de
   `continuity_references`) nunca criaria violação transitória, então
   `INITIALLY IMMEDIATE` foi tentado primeiro para preservar erro cedo em
   uso normal e em pgTAP. Errado: o CI reproduziu a violação de verdade —
   `update or delete on table "leads" violates foreign key constraint
   "continuity_references_lead_contact_fkey"` — porque o fim da instrução
   que reparenteia `leads` já não encontra mais o par antigo, enquanto
   `continuity_references` ainda não foi atualizada. Corrigido para
   `INITIALLY DEFERRED` (checagem só no commit). Consequência aceita:
   dentro de pgTAP (que só faz `rollback`) esta constraint específica não
   dispara sozinha — teria que ser forçada com `set constraints ...
   immediate` dentro do próprio teste.
6. **Permissão de emitir/revogar continuidade (`continuity.issue`) segue a
   faixa de `lead.edit`/`opportunity.edit`** (owner/admin/manager/lawyer/
   sales), não a faixa mais restrita de `attribution.correct`: mandar um
   link de continuação ao cliente é uma ação do dia a dia de quem já atua
   na demanda, não uma reescrita de atribuição.
7. **`now()` é fixo durante toda a transação de um arquivo pgTAP** (mesmo
   padrão já documentado em `08_a3_merge.test.sql`): os testes de
   "continuity_references usada/revogada depois do merge" (item 6 da 2ª
   rodada) precisaram desligar o trigger de `updated_at` e backdatar a
   linha manualmente para simular a passagem real de tempo entre a
   mesclagem e a ação — sem isso, os dois timestamps seriam idênticos e o
   cenário nunca apareceria dentro de uma única transação de teste.

## 4. Segurança

- **Workspace sempre derivado do endpoint/lead no servidor.** O navegador
  nunca informa workspace.
- **`service_role` restrita por lint** a `src/app/api/{forms,webhooks,cron,inngest}/**`.
- **Nenhum GRANT de tabela** para `anon`/`authenticated` nas oito tabelas
  novas: tudo passa por função `SECURITY DEFINER` com `search_path` fixo.
- **`ingest_form_event`, `process_form_event` e `resolve_form_endpoint`
  não são concedidas a `authenticated`** — um visitante com a chave
  publicável não consegue pular Turnstile e rate limit chamando a RPC.
- **IP nunca é persistido e nunca sai para terceiros.** Só o HMAC (chave
  própria) vai para o rate limit; o Turnstile nunca recebe o IP — nem
  completo, nem como HMAC.
- **Identidade confiável só por token de continuidade**, emitido pelo
  servidor e guardado só por hash — com a MESMA representação (texto) na
  emissão e na verificação (item 1 da 2ª rodada) — e nenhum campo do
  corpo público permite reivindicar um contato existente.
- **CORS confere origem exata, protocolo e porta** (item 7 da 2ª rodada);
  `Origin` presente e não autorizado é recusado no SERVIDOR, não só
  omitido do cabeçalho de resposta.
- **Chave de cifra exclusiva da A11**, separada de contatos, blind index e
  cookie. Sem ela, a ingestão para **antes de qualquer gravação**.
- **Configuração de endpoint restrita a owner/admin**; correção de vínculo
  a owner/admin/manager; emissão/revogação de continuidade a owner/admin/
  manager/lawyer/sales, ambas com alcance por registro — todas com
  auditoria.
- **Alcance por registro em `get_lead_attribution`**: escopado pelo
  vínculo EFETIVO, não pelo lead de origem imutável — não vaza id nem
  histórico do lead de destino de uma correção entre leads (item 5 da 2ª
  rodada), e o REGISTRO de um touchpoint migrado é projetado por alcance
  campo a campo — `lead_id`, `original_opportunity_id` e cada entrada de
  `history` (item 1 da 3ª rodada). Cada entrada de `history` é escopada
  pelo vínculo que ela desfez (ou pelo próprio, se `assign`), não por
  `opportunity_id is null` — uma entrada `unassign` não deixa de ter
  alcance só por não referenciar oportunidade nenhuma (item 1 da 4ª
  rodada).
- **`answers_config`/snapshot corrompidos falham fechados em quatro
  camadas** — borda, `ingest_form_event`, worker (item 4 da 2ª rodada) e
  agora também a LEITURA (`listFormEndpoints`, item 2 da 3ª rodada) —
  nenhuma delas finge que uma configuração corrompida é `{fields: []}`.
- **`private.assert_answers_config()` (SQL) alinhado ao Zod da
  aplicação**: `maxLength` precisa ser inteiro, `label` é medido depois
  de trimado — nas duas direções, o banco nunca é mais permissivo nem
  mais estrito que a própria borda que ele deveria só reforçar (item 2 da
  3ª rodada).

## 5. Testes

**Convenção desta seção:** "confirmado localmente" = a suíte rodou nesta
máquina e o resultado abaixo é o que ela reportou. "Contagem estática" =
contagem de `it(`/`test(`/asserções no código-fonte, sem execução — esta
máquina não tem Docker, então `supabase start`/pgTAP/e2e não rodam aqui;
quem confirma essas contagens é o CI (GitHub Actions), efêmero, que sobe
Postgres via Docker no runner.

| Suíte | Testes | Confirmado por |
|---|---|---|
| `npm test` (Vitest, todos os arquivos) | **408/408 passando** | execução local **e** CI (commit `7ba7d1b`) |
| — dos quais, arquivos `tests/unit/a11-*.test.ts` | 8 arquivos (novo na 3ª rodada: `a11-form-endpoints-list-error.test.ts`) | execução local |
| `supabase/tests/database/18_a11_ingestao_atribuicao.test.sql` | **146/146 asserções** (140 depois da 3ª rodada, 127 depois da 2ª, 113 depois da 1ª, 70 antes dela) | **CI**, commit `7ba7d1b` — suíte pgTAP completa: 746/746 |
| Isolamento entre workspaces | **26/26** | **CI**, commit `7ba7d1b` |
| `tests/e2e/forms-attribution.spec.ts` | **15 testes** (sem novo teste e2e desde a 3ª rodada — cobertura nova ficou em pgTAP) | **CI**, commit `7ba7d1b` — suíte e2e completa: 76/76 |

Cobertura nova/ampliada pela segunda rodada, por item: hash de
continuidade recomputado a partir do token REALMENTE devolvido, nunca
lido do banco (1); formato UUID da `idempotency_key`, estabilidade e
diferença entre tokens (2); dois advogados/leads revogando referência
alheia, sem alteração (3); `answers_config`/snapshot corrompidos
recusados em três camadas, zero eventos processados (4); mesmo contato,
dois leads, correção do touchpoint para a oportunidade do outro lead, sem
vazamento de id/histórico (5); continuity_references usada ou revogada
depois do merge causando `undo_conflict` (6); HTTP×HTTPS, porta
diferente, `Origin` não autorizado recusado antes de gravar (7); edição
de endpoint preenchida e persistida depois de recarregar (8).

Cobertura nova da terceira rodada, por item: registro migrado projetado
campo a campo (`lead_id`, `original_opportunity_id`, `history` filtrado),
nos dois sentidos — transferência entre leads e desvincular depois dela
(1); `listFormEndpoints()` lançando em vez de mascarar config corrompida,
`maxLength` fracionário e `label` não trimado alinhados entre SQL e Zod,
nas duas direções (2).

Cobertura nova da quarta rodada, por item: motivo IDENTIFICÁVEL num
`unassign`, reproduzindo o vazamento nos dois sentidos — desvincular no
lead de origem e depois transferir para o lead de destino (motivo do
lead de origem não aparece para quem só acessa o destino); transferir e
depois desvincular de volta (motivo do lead de destino não aparece para
quem só acessa a origem) — e uma checagem positiva de que o histórico
LEGÍTIMO de cada lado continua visível, sem nada retirado além do que
vazava (1). Os 4 pgTAP novos foram confirmados falhando contra o código
anterior à correção (CI, run 36030034204) antes de passarem contra a
correção (CI, run 36030604559, commit `7ba7d1b`).

Os e2e e pgTAP das rodadas anteriores seguem cobertos — nenhuma asserção
foi enfraquecida ou removida, só reescrita quando o próprio mecanismo que
ela verificava mudou (ex.: o hash da referência de continuidade).

## 6. Validação local nesta sessão

| Verificação | Resultado |
|---|---|
| `npm run typecheck` | limpo |
| `npm run lint` | limpo |
| `npm test` | **408/408** (um arquivo alheio, `client-detail-error.test.ts`, deu timeout uma vez sob contenção de recursos ao rodar a suíte inteira e passou limpo ao rodar sozinho — não toca nada desta correção) |
| `npm run build` | passa sem nenhuma variável da A11 — só as rotas de ingestão e jobs respondem `503` sanitizado |

**Docker continua indisponível nesta máquina**, então `supabase start`,
pgTAP, `db:types:check` (comparação do gerador) e e2e **não foram
executados localmente nesta sessão**. Nenhuma coluna nova foi adicionada
nesta rodada — `src/server/types/database.ts` não precisou de edição
manual; é o CI, com Docker, que confirma isso (`db:types:check`).

## 7. Infraestrutura ainda NÃO ativada

Nada externo foi configurado nesta fase (não estava autorizado):

- Turnstile (site key/secret) — não criado;
- Upstash Redis — não criado;
- Inngest (app, event key, signing key) — não criado;
- cron da Vercel para `/api/cron/outbox` e `/api/cron/retention` — **as
  funções, os endpoints protegidos e os testes existem**; só o
  agendamento depende da infraestrutura;
- variáveis de ambiente em Preview/Produção — não preenchidas.

Enquanto isso, em produção e preview a captação **falha fechada** com
`503`: não existe captação pública real ativada.

## 8. Migrations (todas novas, forward-only — 10 arquivos)

```
20260921100000_a11_enum_extensions.sql      activity_source += form_intake
                                            consent_purpose += formulario_contato
20260921100100_a11_schema.sql               8 tabelas + tipos + activities.source_webhook_event_id + continuity_references.updated_at
20260921100200_a11_rls.sql                  RLS habilitada e forçada, deny-all
20260921100300_a11_private_functions.sql    atribuição (ponta vigente, elegibilidade)
20260921100400_a11_config_functions.sql     CRUD de endpoint (owner/admin) + validação de answers_config (maxLength inteiro, label trimado)
20260921100500_a11_ingestion_functions.sql  ingestão (com assert_answers_config no snapshot), outbox, worker
20260921100600_a11_attribution_functions.sql correção de vínculo (por vínculo efetivo, projetado por alcance) + emissão/revogação de continuidade (hash de texto, alcance por registro)
20260921100700_a11_retention_functions.sql  retenção e alertas
20260921100800_a11_merge_integration.sql    merge/undo estendidos, continuity_references com updated_at
20260921100900_a11_revoke_default_execute.sql revoke explícito de anon/authenticated
```

Nenhuma migration aplicada **em banco hospedado** foi editada.
`supabase/migrations/20260917110000` (A10) continua intocada.

## 9. Pendências e limitações honestas (atualizado)

- **Emissão de link de continuidade tem UI mínima** (botão no Perfil 360
  que mostra o token uma vez) — não há reenvio por e-mail automático nem
  listagem de referências emitidas/revogadas por lead; isso ficaria para
  uma fase de UX dedicada, se o produto precisar.
- **Retenção de payload cifrado**: `occurred_at` também é limpo no
  vencimento (é dado declarado pelo visitante). `normalized_occurred_at`
  permanece, porque é o que a atribuição usa e não identifica ninguém.
- A validação visual em preview real (navegador) das telas de configuração
  de formulário e do AttributionPanel **foi concluída** nesta rodada — ver
  §11.
- **Achado nesta rodada**: `/api/cron/outbox` e `/api/cron/retention`
  devolvem `401 unauthorized` quando a configuração A11 está incompleta
  (Turnstile/Upstash/Inngest ausentes), porque `authorized()` engole
  qualquer `IngestConfigError` de `getIngestConfig()` como "não
  autorizado" antes de checar o `CRON_SECRET`. Isso diverge do padrão do
  resto do sistema (`/api/forms/[endpointKey]` devolve `503
  service_unavailable` no mesmo cenário — falha fechada, mas com
  diagnóstico correto). Não é um bug de segurança (a rota segue fechada
  nos dois casos), mas é enganoso: um operador vendo `401` conclui
  "`CRON_SECRET` errado" quando na verdade falta configurar Turnstile/
  Upstash/Inngest. Correção sugerida, não aplicada nesta rodada: mover a
  checagem do `CRON_SECRET` para antes de `getIngestConfig()` completo,
  ou capturar `IngestConfigError` separadamente e devolver `503`.
- **Achado nesta rodada (UX)**: no `AttributionPanel`, o botão
  "Desvincular" de `correct_touchpoint_demand_link` falha silenciosamente
  quando o dropdown "Vincular a" está com seu valor padrão (a oportunidade
  atualmente vinculada) — a RPC recusa `unassign` com `opportunity_id`
  não nulo (`opportunity_not_allowed_on_unassign`), e a mensagem de erro
  só aparece se o usuário não navegar/recarregar antes de notar. Funciona
  corretamente assim que o dropdown é trocado para "Não atribuído" antes
  de clicar "Desvincular" — mas o valor padrão do próprio dropdown induz
  o erro. Corrigível na UI: ignorar o valor do dropdown quando
  `action=unassign`, ou desabilitar/ocultar o dropdown nesse caso.

## 10. Validação pós-migration em banco hospedado (`praxis-crm-dev`)

As 10 migrations listadas em §8 foram aplicadas com `supabase db push
--linked` sem erro; todas aparecem como `remote OK` em `supabase migration
list --linked`. Validação feita por impersonação de papel
(`set local role authenticated` + `request.jwt.claims`) contra o banco
real, com registros fictícios dedicados no workspace de QA existente
("Escritório QA Praxis", `c62151fe-7adb-4a02-9001-8674e8209181`), sempre
confirmando persistência por **leitura em invocação separada** da escrita
— nunca só visibilidade transacional.

**Schema e permissões:**
- 8 tabelas novas com RLS habilitada **e forçada**; zero GRANT de tabela
  para `anon`/`authenticated` (tudo via RPC).
- 12 funções esperadas existem; todas `SECURITY DEFINER` exceto
  `private.assert_answers_config` (helper de validação pura, correto por
  design).
- `anon` sem EXECUTE em nenhuma função sensível; `ingest_form_event`,
  `process_form_event`, `resolve_form_endpoint`, `mark_outbox_published`,
  `mark_outbox_failed`, `purge_expired_webhook_events` corretamente **não**
  concedidas a `authenticated` (só `service_role`).
- Enums estendidos como esperado (`activity_source += form_intake`,
  `consent_purpose += formulario_contato`, `touchpoint_link_action` novo).

**Funcional, com usuários reais do workspace de QA:**
- `create_form_endpoint`/`update_form_endpoint`: funcionam, incluindo
  persistência de campo extra numa edição; `insufficient_permission`
  corretamente devolvido para papel `lawyer`.
- `get_lead_attribution`/`correct_touchpoint_demand_link`: sequência de
  touchpoints, histórico e atribuição corretos; `unassign` refletido em
  leitura separada com `effective_opportunity_id` tornando-se `null`.
- Atividades (A6, não alterada estruturalmente pela A11): `create_activity`
  e `complete_activity` seguem funcionando, `lock_version` incrementando.
- **Mesclar/desfazer contatos**: `merge_contacts` reparenta corretamente um
  touchpoint do contato perdedor para o vencedor (confirmado por leitura
  separada); `unmerge_contact` reverte tudo — `merged_into_contact_id`
  volta a `null` e o touchpoint volta ao contato original.
- **Ingestão (`ingest_form_event`/`process_form_event`, como
  `service_role`)**: reenvio com mesmo `source_event_id` e mesmo
  `content_hash` não duplica evento nem outbox (`created: false`, mesmo
  `webhook_event_id`); mesmo `source_event_id` com `content_hash`
  diferente é recusado com `idempotency_payload_conflict`;
  `process_form_event` cria contato → lead → oportunidade → touchpoint →
  atividade numa só chamada; reprocessar o mesmo evento devolve
  `already_processed: true` com os mesmos IDs, sem duplicar nada.

**Não coberto nesta rodada:** validação visual via navegador (feita na
rodada seguinte, §11) e configuração dos serviços externos (Turnstile,
Upstash, Inngest — continuam pendentes, §7).

## 11. Validação visual em navegador (rodada seguinte)

Feita com Playwright contra o deployment de preview real
(`praxis-au1cxrwsu-johllls-projects.vercel.app`, protegido por Vercel
SSO — acesso via `x-vercel-protection-bypass` + `x-vercel-set-bypass-cookie`,
secret de automação do próprio projeto). Login com a conta `owner` de
`praxis-demo-a10.txt` (`demo-a10.owner@praxis.test`); as credenciais de
`praxisqa1`/`praxisqa2` (workspace "Escritório QA Praxis", usado nos
testes SQL de §10) continuam sem senha registrada em arquivo local —
não foram necessárias nesta rodada.

**Workspace dedicado criado pelo fluxo normal do app**: "QA A11
Validacao Visual" (`9c912c4e-0ebc-4c6e-a148-9e56a091781c`), via
`/onboarding` — nota: o link "Criar novo workspace" do menu do sidebar
aponta para `/onboarding`, que só é acessível a quem NÃO tem workspace
ativo (`src/app/onboarding/page.tsx` redireciona quem já tem um); para
um usuário que já é membro de outro workspace, o link está
funcionalmente quebrado. Contornado limpando o cookie
`praxis_active_workspace` antes de navegar — nenhum outro workspace,
registro ou senha foi alterado.

**Método de cada verificação, explicitado conforme pedido:**

| O quê | Como |
|---|---|
| Criar/editar endpoint de formulário, preservando campo extra | **Navegador** (Playwright) — formulário criado com campo `telefone_alternativo`, editado adicionando `melhor_horario`; ambos confirmados presentes após `reload()` real da página |
| Domínio permitido do CORS | **Navegador** — preenchido com o hostname estável do branch (ver §12); não testado o preflight HTTP real (isso exige Turnstile configurado, ver achado sobre `401`) |
| Acesso recusado por papel (owner-only) | **Navegador** — `demo-a10.lawyer` autenticado no workspace de QA, `GET /configuracoes/formularios` devolve `404` (não `403`, conforme ADR de alcance) |
| AttributionPanel — leitura | **Navegador** — dados reais criados via **SQL/RPC direto** (`ingest_form_event`+`process_form_event`, não passou pela rota HTTP pública nem pelo Inngest), depois visualizados na aba "Origem" do Perfil 360 |
| AttributionPanel — correção de vínculo (unassign) | **Navegador**, ação de UI real (Server Action → RPC `correct_touchpoint_demand_link`); confirmado por **SQL** (leitura separada em `touchpoint_demand_links`) e por **novo carregamento da página** |
| AttributionPanel — acesso por papel | **Navegador** — `demo-a10.lawyer` vê a aba "Origem" e os dados (leitura permitida), mas os botões "Corrigir associação"/"Gerar link" não aparecem (ação restrita a owner/admin/manager) |
| Reconciliação de outbox (falha → preservação → restauração → republicação → processamento único) | **SQL/RPC direto** (`claim_outbox_batch`, `mark_outbox_failed`, `mark_outbox_published`, `process_form_event`) — **não** foi feito via a rota HTTP `/api/cron/outbox` nem via Inngest real (ver achado do `401` abaixo) |

**Explicitamente NÃO testado nesta rodada** (ficaria sendo prova de algo que não foi exercitado): Turnstile, CORS preflight real, rate limit, honeypot, publicação real no Inngest, disparo automático por agendador. Essas camadas vivem na rota HTTP pública e nos serviços externos, nenhum dos quais está configurado ainda.

## 12. Infraestrutura externa — preparação para execução

**URLs estáveis definidas** (o hostname por-deploy muda a cada push; o
alias de branch não):

- Formulário de QA: `https://praxis-crm-git-feat-a11-forms-attribution-johllls-projects.vercel.app/qa/formulario-a11` — página nova em `src/app/qa/formulario-a11/`, fora da landing da Vizentini, só para exercitar o contrato público (réplica do exemplo em `docs/decisoes/a11-exemplo-integracao.md`) contra este preview.
- Callback do Inngest: `https://praxis-crm-git-feat-a11-forms-attribution-johllls-projects.vercel.app/api/inngest`
- Domínio a declarar no Turnstile e em "Domínios permitidos" do endpoint: `praxis-crm-git-feat-a11-forms-attribution-johllls-projects.vercel.app`

**Vercel SSO Protection e automação**: este projeto tem `ssoProtection.deploymentType = "all_except_custom_domains"` — protege todo deployment em `*.vercel.app` (preview e produção sem domínio próprio), mas **não** protege domínios customizados. Ou seja, em produção real com domínio da Vizentini, isso não é um problema; só afeta os testes contra `*.vercel.app` de agora. Resolvido com **Protection Bypass for Automation** (recurso nativo da Vercel): secret de automação (`VERCEL_AUTOMATION_BYPASS_SECRET`, já existia neste projeto) usado via header/query `x-vercel-protection-bypass`, com `x-vercel-set-bypass-cookie: true` para navegação subsequente sem repetir o parâmetro. O Inngest e o workflow do GitHub Actions (§13) usam essa mesma query string na URL configurada.

**Segredos próprios da A11**: gerados e configurados no ambiente Preview (branch `feat/a11-forms-attribution`) — `A11_IP_HMAC_KEY`, `A11_PAYLOAD_ACTIVE_KEY_VERSION`+`A11_PAYLOAD_KEY_VERSIONS`, `CRON_SECRET`, e `SUPABASE_SECRET_KEY` (que estava vazia mesmo localmente — puxada da chave `service_role` real do projeto via `supabase projects api-keys --reveal`). Confirmados salvos corretamente por trigger de redeploy + achado do `401` explicado abaixo (que provou que o `CRON_SECRET` está sendo lido — só falta o resto da config para a rota responder 200).

**Achado ao configurar via `vercel env add | stdin` num pipe do Git Bash**: os primeiros 5 valores gravados vieram truncados (não é possível confirmar o tamanho de uma env var "Sensitive" via `env pull`, que sempre mascara — só foi possível perceber pelo teste HTTP real dando `401`). Corrigido regravando com `< arquivo` em vez de pipe. **Se for configurar segredos futuros via CLI, prefira sempre redirecionamento de arquivo a pipe.**

### Turnstile, Upstash, Inngest — inventário (sem contratar nada nesta rodada)

| Serviço | Env var no praxis-crm | Custo/limite confirmado (fonte oficial) | Quem faz |
|---|---|---|---|
| Cloudflare Turnstile | `TURNSTILE_SECRET_KEY` (server); a site key pública vai no HTML da página de QA/landing, não em env var do servidor | Gratuito, sem cap de volume publicado no Standard; 20 widgets/conta, 10 hostnames/widget ([blog.cloudflare.com/turnstile-ga](https://blog.cloudflare.com/turnstile-ga/)) | Você cria a conta/widget (login); eu configuro a env var depois |
| Upstash Redis | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Tier gratuito permanente: 256 MB, 500k comandos/mês, 10 GB banda/mês ([upstash.com/pricing/redis](https://upstash.com/pricing/redis)) | Você cria a conta/database; eu configuro as env vars depois |
| Inngest | `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` | Hobby gratuito: 50k execuções/mês, 5 steps concorrentes, 3 usuários, 7 dias de trace ([inngest.com/pricing](https://www.inngest.com/pricing)) | Você cria a conta/app; eu configuro as env vars depois |

Prompts prontos para Claude Chrome executar essas três criações (sem devolver secret nenhum no chat) estão no fechamento da rodada, fora deste arquivo.

## 13. Plano de recuperação — corrigido

**Correção sobre a descrição anterior**: o reconciliador (`claim_outbox_batch`, chamado por `/api/cron/outbox`) **republica** o evento pendente/travado — ele nunca processa o efeito comercial. Quem processa é sempre `process_form_event`, chamado pelo worker (Inngest ou, em teste, o adaptador inline). Isso já estava correto no código; a imprecisão estava só na forma como uma rodada anterior descreveu o teste.

**Teste executado nesta rodada** (SQL/RPC direto, simulando cada etapa do ciclo real — nenhum caminho de processamento alternativo foi criado):

1. `ingest_form_event` cria `webhook_events` (status `received`) + `outbox` (state `pending`).
2. `claim_outbox_batch` reivindica (state `publishing`, `attempts: 1`); `mark_outbox_failed(..., 'inngest_unavailable', 0)` simula a publicação real falhando — state vira `failed`.
3. **Confirmado por leitura separada**: `webhook_events.status` continua `received` (evento preservado, nada perdido); `outbox.state = 'failed'`, `attempts: 1`, `last_error_code: 'inngest_unavailable'`.
4. "Serviço restaurado": `claim_outbox_batch` reivindica de novo — **republicação confirmada** (mesmo `webhook_event_id`/`outbox_id`, `attempts: 2`).
5. `mark_outbox_published` + `process_form_event` (simula o worker recebendo a republicação) — processa pela primeira vez: cria contato → lead → oportunidade → touchpoint → atividade.
6. `process_form_event` chamado de novo (simula reconciliador reivindicando por engano após já processado) — devolve `already_processed: true`, mesmos IDs, **nenhuma duplicação**; `claim_outbox_batch` chamado mais uma vez não devolve mais o evento (já fora do critério de elegibilidade).

**Continuar funcionando com o Inngest indisponível**: por desenho — o outbox no Postgres é a fonte da verdade, não o Inngest; o reconciliador só depende do banco.

### Testar execução automática antes do merge — limitação real encontrada

GitHub Actions **não avalia workflows fora do branch padrão de jeito nenhum** — nem `schedule:` nem disparo manual via `workflow_dispatch` funcionam a partir de um branch de feature. Confirmado ao tentar `gh workflow run a11-reconcile.yml --ref feat/a11-forms-attribution`: `HTTP 404: workflow a11-reconcile.yml not found on the default branch`. Isso é mais restritivo do que só "schedule só roda do branch padrão" — nenhuma execução do workflow é possível antes do merge para `main`.

**O que já está pronto, pendente só do merge:**
- `.github/workflows/a11-reconcile.yml` — chama `/api/cron/outbox` e `/api/cron/retention` via HTTP autenticado (`CRON_SECRET` + bypass da proteção SSO da Vercel), a cada 10 minutos por `schedule:`, e sob demanda por `workflow_dispatch`.
- Secrets do repositório já configurados: `A11_CRON_SECRET`, `VERCEL_AUTOMATION_BYPASS_SECRET`.
- **Passa a disparar sozinho automaticamente assim que este arquivo existir em `main`** — ou seja, requer o merge da A11 (ou, no mínimo, deste arquivo isolado) para ser validado de ponta a ponta como agendamento real.

## 14. Configuração externa concluída e validação HTTP real (rodada final)

**Turnstile, Upstash e Inngest configurados** (via Claude Chrome, contas
já existentes reaproveitadas — nenhuma conta nova criada; planos
gratuitos em todos os três). Variáveis confirmadas presentes no
ambiente Preview, escopadas ao branch `feat/a11-forms-attribution`:
`TURNSTILE_SECRET_KEY`, `NEXT_PUBLIC_QA_TURNSTILE_SITE_KEY`,
`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`,
`INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` — nenhuma em Production.
Inngest sincronizado com sucesso no branch environment
`feat/a11-forms-attribution`; função `a11-process-form-submission`
("A11 — processar submissão de formulário") ativa.

**Duas correções de código nesta rodada, ambas fora da lógica de
negócio da A11:**
- `src/proxy.ts`: a página de QA (`/qa/formulario-a11`) não estava na
  allowlist `PUBLIC_PATHS` — um visitante anônimo era desviado para
  `/entrar` em vez de ver o formulário. Adicionada.
- `src/proxy.ts`: a CSP (`script-src`/`frame-src`) bloqueava o iframe do
  widget Turnstile (`challenges.cloudflare.com`) — liberado, com
  comentário explícito de que essa exceção existe só por causa da
  página de QA e deve ser removida junto dela.

**Validado por HTTP real (chamada autenticada direta, não é prova de
agendamento automático):**
- `POST /api/cron/outbox` com `CRON_SECRET` real → `200
  {"claimed":0,"published":0,"failed":0}` (nada pendente no momento;
  confirma que a config completa do schema A11 passa a validar e que o
  `CRON_SECRET` está correto — antes de Turnstile/Upstash/Inngest
  existirem, essa mesma chamada devolvia `401`, ver achado §9).
- Widget Turnstile real carrega e responde no navegador, com o
  hostname/site key corretos — confirmado visualmente duas vezes
  (antes e depois da restauração da secret key, ver incidente abaixo).
- **Tentativa de envio automatizado (Playwright) foi corretamente
  recusada pelo Turnstile real** ("Falha na verificação") — isso é o
  comportamento CORRETO esperado (Turnstile existe para bloquear
  automação), não um defeito.
- Para exercitar o restante do pipeline (CORS real, rate limit,
  publicação no Inngest) sem um humano completando o captcha, troquei
  **temporariamente** `TURNSTILE_SECRET_KEY`/`NEXT_PUBLIC_QA_TURNSTILE_SITE_KEY`
  pelas chaves de teste **oficiais e públicas** da Cloudflare
  (`1x0000...AA`/`1x0000...AA`, documentadas para automação de QA). O
  desafio passou, mas a submissão foi recusada com `403` — as chaves de
  teste da Cloudflare devolvem um `hostname`/`action` fixos que não
  batem com a configuração real do endpoint, então `hostname_mismatch`/
  `action_mismatch` dispara por desenho do próprio código (`src/server/ingest/turnstile.ts`).
  **Não foi possível, portanto, exercitar CORS real/rate limit/
  publicação no Inngest de ponta a ponta nesta rodada** — isso exigiria
  um humano completando o captcha real, fora do alcance de automação.

**Incidente durante o teste com chave de teste (registrado
integralmente, por instrução do usuário):**
- Ao remover `TURNSTILE_SECRET_KEY` para trocar pela chave de teste,
  não havia cópia do valor real salva em nenhum lugar acessível a mim
  (foi inserida diretamente na Vercel pelo Claude Chrome, sem nunca
  passar pelo chat) — a remoção deixou a variável ausente por um
  intervalo.
- **Nenhuma captação pública estava ativa nesse intervalo**: a rota
  pública de ingestão só é usada pela página de QA deste branch
  (`/qa/formulario-a11`), não há tráfego real de visitantes na landing
  da Vizentini apontando para este preview.
- A chave original foi restaurada pelo usuário diretamente na Vercel
  (site key e secret key), confirmada por mim via `vercel env ls`
  (escopo correto: Preview + branch `feat/a11-forms-attribution`, ausente
  de Production) antes de qualquer novo teste.
- Ao restaurar, o usuário também corrigiu um escopo que havia ficado
  incorreto anteriormente incluindo Production — confirmado removido;
  a variável hoje existe só em Preview.
- **Lição registrada**: qualquer teste futuro com chave de teste deve
  rodar em ambiente local/processo isolado, nunca substituindo a
  configuração real do Preview compartilhado.

**Alternativa concreta para provar execução automática HOJE, sem merge e sem contratar nada**: usar `ScheduleWakeup` (mecanismo do próprio Claude Code) para, dentro de uma sessão, chamar o endpoint em intervalos por um período limitado — prova o disparo periódico não supervisionado turno a turno, mas **só resulta em sucesso real (200) depois que Turnstile/Upstash/Inngest estiverem configurados** (sem eles, a rota responde `401` pelo motivo descrito na seção de achados — `getIngestConfig()` falha antes mesmo de checar o `CRON_SECRET`). Não executado nesta rodada — decisão de deixar documentado e retomar depois da configuração externa.

## 15. Validação cross-origin real (harness local) e observabilidade sanitizada

**Método:** harness estático servido em `http://localhost` (fora do repositório, nunca commitado, apagado ao final), com o site key REAL do Turnstile (`0x4AAAAAAFD6Yb_-gD_u4GIt`) e desafio resolvido por um humano — nunca automatizado. O bypass da Vercel Authentication (`VERCEL_AUTOMATION_BYPASS_SECRET`) foi colado pelo usuário diretamente num arquivo local irmão do `index.html`, nunca visto nem impresso por mim; enviado só como query parameter, nunca como header (evita expandir os headers exigidos no preflight).

**Cenário base (evento novo) — PASSOU, comprovado por leitura direta no banco (SQL read-only via `supabase db query --linked`, nunca escrita):**
- `webhook_events`: 1 registro, `status: processed`.
- `outbox`: 1 registro, `state: published`, `attempts: 0`.
- `contacts` / `leads` / `opportunities` / `activities` / `touchpoints` / `contact_consents`: exatamente 1 registro cada, cadeia completa criada uma única vez.
- Execução do Inngest não observada diretamente (sem token do dashboard à mão), mas comprovada por inferência válida: o outbox só republica, nunca cria contato/lead/oportunidade — essas linhas só existem porque o worker do Inngest rodou `process_form_event`.

**Cenário 1 (reenvio idempotente, mesmo `sourceEventId`, novo token Turnstile):**
- 1ª tentativa: `400 {"error":"invalid_submission"}`. Investigado a fundo (ver achado abaixo) — **sem causa confirmada**.
- 2ª tentativa (autorizada explicitamente, única, instrumentada): `202 {"status":"received"}`, mesmo `sourceEventId`. Todas as contagens de negócio continuaram em 1 — idempotência real comprovada.

**Achado sobre o `400` isolado — investigado, não corrigido por hipótese:**
Reproduzi o payload exato (mesma identidade, mesmos campos) contra os schemas Zod reais do produto e a config real do endpoint (lida no banco): validou limpo. Repeti a tentativa real, instrumentada (harness passou a capturar, antes do fetch, o corpo sanitizado e o estado do honeypot, nunca o bypass nem o token): passou limpo, honeypot confirmado vazio no DOM e no corpo enviado. **Não foi possível reproduzir o `400` nem atribuí-lo a uma causa determinística** (não é honeypot, não é schema, não é config do endpoint). A hipótese mais provável — falha transitória na resolução do IP confiável de borda (`x-vercel-forwarded-for`) — permanece **não confirmada**, e nenhuma correção comportamental foi feita com base nela.

**Descoberta separada, não relacionada ao `400`:** `corsHeader: null` no harness NÃO é sinal de falha de CORS. Por especificação, `Access-Control-Allow-Origin` não está entre os headers que o navegador expõe via `Headers.get()` a menos que o servidor declare `Access-Control-Expose-Headers` (`src/server/ingest/cors.ts` não declara). O CORS real já estava comprovado pelo simples fato de o corpo ter sido lido pelo JavaScript — se a origem não fosse autorizada, o `fetch()` teria rejeitado antes disso. O harness foi corrigido para não apresentar mais esse campo como possível problema.

**Melhoria de observabilidade entregue (não é correção do `400`, é capacidade de diagnosticar uma recorrência):**
Todos os caminhos que a borda pública devolve como `invalid_submission` (contrato §1: recusa sempre genérica, nunca distinguível de fora) agora registram, em `src/server/ingest/observability.ts`, um log estruturado sanitizado (`console.warn(JSON.stringify(...))`, mesmo padrão já usado em `src/app/api/cron/retention/route.ts`):
- `json_parse_error`, `schema_validation_failed` (com `code`/`path` de cada issue do Zod, nunca `message` nem valor), `honeypot_filled`, `contract_version_mismatch` (com os números esperado/recebido), `answers_schema_validation_failed` (mesmo tratamento de issues), `client_ip_unresolved` (com `missing_trusted_header`/`invalid_ip`, nunca o IP).
- Nunca payload, nome, e-mail, telefone, resposta livre, IP bruto, token do Turnstile, bypass ou qualquer segredo.
- A resposta pública **não mudou**: continua exatamente `400 {"error":"invalid_submission"}` em todos os casos, sem diferenciação externa.
- Testes novos em `tests/unit/a11-ingest-observability.test.ts` (9 testes, escritos ANTES da implementação, todos falhavam sem ela): classificação correta de cada motivo, ausência de dados sensíveis nos logs, e confirmação de que a resposta pública permanece genérica.

**Pendências para a próxima rodada, nesta ordem (nenhuma executada ainda):**
1. Cenário 2 (continuidade): segunda interação com token de continuidade válido → deve criar só um novo `touchpoint`, sem novo contato/lead/oportunidade.
2. Rate limit real (Upstash): tentativas inválidas controladas, sem criar dado de negócio, confirmando `429` e headers esperados.
3. Recuperação automática do outbox: criar um pendente controlado e reproduzível, chamar `/api/cron/outbox` via HTTP real autenticado, confirmar `claimed:1/published:1/failed:0`, confirmar execução correspondente no Inngest, e confirmar que uma segunda chamada não republica/duplica.
4. Remoção do scaffolding de QA antes do merge (`/qa/formulario-a11`, allowlist, exceções de CSP, envs `NEXT_PUBLIC_QA_*`).
5. Inventário read-only pré/pós-merge (URL do workflow, variáveis Preview vs. Production, sincronização do Inngest, `A11_CRON_SECRET` vs. `CRON_SECRET`) — sem copiar segredos, sem alterar Production, com parada para autorização.
6. Fechamento técnico final: suíte completa, handoff, PR, commit, push, CI.
