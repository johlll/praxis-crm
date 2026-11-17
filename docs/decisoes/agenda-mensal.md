# Agenda mensal com painel do dia (17/11/2026)

A Agenda deixa de ser só "a semana atual" e passa a ser um calendário mensal com o painel do dia selecionado. A tela continua sendo a Agenda do Praxis, com ou sem Google Agenda conectado.

## Consulta

- Nova função **aditiva** `list_activities_in_range(p_workspace_id, p_from, p_to, p_page, p_page_size)` (migration `20261117120000_agenda_mensal_intervalo.sql`). `list_activities()` e os demais consumidores não mudam.
- Datas inclusivas no fuso America/Sao_Paulo, convertidas em instantes no banco. Intervalo obrigatório de no máximo 42 dias; acima disso, `invalid_date_range`. Não existe leitura do histórico inteiro.
- O alcance é o mesmo de `list_activities()`: membro ativo; advogado só vê os próprios leads e os sem responsável. Traz pendentes e concluídas.
- `items` vem paginado em até 100, com o mesmo formato de item. `total_count` e `day_counts` são do intervalo inteiro, nunca da página.
- O servidor (`listActivitiesInRange`) pagina até o fim e confere os itens contra `day_counts`. Falha de página, página vazia antes do fim ou divergência viram erro, e o `error.tsx` da Agenda mostra "Não foi possível carregar a agenda". A falha nunca aparece como "nenhuma atividade".
- pgTAP `54_agenda_mensal_intervalo` (40 asserções), cobrindo:
  - fronteiras de fuso, fevereiro bissexto e virada de ano;
  - papéis, isolamento e anon;
  - validação do intervalo;
  - paginação com 101 atividades.

## Tela

- O mês (`?mes=AAAA-MM`) é validado no servidor. Sem ele, ou com valor inválido, vale o mês de hoje no fuso do escritório.
- O dia (`&dia=AAAA-MM-DD`) é validado no cliente: um dia real do mês exibido. Senão, vale hoje (no mês atual) ou o dia 1.
- Selecionar um dia do mesmo mês só troca a URL pelo History API, que o Next sincroniza com `useSearchParams`. Não há nova busca, criação, reagendamento nem exclusão.
- Trocar de mês navega de verdade e seleciona o dia 1. "Hoje" volta ao mês atual com hoje selecionado.
- Recarregar e Voltar/Avançar reproduzem a seleção. A revalidação depois de criar, editar, concluir ou excluir mantém mês e dia.
- Datas como chaves de texto e aritmética em UTC (`src/lib/calendar-month.ts`). Nunca `new Date("AAAA-MM-DD")` no fuso local.
- Casas do calendário compactas, com número e contagem discreta. Hoje aparece em círculo preenchido com `aria-current="date"`; o selecionado tem contorno e `aria-pressed`. O nome acessível traz a data completa e a quantidade.
- Teclado no calendário:
  - setas andam dentro do mês;
  - Home e End vão ao início e ao fim da semana;
  - PageUp e PageDown trocam de mês.
- Painel do dia:
  - data completa e quantidade;
  - "Com horário" em ordem cronológica e "Sem horário" com as pendentes primeiro;
  - título, tipo, contato (link para o lead), responsável e situação (Pendente / Atrasada / Concluída, com ícone e texto);
  - o selo do Google Agenda que já existia e as ações existentes (`ActivityRowActions`).
- "Nova atividade" fica sempre no cabeçalho do painel e abre o formulário existente com a data do dia preenchida e editável. Ela não muda de lugar quando o dia deixa de estar vazio, porque a revalidação desmontaria o diálogo e levaria junto a confirmação e o aviso do Google.
- Layout em duas colunas a partir de 1280 px (`lg`), com o calendário fixo ao rolar. Abaixo disso, o calendário fica em cima e o dia embaixo: entre 1024 e 1279 px a sidebar de 236 px deixa cerca de 750 a 1000 px, pouco para as duas colunas mais as ações de cada atividade.

## Google Agenda (B2) preservado

- Abrir a Agenda continua disparando a sincronização sob demanda da própria conexão, com a trava de 5 minutos por agenda. Trocar de mês é abrir a Agenda de novo; selecionar dia não chega ao servidor.
- Os avisos de saúde (owner/admin), o selo de vínculo e sincronização e as ações de agenda continuam pelos componentes e fluxos existentes. Os estados foram testados com dados simulados, sem chamadas reais.

## Fora do escopo

Arrastar compromissos, recorrência, IA, WhatsApp e novas regras de agendamento.

## Publicação

A migration precisa ser aplicada no banco hospedado **antes** do deploy desta tela. Sem a função, a Agenda publicada mostraria o erro de carregamento. Nesta entrega ela foi validada só localmente e no CI.
