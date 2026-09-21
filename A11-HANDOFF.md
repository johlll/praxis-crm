# A11 — Formulários próprios e atribuição multitoque · Handoff

Branch `feat/a11-forms-attribution`. **Nenhum banco hospedado foi tocado**
e a PR #16 (documentação da A10) **não foi mesclada**.

Contrato completo: [`docs/decisoes/a11-ingestao-atribuicao.md`](docs/decisoes/a11-ingestao-atribuicao.md).
Exemplo de integração do navegador: [`docs/decisoes/a11-exemplo-integracao.md`](docs/decisoes/a11-exemplo-integracao.md).

## 1. O que foi entregue

| Bloco | Onde |
|---|---|
| Configuração de endpoints por workspace, com ciclo de vida próprio | `form_endpoints` + `form_endpoint_keys`, `/configuracoes/formularios` |
| Rota pública | `src/app/api/forms/[endpointKey]/route.ts` |
| Turnstile (com hostname e action), rate limit, honeypot, limite de corpo, schema estrito e versionado | `src/server/ingest/*` |
| Evento idempotente, payload cifrado, diagnóstico sanitizado | `webhook_events`, `ingest_form_event` |
| Outbox + Inngest como caminho normal + cron reconciliador | `outbox`, `/api/inngest`, `/api/cron/outbox` |
| Worker idempotente com materialização transacional | `process_form_event` |
| Touchpoints append-only e vínculo versionado | `touchpoints`, `touchpoint_demand_links` |
| Referências de continuidade e evidência de consentimento | `continuity_references`, `consent_evidence` |
| Integração com mesclagem/desmesclagem | `20260921100800_a11_merge_integration.sql` |
| AttributionPanel no Perfil 360 | aba "Origem" em `/leads/[id]` |
| Primeiro/último toque e conversão no painel, com filtro de origem | `get_dashboard_attribution`, `AttributionCard` |
| Retenção de 30 dias, tombstone e `expired_unprocessed` | `purge_expired_webhook_events`, `/api/cron/retention` |

## 2. Decisões que o código real obrigou a tomar

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

## 3. Segurança

- **Workspace sempre derivado do endpoint no servidor.** O navegador nunca
  informa workspace.
- **`service_role` restrita por lint** a `src/app/api/{forms,webhooks,cron,inngest}/**`.
  A A11 acrescentou `forms` e `inngest` ao allowlist, com a justificativa
  no próprio arquivo: são a mesma categoria (entrada sem sessão de
  usuário, atrás das proteções).
- **Nenhum GRANT de tabela** para `anon`/`authenticated` nas oito tabelas
  novas: tudo passa por função `SECURITY DEFINER` com `search_path` fixo.
- **`ingest_form_event`, `process_form_event` e `resolve_form_endpoint`
  não são concedidas a `authenticated`** — um visitante com a chave
  publicável não consegue pular Turnstile e rate limit chamando a RPC.
- **IP nunca é persistido.** Só o HMAC (chave própria) vai para o rate
  limit e para o `remoteip` do siteverify; o HMAC também não é gravado
  nesta fase (a coluna existe para quando uma política autorizar).
- **Chave de cifra exclusiva da A11**, separada de contatos, blind index e
  cookie. Sem ela, a ingestão para **antes de qualquer gravação**.
- **Configuração de endpoint restrita a owner/admin**; correção de vínculo
  a owner/admin/manager, com auditoria.

## 4. Testes

| Suíte | Cobertura |
|---|---|
| `supabase/tests/database/18_a11_ingestao_atribuicao.test.sql` (52 asserções) | RLS forçada e grants exatos; chave idempotente; hash conflitante; normalização temporal; transação de negócio; worker concorrente; lead com duas oportunidades; conversão × correção; unassign; evento recebido depois do ganho; continuidade sem reabrir e sem atividade; cadeia sem ramificação; conflito de versão; tombstone; `expired_unprocessed`; limpeza idempotente; alerta de travado; isolamento; merge |
| `tests/unit/a11-ingest.test.ts` (30 testes) | canonicalização e hash (retry com token novo dá o MESMO hash); vazio ≡ ausente; cifra/decifra, chave errada, versão desconhecida; scrubbing sem PII; IP só de cabeçalho confiável; corpo público uniforme (202 idêntico para novo e repetido); 409 só por colisão de conteúdo; honeypot; campo desconhecido; tamanho máximo; rate limit antes do Turnstile; hostname/action; HMAC no lugar do IP; falha de publicação não muda a resposta; configuração ausente = falha fechada sem gravar nada; E.164 |
| `tests/e2e/forms-attribution.spec.ts` (12 testes) | configurar endpoint pela tela; submissão materializando contato/demanda/oportunidade/atividade/touchpoint; repetição idêntica; 409; honeypot/token/chave desconhecida; sequência no Perfil 360; três modelos no painel com primeiro toque padrão e voltar/avançar; filtro de origem e limpar; desativar sem apagar eventos; rotação revogando a anterior; console limpo; papel sem permissão recebe 404 |

Os e2e existentes não foram alterados. Dois testes de unidade da A10
tiveram apenas o **literal de filtros** atualizado (campos novos
`attributionModel`/`source`) — nenhuma asserção foi enfraquecida.

## 5. Validação local

| Verificação | Resultado |
|---|---|
| `npm run typecheck` | limpo |
| `npm run lint` | limpo |
| `npm test` | 342/342 |
| `npm run build` | **passa sem nenhuma variável da A11** — só as rotas de ingestão e jobs respondem `503` sanitizado |

**Docker continua indisponível nesta máquina**, então pgTAP e e2e **não
foram executados localmente**. Não há como afirmar que passam antes do
CI — é o CI efêmero que valida essa parte, e o resultado dele está na PR.

## 6. Infraestrutura ainda NÃO ativada

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

## 7. Migrations (todas novas, forward-only)

```
20260921100000_a11_enum_extensions.sql      activity_source += form_intake
                                            consent_purpose += formulario_contato
20260921100100_a11_schema.sql               8 tabelas + tipos
20260921100200_a11_rls.sql                  RLS habilitada e forçada, deny-all
20260921100300_a11_private_functions.sql    atribuição (ponta vigente, elegibilidade)
20260921100400_a11_config_functions.sql     CRUD de endpoint (owner/admin)
20260921100500_a11_ingestion_functions.sql  ingestão, outbox, worker
20260921100600_a11_attribution_functions.sql correção de vínculo + leituras
20260921100700_a11_retention_functions.sql  retenção e alertas
20260921100800_a11_merge_integration.sql    merge/undo estendidos
```

Nenhuma migration aplicada foi editada. `supabase/migrations/20260917110000`
(A10) continua intocada.

## 8. Pendências e limitações honestas

- **`src/server/types/database.ts` foi editado à mão** (sem Docker para
  rodar o gerador). O passo `db:types:check` do CI é a autoridade: se
  divergir, ele imprime o arquivo correto no log e o commit seguinte
  passa a ser o gerado. Enquanto isso, as tabelas novas **não** aparecem
  em `Tables` — nenhum código as acessa por `.from()`, só por função.
- **Retenção de payload cifrado**: `occurred_at` também é limpo no
  vencimento (é dado declarado pelo visitante). `normalized_occurred_at`
  permanece, porque é o que a atribuição usa e não identifica ninguém.
- **`answers_config`** existe e é validado como forma mínima no banco; a
  validação campo a campo das respostas permitidas é feita por Zod na
  aplicação. Uma tela para editar essa configuração não entrou nesta fase
  (o endpoint aceita a lista fechada padrão).
- **Editar um endpoint existente** tem RPC (`update_form_endpoint`) e
  action, mas a tela de configuração só oferece criar, desativar/reativar
  e rotacionar. Editar exige recriar — limitação consciente para não
  inflar a fase.
- A validação funcional completa em preview **depende de autorização** para
  aplicar as migrations no Supabase de desenvolvimento (checkpoint §15 do
  pedido).
