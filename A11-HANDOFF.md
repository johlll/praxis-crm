# A11 — Formulários próprios e atribuição multitoque · Handoff

Branch `feat/a11-forms-attribution`. **Nenhum banco hospedado foi tocado**
e a PR #16 (documentação da A10) **não foi mesclada**.

Contrato completo: [`docs/decisoes/a11-ingestao-atribuicao.md`](docs/decisoes/a11-ingestao-atribuicao.md).
Exemplo de integração do navegador: [`docs/decisoes/a11-exemplo-integracao.md`](docs/decisoes/a11-exemplo-integracao.md).

**Este documento foi revisado depois de uma auditoria pós-dry-run que
encontrou 12 bloqueadores reais** (idempotência incompleta, Turnstile
vazando IP, ausência de CORS, identidade forjável, continuidade nunca
emitida, `answers_config` decorativo, consentimento sem evidência, FKs
compostas anulando `workspace_id`, outbox nunca marcada, vazamento de
escopo em `get_lead_attribution`, cobertura de merge incompleta e este
próprio documento desatualizado). Todos os 12 foram corrigidos nesta
branch, sempre em migrations **ainda pendentes** (nenhuma foi aplicada em
banco hospedado) — ver §2.

## 1. O que foi entregue

| Bloco | Onde |
|---|---|
| Configuração de endpoints por workspace, com ciclo de vida próprio e lista de campos validada | `form_endpoints` + `form_endpoint_keys`, `/configuracoes/formularios`, `private.assert_answers_config` |
| Rota pública, com CORS estrito por origem | `src/app/api/forms/[endpointKey]/route.ts`, `src/server/ingest/cors.ts` |
| Turnstile (hostname, action, sem IP, idempotency_key pelo token), rate limit, honeypot, limite de corpo, schema estrito e versionado | `src/server/ingest/*` |
| Evento idempotente (hash cobre occurredAt/continuidade/consentimento), payload cifrado, diagnóstico sanitizado | `webhook_events`, `ingest_form_event` |
| Outbox marcada atomicamente pela publicação inicial + Inngest (retries alinhados a `dead`) + cron reconciliador | `outbox`, `/api/inngest`, `/api/cron/outbox` |
| Worker idempotente com materialização transacional; identidade só por continuidade (token servidor, hash-only) | `process_form_event`, `issue_continuity_reference`, `revoke_continuity_reference` |
| Touchpoints append-only e vínculo versionado | `touchpoints`, `touchpoint_demand_links` |
| Referências de continuidade (emissão/revogação reais) e evidência de consentimento (com `text_hash`) | `continuity_references`, `consent_evidence` |
| Integração com mesclagem/desmesclagem (`touchpoints`, `continuity_references`, `consent_evidence`) | `20260921100800_a11_merge_integration.sql` |
| AttributionPanel no Perfil 360, com alcance por REGISTRO (não por contato), e emissão de link de continuidade | aba "Origem" em `/leads/[id]` |
| Primeiro/último toque e conversão no painel, com filtro de origem | `get_dashboard_attribution`, `AttributionCard` |
| Retenção de 30 dias, tombstone e `expired_unprocessed` | `purge_expired_webhook_events`, `/api/cron/retention` |

## 2. Os 12 defeitos da auditoria pós-dry-run e a correção

| # | Defeito | Correção |
|---|---|---|
| 1 | Hash de idempotência não cobria `occurredAt`, token de continuidade nem texto de consentimento | `businessContent()` passa a incluir `occurredAt`, SHA-256 do token e SHA-256 do texto aceito; exemplo de integração persiste `occurredAt` junto do `sourceEventId` |
| 2 | Turnstile recebia HMAC do IP em `remoteip` (campo é IP real) e usava `sourceEventId` como `idempotency_key` (estável entre tokens diferentes) | `remoteip` removido; `idempotency_key` = SHA-256(token), dentro do verificador |
| 3 | `/api/forms/[endpointKey]` sem CORS — sem preflight, sem `Access-Control-Allow-Origin` | `OPTIONS` + cabeçalhos em toda resposta (sucesso e erro) para origem autorizada; nunca `"*"` |
| 4 | `externalIdentity` no corpo público permitia reivindicar QUALQUER contato do workspace | Campo removido do contrato; identidade confiável só por referência de continuidade |
| 5 | `continuity_references` existia mas nada emitia token algum | `issue_continuity_reference`/`revoke_continuity_reference`, FK que garante contato/lead da mesma cadeia, finalidade validada no processamento |
| 6 | `answers_config` só validava a FORMA (`{fields: [...]}`), não o conteúdo | `private.assert_answers_config` no banco + Zod na borda/worker, com snapshot por evento |
| 7 | `granted` sem evidência era aceito; `text_hash` nunca era calculado | Zod exige `textVersion`+`acceptedText` para `granted`; `text_hash` calculado e gravado |
| 8 | FKs compostas com `ON DELETE SET NULL` sem lista de colunas anulariam `workspace_id` | `ON DELETE SET NULL (coluna_opcional)`, sintaxe PG15+ |
| 9 | Outbox nunca marcada pela publicação inicial (nem sucesso nem falha); retries do Inngest desalinhados do limiar de `dead` | `mark_outbox_published`/`mark_outbox_failed` chamadas após a tentativa inicial; `retries: 9` alinhado a `attempts + 1 >= 10` |
| 10 | `get_lead_attribution` vazava touchpoints de OUTRO lead do mesmo contato | `sequence` escopada por `t.lead_id`, não `t.contact_id` |
| 11 | Cobertura de merge/unmerge não cobria `continuity_references`/`consent_evidence`; relatório anterior invertia a lista de tabelas reparentadas | pgTAP cobrindo as três tabelas, undo, e conflito por alteração posterior; texto corrigido em §13 do contrato |
| 12 | Este documento e a descrição da PR estavam desatualizados | Reescritos (este arquivo e a PR #17) |

Nenhuma migration **já aplicada** foi editada — item 6 (auditoria) do
histórico do checkpoint continua valendo. Como nenhuma migration da A11
havia sido aplicada em banco hospedado, as correções acima entraram
**dentro das próprias migrations pendentes** (não como camada nova por
cima): `20260921101000_a11_form_intake_activity_source.sql` foi
consolidada de volta em `20260921100100_a11_schema.sql` (schema) e
`20260921100500_a11_ingestion_functions.sql` (`process_form_event`), e
deixou de existir como arquivo — a lista agora tem 10 migrations, não 11.

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
   revisão): a suposição inicial era que a ordem de
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
  própria) vai para o rate limit; o Turnstile deixou de receber o IP —
  nem completo, nem como HMAC (correção do item 2).
- **Identidade confiável só por token de continuidade**, emitido pelo
  servidor e guardado só por hash — nenhum campo do corpo público permite
  reivindicar um contato existente (correção do item 4).
- **Chave de cifra exclusiva da A11**, separada de contatos, blind index e
  cookie. Sem ela, a ingestão para **antes de qualquer gravação**.
- **Configuração de endpoint restrita a owner/admin**; correção de vínculo
  a owner/admin/manager; emissão de continuidade a owner/admin/manager/
  lawyer/sales — todas com auditoria.
- **Alcance por registro em `get_lead_attribution`**: corrigido para não
  vazar touchpoints de outro lead do mesmo contato (item 10).

## 5. Testes

**Convenção desta seção:** "confirmado localmente" = a suíte rodou nesta
máquina e o resultado abaixo é o que ela reportou. "Contagem estática" =
contagem de `it(`/`test(`/asserções no código-fonte, sem execução — esta
máquina não tem Docker, então `supabase start`/pgTAP/e2e não rodam aqui;
quem confirma essas contagens é o CI (GitHub Actions), efêmero, que sobe
Postgres via Docker no runner.

| Suíte | Testes | Confirmado por |
|---|---|---|
| `npm test` (Vitest, todos os arquivos) | **392/392 passando** | **execução local** nesta sessão |
| — dos quais, arquivos `tests/unit/a11-*.test.ts` | 80 testes (6 arquivos) | execução local |
| `supabase/tests/database/18_a11_ingestao_atribuicao.test.sql` | **113 asserções** (contagem estática — era 70 antes da auditoria) | **CI** (pendente nesta sessão) |
| `tests/e2e/forms-attribution.spec.ts` | **14 testes** (contagem estática — era 13 antes da auditoria) | **CI** (pendente nesta sessão) |

Cobertura nova/ampliada pela auditoria, por item: canonicalização de
`occurredAt`/token de continuidade/texto de consentimento isolados (1);
corpo real enviado ao Siteverify sem `remoteip`, idempotency_key pelo
token (2); origem autorizada × recusada, preflight e resposta de erro
(3); `externalIdentity` recusado pelo schema (4); emissão/revogação de
continuidade, segunda interação sem sobrescrever a primeira, finalidade
errada degradando para captação nova (5); campo não configurado/
obrigatório ausente/tipo errado recusados, snapshot revalidado (6);
`granted` sem evidência recusado, `text_hash` calculado (7); `ON DELETE
SET NULL` anulando só a coluna opcional (8); outbox marcada published/
failed, fluxo falha→reclama→republica→published (9); dois leads do mesmo
contato sem vazamento (10); merge/unmerge das três tabelas com conflito
por alteração posterior (11).

Os e2e pré-existentes (fora deste arquivo) não foram alterados nesta
sessão. Os testes de unidade e pgTAP da A10 seguem como no checkpoint
anterior — nenhuma asserção foi enfraquecida em nenhuma suíte.

## 6. Validação local nesta sessão

| Verificação | Resultado |
|---|---|
| `npm run typecheck` | limpo |
| `npm run lint` | limpo |
| `npm test` | **392/392** |
| `npm run build` | passa sem nenhuma variável da A11 — só as rotas de ingestão e jobs respondem `503` sanitizado |

**Docker continua indisponível nesta máquina**, então `supabase start`,
pgTAP, `db:types:check` (comparação do gerador) e e2e **não foram
executados localmente nesta sessão**. `src/server/types/database.ts` foi
atualizado à mão para as assinaturas novas/alteradas
(`ingest_form_event`, `get_webhook_event_payload`,
`issue_continuity_reference`, `revoke_continuity_reference`,
`webhook_events.answers_config_snapshot`,
`continuity_references_lead_contact_fkey`); é o CI, com Docker, que
confirma se o arquivo bate com o que `supabase gen types` produziria.

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
20260921100100_a11_schema.sql               8 tabelas + tipos + activities.source_webhook_event_id
20260921100200_a11_rls.sql                  RLS habilitada e forçada, deny-all
20260921100300_a11_private_functions.sql    atribuição (ponta vigente, elegibilidade)
20260921100400_a11_config_functions.sql     CRUD de endpoint (owner/admin) + validação de answers_config
20260921100500_a11_ingestion_functions.sql  ingestão, outbox, worker (process_form_event completo)
20260921100600_a11_attribution_functions.sql correção de vínculo + leituras + emissão/revogação de continuidade
20260921100700_a11_retention_functions.sql  retenção e alertas
20260921100800_a11_merge_integration.sql    merge/undo estendidos (touchpoints, continuity_references, consent_evidence)
20260921100900_a11_revoke_default_execute.sql revoke explícito de anon/authenticated
```

Nenhuma migration aplicada **em banco hospedado** foi editada.
`supabase/migrations/20260917110000` (A10) continua intocada. A
consolidação de `20260921101000_a11_form_intake_activity_source.sql` (que
existia como arquivo próprio) para dentro de `100100`/`100500` só foi
possível porque nenhuma migration da A11 havia sido aplicada em nenhum
banco — nada disso teria sido feito se o checkpoint anterior tivesse
avançado para `db push` real.

## 9. Pendências e limitações honestas (atualizado)

- **Tela de edição de um endpoint existente não tem UI** para NENHUM
  campo (nome, pipeline, `answers_config`, etc.) — só criar, desativar/
  reativar e rotacionar chave têm botão. `update_form_endpoint` existe e
  já valida tudo (inclusive `answers_config`), mas editar hoje exige
  chamar a RPC fora da tela. Limitação preexistente ao checkpoint
  anterior, não introduzida pela auditoria — registrada aqui para não
  ficar implícita.
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
