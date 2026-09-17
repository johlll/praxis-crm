# A10 — Visão geral: definições dos indicadores

Fonte única dos números: `public.get_dashboard` (migration
`20260917100000_a10_dashboard.sql`). A tela só formata o que a função
devolve. Este documento é a especificação que a função implementa.

## 1. Regras gerais

| Regra | Como é aplicada |
|---|---|
| Alcance por registro antes de agregar | Todo bloco parte do conjunto `sl` (leads visíveis) filtrado por `private.lead_accessible_to_role` — a mesma regra de leitura desde a A4. Oportunidades, atividades e propostas entram só pelo lead. Contadores, séries, rankings, funil e insights são calculados depois desse filtro. Nenhuma permissão nova. |
| Dinheiro protegido no servidor | Somas, séries e previsões em reais só existem no JSON para owner, admin, manager e lawyer (lawyer só sobre o próprio alcance). Sales recebe apenas a faixa (`value_band`) de cada oportunidade individual da lista de atenção. Viewer não recebe valor nem faixa. Toda chave em reais termina em `_cents`; data prevista, probabilidade e modelo de honorários também não chegam a sales/viewer. |
| Fuso | `private.office_timezone()` → `America/Sao_Paulo`, o único fuso já usado desde a A6 (o schema ainda não tem fuso por escritório; a função é o ponto único para quando tiver). |
| Período | Dias de calendário no fuso do escritório, intervalos meio-abertos `[início, fim)`. Atual = `N` dias terminando hoje (inclui hoje até agora). Anterior = os `N` dias imediatamente antes, sem sobreposição. `N` ∈ {7, 30, 90}; outro valor é recusado (`invalid_period`). |
| Variação | `(atual − anterior) / anterior`, arredondada. Anterior = 0 → "—" (sem base). |
| Período × posição | Indicadores de período usam a data do próprio evento e têm comparação. Posições atuais (abertas, valor em negociação, atrasos, atenção, agenda de hoje, distribuição por etapa, previsão) não têm comparação: o banco não guarda o estado passado delas. A tela separa os dois blocos ("No período" / "Agora"). |
| Filtros | Responsável **atual** do lead, "sem responsável", área jurídica do lead (igualdade exata). Valem para todos os blocos. O pipeline só escolhe o funil. Estado na URL (formulário GET), então cada combinação tem endereço próprio e o histórico do navegador funciona; os seletores são remontados quando a URL muda (`key`), para nunca mostrarem um filtro diferente do que os números já refletem. |
| Falha | Erro da RPC ou resposta vazia → `DashboardLoadError` → `error.tsx` com "Tentar novamente". Nunca zero nem painel vazio. |
| Volume | Tudo agregado em SQL sobre todos os registros. Listas exibidas têm limite (atenção: 20; agenda: 50) e sempre trazem o total real ao lado. |

## 2. Indicadores do período

| Indicador | Entidade (sem duplicar) | Data | Fórmula / denominador | Ausência e anterior | Papéis |
|---|---|---|---|---|---|
| Leads recebidos | lead (linha de `leads`) | `leads.created_at` | contagem | 0; comparação normal | todos |
| Consultas realizadas | atividade `type = meeting`, `status = done` | `activities.completed_at` | contagem | reunião pendente não conta; 0 | todos |
| Propostas enviadas | proposta com envio registrado | `proposals.sent_at` | contagem | rascunho (sem `sent_at`) não conta | todos |
| Oportunidades ganhas | oportunidade `status = won` | `opportunities.won_at` | contagem | lead antigo que ganhou no período entra; o rótulo não diz "contratos" porque o ganho não exige assinatura (`signed_at` é opcional) | todos |
| Honorários das ganhas | as mesmas oportunidades | `won_at` | soma de `value_cents` (valor acordado, obrigatório no ganho) | não é valor recebido | owner/admin/manager/lawyer |
| Tempo até o ganho | as mesmas oportunidades | `won_at` | média de `won_at − lead.created_at`, em dias (1 casa) | sem ganhas → "—"; o anterior é mostrado como valor, não como % | todos (não revela valor) |
| Conversão dos leads recebidos | **leads** criados no período (coorte) | `leads.created_at` | leads da coorte com ≥1 oportunidade ganha (até agora) ÷ leads da coorte | coorte vazia → "—"; **sem comparação**: a coorte anterior teve mais tempo para amadurecer | todos |

A conversão nunca divide ganhas do período por leads do período: numerador e
denominador são a mesma população (leads da coorte), unidade = lead.

## 3. Posições atuais

| Indicador | Definição |
|---|---|
| Oportunidades abertas | `status = open` |
| Valor em negociação | soma de `value_cents` das abertas; abertas sem valor são contadas à parte (money roles) |
| Paradas | abertas com `stage_entered_at` há mais de 5 dias |
| Sem responsável | abertas cujo lead não tem responsável |
| Com atividade atrasada | abertas com atividade `pending` e `due_at < agora` |
| Exigem atenção | abertas com qualquer um dos três sinais acima (conta uma vez) |
| Atividades atrasadas | atividades `pending` com `due_at < agora` |
| Sem próxima ação | abertas sem atividade `pending` com `due_at ≥ agora` (mesma regra da A6) |
| Agenda de hoje | atividades com `due_at` em `[meia-noite de hoje, meia-noite de amanhã)`, pendentes e concluídas |
| Previsão | abertas por `forecast_date` nos próximos `N` dias, em faixas; vencidas, sem data e sem valor contadas à parte (money roles) |

## 4. Funil

- Um pipeline por vez (padrão, ou o escolhido). Etapas de pipelines
  diferentes nunca são somadas, nem por nome nem por posição.
- **Nenhum indicador de "qualificado"**: as etapas são configuráveis e não
  existe marca de qualificação. O funil mostra as etapas reais.
- **Agora** (distribuição): abertas por etapa atual (+ soma em reais para
  money roles, pela projeção de coluna da A5).
- **No período** (avanço histórico): população = oportunidades do pipeline
  criadas no período (unidade = oportunidade; um lead com duas conta duas).
  Cada oportunidade tem o conjunto das etapas por onde **realmente passou**:
  a etapa atual e a origem e o destino de cada transição registrada (a etapa
  de criação é a origem da primeira transição; sem transição, é a etapa
  atual). Duas colunas por etapa:

  | Coluna | Definição |
  |---|---|
  | **Passaram** (`visited`) | oportunidades da coorte com registro naquela etapa, **uma vez cada** — reentrada e várias transições não duplicam |
  | **Seguiu** (`advanced`) | **das que passaram por aquela etapa**, quantas seguiram adiante: registraram passagem por uma etapa de posição maior, ou foram ganhas |

  A taxa exibida é `advanced ÷ visited` da **própria** etapa: numerador e
  denominador são a mesma população, então nunca passa de 100% e nunca
  divide duas contagens independentes. Ganhas, perdas registradas
  (`status = lost`, na etapa em que estavam) e em andamento aparecem à
  parte: falta de avanço **não** é perda. Coorte vazia → "Indisponível".
- **Etapa pulada não conta como passagem.** A A5 permite mover direto para
  uma etapa adiante (`move_opportunity_stage` exige os requisitos das
  intermediárias, mas não registra passagem por elas). A leitura é por
  identidade de etapa, nunca por comparação de posições — comparar posições
  inferia passagem que não aconteceu e fazia o funil parecer sempre
  monotônico. As regras de movimentação da A5 não foram alteradas.
- **Reordenar etapas não reescreve o histórico**: quais etapas foram
  visitadas é fato registrado por etapa. A ordem das etapas (e, com ela, o
  que conta como "adiante" e a ordem de exibição) é sempre a atual.
- Limitação registrada: perdas não têm data própria (só a auditoria
  registra o momento), então não existe "perdidas no período".

## 5. Equipe

| Coluna | Agrupamento |
|---|---|
| Leads recebidos (período) | responsável **atual** do lead |
| Consultas realizadas (período) | responsável **atual** da atividade (a reatribuição não é bloqueada para concluídas; não existe responsável histórico) |
| Oportunidades ganhas (período) | responsável **atual** do lead |
| Atrasadas agora | responsável atual da atividade |

Não há coluna "atendidas": atribuir um lead não prova atendimento, e primeira
resposta ficou fora desta fase. Linha "Sem responsável" só aparece com algum
número; visualizador sem nada atribuído não aparece.

**Responsável que saiu do escritório.** `remove_membership` (A2) apaga a
membership e **preserva** `assigned_to` em leads e atividades. A tabela parte
dos membros ativos **e** dos responsáveis presentes nos registros visíveis
sem membership ativa (marcados `is_former`, exibidos com a etiqueta "Fora da
equipe"). Sem isso, os registros de quem saiu ficariam fora da tabela e a
soma das colunas deixaria de bater com os indicadores gerais do período.
Entra apenas o nome, e só de quem já está atribuído a registros dentro do
alcance de quem consulta: nenhum acesso é devolvido, nenhuma atribuição muda
e o alcance não é ampliado.

Soma conferível, coluna por coluna: `Σ leads recebidos` = "Leads recebidos"
do período; `Σ consultas` = "Consultas realizadas"; `Σ ganhas` =
"Oportunidades ganhas"; `Σ atrasadas` = "Atividades atrasadas" (posição
atual). O que não tem responsável cai na linha "Sem responsável", que
aparece sempre que tem algum número.

## 6. Insights

Só a partir de números já calculados, com a base declarada e mínimos:

| Insight | Mínimo | Base |
|---|---|---|
| N de M abertas sem próxima atividade | ≥ 3 abertas e ≥ 1 sem próxima | posição atual |
| Etapa que concentra as paradas | ≥ 3 paradas e ≥ 2 na etapa | posição atual |
| Motivo de perda mais registrado | ≥ 3 perdidas na coorte do período e ≥ 2 com o motivo | oportunidades criadas no período |

Abaixo do mínimo, o bloco não aparece.

## 7. Fora desta fase

Origem dos leads, filtro de origem e modelo de atribuição (A11); primeira
resposta; série "Recebido"; metas; personalização; `/relatorios` (placeholder
sem fase atribuída).

## 8. Decisões de implementação

- Sem biblioteca de gráficos: o protótipo usa barras simples, feitas em CSS
  com os tokens (nenhuma dependência nova — política §2.1).
- `workspaces.is_demo` marca escritórios só com dados fictícios; só SQL
  direto altera (authenticated tem apenas SELECT em `workspaces`).
- Dados: seed local/CI com os escritórios "Painel" e "Painel B" e usuários
  próprios (os testes anteriores não mudam); o mesmo gerador cria o
  escritório demonstrativo do `praxis-crm-dev` via
  `scripts/a10-demo-workspace.mjs`.
