# A8 — Clientes e handoff — Handoff

**Status: PR aberta, NÃO mesclada.** Branch `feat/a8-clients-handoff`,
[PR #10](https://github.com/johlll/praxis-crm/pull/10). CI verde no commit
final `0ca580d`. Validação interativa no preview concluída com sucesso
(§8). **Merge, commit direto em `main` e início da A9 seguem explicitamente
não autorizados** — nenhum dos três foi feito.

## 1. Escopo

Entregue nesta fase, conforme o pedido:

- Reaproveitamento total da fundação da A5: `clients`, `client_handoffs` e a
  conversão transacional de `win_opportunity()` — nenhuma reescrita, nenhuma
  segunda chamada de criação de cliente no frontend.
- `/clientes` — lista com busca, filtro por status, paginação.
- `/clientes/[id]` — contato, responsável, status, origem, histórico
  (oportunidade + handoff por item), valor total (projetado por papel).
- Links "Ver cliente" na oportunidade ganha e no lead (reaproveita o
  `client_id` já carregado, sem consulta extra).
- `HandoffCard` — honesto: "Aguardando integração" sem integração
  configurada; nunca finge conclusão nem expõe `payload`/`last_error`.
- Mudança de status do cliente (ativo/encerrado/suspenso) com auditoria e
  concorrência otimista (`lock_version`).
- Transferência de responsável pelo cliente.
- Integração com mesclar/desfazer contato (A4) — cliente reparenta junto,
  com recusa explícita se ambos os contatos tiverem cliente ativo.

**Fora do escopo, como pedido:** atribuição/touchpoints (A11), upload de
documentos, qualquer integração jurídica real.

## 2. Decisões de design

Raciocínio completo (reaproveitamento da A5, histórico por
`client_handoffs.client_id`, papéis, status/concorrência, "Cliente desde"/
origem, handoff honesto) em
[`docs/decisoes/a8-clientes.md`](docs/decisoes/a8-clientes.md), escrito
antes da implementação.

## 3. Modelo de dados

Migrations novas (nenhuma das já aplicadas foi reescrita):

- `20260911160000_a8_schema.sql` — `clients.lock_version`.
- `20260911160100_a8_business_functions.sql` — `update_client_status()`,
  `transfer_client_owner()`. Ambas com verificação atômica de versão
  (`UPDATE ... WHERE lock_version = p_lock_version`), auditoria em
  `audit_logs`, e reativação conflitante recusada com
  `active_client_conflict` (nunca mescla/apaga cadastro).
- `20260911160200_a8_read_functions.sql` — `list_clients()`, `get_client()`
  (novas); `get_opportunity()`/`list_opportunities()` (`create or replace`,
  mesma assinatura já existente da A6 — só `client_id` adicionado ao
  retorno).
- `20260911160300_a8_merge_integration.sql` — `merge_contacts()`/
  `unmerge_contact()` (`create or replace`, mesma assinatura da A4) —
  reparenta `clients.contact_id` no merge/undo; recusa o merge se AMBOS os
  contatos tiverem cliente ativo (`client_merge_conflict_active_client`).

`get_client()` monta o histórico via `client_handoffs.client_id` +
`opportunity_id` (nunca busca todas as oportunidades do contato — clientes
distintos do mesmo contato têm históricos distintos), com projeção
financeira por papel reaproveitada de `private.opportunity_financial_projection()`/
`private.opportunity_column_sum_projection()` (A5, sem duplicar a regra).
`payload`/`last_error` de `client_handoffs` nunca saem da função.

## 4. Permissões

Novas entradas em `src/lib/roles.ts`:

| Permissão | Quem |
|---|---|
| `client.view` | todos os papéis (alcance real por registro na RPC) |
| `client.manage` | só owner/admin/manager (status e responsável) |

Alcance por registro (dentro de um cliente visível, cada oportunidade/
handoff é filtrado pelo alcance do usuário — acesso a uma negociação nunca
libera as demais; ser responsável pelo cliente não dá acesso adicional a
leads/oportunidades):

- Lawyer: só vê clientes com pelo menos uma oportunidade em seu alcance
  aprovado ("seus + sem responsável", `private.lead_accessible_to_role()`
  reaproveitada sem duplicar a regra).
- Sales/viewer: veem o cliente conforme o acesso às negociações vinculadas
  (mesma função), mas nunca alteram status/responsável — só owner/admin/
  manager podem.
- Registros legados sem vínculo suficiente para determinar alcance mantêm
  acesso administrativo (nunca ficam invisíveis a owner/admin/manager).

## 5. Testes

**pgTAP** (`supabase/tests/database/13_a8_clients.test.sql`, 44 asserções,
roda no CI via `npm run test:db`): `client_id` em `get_opportunity`/
`list_opportunities`; alcance do advogado em `list_clients`/`get_client`;
owner com visibilidade total e valor exato; viewer sem nenhuma chave
financeira; sales com faixa (nunca soma exata); `update_client_status`
(permissão/conflito/`active_client_conflict`); `transfer_client_owner`
(permissão/`assignee_not_a_member`/conflito); `merge_contacts` recusado com
dois clientes ativos, aceito com um encerrado, `unmerge_contact` restaura;
paginação de `list_clients`; isolamento entre workspaces.

**Unitário** (`tests/unit/clients-list-error.test.ts`): `listClients()`
joga `ClientsLoadError` numa falha de consulta, distinto de workspace
genuinamente sem clientes (mesmo padrão de `ConversationsLoadError`).

**E2E** (`tests/e2e/clients.spec.ts`, 5 cenários): ganhar cria cliente,
"Ver cliente" aparece na oportunidade e no lead → `/clientes` lista o
cliente, detalhe mostra histórico/handoff honesto → owner muda status,
persiste após reload → viewer vê o cliente mas nunca o valor financeiro
(nem no HTML nem nas respostas de rede) nem os controles de gestão →
isolamento entre workspaces (usando `daniel`, não `bruno` — ver §7).

## 6. CI

**Verde no commit final** —
[run](https://github.com/johlll/praxis-crm/actions/runs/34661782987)
(commit `0ca580d`): typecheck, lint, testes unitários, `db:types:check`,
pgTAP (44/44 novas — suíte completa do repositório), build, e2e (50/50).

Levou 6 rounds de CI até fechar — todos achados reais, nenhum de produto:

1. **Vercel build falhou** (não o CI de testes): `client-status-form.tsx`
   ("use client") importava `CLIENT_STATUSES` de `queries.ts`, cujo topo
   importa `createServerSupabaseClient` (`next/headers`) — isso arrasta o
   módulo servidor inteiro para o bundle do navegador
   (`Error: You're importing a module that depends on "next/headers"`).
   Corrigido: `CLIENT_STATUSES` movido para `schema.ts` (só depende de
   `zod`), mesma disciplina já documentada em `src/lib/roles.ts`.
2. **pgTAP**: `is(:'var', 'literal', ...)` com os dois lados sem tipo
   ancorado — `could not determine polymorphic type because input has type
   unknown`. Corrigido com cast explícito `::text` nos dois lados.
3-5. **Seletores ambíguos no e2e** (3 correções sucessivas, cada uma achada
   por uma rodada real de CI): `"R$ 350,00"` e `"Empresarial"` aparecem
   duas vezes na tela (resumo do cliente + item do histórico) — resolvido
   com `.first()`; `"suspenso"` também "resolve" na `<option>` oculta do
   `<select>` de status — resolvido escopando ao `getByRole("banner")`
   (Topbar).
6. **Achado real de composição de teste, não de segurança**: o teste de
   isolamento usava `bruno` como "usuário de outro workspace" — mas
   `auth-workspace.spec.ts` (mesmo banco efêmero da suíte inteira,
   executado antes) convida `bruno` para o workspace da `ana` e ele aceita
   o convite, virando membro legítimo de `ws_um` por composição da própria
   suíte. `get_client()` corretamente devolveu o cliente para ele — não é
   um vazamento de autorização, é o teste usando o usuário errado.
   Confirmado por pgTAP (`throws_ok` para exatamente esse cenário com
   `bruno` como estranho de verdade, isolado, já passava) e por inspeção
   do screenshot da falha (sessão real, workspace correto, papel correto —
   só que legitimamente membro de dois workspaces). Corrigido trocando para
   `daniel` (nunca ganha acesso a `ws_um`, mesmo padrão já usado em
   `leads.spec.ts`/`pipeline.spec.ts`).

Nenhum dos 6 achados exigiu tocar em RLS ou nas regras de negócio da A5
reaproveitadas (`win_opportunity()`, `lead_accessible_to_role()`,
projeções financeiras) — todas continuam como estavam.

## 7. Validação em preview

Mesma diferença de ambiente documentada na A7 (§8 do `A7-HANDOFF.md`): o CI
roda contra Postgres efêmero local; o preview do Vercel roda contra o
Postgres hospedado e persistente `praxis-crm-dev`, que só recebe migrations
via `supabase db push --linked` manual.

- **Achado real, confirmado antes de agir**: `/clientes` devolveu HTTP 500
  no preview antes de qualquer outra ação — as 4 migrations da A8 ainda não
  tinham sido aplicadas em `praxis-crm-dev` (`db:push:dry-run` confirmou
  exatamente essas 4 pendentes, nada acumulado de fases anteriores). Não é
  bug de produto. Autorizado explicitamente pelo usuário e aplicado via
  `npm run db:push` antes de prosseguir.
- Login via Playwright (`playwright-cli`) com sessão persistente já
  autenticada no SSO da Vercel de uma verificação anterior (mesmo perfil
  usado na A7) — não precisou de nova autenticação Vercel. Login no próprio
  Praxis com a conta QA owner (`joaoniero2+praxisqaa3@gmail.com`,
  "Escritorio QA Praxis A3").
- Fluxo completo validado de ponta a ponta contra o preview real:
  contato+lead+oportunidade criados → **Ganhou** (com o requisito
  obrigatório de etapa preenchido) → oportunidade marcada "Ganha", valor
  R$ 500,00 → **Ver cliente** visível na oportunidade E no lead, mesmo
  `client_id` → `/clientes` lista o cliente → detalhe mostra "Cliente
  desde", origem (link para a oportunidade), valor total, histórico com
  "Aguardando integração" (nunca "concluído", nunca payload/erro bruto) →
  **mudança de status** para "Suspenso" via formulário, persistiu depois de
  reload.
- **Papel restrito**: login como usuário de teste com papel
  "Atendimento/comercial" (sales) do mesmo workspace — vê o cliente e o
  histórico, mas o valor aparece como faixa ("Até R$ 2.000", nunca "R$
  500,00"), sem nenhuma linha de "Valor total" agregado, e sem os
  formulários de status/responsável (`client.manage` corretamente negado).
  Nenhum valor exato encontrado no texto renderizado da página.

Nenhum dado real de cliente foi usado — só registros fictícios
("Cliente A8 Preview") no workspace de QA já dedicado a isso.

## 8. Limitações conhecidas

- "Cliente desde" reaproveita `clients.created_at` (mesma semântica
  confirmada no código: é a criação do cliente na conversão) — sem coluna
  duplicada.
- Origem identificada pelo primeiro `client_handoffs` (ordenação
  `created_at, id`), resolvido no cliente a partir de `history[0]`, sem
  consulta redundante.
- Atribuição/touchpoints comerciais continuam fora do escopo (A11).
- `win_opportunity()` continua criando/reaproveitando cliente mesmo quando
  só existem clientes encerrados/suspensos para o contato (comportamento
  da A5, documentado, não alterado silenciosamente).

## 9. Confirmações explícitas

- Nenhuma migration já aplicada por outro ambiente foi editada — as 4
  migrations da A8 são todas novas.
- `win_opportunity()` em si não foi tocado (só as leituras que passaram a
  incluir `client_id` no retorno).
- **Merge NÃO realizado.** Nenhum commit direto em `main`. **A9 não foi
  iniciada.**
