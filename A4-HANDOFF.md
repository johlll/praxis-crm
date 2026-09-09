# A4 — Handoff: leads

**Projeto:** Praxis CRM Jurídico
**Fase:** A4
**Branch:** `feat/a4-leads`
**PR:** https://github.com/johlll/praxis-crm/pull/4 — **aberto, aguardando CI/aprovação**
**Preview:** https://praxis-crm-git-feat-a4-leads-johllls-projects.vercel.app
**Data:** 09/09/2026

**Status:** implementada por completo — schema, permissões e projeções,
interface, integração com merge/undo de contatos (A3), pgTAP, e2e e
validação manual ao vivo. **Aguardando resultado final do CI e aprovação
explícita para merge — nenhum merge foi feito.**

**Pendências herdadas, não resolvidas por esta fase:** Site URL/Redirect
URLs do Supabase Auth (A2/A3) e o ambiente real de clientes (ainda não
existe — ver A3-HANDOFF.md seção 7) seguem como estavam.

---

## 1. O que foi implementado

### 1.1 Banco de dados

2 tabelas novas: `leads` e `lead_values`, mais 2 enums
(`lead_priority`: baixa/media/alta; `lead_status`: ativo/arquivado).

`leads.contact_id` usa **FK composta** contra `contacts (workspace_id,
id)` — não uma FK simples contra `contacts.id` — para garantir, no
próprio banco, que um lead nunca aponte para um contato de outro
workspace (constraint nova `contacts_workspace_id_id_key`, aditiva).

`lead_values` guarda só `estimated_value_cents`, numa tabela separada de
`leads`, **sem nenhum GRANT** para `authenticated`/`anon` — mesmo padrão
de `contact_sensitive` na A3, mas por um motivo diferente: não é dado
cifrado, é dado com visibilidade por papel de aplicação, que o GRANT do
Postgres (por papel de banco) não consegue expressar sozinho. **A
tabela `leads` também não tem GRANT nem policy que permita acesso** —
diferente de `contacts`, que permite SELECT direto — porque a regra
"advogado só vê os leads dele + sem responsável" é um filtro de linha
dependente do papel de aplicação, com o mesmo problema. Decisão completa
em `docs/decisoes/a4-leads.md`.

9 funções `SECURITY DEFINER`: `create_lead`, `update_lead_basic_fields`,
`assign_lead`, `set_lead_status`, `set_lead_value`, `get_lead`,
`list_leads`, mais os helpers privados `private.money_band_label()` e
`private.lead_value_projection()`.

### 1.2 Projeção do valor por papel

`get_lead()`/`list_leads()` devolvem jsonb montado com
`jsonb_build_object(...) || private.lead_value_projection(papel, centavos)`:

- **Owner/admin/manager/lawyer:** `estimated_value_cents` (número exato).
- **Sales (atendimento):** `estimated_value_band` (faixa: até R$2.000,
  R$2.000–5.000, R$5.000–10.000, R$10.000–25.000, acima de R$25.000) —
  **nunca o número exato**, mesmo podendo escrever um valor novo.
- **Viewer:** nenhuma das duas chaves — ausência real no jsonb, não um
  `null` presente.

### 1.3 "Seus + equipe" do advogado

Filtro de linha dentro de `list_leads()`/`get_lead()`:
`assigned_to = auth.uid() OR assigned_to IS NULL`. Lead fora do alcance
responde `lead_not_found` — nunca erro de permissão (não revela
existência, mesmo princípio de recurso de outro workspace do plano §6.8).

### 1.4 Concorrência

`update_lead_basic_fields`, `assign_lead`, `set_lead_status` e
`set_lead_value` recebem `p_expected_updated_at` opcional; se vier
preenchido e não bater com o `updated_at` atual, recusam com
`lead_conflict` — nunca sobrescrevem silenciosamente. `set_lead_value`
compara contra o `updated_at` de `lead_values` (linha separada de
`leads`) — por isso `get_lead()`/`list_leads()` expõem `value_updated_at`
à parte (achado escrevendo a tela de valor, corrigido antes do PR — ver
migration `20260909100400`).

### 1.5 Integração com merge/undo de contatos (A3)

`merge_contacts()`/`unmerge_contact()` estendidas (`CREATE OR REPLACE`,
mesma assinatura, mesmo GRANT) para reconhecer `leads` no formato já
genérico de `moved_rows`. Mesclar reparenta os leads do contato perdedor
para o vencedor; desfazer restaura, com a mesma trava de conflito
(linha editada/apagada depois da mesclagem). Usa `UPDATE ... RETURNING
updated_at` desde o primeiro commit — mesma correção do achado 7 da A3,
aplicada aqui preventivamente.

### 1.6 Interface

- `/leads` — `DataTable` com paginação, `FilterBar` (busca, status,
  prioridade, responsável — tudo resolvido no servidor via `list_leads`,
  nunca carregado por inteiro pro navegador filtrar), estados de vazio
  ("nenhum ainda" vs. "nenhum encontrado" com filtro ativo), erro
  (`error.tsx`) e carregamento (`loading.tsx`).
- `/leads/novo` — cria vinculando um **contato existente** (reaproveita
  `listContactOptions()`, mesma tabela/RLS de `contacts`, sem duplicar
  cadastro), com atalho `?contactId=` para pré-selecionar.
- `/leads/[id]` — edição de dados básicos (somente leitura para quem não
  tem `lead.edit`), atribuir responsável, arquivar/reabrir, seção de
  valor (só para quem tem `lead.view_value`).

### 1.7 Permissões

Estendida a matriz de `src/lib/roles.ts`: `lead.view` (todos os papéis —
o filtro de linha do advogado é aplicado no banco, não aqui),
`lead.edit` (todos menos viewer), `lead.view_value` (todos menos viewer
— o formato exato/faixa é decidido no banco).

Toda Server Action de leads retorna `{ok, error}` visível — nenhuma ação
void que engula `AuthzError` sem dar retorno a quem clicou (instrução
explícita desta fase, para não repetir o padrão já identificado como
pendência em `team/actions.ts`).

---

## 2. Matriz de campos e ações por papel

| Ação/campo | Owner/Admin/Manager | Advogado | Atendimento (sales) | Visualizador |
|---|---|---|---|---|
| Ver lista de leads | Todos do workspace | Só os seus + sem responsável | Todos do workspace | Todos do workspace |
| Ver um lead específico | Sempre | "Não encontrado" se não for seu/sem responsável | Sempre | Sempre |
| Criar / editar dados básicos | ✅ | ✅ | ✅ | ❌ |
| Atribuir responsável | ✅ | ✅ | ✅ | ❌ |
| Arquivar/reabrir | ✅ | ✅ | ✅ | ❌ |
| Ver valor de honorários | Exato | Exato (só nos que vê) | **Faixa**, nunca exato | **Nenhum** (chave ausente) |
| Definir valor de honorários | ✅ | ✅ | ✅ (mesmo sem ver o exato de volta) | ❌ |

---

## 3. Verificação nesta máquina (sem Docker)

| Comando | Resultado |
|---|---|
| `npm run typecheck` | sem erros |
| `npm run lint` | sem erros nem avisos |
| `npm test` | **112 testes**, todos passando (7 novos: `parseMoneyBRToCents`, cobrindo inclusive o caso que quebraria com ponto flutuante) |
| `npm run build` | 25 rotas, as 3 novas de `/leads` entre elas |

## 4. Verificação no CI (Docker real)

_A preencher com o resultado final assim que o CI da branch fechar._

## 5. Validação funcional — três camadas

### 5.1 pgTAP (`09_a4_leads.test.sql`, 34 asserções)

Criação/edição com persistência; vínculo obrigatório com contato do
mesmo workspace (FK composta barra no banco); concorrência (edição com
`updated_at` desatualizado recusada); permissão por papel (viewer não
cria/edita); **ausência real da chave** `estimated_value_cents`/
`estimated_value_band` para viewer; faixa correta para sales
(R$5.000–10.000 para R$5.500,00); valor exato para owner; acesso direto
às tabelas `leads`/`lead_values` negado (`42501`, sem GRANT nenhum);
"seus + equipe" do advogado (não encontra lead alheio, encontra o sem
responsável); busca/filtro/paginação (`total_count` correto mesmo com
página menor que o total); isolamento entre workspaces; integração
completa com merge (reparenta) e undo (restaura); RLS forçada e GRANT
exato (nenhum) nas duas tabelas novas.

### 5.2 e2e (`leads.spec.ts`, 8 testes)

Criação vinculando contato existente e persistência do valor; edição
básica; busca e filtro no servidor; **o payload real que um visualizador
recebe** — `page.content()` (o HTML de verdade enviado ao navegador, não
só o texto visível) não contém o valor, a faixa, nem a chave
`estimated_value` em nenhuma forma; ação de edição negada para viewer
sem crash; isolamento entre workspaces (lead de um escritório não existe
para outro); faixa do atendimento (sales); mesclar contato reparenta o
lead e desfazer restaura.

### 5.3 Validação manual ao vivo

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

**No preview real da branch** (`https://praxis-crm-git-feat-a4-leads-johllls-projects.vercel.app`,
com o token de bypass do SSO):

| Fluxo | Resultado |
|---|---|
| Login | OK |
| Revelar CPF de um contato existente | OK — confirma que a variável `CONTACTS_ACTIVE_KEY_VERSION`/`CONTACTS_KEY_VERSIONS` **genérica** de Preview (sem branch específico, herdada da A3) funciona de verdade neste branch novo, não só por estar presente |
| Listagem de leads | OK — mostra os leads criados no teste local (mesmo banco), incluindo o valor formatado |

**Papel `sales` testado ao vivo no preview** (conta QA
`joaoniero2+praxisqaa3sales@gmail.com`, senha redefinida com autorização
explícita, mesma técnica já usada para a conta owner): abriu o mesmo
lead de R$ 5.500,00 e viu "Valor atual: R$ 5.000–10.000" — nunca o valor
exato. Conferido também via `page.evaluate` que nem "550000" nem
"5.500,00" aparecem em lugar nenhum do HTML da página para esse papel
(a única ocorrência de "5.500,00" no HTML é o texto de exemplo estático
do campo de input, igual para qualquer lead — não é o dado real
ecoado).

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
- **Sem merge em `main`.** PR #4 aberto, aguardando CI e aprovação
  explícita.
- **`praxis-crm-dev`:** só migrations aditivas aplicadas (dry-run
  conferido antes de cada uma).
- **Nenhum dado sensível novo:** `leads` não guarda CPF, só referencia o
  contato (que já tem sua própria proteção da A3).
