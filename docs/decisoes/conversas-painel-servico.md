# Conversas + IA — painel do caso, etapa B: identificação, tipo de serviço, roteiro e marcos

Segunda entrega do painel do caso ([conversas-painel-caso.md](conversas-painel-caso.md), #359). Entrega o **número
interno do caso**, o **catálogo de tipos de serviço** com etapas ordenadas, o **roteiro aplicado ao caso** e os
**marcos concluídos** efetivamente registrados, convivendo com a trilha `case_progress` da fundação
([conversas-ia-fundacao.md](conversas-ia-fundacao.md)) sem dois estados capazes de se contradizer.

Migration nova (aditiva): `20261121120000_conversas_painel_servico.sql` — posterior à última publicada
(`20261120120000`); **não aplicada no hospedado**. Não carrega nem reordena a migration da #358.

Não fazem parte desta entrega: observações por caso, Documentos, número de processo judicial (CNJ), IA e avanço
automático (ver "Pendências").

## 1. Número interno do caso

- **O que é:** número sequencial do escritório, exibido `#0042`, **separado de qualquer número judicial** (a tela diz
  "Número interno do escritório, separado de qualquer número de processo"). A identidade técnica continua sendo o UUID
  da oportunidade.
- **Onde:** `opportunity_case_numbers` (uma linha por caso numerado) e `case_number_counters` (último número de cada
  escritório). Sem linha, o caso **não tem número** — nada é inventado nem preenchido com código de exemplo.
- **Unicidade e concorrência:** índice único (escritório, número) e trava na linha do contador. Dois pedidos ao mesmo
  tempo para casos diferentes recebem números distintos, sem buraco; dois pedidos para o mesmo caso recebem um só número
  (o segundo espera a trava, relê e devolve o existente). O contador nunca volta: excluir um caso não libera o número.
- **Atribuição:**
  - **casos antigos:** só por **atribuição explícita** (lápis → "Identificação do caso" → "Atribuir número interno" →
    confirmação). A migration **não numera nada**;
  - **daqui em diante:** ganhar uma oportunidade lhe dá o próximo número (gatilho na mudança de `status` para `won`;
    `win_opportunity` não foi alterada). Um caso ainda aberto também pode receber número por escolha; caso perdido, não.
- **Permissão:** `case.number_assign` = quem edita a oportunidade (owner, admin, manager, lawyer, sales), com o alcance
  do lead. O banco repete a faixa.
- **Imutável:** o número não muda depois de atribuído (gatilho recusa `UPDATE`). Corrigir/renumerar fica fora desta
  etapa. Não há numeração inicial configurável (começa em 1 por escritório).

## 2. Catálogo de tipos de serviço

- `service_types` (nome único entre os ativos do escritório, versão, arquivamento) e `service_type_steps` (1 a 30
  etapas em ordem, 1 a 80 caracteres, sem repetir). Até 100 tipos ativos por escritório.
- **Quem configura:** `service_catalog.manage` = owner, admin, manager (a mesma faixa de quem configura o pipeline).
  Todos os membros **leem** o catálogo (os nomes aparecem nos casos). Tela: **Configurações → Tipos de serviço**.
- **Modelos sugeridos** (no código, `SERVICE_TYPE_SUGGESTIONS`): processo judicial, procedimento extrajudicial,
  consultoria ou parecer, contrato ou documento. São ponto de partida do produto, **não validação jurídica**. Só entram
  no catálogo quando alguém clica em "Copiar para o catálogo"; a cópia abre preenchida para ajustar antes de salvar
  (guarda só o código da sugestão de origem). **Os extrajudiciais e consultivos não têm protocolo de ação nem
  sentença.** Nenhum tipo é associado automaticamente a caso nenhum.
- Editar um tipo incrementa a versão; arquivar tira o tipo das opções para novos casos. **Nenhuma das duas muda casos
  que já usam o tipo.**

## 3. Roteiro aplicado ao caso

- **Cópia, não referência:** aplicar um tipo a um caso cria `case_service_plans` (nome e versão do tipo copiados) e
  `case_service_plan_steps` (nome e ordem copiados). O caso guarda a própria configuração; o painel avisa quando o modelo
  ganhou versão mais nova ("O modelo foi alterado depois; este caso continua com a cópia aplicada"). Para adotar o
  modelo novo, a pessoa **troca o roteiro** explicitamente. A cópia é feita com trava de leitura no tipo: uma edição
  simultânea do modelo nunca resulta em metade de cada versão (prova de concorrência real).
- **Só oportunidade ganha** e só por escolha explícita (tipo + etapa atual inicial, ou nenhuma). Um ativo por caso.
  O roteiro pertence à **oportunidade**, nunca ao contato: dois casos do mesmo contato têm roteiros independentes, e uma
  etapa de um caso não é aceita no outro (`service_step_not_found`).
- **Trocar ou remover:** o roteiro anterior fica **encerrado** (`replaced`/`removed`) com as conclusões dele — nada é
  apagado. Se ele já teve conclusão registrada, o banco exige `p_acknowledge_records` e a tela pede a confirmação
  "Entendo que as conclusões ficam no histórico e não passam para o caso daqui em diante". Roteiro encerrado é histórico:
  não recebe mais mudança (gatilho).
- **Permissão:** aplicar, trocar, remover, concluir, reabrir e definir a etapa atual seguem `case.progress_edit`
  (owner, admin, manager, lawyer), com o alcance do lead — o roteiro é parte do andamento do serviço. Atendimento e
  visualizador só leem.

## 4. Convivência com `case_progress` (decidida antes das gravações)

`case_progress` continua sendo o **andamento do serviço** e já contém fases (análise, execução), situações de espera
(aguardando documentos, cliente ou terceiros), `suspenso` e `concluido`. A decisão foi **não** criar um segundo estado
independente: o roteiro passou a fazer parte da **mesma trilha**.

| Elemento | Responde | Onde |
|---|---|---|
| andamento (`case_progress_status`) | **como** o serviço está (em curso, aguardando, suspenso, concluído) | `status_tracks` |
| etapa atual | **em que ponto** do roteiro o trabalho está | `case_service_plans.current_step_id` |
| marcos concluídos | **o que foi efetivamente concluído**, por quem e quando | `case_service_plan_steps.completed_at/by` |

**Uma versão, uma trava, uma pausa.** Toda operação do roteiro trava a linha `case_progress` do caso, exige a versão
esperada **dessa trilha** e a incrementa; a correção do andamento também. Assim, qualquer mudança no andamento OU no
roteiro invalida uma tela (ou uma avaliação futura) feita sobre a versão anterior — `track_conflict`. A pausa das
alterações automáticas do andamento vale para o roteiro inteiro. Toda operação grava o marco da decisão humana
(`manual_decided_at`).

**Regras que o banco garante** (conferidas em cada escrita e de novo por `private.case_service_assert` antes do commit):

- **I1.** `concluido` ⇒ todas as etapas do roteiro ativo concluídas (`service_steps_pending` na correção do andamento).
- **I2.** A etapa atual, quando existe, é uma etapa **pendente** do roteiro ativo.
- **I3.** No máximo um roteiro ativo por caso.

**Operações:**

| Operação | Efeito no roteiro | Efeito no andamento |
|---|---|---|
| **Concluir etapa** | registra a conclusão **daquela** etapa (quem, quando); nenhuma outra é concluída. Se ela era a atual, a etapa atual passa a ser a que a pessoa escolheu ("Depois de concluir, etapa atual" — a próxima pendente vem sugerida) ou nenhuma | nenhum |
| **Avançar** | é "concluir a atual" com a próxima escolhida, numa operação | nenhum |
| **Escolher etapa atual** (inclusive uma posterior) | muda só a posição; **não conclui** as anteriores | nenhum |
| **Voltar** | a uma etapa pendente: escolher etapa atual. A uma concluída: **reabrir** (opcionalmente "voltar a ser a etapa atual") | nenhum |
| **Reabrir etapa** | a conclusão atual sai; o histórico guarda a conclusão **e** a reabertura | só se o serviço estava **concluído**: a pessoa escolhe o novo andamento e as duas mudanças acontecem na mesma transação (os dois históricos recebem o evento, com a mesma versão) |
| **Aguardar informações** | nada (a etapa atual continua) | correção do andamento para aguardando documentos/cliente/terceiros |
| **Concluir o serviço** | exige todas as etapas concluídas | correção do andamento para `concluido` |
| **Reabrir o serviço** | nada é reaberto (as etapas continuam concluídas) | correção do andamento saindo de `concluido` |
| **Aplicar/trocar roteiro** | recusado em serviço concluído (`case_concluded`): as etapas novas ficariam pendentes | nenhum |
| **Remover roteiro** | o caso volta a não ter roteiro | nenhum |

**Nunca acontece:** conclusão inferida pela posição da etapa, por escolher uma etapa posterior, por arquivo recebido ou
pela palavra do cliente; mudança da **situação do atendimento** ou da **etapa comercial** como efeito colateral
(conferido no pgTAP, no script de concorrência e no navegador).

**Registros antigos:** caso ganho sem roteiro continua exatamente como antes (andamento e histórico iguais — script de
atualização). Sem roteiro, o andamento não ganha restrição nova.

**Consequências para a futura automação** (contrato, nada implementado aqui):

- o aplicador deve ler e enviar a **versão da trilha `case_progress`** (que agora cobre o roteiro) e respeitar a pausa
  dela; uma decisão humana no roteiro invalida avaliações anteriores;
- concluir etapa automaticamente exigirá **evidência autorizada para aquela etapa** e uma autoria própria
  (`actor_kind` ampliado em `case_service_events`, hoje só `user`), e continua sujeito a I1/I2;
- a automação **não** escolhe nem troca o roteiro de um caso, não conclui o serviço e não reabre etapas sem regra
  própria e revisão;
- etapa e andamento continuam separados: uma mensagem de "aguardando" muda no máximo o andamento, nunca a etapa;
- o modelo **não** impede a automação: tudo é registro explícito, versionado e auditável.

## 5. Histórico, idempotência e auditoria

- `case_service_events`: uma linha imutável por operação (aplicar, trocar, remover, concluir, reabrir, definir/limpar a
  etapa atual), com o alvo (roteiro, etapa, etapa atual antes/depois), a mudança de andamento quando houve, a versão,
  o autor e a **chave de idempotência**. Repetir o mesmo pedido com a mesma chave devolve o resultado como repetição
  (nada gravado de novo); a mesma chave com outro pedido é `idempotency_conflict`, inclusive entre o histórico do roteiro
  e o do andamento. Três repetições simultâneas gravam um evento só (concorrência real).
- O painel mostra os eventos na aba **Histórico** (origem "Roteiro do serviço") junto com o número interno
  (origem "Identificação"), o andamento, a etapa comercial e os marcos da oportunidade.
- Auditoria (`audit_logs`): `opportunity.case_number_assigned` (atribuição manual), `opportunity.case_service_changed`
  (operação e versão), `service_type.created|updated|archived|restored` — só códigos, números e contagens.

## 6. Exportação, retenção e anonimização

- **Exportação do titular (C3a):** três seções novas — `case_numbers`, `case_service_plans` (com as etapas copiadas e as
  datas de conclusão) e `case_service_history`. Sem usuário interno (quem atribuiu, aplicou, concluiu) e sem chave de
  idempotência, como no restante da C3a. As seções anteriores ficaram byte a byte iguais (teste estático + script de
  atualização).
- **Anonimização (C3b):** os registros novos são **esqueleto** — número, códigos, datas e nomes de etapa vindos do
  catálogo do escritório; **não há texto livre por caso** (observações ficam para a próxima entrega). Por isso a
  anonimização não precisa apagar nada deles e não foi alterada; depois de `contacts.anonymized_at`, um gatilho recusa
  qualquer `INSERT`/`UPDATE` neles (`contact_anonymized`), como no restante do esqueleto. O pgTAP anonimiza um contato
  com caso numerado e confere as duas coisas.
- **Retenção:** sem mudança. Oportunidade ganha já bloqueia a anonimização (`open_or_won_opportunity`); um caso perdido
  com número segue o fluxo normal.
- **Exclusão administrativa:** excluir a oportunidade leva número, roteiros, etapas e eventos em cascata.

## 7. Interface

- **Cabeçalho do caso:** "Caso #0042" quando há número e, abaixo, tipo de serviço · área (como a referência); sem
  número, a área continua sendo o título.
- **Lista e cabeçalho da conversa:** etiqueta "#0042 · área"; o **selo continua sendo o andamento** (mesmo valor na
  lista, no cabeçalho e no painel); a etapa atual entra só na frase completa do selo (dica e leitor de tela), sem virar
  outro estado.
- **Resumo:** "Nº interno" e "Tipo de serviço" nas Informações do caso; cartão **Andamento do serviço** com o selo,
  "N de M etapas concluídas" e as etapas. Até 4 etapas, faixa horizontal da referência; acima, lista vertical com
  número da etapa e "Concluída em … por …". Concluída = ✓ preenchido; atual = anel com ponto e a palavra "atual";
  pendente = círculo vazio — **distintas sem depender de cor**, com o estado por extenso para leitor de tela. A linha
  entre duas etapas só fica cheia quando as duas têm conclusão registrada. O Resumo continua **sem formulário**.
- **Edição pelo lápis:** seções "Identificação do caso" (atribuir número, com confirmação), "Andamento do serviço"
  (correção existente, com a regra I1 explicada), **"Roteiro do serviço"** (aplicar; concluir a atual escolhendo a
  próxima; tornar atual; reabrir com confirmação — e com o novo andamento quando o serviço está concluído; trocar e
  remover com confirmação dos registros), "Etapa comercial" e "Alterações automáticas".
- **Trocar de caso** com a edição aberta: o editor do roteiro e o do número têm identidade `trilha:alvo`
  (`case_progress:<oportunidade>`), então escolhas, confirmações, erros e chave de idempotência do caso anterior não
  passam para o novo; o rascunho da mensagem fica (o compositor não é remontado).
- Conflito de versão: "Este caso mudou enquanto você editava (o andamento e o roteiro têm uma versão só)" + Atualizar;
  nada é repetido à força.

## 8. Testes

- pgTAP `59_conversas_painel_servico` (128): superfície fechada; caso antigo sem número nem roteiro; numeração no ganho,
  explícita, repetível e por escritório; imutabilidade; catálogo (permissões, validação, versão, arquivamento); cópia
  sem efeito retroativo; concluir/avançar/escolher/voltar sem inferência; I1 e a reabertura atômica; idempotência e
  conflito entre os dois históricos; troca e remoção com registros; dois casos do mesmo contato; permissões, alcance e
  isolamento; nada na situação do atendimento nem na etapa comercial; esqueleto anonimizado; cascata.
- pgTAP `49_c3a_exportacao_titular`: o titular de teste ganha um caso numerado com roteiro e conclusão.
- Concorrência real `scripts/painel-servico-concurrency-check.sh` (no CI): números simultâneos, mesma conclusão por três
  sessões, mesma chave ao mesmo tempo, modelo editado durante a aplicação.
- Atualização `scripts/check-upgrade-conversas-painel-servico.sh` (no CI): lista, opções, trilha, histórico e exportação
  iguais nas chaves/seções antigas; nada numerado nem aplicado; nenhuma linha antiga alterada.
  `check-upgrade-conversas-painel-caso.sh` passou a ignorar só as chaves novas do item de caso.
- Unitários `conversas-painel-servico.test.ts` (regras, modelos, leitura, ações, permissões no código e no banco,
  contrato da migration) e `conversas-painel-servico-render.test.tsx` (painel e editor renderizados, troca de caso).
- e2e `conversations.spec.ts`: atribuição do número no caso aberto (cabeçalho e lista coerentes), cópia de modelo no
  catálogo e visualizador sem acesso ao catálogo.
- Mutações: 9 no SQL e 6 na interface, todas detectadas.

## 9. Pendências (registradas, não implementadas)

1. **Observações por caso** — notas acrescentadas e vinculadas ao caso, preservando as notas gerais do lead (próxima
   entrega).
2. **Documentos** — acesso, armazenamento, conferência humana (arquivo recebido não é documento analisado) e retenção
   reais.
3. **Automação** — aplicador e extrator seguindo o contrato da seção 4; nada automático nesta entrega.
4. Número de processo judicial (CNJ) só com persistência e significado definidos (sem validação CNJ aqui).
5. Renumerar/corrigir número interno e numeração inicial configurável, se o escritório pedir.
6. Busca da lista pelo número interno (hoje a busca segue por contato, telefone e área).
