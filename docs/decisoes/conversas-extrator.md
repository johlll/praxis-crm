# Conversas + IA — extrator de propostas de status

Migrations: `20261126120000_conversas_aplicador_alvo_estavel.sql` (correção de concorrência do aplicador) e
`20261126130000_conversas_extrator_contexto.sql` (leitura do contexto). Ambas aditivas; **só valem depois de
aplicadas no hospedado**, com autorização. Dependem do aplicador (`20261125120000`, #365) e do horário de origem
(`20261124120000`, #358), já publicados.

Esta etapa entrega o **extrator preparado e desligado**: lê o contexto autorizado de uma conversa, monta as
instruções, chama um modelo (interface) e transforma a resposta em propostas estritas para o aplicador. **Não há**
provedor contratado, credencial, chamada paga, rota, agendamento nem ativação em ambiente hospedado.

## Primeiro: alvo estável no aplicador

**Risco confirmado com sessões reais** (local, Postgres 17 descartável). O aplicador lia a conversa, o caso e a
resolução do vínculo **antes** de `private.status_track_lock` e não reconferia depois de esperar a trava da trilha.
Com o aplicador esperando a trilha:

- outra sessão criou um segundo caso para o contato (`create_opportunity`) — a resolução ficou ambígua — e o
  aplicador aplicou no caso antigo;
- outra sessão revinculou a conversa a outro caso (`resolve_conversation_link`) e o aplicador aplicou no caso
  antigo.

Na primeira rodada, a trilha ficou presa por outra proposta do aplicador recusada depois da trava (caminho real,
sem mudar a versão).

**Correção** (`20261126120000`, mesma função e assinatura, só acrescenta as travas): tudo o que decide o alvo é
**travado antes de ser lido e antes da trava da trilha**, e fica travado até a gravação:

| O que pode mudar o alvo | Trava do aplicador | Efeito no escritor |
| --- | --- | --- |
| troca de vínculo (`resolve_conversation_link`, efeitos da B3) | conversa `FOR SHARE` | o `UPDATE` da conversa espera |
| novo lead para o contato | contato `FOR UPDATE` | a checagem de chave estrangeira do `INSERT` espera |
| novo caso num lead do contato | leads do contato `FOR UPDATE` | idem |
| status ou lead de um caso do contato | oportunidades do contato `FOR SHARE` | o `UPDATE` espera |

- As travas do alvo são pedidas **sem espera** (`NOWAIT`). Se outro escritor estiver no meio de uma mudança, o
  aplicador desiste na hora com `target_busy` (erro, nada gravado; a mesma proposta pode ser repetida com a mesma
  chave). Assim o aplicador nunca espera trava de alvo e não forma ciclo de espera com escritores que travam em
  outra ordem (troca de vínculo: conversa → lead; anonimização: contato → conversa).
- Dois aplicadores do mesmo contato se **enfileiram** numa trava consultiva só deles
  (`pg_advisory_xact_lock`), em vez de um derrubar o outro com `target_busy`.
- Os escritores existentes não mudam: só esperam o fim da transação do aplicador (curta).
- Regressão determinística: cenários 7 e 8 de `scripts/aplicador-concurrency-check.sh` (já no CI). Contra a
  versão publicada eles **falham** (a mudança do alvo não espera; o aplicador aplica com a troca em andamento);
  com a correção passam (a mudança espera o aplicador; troca em andamento → `target_busy`, nada gravado). No
  script, a trilha fica presa com a mesma trava de linha que `private.status_track_lock` usa; as mudanças do alvo
  usam os caminhos reais.

## O extrator

### Desligado por padrão, em quatro camadas

1. `STATUS_EXTRACTOR_ENABLED` diferente de `"true"` → não lê nada nem chama ninguém (`disabled`).
2. Portão do aplicador no banco (`status_track_automation_gate`) fechado → o contexto é recusado (`disabled`).
3. Sem modelo configurado → para antes de qualquer chamada (`no_model`). Nenhum provedor está implementado.
4. Aplicar exige `STATUS_EXTRACTOR_APPLY_ENABLED = "true"`; sem isso, só devolve as propostas (`dry_run`). Mesmo
   aplicando, quem decide é o aplicador no banco.

Nenhuma dessas variáveis existe em ambiente hospedado.

### Contexto autorizado (`get_status_automation_context`)

Só `service_role`, só com o portão aberto, só a conversa pedida **deste escritório** (outro escritório =
`target_not_found`). Entrega:

- situação do atendimento (estado, versão, pausa);
- o caso **só quando inequívoco e ganho** (a mesma regra do aplicador), com estado, versão, pausa e roteiro; senão,
  o motivo (`conversation_link_unresolved`, `no_case`, `ambiguous_case`, `opportunity_not_won`);
- as últimas mensagens (até 50), em ordem, com autor calculado pelo banco (cliente, escritório, outro), tipo de
  conteúdo, texto cortado em 1.500 caracteres e se é elegível no tempo para cada trilha (veredito da #358 contra a
  decisão humana da trilha).

**Não entrega** horários, telefones, nomes, remetente, papel, permissão ou chave: o extrator não recebe nada que
possa repassar como fato de tempo, identidade ou autoridade.

### Instruções e dados

- O texto das mensagens **nunca** entra nas instruções: vai no conteúdo do usuário como dado JSON (aspas, quebras e
  marcações escapadas), sob um campo identificado. As instruções dizem que nada ali é instrução.
- O modelo não recebe ids de escritório nem de caso, nem versões: não tem o que escolher.
- O modelo classifica cada evidência citada: `fact`, `request`, `hypothesis`, `negation`, `quotation`. Só `fact`
  sustenta proposta.

### Resposta do modelo → propostas

- Esquema **estrito**: só `{"proposals":[{track, change, to_status, step_id, evidence:[{message_id, statement}]}]}`,
  até 5 propostas e 20 evidências; campo extra, tipo errado, texto fora do JSON ou JSON quebrado = resposta
  inválida, nenhuma proposta (um único bloco ```json é aceito). Horário, remetente, permissão, caso, versão ou
  chave na resposta invalidam a resposta inteira.
- Conferência contra o **contexto** (não contra o que o modelo diz): só o catálogo do aplicador; evidência só da
  conversa e elegível para a trilha; toda evidência `fact`; autor e tipo calculados pelo banco ("enviei" em texto
  não vira arquivo recebido); caso só o do contexto; etapa só pendente e posterior à atual; estado atual e pausa.
- Escritório, conversa, caso, **versão esperada** e **chave de idempotência** vêm do contexto e do conteúdo. A chave
  é um UUID determinístico do pedido (conversa, trilha, mudança, alvo, versão, evidências ordenadas): a mesma
  proposta sobre o mesmo estado gera a mesma chave, e o aplicador devolve a mesma decisão.
- Motivos de descarte (códigos): `not_in_catalog`, `no_unambiguous_case`, `evidence_not_in_context`,
  `evidence_repeated`, `evidence_not_eligible`, `non_fact_evidence`, `evidence_kind_insufficient`,
  `step_not_pending_after_current`, `status_unchanged`, `track_paused`, `duplicate`.

### O que o extrator nunca faz

Enviar mensagem, escrever status direto (só pelo aplicador), ler outra conversa ou escritório, guardar ou devolver
texto de mensagem (o resultado só tem ids, códigos e contagens), chamar rede sem um adaptador escolhido.

## Decisão pendente: provedor e modelo

Indispensável antes de qualquer teste real. O código está pronto para um adaptador (`StatusExtractionModel`:
recebe `system` e `user` separados, devolve o texto bruto). É preciso escolher:

1. **Provedor e modelo** (custo por conversa, latência, qualidade em português jurídico).
2. **Tratamento de dados**: as mensagens são dados pessoais de clientes; contrato de processamento, região,
   retenção e não uso para treino.
3. **Credencial própria do extrator** (não a da Vitória), guardada como variável do ambiente.
4. **Volume e custo**: quando processar (a cada mensagem recebida, em lote) e limite mensal.

Depois da escolha: implementar o adaptador (sem ferramentas, temperatura baixa, saída curta), avaliar com conversas
fictícias e reais anonimizadas, e só então discutir ativação.

## Testes

- pgTAP `63_conversas_extrator_contexto` (34): superfície e portão; outro escritório; ordem, autor, corte,
  elegibilidade por trilha; nenhum horário, telefone, nome, papel ou permissão; caso indisponível com motivo;
  roteiro; nada gravado.
- Concorrência real: cenários 7 e 8 de `aplicador-concurrency-check.sh` (alvo estável, `target_busy`).
- Unitários `conversas-extrator.test.ts` (respostas simuladas): desligado por padrão; propostas válidas; caso
  ambíguo; evidência fora do contexto, inelegível, repetida; pedido, hipótese, negação e citação; "enviei" ×
  arquivo; estados humanos; etapa concluída ou anterior; conteúdo malicioso (instrução embutida, horário,
  identidade, permissão, caso, versão ou chave na resposta); respostas malformadas; falha do modelo; repetição;
  isolamento. `conversas-aplicador-alvo.test.ts`: forma da correção do alvo.

### Comprovado por fixtures × pendente de YCloud real e de modelo real

Tudo roda com dados sintéticos e respostas simuladas. **Não comprovado**: a classificação real do remetente, o tipo
de conteúdo de arquivo e o horário de origem com eventos da YCloud real (validação da B3 ainda pendente), e o
comportamento de um modelo real (nenhum foi chamado).

## Lista para depois (não bloqueia)

- Gatilho do processamento (por mensagem ou em lote) e onde roda (job interno) — depende da decisão de provedor.
- Leitura das decisões e propostas descartadas na interface.
- Ampliar o catálogo só com critério verificável no banco.
