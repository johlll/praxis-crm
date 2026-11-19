# Conversas + IA — painel do caso: observações por caso

Item 5 das pendências do painel do caso ([conversas-painel-caso.md](conversas-painel-caso.md)) e item 1 da
etapa B ([conversas-painel-servico.md](conversas-painel-servico.md)). Migration
`20261122120000_conversas_observacoes_caso.sql`, posterior à última publicada (`20261121120000`); não carrega
nem reordena a da #358.

Fora desta entrega: Documentos e automação/IA (continuam pendentes).

## 1. O que é uma observação

- **Pertence ao caso (oportunidade), nunca ao contato inteiro.** Dois casos do mesmo contato têm observações
  independentes; trocar o caso em foco no painel não move nem copia nada (o foco continua sendo só estado da
  tela, vindo da URL).
- **As notas gerais do lead (`lead_notes`) não mudam.** Continuam no perfil do lead, identificadas como notas do
  lead. Nenhuma nota antiga é migrada nem associada a um caso por inferência (a migration não escreve em
  `case_notes`; o script de atualização confere).
- **Registro acrescentado e imutável**: texto, autor (`created_by`) e data/hora (`created_at`, com
  microssegundos). Não há um campo sobrescrito. Corrigir é registrar outra observação; não há edição nem exclusão
  comum (o gatilho recusa `UPDATE` com `case_note_immutable`; nenhuma função apaga).
- **Não exige número interno nem roteiro**, e vale para caso aberto, ganho ou perdido.
- Texto de 1 a 4.000 caracteres depois de normalizar: CRLF vira LF, as quebras internas ficam, só as bordas são
  aparadas (espaço, tab, quebras). É guardado como **texto**: nada é interpretado como HTML.

## 2. Interface

- **Resumo** (consulta): cartão **Observações** (ícone de documento, como a referência) depois de "Próximas
  ações", com as **3 mais recentes**, cada uma numa caixa com o texto, o autor e a data/hora, em ordem
  determinística `(created_at desc, id desc)`. **"Ver anteriores"** busca no servidor a página seguinte (10 por
  vez) pelo cursor da última mostrada (horário exato + id), até acabar — nada é carregado de uma vez nem
  escondido. Sem caixa de texto no Resumo; quem pode escrever vê o atalho **"Escrever"**, que abre a edição já
  na seção de observações.
- **Estados distintos**: vazio ("Nenhuma observação registrada neste caso."), **falha** (aviso com "Tentar
  novamente"; a carga das observações não derruba o painel e **nunca** aparece como "nenhuma observação"),
  indisponível para o perfil e **carregando** ("Carregando…" ao buscar anteriores; "Registrando…" ao gravar).
  Falha ao buscar as anteriores mantém as já mostradas e oferece "Tentar de novo" com o mesmo cursor.
- **Texto**: `white-space: pre-wrap` (quebras preservadas) e quebra de palavra longa (`overflow-wrap:
  anywhere`) — sem rolagem lateral em 1440, 1280, 1100, 1024, 768 e 390 px. O React escapa o texto: `<script>`
  ou `<img onerror>` aparecem como texto.
- **Edição (lápis)**: seção **"Observações do caso"** logo depois da identificação, com o rótulo **"Nova
  observação para #0042 · Imobiliário"** (número e área do caso em foco; sem número, só a área), contador
  `n / 4.000`, a regra ("fica registrada com seu nome e o horário; não é editada nem excluída") e as observações
  recentes logo abaixo. Quem só lê vê "Seu perfil só lê as observações deste caso." O lápis passa a aparecer
  também para quem só acrescenta observações.
- **Nenhuma aba nova.**

### Rascunho e troca de caso

- O compositor tem identidade **`case_note:<oportunidade>`**: trocar de caso cria outro, então o rascunho, o
  erro, a confirmação e a chave de um caso **nunca** passam para outro, e nada é enviado ao alvo novo.
- Com texto não registrado, qualquer link interno que saia da tela atual (outro caso, outra aba, "Voltar ao
  caso", outra conversa, menu) é interceptado **antes** da navegação e a seção mostra: "A observação para
  *caso* ainda não foi registrada. Se você sair agora, o texto será descartado." com **Continuar escrevendo** e
  **Descartar e sair**. Fechar ou recarregar a aba usa o aviso do navegador. Durante a gravação, o aviso diz para
  aguardar a confirmação.
- Se a tela mudar de caso por outro caminho (voltar do navegador) com uma gravação em andamento, a gravação vai
  para o caso **original** (o pedido já levava o id dele) e a resposta não aparece no caso novo.
- O **rascunho da mensagem do WhatsApp** não é tocado (a caixa de mensagem não é remontada na troca de caso).

## 3. Permissões e gravação

- **`case_note.add`**: owner, admin, manager, lawyer e sales — a mesma faixa de `lead_note.edit` (teste confere
  que as duas permissões têm os mesmos papéis e que o banco usa a mesma lista). Visualizador só lê.
- **Leitura** (`list_case_notes`): quem enxerga o caso (escritório + alcance do lead), visualizador incluído.
  **Escrita** (`add_case_note`): o banco repete permissão, escritório, alcance do lead e o bloqueio de contato
  anonimizado. Inexistente, de outro escritório ou fora do alcance → `opportunity_not_found` (não revela se
  existe).
- **Idempotência** (clique duplo, resposta perdida, repetição): chave por intenção, gerada na tela e mantida
  enquanto o texto não muda (repetir depois de uma falha usa a mesma chave; mudar o texto gera outra). Única por
  escritório. A mesma chave com o mesmo pedido devolve o registro gravado (`replayed`, sem auditoria nova); com
  outro texto ou outro caso, `idempotency_conflict`. A segunda gravação simultânea da mesma chave espera a
  primeira no índice único (`on conflict do nothing`) e depois decide entre repetição e conflito.
- **Duas pessoas ao mesmo tempo**: não há versão a disputar; cada uma grava o seu registro (concorrência real:
  seis sessões, seis observações, cada autor certo).
- **Sem efeito colateral**: acrescentar não muda situação do atendimento, andamento, roteiro, etapa comercial,
  versões das trilhas, vínculo da conversa, mensagens, notas do lead nem automações (pgTAP compara uma fotografia
  de tudo isso; a concorrência prova que nem a trava do andamento é esperada).
- **Auditoria**: `opportunity.case_note_added` com `note_id` e `length` — **nunca o texto**.

## 4. Privacidade

Observações são **texto livre**, possivelmente com dado pessoal — **não** são esqueleto como os registros da
etapa B.

- **Exportação do titular (C3a)**: seção nova `case_notes` só com a **existência** (`id`, `opportunity_id`,
  `created_at`), como `lead_notes`: o texto (texto livre interno) e o autor (usuário interno) ficam fora do
  arquivo automático, e fornecê-los depende de revisão humana e jurídica. As seções anteriores ficaram iguais
  (teste estático compara a função inteira menos a seção nova; o script de atualização compara o pacote).
- **Anonimização (C3b)**: as observações dos casos do titular são **apagadas**, como as notas do lead
  (`private.privacy_anonymize_contact` recriada com a mesma assinatura e só duas linhas novas: o `delete` e a
  conferência final, que desfaz tudo se alguma observação sobrar). A auditoria das observações perde o
  metadata (já não tinha o texto). Depois da anonimização, o gatilho recusa observação nova
  (`contact_anonymized`), inclusive a repetição de um pedido antigo. Nada desta entrega guarda outra cópia do
  texto (sem histórico de eventos, sem cache, sem log).
- **Retenção**: sem mudança, como as notas do lead — a contagem continua a partir do arquivamento do lead e uma
  observação não a reinicia; quando a retenção anonimiza o contato, as observações saem junto.
- **Exclusões administrativas**: excluir a oportunidade ou o escritório leva as observações em cascata. (Excluir
  um lead com oportunidades continua bloqueado pela regra anterior.) `created_by` segue `on delete restrict`, como
  em `lead_notes`.

## 5. Testes

- pgTAP `60_conversas_observacoes_caso` (67): superfície fechada; texto com quebras e HTML guardado como texto;
  limites; permissões por papel e alcance; outro escritório; idempotência (repetição, conflito por texto e por
  caso, mesma chave em outro escritório); caso dono (dois casos do mesmo contato, nota do lead intacta e não
  migrada); caso sem número; nenhum efeito colateral; auditoria sem texto; imutabilidade; paginação com horários
  iguais (63 observações, páginas de 10 e de 7, limite 50, cursor inválido); exportação só com a existência;
  anonimização apaga, desfaz se não conseguir apagar e bloqueia depois; cascata.
- Concorrência real `scripts/observacoes-caso-concurrency-check.sh` (no CI): duas pessoas/seis sessões no mesmo
  caso; mesma chave por três sessões; mesma chave com textos diferentes; observação durante a trava do andamento.
- Atualização `scripts/check-upgrade-conversas-observacoes-caso.sh` (no CI): nada criado nem migrado; notas do
  lead intactas; exportação igual nas seções antigas; nenhuma linha antiga alterada; anonimização de contato
  antigo igual e agora também apagando observações.
- Unitários `conversas-observacoes-caso.test.ts` (regras, leitura, carga do painel, ações, permissões, contrato
  da migration e da privacidade) e `conversas-observacoes-caso-render.test.tsx` (cartão, estados, paginação,
  falha, HTML, escrita, chave, aviso de rascunho, troca de caso com gravação em andamento, visualizador).
- e2e `conversations.spec.ts` (10): escrever pelo lápis, ler no Resumo como texto; visualizador só lê.

## 6. Pendências

1. **Documentos** — acesso, armazenamento, conferência humana e retenção reais.
2. **Automação/IA** — aplicador e extrator, seguindo o contrato da etapa B; nada automático aqui.
3. Fornecer o texto das observações ao titular, se o escritório decidir (revisão humana e jurídica), como as
   notas do lead.
