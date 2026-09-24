# A11 — Formulários próprios e atribuição multitoque · Handoff

Branch `feat/a11-forms-attribution`. **Nenhum banco hospedado foi tocado**
e a PR #16 (documentação da A10) **não foi mesclada**.

Contrato completo: [`docs/decisoes/a11-ingestao-atribuicao.md`](docs/decisoes/a11-ingestao-atribuicao.md).
Exemplo de integração do navegador: [`docs/decisoes/a11-exemplo-integracao.md`](docs/decisoes/a11-exemplo-integracao.md).

**Este documento passou por TRÊS rodadas de auditoria pós-dry-run.** A
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
corrigido na ESCRITA) — corrigidos e registrados em §2.3. Todos os 22,
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

Nenhuma migration **já aplicada** foi editada em nenhuma das três
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
  `history` (item 1 da 3ª rodada).
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
| `npm test` (Vitest, todos os arquivos) | **408/408 passando** | **execução local** nesta sessão |
| — dos quais, arquivos `tests/unit/a11-*.test.ts` | 8 arquivos (novo: `a11-form-endpoints-list-error.test.ts`) | execução local |
| `supabase/tests/database/18_a11_ingestao_atribuicao.test.sql` | **140 asserções** (contagem estática — 127 depois da 2ª rodada, 113 depois da 1ª, 70 antes dela) | **CI** (pendente nesta sessão) |
| `tests/e2e/forms-attribution.spec.ts` | **15 testes** (sem novo teste e2e nesta rodada — cobertura nova ficou em pgTAP e Vitest) | **CI** (pendente nesta sessão) |

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
- A validação funcional completa em preview **depende de autorização** para
  aplicar as migrations no Supabase de desenvolvimento — novo dry-run
  necessário depois desta correção, novo checkpoint próprio.
