# A10 — Visão geral com dados reais · Handoff

Branch `feat/a10-dashboard` · PR #15 (aberta, **não mesclada**). A11 não iniciada.

## 1. O que foi entregue

- `/visao-geral` no layout do protótipo aprovado, ligada a `public.get_dashboard`
  (migration `20260917100000_a10_dashboard.sql`).
- Blocos: filtros (período 7/30/90, responsável atual do lead, sem responsável,
  área jurídica); indicadores **do período** com comparação; faixa **Agora**
  (conversão dos leads recebidos, tempo até o ganho, abertas, valor em
  negociação); alerta de atenção; funil por etapas reais ("No período" e
  "Agora"); série de ganhos e previsão; oportunidades que exigem atenção com
  painel lateral (perfil completo, Ganhou/Perdeu com os diálogos do Pipeline);
  agenda de hoje com concluir; desempenho da equipe; destaques calculados.
- `workspaces.is_demo` e marcação "Dados demonstrativos".
- `/relatorios`: placeholder sem fase atribuída (`PagePlaceholder.phase` ficou
  opcional).
- Título do teste de confirmação corrigido sem mudar a lógica
  (`tests/unit/stabilization-auth-confirm.test.tsx`).

## 1.1 Revisão da PR (antes do merge)

Três pontos revisados a pedido. **Os três eram defeitos reais** e cada um foi
reproduzido com teste que falha antes da correção e passa depois — nenhum
ficou só na leitura do código. Nenhuma regra da A5 foi alterada e a migration
anterior não foi editada: a correção está em
`20260917110000_a10_dashboard_review.sql`.

| Ponto | O que estava errado | Como foi reproduzido | Correção |
|---|---|---|---|
| **Funil** | A etapa contava como alcançada por comparação de posições (`maior posição já ocupada ≥ posição da etapa`). Como a A5 permite mover direto para uma etapa adiante, a etapa **pulada** aparecia como alcançada; e reordenar etapas (ou inserir uma no meio) mudava o histórico já registrado. A taxa dividia duas contagens independentes. | Teste de banco com uma oportunidade movida de 0 direto para 3: a função devolvia 3 passagens nas etapas 1 e 2 (o certo é 2 e 2), e o funil parecia perfeito — 100% de "conversão" em etapas por onde ninguém passou. | Contagem pelas etapas **efetivamente registradas** (etapa atual + origem e destino de cada transição), por identidade de etapa, com `distinct` para reentrada. Duas colunas: **Passaram** e **Seguiu** (das que passaram por aquela etapa, quantas seguiram adiante — etapa posterior ou ganho). Numerador ⊆ denominador: a taxa nunca passa de 100%. |
| **Equipe** | A tabela partia só das memberships ativas, mas `remove_membership` apaga a membership e **preserva** `assigned_to`. Os registros de quem saiu desapareciam da tabela. | Teste de banco removendo um membro com lead, consulta e atrasada atribuídos: a soma da coluna de leads veio **3** contra **4** do indicador geral, e a linha da pessoa sumiu. | Entram também os responsáveis presentes nos registros visíveis sem membership ativa, marcados `is_former` (etiqueta "Fora da equipe"). Sem devolver acesso, sem mudar atribuição, sem passar do alcance de quem consulta. As quatro colunas somam os indicadores correspondentes. |
| **Filtros** | Os seletores usavam `defaultValue`, que só vale na montagem. Em "Limpar filtros" e em voltar/avançar (navegação do cliente, mesmo componente), o seletor continuava mostrando o filtro anterior enquanto os números já eram os da URL nova. | Teste de componente: aplicar período 7 e depois receber as props de `/visao-geral` deixava o seletor em "7 dias" com os indicadores de 30 dias (`expected '7' to be '30'`). | `key` com o valor que veio da URL em cada seletor: quando a URL muda, o seletor é remontado com o valor certo. Sem JavaScript nada muda — o HTML já vem do servidor com a opção marcada. |

Testes acrescentados: `supabase/tests/database/17_a10_dashboard_review.test.sql`
(21 asserções), `tests/unit/a10-dashboard-review.test.tsx` (6) e o e2e 5 de
`tests/e2e/dashboard.spec.ts` (aplicar → limpar → voltar/avançar conferindo
URL, seletores e indicadores a cada navegação).

Evidência da reprodução, antes da correção, no `praxis-crm-dev` (transação
desfeita), com a função da migration anterior e as mesmas fixtures do teste
novo — uma oportunidade movida de 0 direto para 3, uma que voltou e reentrou,
uma ganha:

| Etapa | Leitura antiga (`reached`) | Passagem registrada (correto) |
|---|---|---|
| 0 | 3 | 3 |
| 1 | **3** | 2 |
| 2 | **3** | 2 |
| 3 | 1 | 1 |

Com a função antiga, 3 das 21 asserções passavam; com a migration da revisão
aplicada na mesma transação, 21 de 21. No mesmo teste, a soma da coluna de
leads da tabela da equipe vinha **3** contra **4** do indicador geral depois
de `remove_membership`.

## 2. Fórmulas e decisões

Especificação completa: [`docs/decisoes/a10-dashboard.md`](docs/decisoes/a10-dashboard.md).
Resumo:

| Indicador | Data | Fórmula |
|---|---|---|
| Leads recebidos | `leads.created_at` | contagem de leads |
| Consultas realizadas | `activities.completed_at` | reuniões concluídas |
| Propostas enviadas | `proposals.sent_at` | propostas com envio registrado |
| Oportunidades ganhas | `opportunities.won_at` | contagem (não "contratos": `signed_at` é opcional) |
| Honorários das ganhas | `won_at` | soma do valor acordado no ganho (não é recebido) |
| Tempo até o ganho | `won_at` | média `won_at − lead.created_at` |
| Conversão dos leads recebidos | `leads.created_at` | leads da coorte com ganho ÷ leads da coorte, sem comparação |

- Período: dias de calendário em `America/Sao_Paulo` (`private.office_timezone`),
  `[início, fim)` sem sobreposição; anterior com o mesmo número de dias;
  base zero → "—".
- Posições atuais sem comparação histórica.
- Funil: coorte das oportunidades do pipeline criadas no período; etapas
  efetivamente registradas (atual + origem/destino das transições), uma
  contagem por etapa mesmo com reentrada e sem contar etapa pulada; taxa de
  avanço sobre a mesma população (das que passaram, quantas seguiram
  adiante); ganhas, perdas registradas e em andamento separadas; nenhum
  "qualificado"; pipelines nunca somados entre si.
- Equipe: leads e ganhas pelo responsável atual do lead; consultas e atrasadas
  pelo responsável atual da atividade; sem "atendidas"; quem saiu do
  escritório continua na tabela, marcado "Fora da equipe".
- Papéis: alcance por registro antes de agregar; reais, previsão, data
  prevista, probabilidade e modelo só para owner/admin/manager/lawyer; sales
  só a faixa da oportunidade individual; viewer nada.
- Insights com mínimos (3/1, 3/2, 3/2) e base declarada.
- Falha da RPC → `DashboardLoadError` → `error.tsx` com "Tentar novamente".
- Sem biblioteca de gráficos (barras em CSS, nenhuma dependência nova).
- Sem `loading.tsx` na rota: com streaming, a página sem JavaScript ficava
  presa no esqueleto (o conteúdo só aparece por script). Sem ele, o HTML já
  chega completo e os filtros (formulário GET via `next/form`) funcionam
  antes da hidratação.

## 3. Dados

- **Seed local/CI**: escritórios "Escritório Painel (seed)" (owner Paula,
  lawyer Lucas, sales Sofia, viewer Vitor; 64 leads, 59 oportunidades, 132
  atividades, 17 propostas) e "Escritório Painel B (seed)" (12 leads, owner
  Otávio), com usuários próprios. Escritório Um/Dois e seus usuários não
  mudaram. Gerador determinístico (aritmética sobre o índice do lead, datas
  relativas ao dia do reset, dias de borda de período evitados), com lead
  antigo ganho no período, reentrada de etapa, leads com duas oportunidades e
  leads sem oportunidade. O seed checa se `is_demo` existe, porque o CI também
  o aplica numa versão anterior do banco.
- `scripts/check-upgrade-proposal-counter.sh`: a proposta usada no passo 4
  passou a ser escolhida só no Escritório Um. Antes era "qualquer uma", e o
  seed agora tem propostas em escritórios onde a Ana não é membro. As
  conferências não mudaram.
- **praxis-crm-dev**: "Escritório Demonstração (A10)"
  (`d10a0000-0000-4000-8000-000000000001`, `is_demo = true`), criado por
  `scripts/a10-demo-workspace.mjs`:
  - confere o projeto vinculado (`rgoeppjwnltcbeqipovh`) antes de gravar;
  - simula por padrão (rollback) e só grava com `--apply`;
  - usa o mesmo gerador do seed;
  - cria quatro contas novas (`demo-a10.<papel>@praxis.test`) sem tocar em
    contas, escritórios ou permissões existentes;
  - calcula a senha como hash argon2id no Node, então a senha nunca vai no
    SQL;
  - guarda as credenciais só em `C:\Users\niero\Desktop\Henrique\praxis-demo-a10.txt`.
  - Segunda execução: nada gravado, contagens iguais (64 leads, 59
    oportunidades, 132 atividades, 17 propostas, 4 membros).
  - As quatro contas autenticaram (HTTP 200).

## 4. Evidências

| Verificação | Tipo | Resultado |
|---|---|---|
| `16_a10_dashboard.test.sql` (64 asserções): bordas de período, lead antigo com ganho, anterior, reentrada, duas oportunidades por lead, filtros, alcance do advogado, sales filtrado até uma oportunidade, viewer, isolamento, sem sessão, erros, ganho refletido, função × consultas independentes no seed (>20 leads) | teste de banco | 64/64 no `praxis-crm-dev` em transação desfeita; verde no CI |
| Suíte pgTAP completa / isolamento | CI | 579 / 26, PASS (run 35221333610) |
| Unitários (`a10-dashboard.test.tsx` + suíte) | teste automatizado | 306/306 |
| e2e `dashboard.spec.ts` (blocos, HTML de sales/viewer sem `Cents`, RPC direta, filtros sem JS, ganho pelo painel, sem erro de hidratação) + suíte | CI | 60/60 (run 35221333610) |
| Preview, 4 papéis, 30 dias | hospedado | owner/lawyer com reais; sales só `valueBand`; viewer sem "R$"; advogado com alcance próprio (15 leads, 3 ganhas); 0 erros de console e de hidratação |
| Preview × banco (owner, 30 dias) | hospedado + consulta só de leitura | 30 leads, 15 consultas, 15 propostas, 5 ganhas, R$ 150.000 na tela e nas consultas independentes |
| Ganho pelo painel (owner, 7 dias) | hospedado | ganhas 2 → 3, mantido após recarregar; no banco `won`, R$ 2.500, handoff criado |
| Filtros sem JavaScript | hospedado | `?periodo=7` aplicado, série "Últimos 7 dias" |
| Acessibilidade (axe, WCAG A/AA, `main`) | hospedado | 0 violações |
| Layout 1440×900 × protótipo | hospedado | mesma estrutura (filtros, 5 cartões, faixa + alerta, funil + atenção, série + agenda, equipe, destaques); corrigido o grid em 2 colunas (`sm:` perdia para `lg:`) |

### Revisão da PR — verificações próprias

| Verificação | Tipo | Resultado |
|---|---|---|
| `17_a10_dashboard_review.test.sql` (21 asserções): etapa pulada, reentrada, reordenação de etapas, taxa ≤ 100%, consulta independente, membro removido com registros, somas × indicadores gerais | teste de banco | 3/21 com a função anterior (defeitos reproduzidos); 21/21 com a migration da revisão, no `praxis-crm-dev` em transação desfeita; verde no CI |
| Funil no preview × consulta independente (escritório demonstrativo, 30 dias) | hospedado + consulta só de leitura | passagens 29/26/24/20/16/12/8/4 e "seguiu" 26/24/20/16/12/9/5/1 iguais na tela e na consulta escrita à parte; nenhuma taxa acima de 100% |
| Filtros com JavaScript: aplicar período → área → responsável, limpar, voltar (2×), avançar | hospedado | a cada navegação, URL, os três seletores e "Leads recebidos" juntos (30 → 8 → 1 → 1, limpar volta a 30) |
| O mesmo fluxo no preview **anterior** (`eb41a8b`) | hospedado | defeito reproduzido: depois de "Limpar filtros" a URL era `/visao-geral` e o indicador 30, mas os seletores continuavam em "7 dias" e "Trabalhista" |
| Equipe com responsável fora da equipe | hospedado | `remove_membership` executado no escritório **demonstrativo** pelo fluxo real: a linha continuou na tabela com a etiqueta "Fora da equipe" e 7 leads; soma 8 + 8 + 7 + 7 = 30 = indicador geral. A membership foi recriada em seguida (4 membros ativos, mesmos papéis); nenhum lead ou atividade foi alterado |

Commits: `215270c` (A10), `ddb2550` (layout, sem JavaScript e seletores do
e2e), `eb41a8b` (handoff e script de atualização), `f45afca` (revisão da PR:
funil, equipe e filtros), `773f705` (linha da equipe no teste 16 inclui
`is_former`) e `5addf83` (o e2e dos filtros confere os seletores contra a URL
corrente, sem depender da contagem de entradas do histórico). O CI do último
commit está registrado na PR.

## 5. Pendências e observações

- Migration aplicada no `praxis-crm-dev` antes do merge, como nas fases
  anteriores (só acréscimos: uma coluna com padrão e três funções). Os tipos
  foram atualizados à mão, porque o gerador remoto formata diferente do
  local; o CI confirma pelo gerador local.
- A migration da revisão (`20260917110000`) também já está aplicada no
  `praxis-crm-dev` — `create or replace` da mesma função, sem mudança de
  schema nem de dados. Sem ela o preview mostraria as chaves novas vazias.
- Para validar na tela a linha "Fora da equipe", a membership da conta
  fictícia de atendimento do escritório **demonstrativo** foi removida pelo
  fluxo real e recriada logo depois (papéis e contagens conferidos). Ficou
  registrado um `audit_log` de `membership.removed` nesse escritório
  demonstrativo; nenhum escritório, conta ou permissão real foi tocado.
- As iniciais do avatar usam a última palavra do nome, então "Demo
  Proprietária (A10)" vira "D(". O comportamento de `initialsOf` já existia e
  não foi alterado.
- Perdas não têm data própria, então não há "perdidas no período".
- Reordenar etapas não muda quais etapas cada oportunidade visitou; muda
  só a ordem de exibição e o que conta como "adiante" na taxa de avanço.
- Fuso por escritório ainda não existe (ponto único:
  `private.office_timezone`).
- Fora da fase: origem e atribuição (A11), primeira resposta, recebidos,
  metas, personalização e `/relatorios`.
