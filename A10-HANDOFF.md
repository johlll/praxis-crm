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
- Funil: coorte das oportunidades do pipeline criadas no período; maior etapa
  já ocupada (atual + origem/destino das transições); uma contagem por etapa
  mesmo com reentrada; ganhas, perdas registradas e em andamento separadas;
  nenhum "qualificado"; pipelines nunca somados entre si.
- Equipe: leads e ganhas pelo responsável atual do lead; consultas e atrasadas
  pelo responsável atual da atividade; sem "atendidas".
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

Commits: `215270c` (A10), `ddb2550` (layout, sem JavaScript e seletores do
e2e), e o commit deste handoff (script de atualização). O CI do último commit
está registrado na PR.

## 5. Pendências e observações

- Migration aplicada no `praxis-crm-dev` antes do merge, como nas fases
  anteriores (só acréscimos: uma coluna com padrão e três funções). Os tipos
  foram atualizados à mão, porque o gerador remoto formata diferente do
  local; o CI confirma pelo gerador local.
- As iniciais do avatar usam a última palavra do nome, então "Demo
  Proprietária (A10)" vira "D(". O comportamento de `initialsOf` já existia e
  não foi alterado.
- Perdas não têm data própria, então não há "perdidas no período".
- Reordenar etapas muda a leitura do funil histórico.
- Fuso por escritório ainda não existe (ponto único:
  `private.office_timezone`).
- Fora da fase: origem e atribuição (A11), primeira resposta, recebidos,
  metas, personalização e `/relatorios`.
