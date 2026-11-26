# Financeiro — etapa visual com demonstração

Página `/financeiro`. **Não é um módulo financeiro**: não há tabela, migration, gravação, integração bancária,
cobrança, nota fiscal, conciliação ou contabilidade. A referência de composição é a imagem aprovada
"Financeiro"; ela define hierarquia e organização, não o tema.

## Quem acessa

- `finance.view`: proprietário, administrador e gestor. A página confere no servidor **antes de qualquer consulta**;
  os demais papéis recebem "não encontrado" e não veem o item no menu.
- Dados fictícios só com `workspaces.is_demo = true` (`isDemoWorkspace`; o app não consegue alterar a coluna).
  Parâmetro de URL não libera nada: a página nem lê a URL. Falha nessa leitura é erro.
- Qualquer outro escritório: "Ainda não há lançamentos neste módulo", sem número (nem zero) e sem botão de lançar.

## Cálculos

Todos em centavos inteiros, a partir da mesma lista de lançamentos (`buildMonthView`). Cartões, gráfico, rosca e
tabela não têm outra fonte.

| Número | Regra |
| --- | --- |
| Recebido | receitas recebidas, pela **data do recebimento**, no mês |
| Despesas pagas | pagamentos, pela **data do pagamento**, no mês |
| Resultado do mês | recebido − despesas pagas (pode ser negativo) |
| A receber | **posição** na data de referência: receitas lançadas até ela e não recebidas nela |
| Em atraso | da posição, o que venceu **antes** da referência |
| A vencer | da posição, o que vence na referência ou depois |

- Previsto não entra no realizado nem no gráfico.
- Não há recebimento parcial: cada parcela é um lançamento.
- Toda receita deste módulo é honorário; por isso a rosca "Honorários a receber" e o cartão "A receber" são o
  mesmo número. Outras receitas (reembolso de custas, por exemplo) exigiriam separar os dois.
- Oportunidade ganha e proposta aceita **não** são lançamento: o módulo não lê o CRM.

## Datas

- Datas civis (`AAAA-MM-DD`) no fuso do escritório, `America/Sao_Paulo`. "Hoje" é calculado no servidor.
- Corte do realizado: do dia 1 até o último dia (mês fechado) ou até **hoje** (mês atual). Mês futuro não tem
  realizado.
- Data de referência do "a receber": último dia (mês fechado) ou hoje (mês atual e futuro).
- A situação mostrada na tabela é sempre a **de hoje**. Um lançamento é situado no mês pela data do dinheiro ou,
  em aberto, pelo vencimento.

## Comparação com o mês anterior

- Mês fechado: mês inteiro contra mês inteiro.
- Mês em curso: **o mesmo intervalo de dias** do mês anterior (26/11 compara com 1 a 26/10), limitado ao tamanho
  dele. No último dia do mês, volta a ser mês inteiro.
- A receber: posição na referência contra a posição no fim desse intervalo.
- **Sem percentual** quando: a base é zero; o resultado anterior foi negativo (o valor é mostrado); não há dados de
  todo o período anterior; o mês é futuro. Resultado atual negativo com base positiva é calculado.
- Cores: recebido e resultado, melhor para cima; despesas e a receber, sem juízo.

## Simulação (só na demonstração)

"Novo lançamento" abre um formulário com tipo, descrição, cliente ou fornecedor fictício, valor, vencimento,
situação e data de recebimento ou pagamento. Aviso fixo: **"Simulação — não grava no financeiro do escritório"**.

- O lançamento entra na memória da página, com a data de criação de hoje e marcado "simulado". Sem Server Action,
  banco, URL, `localStorage` ou `sessionStorage`. Recarregar (ou sair da página) volta ao início.
- Validações: campos obrigatórios; valor em reais (`1.250,00`), maior que zero e até R$ 100 milhões; datas reais a
  até dois anos de hoje; data de recebimento ou pagamento não pode ser futura.
- A confirmação diz "Incluído na simulação (não gravado)".

## Demonstração

**Os lançamentos são estáveis por mês.** Os de um mês saem só do próprio mês (`demoEntriesOfMonth` não recebe a data
atual): datas, valores e identificadores não mudam de um dia para o outro nem depois que o mês vira. Os nomes são
fictícios e não vêm da imagem. Os dados começam em 01/06/2026.

| Meses | Conteúdo |
| --- | --- |
| junho a outubro de 2026 | histórico: um recebimento e um pagamento por dia, do dia 1 ao 25 |
| novembro de 2026 | conjunto detalhado, com datas fixas |
| dezembro de 2026 em diante | mesmo formato do histórico, com totais que se repetem a cada cinco meses |

- Novembro, em qualquer data a partir de 26/11: R$ 38.400 recebidos, R$ 12.600 pagos, resultado R$ 25.800 e
  R$ 14.200 a receber (R$ 11.000 a vencer e R$ 3.200 em atraso). Outubro: R$ 32.400 e R$ 13.660, com R$ 12.600 a
  receber no fim do mês.
- De dezembro em diante, lançamento, vencimento e dinheiro ficam dentro do próprio mês, para nunca alterar um mês
  anterior. Esses meses não criam honorários em aberto.

**A data atual só corta e classifica:**
- o que ainda não foi lançado não aparece, e o que ainda não foi recebido ou pago fica em aberto;
- o realizado vai até hoje, e a comparação usa o intervalo descrito acima;
- um lançamento em aberto passa de "a vencer" para "em atraso" depois do vencimento. Os que novembro deixa em
  aberto (30/11, 07/12 e 16/12, além da despesa de 03/12) não ganham baixa automática: continuam em aberto e passam
  a aparecer em atraso.

A página usa o relógio real; nada congela a data.

### A referência não concilia

- Resultado de outubro: a imagem traz R$ 19.120, mas 32.400 − 13.660 = **18.740**; a variação do resultado passa
  de +34,9% para **+37,7%**.
- Recebido: 38.400 sobre 32.400 é **+18,5%**, não +18,6%.
- A curva diária somaria bem mais que o total recebido do cartão.

## Apresentação

- Um ponto por dia (soma do dia); curva "monotone", que não cria picos nem valores abaixo de zero. Recebimentos em
  linha cheia (`chart3`), despesas tracejadas (`chart1`); "Ver dados em tabela" traz todos os dias com movimento e
  o total.
- Rosca: A vencer `chart1`, Em atraso `chart4`, com a lista de valores e percentuais ao lado (o desenho é
  decorativo para leitor de tela).
- Tabela com 8 linhas e "Mostrar todos", busca por descrição e cliente ou fornecedor sem diferenciar acento, e
  ordenação por data. Estreita, vira lista com um botão de ordem.
- O seletor oferece 12 meses para cada lado e alcança qualquer lançamento simulado.

## Falta para um Financeiro real (fora desta etapa)

1. Modelo de dados (lançamentos, parcelas, recebimento parcial, estorno, cancelamento, categorias), com RLS,
   auditoria e permissões de escrita.
2. Quem lança, altera e vê cada coisa; vínculo opcional com cliente e caso, sem presumir recebimento.
3. Receitas que não são honorários e como aparecem em "a receber".
4. Importação do que o escritório já usa, conciliação, cobrança e documentos fiscais: cada um com ordem própria.
5. Retenção e exportação do titular para os dados financeiros.

## Lista para depois (não bloqueia)

- Editar ou excluir um lançamento simulado individualmente (hoje há "Restaurar demonstração").
- Filtro por receita/despesa e por situação.
