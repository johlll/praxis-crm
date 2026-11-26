# Tráfego Pago — etapa visual com demonstração

Página `/trafego-pago`: desempenho de anúncios (Meta e Google) e oportunidades. **Não há integração**: sem OAuth,
token, conta, rota de API, migration ou gravação. A referência de composição é a imagem aprovada
"Painel de tráfego pago do PRAXIS CRM"; ela define composição e hierarquia, não o tema.

## Quem vê o quê

| Escritório | Tela |
| --- | --- |
| `workspaces.is_demo = true` | dados **fictícios**, com aviso "Dados demonstrativos" na tela e "DEMONSTRAÇÃO (dados fictícios)" no CSV e no nome do arquivo |
| qualquer outro | "Nenhuma conta conectada": sem filtros, números ou campanhas |

- `is_demo` não tem permissão de UPDATE para o app; só muda por SQL direto. É a única leitura de banco da página.
- Falha nessa leitura vira erro (`error.tsx`). Nunca vira "é demonstração" nem "sem conexão".
- O conjunto fictício (`src/modules/traffic/demo-data.ts`) é montado no servidor, pela página, só para a
  demonstração. Nada é gravado no banco.
- O item do menu aparece para todos os papéis. **Antes de dados reais**, definir quem pode ver investimento (é
  informação financeira) e quem pode conectar contas.

## Estados

| Estado | Quando | O que aparece |
| --- | --- | --- |
| sem conexão | escritório não demonstrativo | "Nenhuma conta conectada" e a apresentação Meta/Google |
| carregando | rota (`loading.tsx`) e troca de filtro | aviso "Carregando…"; no filtro, o conteúdo anterior fica esmaecido e `aria-busy` |
| período inválido | datas recusadas | mensagem junto aos campos; nenhum número |
| sem resultados | nenhuma campanha com dados no filtro | texto próprio; sem cartões nem percentuais |
| falha | erro de leitura (`error.tsx`) | "Não foi possível carregar o Tráfego Pago" e "Tentar novamente" |

"Conectar" abre só uma explicação: a integração virá depois, começando **somente leitura**; o Praxis não cria,
pausa nem altera campanhas ou orçamento. Não há campo para preencher nem simulação de sucesso.

## Filtros e datas

- Na URL: `plataforma` (repetível), `periodo` (`7`, `30`, `90`, `mes`, `mes-anterior`, `personalizado`), `de`, `ate`.
  Sem JavaScript é um formulário GET.
- Ao menos uma plataforma fica marcada.
- Datas no fuso do escritório (`America/Sao_Paulo`), inclusivas. "Últimos N dias" termina hoje.
- Personalizado recusa: data faltando ou inexistente, início depois do fim, fim no futuro, início antes de 2000,
  mais de 366 dias. Uma data inválida na URL é recusada; o período nunca é trocado em silêncio.
- Cartões, gráfico, distribuição, tabela e CSV saem da mesma função (`buildTrafficReport`) sobre as mesmas linhas.

## Contrato de dados

| Métrica | Definição | Nunca |
| --- | --- | --- |
| Investimento | gasto informado pela plataforma, em centavos | — |
| Conversas | informadas pela **plataforma de anúncios** | somar ou confundir com as conversas do CRM |
| Leads qualificados | métrica própria do conjunto | — |
| Contratos | métrica própria, recebida pronta | deduzir de oportunidade ganha |
| Área de atuação | campo declarado da campanha | deduzir do nome |
| CPL | investimento ÷ leads qualificados do mesmo filtro; no total, soma ÷ soma | dividir por zero (mostra "—") |
| Situação | situação **atual** da campanha | tratar como situação do período |

**Comparação**: período anterior de igual duração, imediatamente antes. Só há percentual se os dois períodos têm
dados completos e a base anterior não é zero; senão, "sem base de comparação". A variação do investimento é
neutra (gastar mais não é melhor nem pior).

**Cobertura**: a demonstração tem 180 dias até hoje. Antes disso não há dado, o que é diferente de zero.

**Gráfico**: até 14 dias, um ponto por dia; acima, até 11 faixas alinhadas ao fim do período. A faixa menor, se
houver, é a primeira e é identificada como parcial na dica e na tabela.

## Demonstração

Cinco campanhas. Os "últimos 30 dias" somam R$ 7.890,00, 318 conversas, 127 leads qualificados e 21 contratos
(CPL R$ 62,13), com comparação de +12,4%, +18,7%, +24,5% e +40,0%. O conjunto é relativo a "hoje" e
determinístico: os atalhos de dias mostram os mesmos totais em qualquer data; um intervalo fixo do calendário
pode mudar de um dia para o outro, porque o conjunto anda junto.

A imagem de referência tem números que não fecham entre si, e eles **não** foram copiados: a distribuição mostra
Meta R$ 5.365,20 (68%) e Google R$ 2.524,80 (32%), mas as campanhas da própria tabela somam Meta R$ 4.265,20
(54%) e Google R$ 3.624,80 (46%); os pontos do gráfico somam bem mais que os 127 leads.

## CSV

Conjunto filtrado, na ordem exibida, sem linha de total; separador `;`, vírgula decimal, BOM. Texto que comece
(mesmo após espaços ou caracteres de controle) com `=`, `+`, `-`, `@` ou as versões de largura total, ou com
tabulação ou quebra de linha, ganha um apóstrofo. A coluna "Origem dos dados" identifica a demonstração.

## Apresentação

- Três formas da tabela conforme a largura do **conteúdo** (a barra lateral ocupa parte da janela): completa;
  com plataforma, área e situação sob o nome; cartões. Nas duas últimas há "Ordenar por".
- Cores: Meta `chart1`, Google `info`, sempre com o nome ao lado. Linhas: leads `chart4` (cheia, pontos cheios) e
  contratos neutro (tracejada, pontos vazados), com legenda e tabela. Os dois pares passam na separação para
  visão normal e daltonismo e no contraste; o tom claro de cada par fica fora da faixa de luminosidade/croma do
  validador, escolha mantida para seguir a referência.
- Sem os logotipos das plataformas e sem o menu "⋮" por campanha da referência (não há ação sobre campanha).
- `Topbar` ganhou a opção `wrapSubtitle` (usada só aqui).

## Testes

- `tests/unit/trafego-pago.test.tsx`: datas, comparação, consistência entre todas as visões em vários filtros,
  CPL, ordenação, CSV (inclusive fórmulas), tela, estados e isolamento.
- `tests/e2e/trafego-pago.spec.ts`: navegação e foco reais, voltar do navegador, download, sem JavaScript,
  larguras 1440 a 360 sem rolagem lateral, escritório comum sem dado fictício no HTML.

## Integração futura (fora desta etapa)

Precisa de contrato próprio e autorização antes de qualquer dado real:

1. Meta Ads e Google Ads **somente leitura**: aplicativos, escopos, contas e quem autoriza.
2. Guarda de tokens cifrados, revogação e isolamento por escritório.
3. Sincronização: frequência, atraso de dados, correções retroativas das plataformas e estado de falha/parcial.
4. Moeda, fuso da conta de anúncios e janela de atribuição.
5. Regra de **lead qualificado** e de **contrato** a partir do CRM, e como ligar campanha a lead (sem deduzir).
6. De onde vem a área de atuação de cada campanha.
7. Quem pode ver investimento e quem pode conectar.

## Lista para depois (não bloqueia)

- Logotipos oficiais das plataformas, se desejado, conforme as diretrizes de marca de cada uma.
- Guardar a ordenação escolhida na URL.
- Escolher colunas ou buscar campanha na tabela.
