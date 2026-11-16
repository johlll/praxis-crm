# Refinamento visual 2 — Visão geral com gráficos (16/11/2026)

Escopo aprovado por João: aproximar a Visão geral da referência (saudação e período no topo, faixa de indicadores, funil largo, gráficos e painel operacional) usando só os dados que a tela já recebia. Nenhuma RPC, migration, regra de negócio ou permissão nova.

## Fonte de cada bloco

| Bloco | Fonte | O que não mudou |
|---|---|---|
| Cartões do período | `get_dashboard.period_metrics` | fórmulas, rótulos e comparação (só onde já existia; base zero → "—") |
| Faixa complementar | `get_dashboard.cohort` / `positions` | posições atuais sem comparação |
| Funil (barras) | `get_dashboard.funnel` | as duas leituras, a taxa "Seguiu" da própria etapa e os mesmos títulos |
| Série (área) | `get_dashboard.series.won` | um ponto por faixa da RPC (1, 5 ou 15 dias), sem interpolar nem redistribuir |
| Previsto (barras) | `get_dashboard.series.forecast` | só para quem já recebia valores |
| Origem (rosca) | `get_dashboard_attribution.sources` | unidade oportunidade, um toque por oportunidade no modelo escolhido; "ganhas" fica só na tabela |
| Painel operacional | `get_dashboard.attention` / `agenda_today` | mesma lista, mesmos links e mesmo painel lateral |

## Lacunas (não implementadas por falta de fonte)

- Série de leads recebidos ou de conversas por dia: a RPC não tem (A10 §7). A evolução mostra oportunidades ganhas, e honorários para quem vê valores.
- Funil de leads: o funil do Praxis é de oportunidades por etapa.
- "Contratos assinados" e "honorários previstos": não são métricas do contrato atual. Os rótulos continuam "Oportunidades ganhas" e "Honorários das ganhas".
- Feed de "atividades recentes": não há fonte autorizada. O painel operacional reapresenta as oportunidades que exigem atenção.

## Decisões

- Recharts 3.10.1 (ver `versoes.md`). Sem `shadcn init`: o tooltip e a tabela são componentes próprios com os tokens.
- Funil em barras horizontais, não em segmentos encadeados. As 8 etapas reais têm nomes longos ("Verificar aderência e conflito"), que não cabem legíveis em segmentos a 1280–1440 px. Junto vai o resumo da coorte: ganhas + perdas + em andamento = criadas.
- Paleta `chart1`…`chart6` validada por script contra `surface`: luminosidade, croma, contraste ≥ 3:1 e separação entre fatias vizinhas para daltonismo (protan/deutan) e visão normal, inclusive no fechamento da rosca. "Não informada" usa `neutral`, também validado contra as seis. Com mais de seis origens, as cinco maiores mantêm cor e o resto vira "Outras origens".
- Rosca só com duas fatias ou mais; com uma origem só, uma frase. O centro mostra o total ou a fatia apontada (mouse ou teclado), e a linha da tabela acende.
- Cada gráfico tem tabela equivalente num `<details>`, que abre sem JavaScript; o tooltip nunca é o único caminho. Teclado: foco no gráfico e setas.
- O gráfico só é desenhado no navegador, depois de medir a área. O servidor reserva a mesma altura, então não há diferença de hidratação nem salto. A animação é curta e some com movimento reduzido.
- Sem `loading.tsx` na rota: sem JavaScript, o conteúdo transmitido ficaria escondido atrás do esqueleto e os filtros sem JavaScript quebrariam. Ao trocar filtro, a tela mantém os números anteriores até chegarem os novos.
- Breakpoints só base, `md` e `lg`. Aqui `md`/`lg` estão em px e o `sm` padrão em rem, e o Tailwind emite o `sm` depois do `lg`.
- Para o navegador vai o mesmo objeto já projetado pelo servidor. Sales e viewer não recebem chaves em reais; o HTML bruto foi conferido antes e depois.
