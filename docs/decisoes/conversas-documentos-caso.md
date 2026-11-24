# Conversas — painel do caso: DOCUMENTOS POR CASO

Migration: `20261123120000_conversas_documentos_caso.sql` (aditiva; **só vale depois de aplicada no hospedado**).
Entrada: Conversas → conversa → painel do caso → aba **Documentos** (entre Tarefas e Histórico, como na referência).

> **O recebimento de arquivos está FECHADO** em todos os ambientes publicados até a ativação do backup dos
> documentos (ver "Antes do primeiro upload real"). A aba funciona para ler, abrir, baixar, conferir e remover.

## O que é

- Um documento pertence à **oportunidade (o caso)**, nunca ao contato inteiro. Dois casos do mesmo contato não
  compartilham arquivos; sem caso em foco, a aba pede a escolha e não mostra nada misturado.
- Não exige número interno, caso ganho nem roteiro.
- Cada documento mostra nome, tipo, tamanho, quem enviou, quando e a **situação da conferência**.
- Os PDFs de proposta já gerados pelo Praxis e ligados ao caso (pela proposta) aparecem numa **seção separada**, com
  o download e a permissão das propostas. Nada é copiado; eles não são "documentos recebidos".

## Conferência humana

Estados explícitos: **Recebido** (ao subir) → **Conferido** ou **Com pendência** (observação obrigatória; até 1.000
caracteres). Grava quem conferiu e quando; voltar para Recebido desfaz o registro (fica na auditoria).

- "Conferido" = a equipe autorizada registrou a conferência do arquivo. **Não é aprovação jurídica automática.**
- Versão própria (`review_version`): duas pessoas conferindo ao mesmo tempo nunca se sobrescrevem em silêncio — a
  segunda recebe "outra pessoa registrou antes" e a tela traz a situação atual.
- Receber ou conferir um arquivo **não** conclui etapa, não muda andamento, roteiro, situação do atendimento, etapa
  comercial, automações nem integrações (conferido no pgTAP 61 e na validação no navegador). Nenhuma IA participa.

## Permissões (o banco repete tudo)

| ação | owner | admin | manager | lawyer | sales | viewer |
|---|---|---|---|---|---|---|
| ver, abrir, baixar | sim | sim | sim | sim* | sim | sim |
| anexar (`case_document.upload`) | sim | sim | sim | sim* | sim | não |
| conferir (`case_document.review`) | sim | sim | sim | sim* | não | não |
| remover (`case_document.remove`) | sim | sim | sim | sim* | não | não |

\* advogado: só nos casos de leads dele ou sem responsável (a mesma regra de alcance do lead de todo o app). Outro
escritório e fora do alcance respondem "não encontrado" (404 na rota de abrir/baixar). Contato anonimizado: só
consulta.

## Arquivos e segurança

- **Formatos:** PDF, JPEG e PNG, **até 10 MiB** por arquivo (o mesmo limite das propostas). O bucket aplica o limite e
  os tipos; o servidor confere o **conteúdo** (assinatura no início e marca de fim, o que também pega arquivo truncado)
  e recusa quando ele não bate com o tipo. Extensão e tipo informado pelo navegador não decidem nada.
  **Isso não é antivírus** e não detecta conteúdo malicioso dentro de um PDF bem formado. O app nunca executa nem
  interpreta o arquivo: ele é guardado e devolvido por link temporário, servido pelo domínio do Storage.
- **Armazenamento:** bucket privado `case-documents`, **sem nenhuma policy de Storage** para sessões. Acesso só pelas
  funções do banco (quem pode o quê) e pelo cliente de serviço isolado (`src/server/case-documents/admin/`, regra de
  lint), como nas propostas (B1). O caminho do objeto é gerado pelo banco (`<escritório>/<caso>/<documento>`), nunca
  pelo navegador; o nome original é só exibição (sem caminho, sem caracteres de controle nem marcas de direção de
  texto) e aparece sempre como texto.
- **Envio em duas fases**, direto do navegador ao Storage (o corpo não passa pela função do servidor):
  1. `begin_case_document` reserva o documento (linha pendente) e o caminho e abre a **janela do link de envio**
     (`upload_window_until`); só então o servidor emite um link de envio **daquele** caminho, sem sobrescrita.
  2. O navegador sobe o arquivo.
  3. O servidor baixa o objeto, confere o conteúdo, calcula o SHA-256 e `finalize_case_document` só torna o
     documento visível depois de conferir, no mesmo Postgres (`storage.objects`), que o objeto existe com o mesmo
     tamanho. Repetição com a mesma chave (clique duplo, resposta perdida) devolve o mesmo documento.
- **Link de envio não é revogável (limitação do provedor).** Ele vale 2 horas a partir da emissão, só para aquele
  caminho. Apagar a linha ou o objeto **não** o invalida, e `upsert: false` só impede sobrescrever um objeto que exista
  — com o caminho vazio (depois de um cancelamento ou de uma remoção), um envio atrasado ou um link reutilizado grava
  de novo (reproduzido com a API real do Storage). Por isso:
  - cada linha guarda `upload_window_until` = emissão **mais recente** + 2 h de validade + 1 h de folga (um envio que
    começou dentro da validade pode terminar depois). Repetir o begin para um envio pendente emite link novo e
    **estende** a janela (nunca encolhe; documento pronto não ganha janela nova);
  - quando a linha sai antes de a janela fechar (cancelamento, remoção logo depois do envio, cascata), o gatilho põe o
    caminho na fila de limpeza com `watch_until`, e ele **só sai da fila quando o objeto não existe E a janela
    fechou**. Um objeto gravado nesse meio-tempo continua rastreado e é apagado pela limpeza;
  - envio pendente só expira na limpeza depois de a janela fechar (não mais "3 horas desde a criação").
  - Folga de 1 hora: um envio iniciado dentro da validade e que demore mais que isso para terminar ficaria fora da
    vigilância. Com o limite de 10 MiB isso não é esperado; é a premissa documentada.
- **Cancelamento do envio em duas fases** (conteúdo inválido, envio interrompido, desistência):
  1. `begin_case_document_abandon` **reserva** a transição pendente → `abandoning` sob a trava da linha, **antes** de
     qualquer exclusão no Storage. A finalização disputa a mesma trava: se ela venceu (documento pronto), o
     cancelamento é recusado (`document_not_pending`) e **nada é apagado**; se o cancelamento venceu, a finalização é
     recusada e repetir o begin não emite link novo. Sempre um vencedor só.
  2. O servidor apaga o objeto (nenhuma transação fica aberta durante a chamada ao Storage).
  3. `finalize_case_document_abandon` só tira a linha depois de conferir que o objeto saiu; senão o cancelamento fica
     reservado e a limpeza o conclui.
  - A tela só diz **"Nada foi guardado"** com essa confirmação (cancelamento concluído). Sem ela, diz que o arquivo não
    ficou visível e que a exclusão ficou registrada para a limpeza — ou que não foi possível confirmá-la agora. Se a
    finalização já tinha vencido, a tela mostra o documento recebido.
- **Abrir/baixar:** `/api/case-documents/<id>?modo=abrir|baixar`, autorizado pela sessão a cada clique, redireciona
  para um link temporário de **60 segundos**, gerado na hora e nunca reaproveitado. Limitação inerente: durante esses
  60 s, quem tiver o link abre o arquivo. No download, o nome é o original **sem acentos** (o cliente do Storage
  codifica duas vezes o parâmetro do nome); o nome completo continua na tela e no banco.
- Auditoria só com ids, códigos, tipo e tamanho: nunca o nome do arquivo nem a observação da pendência.

## Remoção controlada (duas fases) e limpeza

- Remover exige motivo em código fechado (enviado por engano, duplicado, arquivo errado, pedido do titular, outro) e
  fica auditado (pedido e conclusão).
- 1ª fase: `begin_case_document_removal` marca o documento **em remoção** (ele deixa de abrir). 2ª fase: o servidor
  apaga o objeto e `finalize_case_document_removal` só apaga o registro **depois de conferir que o objeto saiu**.
- Se o arquivo não sair (falha do Storage), a remoção fica **pendente e visível** ("Remoção pendente"), com o botão
  "Concluir a remoção"; a limpeza também a retoma. **A exclusão não é dada como concluída enquanto houver limpeza
  pendente.**
- **Exclusão administrativa** (cascata do escritório, lead ou caso — o app não tem essa ação): o caminho do objeto que
  ainda existir (ou com janela de envio aberta) vai para `case_document_storage_cleanup` (sem FK, sobrevive à exclusão
  do escritório). A fila só perde a linha quando o banco confirma que o objeto não existe e a janela fechou.
- **O que a limpeza faz:** tira envios pendentes cuja janela fechou, conclui remoções e cancelamentos interrompidos
  (há mais de 2 minutos) e processa a fila. Caminho vigiado sem objeto é reconferido em até 10 minutos (ou no fim da
  janela), para apagar logo um envio atrasado.
- **Quando a limpeza roda hoje:** só de forma **oportunista**, num lote pequeno, depois de envio, finalização e remoção
  (sem agendamento nem configuração externa nesta entrega). **Se ninguém voltar a usar o app, nada é processado**: as
  pendências ficam registradas no banco (nunca se perdem), mas um objeto atrasado pode continuar no Storage — e nos
  backups do bucket — até a próxima escrita.
- **Backups:** cópias de um arquivo removido continuam nos pacotes de backup já gerados até o fim da retenção deles
  (30 dias no desenho atual; o backup dos documentos ainda nem foi ativado).

## Privacidade

- **Exportação do titular (C3a):** seção `case_documents` com os **metadados** (id, caso, nome, tipo, tamanho,
  situação, conferência e datas). Cada item traz `file_content_included: false`: **o conteúdo dos arquivos não é
  entregue** pela exportação. A observação interna da conferência e os usuários internos não entram.
- **Anonimização (C3b):** contato com documento de caso **não é anonimizado** (`case_document_present`), como já
  acontece com PDF de proposta: os documentos precisam ser removidos antes (remoção controlada). Defesa em
  profundidade: um gatilho recusa gravar a marca de anonimizado enquanto houver documento. Depois da anonimização,
  nada novo entra no caso (`contact_anonymized`).
- **Retenção:** documento não reinicia a contagem dos 12 meses; ele só bloqueia a anonimização até ser removido.

## Recebimento fechado até a ativação do backup (duas travas)

1. **Servidor:** variável `CASE_DOCUMENTS_UPLOAD_ENABLED`. Ausente, vazia ou diferente de exatamente `true` =
   fechado. Conferida em todos os caminhos de envio e finalização (ações do servidor), nunca só na tela.
2. **Banco:** `public.case_document_upload_gate` (deny-all para os papéis de API) nasce **fechado**;
   `begin_case_document` e `finalize_case_document` recusam com `case_documents_upload_disabled`. Abrir exige a
   referência do registro da ativação (`backup_activation_ref`, constraint). **Sem exceção por escritório** — nem o
   demonstrativo.

As funções de envio têm EXECUTE só para `service_role` e o bucket não tem policy: nem o owner contorna pelo formulário
ou por chamada direta. A tela mostra "O recebimento de documentos aguarda a ativação do backup dos arquivos".

## Antes do primeiro upload real (obrigatório)

1. Decidir destino e capacidade do backup dos documentos (etapa própria). Pacotes completos diários em artefatos com
   retenção de 30 dias não servem para volume real de documentos (cota do Actions); qualquer proposta precisa
   explicar dependências, expiração e recuperação completa — backup incremental em artefatos temporários não é
   suficiente por si só.
2. Ativar o backup do bucket `case-documents` (os scripts já aceitam o bucket por escolha explícita; o workflow diário
   **não** foi alterado nesta entrega) e fazer um **teste real de recuperação** dos documentos num destino descartável.
3. Aplicar a migration no hospedado (se ainda não estiver).
4. **Consumidor independente da limpeza** (requisito operacional): uma execução periódica, fora do uso do app, que
   chame a limpeza (`case_document_cleanup_claim`/`_complete` pelo módulo do servidor) — por exemplo uma função
   agendada no Inngest, que exige sincronizar o app e recalcular as execuções do plano. **Não foi configurado nesta
   entrega** (a ordem foi não configurar agendamento externo).
5. Só então abrir as duas travas: a variável na Vercel e o portão no banco, com a referência do registro da ativação.

## Testes

pgTAP 61 (superfície, portão, papéis, alcance, dois casos, idempotência, finalização, cancelamento em duas fases com
vencedor único, janela do link de envio, caminho vigiado na fila, conferência com versão, remoção em duas fases, fila,
efeitos colaterais, exportação, anonimização); concorrência real (`scripts/documentos-caso-concurrency-check.sh`: chave
repetida, finalizações e conferências simultâneas, remoção × conferência, conclusões simultâneas, anonimização × envio,
finalização × cancelamento nas duas ordens e solta, repetição do begin × cancelamento); **Storage real**
(`tests/storage-real/documentos-caso.real.ts`, `vitest.storage-real.config.ts`: as server actions e o módulo do servidor
contra a API do Storage e o Postgres de um ambiente descartável — disputa finalização × cancelamento nas duas ordens,
falha do Storage, resposta perdida, link válido depois do cancelamento e da remoção, envio em andamento, renovação do
link; não roda no `npm test` nem no CI); atualização a partir da versão anterior
(`scripts/check-upgrade-conversas-documentos-caso.sh`); backup e restauração do bucket novo com arquivos sintéticos
(`scripts/backup/check-storage-backup.sh`, cenário 19); unitários (conteúdo, nome, limites, permissões, travas, ações,
rota, interface com promessas controladas); e2e (aba e recebimento fechado no app real).
Os dois scripts novos (concorrência e atualização) e a suíte do Storage real rodam localmente; **não foram incluídos no
CI** nesta entrega porque a ordem foi não alterar workflows.
