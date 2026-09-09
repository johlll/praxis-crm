# A4 — Handoff: leads

**Projeto:** Praxis CRM Jurídico
**Fase:** A4
**Branch:** `feat/a4-leads`
**PR:** https://github.com/johlll/praxis-crm/pull/4 — **aberto, revisão pós-commit `1c6e753` aplicada, aguardando novo CI e aprovação**
**Preview:** https://praxis-crm-git-feat-a4-leads-johllls-projects.vercel.app
**Data:** 09/09/2026

**Status:** implementada e revisada. A primeira entrega (commit
`1c6e753`, CI verde) teve **três problemas reais** identificados em
revisão antes do merge — todos corrigidos na mesma branch, migration
aditiva nova (`20260909100500_a4_review_hardening.sql`), sem apagar
dado nem reescrever migration já aplicada. Detalhe completo na seção 0.
**Aguardando o CI da correção rodar e aprovação explícita para merge —
nenhum merge foi feito, A5 não foi iniciada.**

**Pendências herdadas, não resolvidas por esta fase:** Site URL/Redirect
URLs do Supabase Auth (A2/A3) e o ambiente real de clientes (ainda não
existe — ver A3-HANDOFF.md seção 7) seguem como estavam.

---

## 0. Revisão pós-commit `1c6e753` — achados, correções e limitações

Revisão feita antes do merge do PR #4, sobre o commit que já estava com
CI verde. Encontrou três problemas reais (não estilo/preferência) e
pediu ajustes de teste. Nenhum deles foi um falso positivo — todos
reproduzidos e corrigidos.

### 0.1 Achados reproduzidos e correção aplicada

1. **Alcance por registro só valia na leitura.**
   `update_lead_basic_fields()`/`assign_lead()`/`set_lead_status()`/
   `set_lead_value()` checavam só papel/membership
   (`private.has_workspace_role`), sem checar se o REGISTRO estava no
   alcance do advogado ("seus + sem responsável") — um advogado
   conseguia editar, arquivar ou se autoatribuir um lead de outro colega
   chamando a RPC direto, mesmo nunca vendo esse lead pela tela.
   **Reproduzido** via pgTAP direto contra a função antes da correção
   (carla, lawyer, editava `lead_um` — atribuído a Ana — sem nenhum
   erro). **Corrigido** centralizando a regra em
   `private.lead_accessible_to_role()`, usada pelas quatro funções de
   escrita além das duas de leitura; negação usa `lead_not_found` (não
   revela o registro), e a checagem acontece ANTES de qualquer `UPDATE`
   (dado nunca é tocado). Antes de aplicar, confirmei com o dono do
   produto a definição de "equipe" do plano (não existe tabela de
   equipe/hierarquia no schema): **"seus + sem responsável"**, a mesma
   regra já usada na leitura — não "só os seus, estritamente".
2. **Concorrência com janela real entre checar e gravar.** A versão
   anterior fazia `SELECT`, comparava `updated_at` em PL/pgSQL, e só
   DEPOIS rodava um `UPDATE` **sem nenhuma condição de versão no
   `WHERE`** — checar e gravar eram dois passos separados, com uma
   janela onde outra transação podia gravar no meio e a segunda gravação
   vencia em silêncio. **Corrigido** movendo a comparação para dentro do
   `WHERE` do próprio `UPDATE`/upsert — checar e gravar viram uma única
   operação atômica; se zero linhas forem afetadas, `lead_conflict`.
   `p_expected_updated_at` também deixou de ter default nulo nas três
   funções de edição de lead (o nulo era usado como "pular a checagem",
   um atalho que não devia existir numa edição normal).
3. **Honorários antecipado sem aprovação.** A A4 introduziu
   `lead_values`/`estimated_value_cents` em `leads`, mas o plano original
   (seção 6.3) só coloca valor monetário em `opportunities` (A5) — a
   justificativa de criar o campo "para ter algo a proteger no teste" foi
   rejeitada. **Corrigido** retirando o fluxo do contrato ativo:
   `create_lead()` não aceita mais o parâmetro de valor (assinatura de 8
   para 7 parâmetros); `get_lead()`/`list_leads()` nunca mais projetam
   nenhuma chave de valor, para nenhum papel; `set_lead_value()` teve o
   `EXECUTE` **revogado de `authenticated`** (ninguém, por nenhuma via,
   consegue mais chamá-la). **Nada foi apagado**: `lead_values`,
   `private.lead_value_projection()` e `private.money_band_label()`
   continuam existindo intocadas, como estrutura residual — inclusive a
   única linha real gravada no ambiente hospedado `praxis-crm-dev`
   durante a validação manual anterior (um lead de teste, R$ 5.500,00)
   permanece lá, sem uso pelo contrato ativo. Confirmado por consulta
   direta ao banco hospedado antes de qualquer alteração: só essa uma
   linha existia. A A5 decide o destino dessa estrutura residual quando
   `opportunities.value_cents` existir.

### 0.2 Testes reforçados (mesmo pedido, não passou batido)

- `tests/e2e/leads.spec.ts` teste 5 (escrita negada): antes só checava a
  ausência do botão "Salvar" na tela. Agora tenta uma escrita real,
  direto na API do Supabase (fora da UI, com o token de sessão da própria
  Elisa), confirma a recusa do SERVIDOR (não só a interface escondendo o
  botão) e confirma que o dado permanece inalterado depois.
- `tests/e2e/leads.spec.ts` teste 8 (mesclagem): antes aceitava qualquer
  um dos dois contatos como vencedor (ordem por uuid imprevisível). Agora
  seleciona EXPLICITAMENTE o contato que NÃO tem o lead como vencedor,
  confirma a transferência pelo ID de destino (não só pelo nome no
  heading) e depois a restauração ao ID original.
- `tests/e2e/leads.spec.ts` teste 4 (payload do viewer): antes só olhava
  `page.content()` (o HTML final já renderizado). Agora também escuta as
  respostas de rede reais (navegação e o payload que a sustenta) durante
  o fluxo, e usa um contato com CPF fictício CONHECIDO (o mesmo já usado
  na criação do lead) para confirmar que o viewer não recebe esse valor
  em lugar nenhum — nem no DOM, nem em nenhuma resposta.
- `tests/e2e/leads.spec.ts` teste novo (6): duas chamadas RPC
  **simultâneas de verdade** (`Promise.all`, duas conexões HTTP reais
  contra o Supabase local) editando o mesmo lead com a mesma versão
  inicial — confirma que exatamente uma grava e a outra recebe
  `lead_conflict`, nunca as duas, nunca nenhuma.
- `supabase/tests/database/09_a4_leads.test.sql`: 8 asserções novas
  cobrindo o achado 1 (advogado bloqueado em editar/atribuir/arquivar
  fora do alcance, com dado preservado; permitido dentro do alcance) e 2
  asserções novas para o achado 2 (versão omitida é recusada; reusar uma
  versão já substituída — não um `now() - interval` artificial — é
  recusado). A seção antiga de projeção de valor (5 asserções) foi
  removida e substituída por uma única asserção de regressão: nenhum
  papel, nem o proprietário, recebe qualquer chave de valor.

### 0.3 Limitação conhecida, registrada de propósito

pgTAP roda numa sessão só — não prova duas transações concorrentes de
verdade (só prova que versão desatualizada é recusada, testado
sequencialmente). A prova de concorrência real está no teste e2e novo
(duas chamadas HTTP simultâneas contra o Supabase local, duas conexões
Postgres de verdade competindo pela mesma linha). Isso é uma limitação da
ferramenta pgTAP, não do comportamento do banco — documentado no
cabeçalho de `09_a4_leads.test.sql` para quem ler o arquivo depois sem
este handoff.

---

## 1. O que foi implementado

### 1.1 Banco de dados

2 tabelas novas: `leads` e `lead_values`, mais 2 enums
(`lead_priority`: baixa/media/alta; `lead_status`: ativo/arquivado).

`leads.contact_id` usa **FK composta** contra `contacts (workspace_id,
id)` — não uma FK simples contra `contacts.id` — para garantir, no
próprio banco, que um lead nunca aponte para um contato de outro
workspace (constraint nova `contacts_workspace_id_id_key`, aditiva).

`lead_values`/`private.money_band_label()`/`private.lead_value_projection()`
continuam existindo (nenhuma migration aplicada foi reescrita), mas **não
fazem mais parte do contrato ativo** — ver seção 0. `estimated_value_cents`
não é um campo de `leads` no modelo aprovado; honorários é assunto de
`opportunities`, na A5. **A tabela `leads` não tem GRANT nem policy que
permita acesso direto** — diferente de `contacts`, que permite SELECT
direto — porque a regra "seus + sem responsável" do advogado é um filtro
de linha dependente do papel de aplicação, que o GRANT do Postgres (por
papel de banco) não consegue expressar sozinho. Decisão completa em
`docs/decisoes/a4-leads.md`.

7 funções `SECURITY DEFINER` no contrato ativo: `create_lead`,
`update_lead_basic_fields`, `assign_lead`, `set_lead_status`, `get_lead`,
`list_leads`, mais o helper privado `private.lead_accessible_to_role()`
(a implementação única do alcance "seus + sem responsável", usada por
leitura e escrita). `set_lead_value()` continua definida, mas com
`EXECUTE` revogado de `authenticated` — não é chamável por nenhum papel.

### 1.2 "Seus + sem responsável" do advogado — leitura e escrita

Filtro de linha único (`private.lead_accessible_to_role`), usado em
`list_leads()`/`get_lead()` **e** em `update_lead_basic_fields()`/
`assign_lead()`/`set_lead_status()`: `assigned_to IS NULL OR assigned_to
= auth.uid()`. Fora do alcance, leitura E escrita respondem
`lead_not_found` — nunca erro de permissão (não revela existência, mesmo
princípio de recurso de outro workspace do plano §6.8), e nenhum dado é
alterado. "Equipe" confirmado com o dono do produto como "seus + sem
responsável" (fila compartilhada) — não existe tabela de equipe/hierarquia
no schema, e essa era a definição que faltava aprovar (ver seção 0.1).

### 1.3 Concorrência — checagem atômica

`update_lead_basic_fields`, `assign_lead` e `set_lead_status` recebem
`p_expected_updated_at`, agora **obrigatório**. A comparação acontece
dentro do `WHERE` do próprio `UPDATE` — checar e gravar são a mesma
operação atômica, sem janela entre os dois passos (ver seção 0.1,
achado 2). Zero linhas afetadas → `lead_conflict`.

### 1.4 Integração com merge/undo de contatos (A3)

`merge_contacts()`/`unmerge_contact()` estendidas (`CREATE OR REPLACE`,
mesma assinatura, mesmo GRANT) para reconhecer `leads` no formato já
genérico de `moved_rows`. Mesclar reparenta os leads do contato perdedor
para o vencedor; desfazer restaura, com a mesma trava de conflito
(linha editada/apagada depois da mesclagem). Usa `UPDATE ... RETURNING
updated_at` desde o primeiro commit — mesma correção do achado 7 da A3,
aplicada aqui preventivamente.

### 1.5 Interface

- `/leads` — `DataTable` com paginação, `FilterBar` (busca, status,
  prioridade, responsável — tudo resolvido no servidor via `list_leads`,
  nunca carregado por inteiro pro navegador filtrar), estados de vazio
  ("nenhum ainda" vs. "nenhum encontrado" com filtro ativo), erro
  (`error.tsx`) e carregamento (`loading.tsx`).
- `/leads/novo` — cria vinculando um **contato existente** (reaproveita
  `listContactOptions()`, mesma tabela/RLS de `contacts`, sem duplicar
  cadastro), com atalho `?contactId=` para pré-selecionar.
- `/leads/[id]` — edição de dados básicos (somente leitura para quem não
  tem `lead.edit`), atribuir responsável, arquivar/reabrir. Sem seção de
  valor — não existe mais (seção 0.1, achado 3).

### 1.6 Permissões

Matriz de `src/lib/roles.ts`: `lead.view` (todos os papéis — o filtro de
linha do advogado é aplicado no banco, não aqui) e `lead.edit` (todos
menos viewer). `lead.view_value` foi removida — não sobrou nenhuma
permissão de valor para expressar (seção 0.1, achado 3).

Toda Server Action de leads retorna `{ok, error}` visível — nenhuma ação
void que engula `AuthzError` sem dar retorno a quem clicou (instrução
explícita desta fase, para não repetir o padrão já identificado como
pendência em `team/actions.ts`).

---

## 2. Matriz de campos e ações por papel

| Ação | Owner/Admin/Manager | Advogado | Atendimento (sales) | Visualizador |
|---|---|---|---|---|
| Ver lista de leads | Todos do workspace | Só os seus + sem responsável | Todos do workspace | Todos do workspace |
| Ver um lead específico | Sempre | "Não encontrado" se não for seu/sem responsável | Sempre | Sempre |
| Editar dados básicos | ✅ | ✅ só dentro do alcance ("não encontrado" fora dele, dado preservado) | ✅ | ❌ |
| Atribuir responsável (inclusive a si mesmo) | ✅ | ✅ só dentro do alcance | ✅ | ❌ |
| Arquivar/reabrir | ✅ | ✅ só dentro do alcance | ✅ | ❌ |

Honorários não é campo de `leads` — não há linha de valor nesta matriz
porque o dado não existe neste modelo (seção 0.1, achado 3). Fica para a
matriz da A5, quando `opportunities.value_cents` existir.

---

## 3. Verificação nesta máquina (sem Docker)

Resultado após aplicar as correções da revisão (seção 0) — mesmos
comandos, mesma máquina sem Docker local (`supabase status` não conecta
— reproduz o banco completo só no CI, como já era antes):

| Comando | Resultado |
|---|---|
| `npm run typecheck` | sem erros |
| `npm run lint` | sem erros nem avisos |
| `npm test` | **112 testes**, todos passando (sem mudança de contagem — a correção não alterou nenhum teste unitário; `money.ts`/`money.test.ts` seguem intactos, só sem chamador em leads agora) |
| `npm run build` | 25 rotas, as mesmas de antes — a remoção da seção de valor não tirou nem criou rota |

A migration nova (`20260909100500_a4_review_hardening.sql`) foi aplicada
em `praxis-crm-dev` com `db:push:dry-run` antes e `db:push` depois
(confirmado o projeto linkado antes de cada um); os tipos foram
regenerados com `db:types` a partir do banco hospedado, e conferidos
depois pelo `db:types:check` do próprio CI (mesma diferença cosmética
`--linked`/`--local` já conhecida das fases anteriores, sem mudança de
schema real).

## 4. Verificação no CI (Docker real)

### 4.1 Primeira entrega (commit `7215d25`/`1c6e753`) — histórico

**Ficou verde**, depois de 8 rodadas — todas por erro meu (teste ou UI),
nenhuma por bug real de política de acesso do banco (o isolamento sempre
esteve correto; os achados foram todos em como eu TESTAVA isso ou em como
a interface reage ao React 19, nunca em quem podia ver o quê). pgTAP: 174
asserções em 9 arquivos (34 da A4, na versão anterior à revisão — inclua
os testes de projeção de valor removidos depois). e2e: 24 testes (16 já
existentes da A2/A3 + 8 da A4, na versão anterior à revisão).

**Essa entrega passou no CI mas não devia ter passado na revisão** — CI
verde prova que o código faz o que os testes pedem, não que os testes
pediam a coisa certa. A revisão encontrou os três problemas da seção 0
justamente porque nenhum teste (pgTAP ou e2e) exercitava escrita fora do
alcance do advogado, concorrência atômica de verdade, nem questionava se
honorários devia estar em `leads`.

### 4.2 O que cada rodada da primeira entrega corrigiu

1. **`database.ts` desatualizado** — mesma diferença cosmética
   `--linked`/`--local` já documentada na A2/A3 (bloco
   `__InternalSupabase` e sintaxe dos tipos utilitários). Sem mudança de
   schema real.
2. **pgTAP: `insufficient_permission` inesperado** — o teste usava
   `reset role` achando que isso também trocaria quem `auth.uid()`
   enxerga; `request.jwt.claims` é escopo de TRANSAÇÃO, não de papel do
   Postgres. Reescrito reafirmando papel E jwt explicitamente antes de
   cada bloco, em vez de confiar em estado deixado pelo anterior — inclui
   corrigir o teste de isolamento entre workspaces, que chamava
   `list_leads(ws_dois)` como Ana (sem membership lá, gerava erro em vez
   de `total_count=0`); passou a chamar como Bruno, dono de verdade do
   Escritório Dois.
3. **pgTAP: filtro por prioridade falhando** — um teste anterior mudava a
   prioridade do lead de 'alta' para 'media' como efeito colateral não
   intencional, quebrando um filtro testado mais adiante. Prioridade
   preservada.
4. **e2e: `switchWorkspace()` não esperava a troca terminar de verdade**
   — a Server Action troca o cookie e faz `redirect("/visao-geral")`;
   sem esperar essa navegação, uma chamada seguinte que depende do
   workspace ativo (a listagem de contatos do formulário de novo lead)
   podia correr na frente e ler o workspace ANTERIOR. Só depois de testar
   dois sinais diferentes (a URL sozinha não bastava — quem troca já
   costuma estar em `/visao-geral`, então essa espera nunca esperava nada
   de fato) que o texto do workspace ativo na sidebar se mostrou o sinal
   confiável. Corrigido no helper compartilhado (usado por A2/A3 também,
   sem quebrar nada lá).
5. **e2e: `page.url()` lido antes do redirect terminar** — dois pontos do
   teste de mesclagem liam a URL logo após clicar num botão cuja Server
   Action faz `redirect()`, capturando a URL ANTERIOR (`/contatos/novo`)
   em vez da nova — o `contactId` virava a string literal "novo".
6. **e2e: Bruno não era mais um "estranho" de verdade** — o próprio e2e
   da A2 (`auth-workspace.spec.ts`) convida e aceita Bruno no Escritório
   Um mais cedo na MESMA execução do CI (mesmo banco local, sem reset
   entre arquivos) — na hora em que o teste de isolamento da A4 rodava,
   Bruno já era membro de verdade de lá. Confirmado com um rerun idêntico
   do CI (mesma falha, não era instabilidade) e com uma chamada direta a
   `get_lead()` contra o banco hospedado simulando um usuário
   genuinamente sem membership nenhuma — corretamente recusado. Trocado
   para Daniel, que nunca ganha acesso ao Escritório Um em nenhum outro
   teste.
7. **Achado real de UI, não de teste: React 19 duplicava texto ao
   resetar um `<form action>` não controlado.** Depois de um save bem-
   sucedido, React reseta os campos não controlados do formulário — e
   reconciliar o MESMO nó de texto com um `defaultValue` novo (o dado que
   acabou de ser salvo) durante esse reset duplicava o conteúdo (texto
   novo + texto antigo concatenados) em vez de substituir. Reproduzido e
   confirmado manualmente contra build de produção antes de corrigir:
   `key={lead.updatedAt}` em cada campo (não no `<form>` inteiro, para
   não afetar o estado de `useActionState` — a mensagem "Dados salvos."
   continua aparecendo normalmente) força uma remontagem limpa
   exatamente quando o dado muda.

### 4.3 CI da revisão (migration `20260909100500` + testes reforçados)

*(preenchido depois de rodar — placeholder até o CI deste commit terminar)*

## 5. Validação funcional — três camadas

### 5.1 pgTAP (`09_a4_leads.test.sql`, 40 asserções — 6 a mais que antes da revisão)

Criação/edição com persistência; vínculo obrigatório com contato do
mesmo workspace (FK composta barra no banco); **versão esperada
obrigatória** (omitir é recusado com `expected_version_required`);
**concorrência atômica** (reusar uma versão JÁ SUBSTITUÍDA — não um
`now() - interval` artificial — é recusada; a versão correta É aceita);
permissão por papel (viewer não cria/edita); **nenhuma chave de valor**,
para nenhum papel, nem o proprietário (honorários não é campo de leads);
acesso direto às tabelas `leads`/`lead_values` negado (`42501`, sem GRANT
nenhum) e `set_lead_value()` com `EXECUTE` revogado de `authenticated`;
"seus + sem responsável" do advogado **na leitura e na escrita**
(bloqueado em editar/atribuir/arquivar fora do alcance, com o dado
preservado depois da tentativa; permitido dentro do alcance, inclusive
autoatribuição de um lead sem responsável); busca/filtro/paginação
(`total_count` correto mesmo com página menor que o total); isolamento
entre workspaces; integração completa com merge (reparenta) e undo
(restaura); RLS forçada e GRANT exato (nenhum) nas duas tabelas novas.

### 5.2 e2e (`leads.spec.ts`, 8 testes)

Criação vinculando contato existente; edição básica; busca e filtro no
servidor; **o payload real que um visualizador recebe** — DOM final E
respostas de rede coletadas durante a navegação, sem nenhuma chave de
honorários e sem o CPF de um contato fictício com CPF CONHECIDO (o mesmo
vinculado ao lead); **escrita negada pelo SERVIDOR** — tentativa real via
API direta do Supabase (não só a interface escondendo o botão), com o
dado preservado depois; **duas edições concorrentes de verdade** (duas
chamadas HTTP simultâneas, `Promise.all`, contra o Supabase local —
exatamente uma grava, a outra recebe `lead_conflict`); isolamento entre
workspaces (lead de um escritório não existe para outro); mesclar contato
com **vencedor escolhido explicitamente** (o contato que NÃO tinha o
lead) e desfazer restaura, ambos confirmados pelo ID de destino.

### 5.3 Validação manual ao vivo — primeira entrega (histórico, antes da revisão)

Feita antes da revisão, contra a versão QUE TINHA o fluxo de valor —
mantida aqui como registro do que foi verificado então, não como
validação da versão atual (a seção de valor testada abaixo não existe
mais):

**No servidor local** (`playwright-cli`, contra o banco hospedado
`praxis-crm-dev`, conta QA `joaoniero2+praxisqaa3@gmail.com`):

| Fluxo | Resultado |
|---|---|
| Criar lead com valor (R$ 5.500,00) | OK — persistido e exibido corretamente |
| Editar dados básicos | OK — "Dados salvos." |
| Arquivar / reabrir | OK — botão alterna corretamente |
| Filtrar por status/prioridade/busca | OK |
| Mesclar dois contatos com lead vinculado ao perdedor | OK — lead passou a mostrar o contato vencedor |
| Desfazer a mesclagem | OK — lead voltou a mostrar o contato original |

**No preview real da branch:** login OK; revelar CPF de um contato
existente OK (confirmou a variável genérica de Preview funcionando de
verdade); listagem de leads OK. Papel `sales` viu a faixa, nunca o valor
exato (conferido também via `page.evaluate` no HTML).

### 5.4 Validação manual da revisão — o que foi feito e o que ficou pendente

**Feito nesta máquina:** `npm run build` completo sem erros (25 rotas,
as mesmas de antes — remover a seção de valor não mudou nenhuma rota);
consulta direta e somente-leitura ao banco hospedado antes e depois da
migration, confirmando a única linha residual de `lead_values` preservada
e a assinatura nova de `create_lead` (7 parâmetros) e o `EXECUTE`
revogado de `set_lead_value`.

**Não feito nesta rodada, honestamente registrado:** um novo smoke-test
autenticado ao vivo (local ou no preview) — Docker não está disponível
nesta máquina (`supabase status` não conecta ao daemon) e as credenciais
das contas QA hospedadas usadas na primeira validação não estavam em mãos
nesta sessão para reautenticar manualmente. A prova funcional desta
rodada é o CI (seção 4.3) — que reproduz o banco completo do zero e roda
os 8 e2e reais, incluindo os fluxos que a primeira validação manual
cobriu (criar, editar, arquivar, filtrar, mesclar/desfazer) — não um
smoke-test manual adicional. Se preferir, faço um smoke-test ao vivo
depois do CI verde, antes do merge — é rápido e sem custo.

---

## 6. Ambiente

Nenhuma migration destrutiva; todas aditivas, dry-run conferido antes de
cada push. Nenhuma chave criptográfica gerada, alterada ou vista por
mim. Nenhuma variável de ambiente da Vercel foi tocada nesta fase — o
preview do branch `feat/a4-leads` funcionou usando a entrada **genérica**
de Preview (sem branch específico) que já existia desde a A3, confirmado
funcionando de verdade (não só presente) revelando um CPF real.

---

## 7. Confirmações explícitas

- **Nenhuma fase além da A4 foi iniciada.**
- **Nenhum arquivo de referência visual foi alterado.**
- **Sem merge em `main`.** PR #4 aberto, correções da revisão aplicadas
  nesta branch, aguardando o CI da migration nova e aprovação explícita.
- **`praxis-crm-dev`:** só migrations aditivas aplicadas (dry-run
  conferido antes de cada uma, incluindo a da revisão). Nenhum dado
  apagado — a linha residual de `lead_values` da validação manual
  anterior segue lá, sem uso pelo contrato ativo (seção 0.1).
- **Nenhum dado sensível novo:** `leads` não guarda CPF, só referencia o
  contato (que já tem sua própria proteção da A3).
