# Conversas + IA — horário de origem das mensagens

Migration: `20261124120000_conversas_horario_origem.sql` (aditiva; **só vale depois de aplicada no
hospedado**, com autorização; ver [Ordem da migration](#ordem-da-migration)). Esta PR entrega **só o registro e a validação do horário de origem**,
pré-requisito do aplicador automático. Não há IA, aplicador, rota que execute alterações, mudança de
status automática nem mudança de interface. A fundação das trilhas está em
[conversas-ia-fundacao.md](conversas-ia-fundacao.md) e a interface em
[conversas-interface.md](conversas-interface.md).

## O problema

A fundação deixou uma limitação registrada: `messages` guarda só `created_at`, o instante em que a
mensagem **chegou ao CRM**. Uma mensagem antiga que chega atrasada (reentrega do provedor, evento
fora de ordem) teria `created_at` posterior à decisão humana e pareceria evidência nova. O aplicador
só pode agir com evidência **posterior** a `manual_decided_at`; para isso precisa saber **quando a
mensagem ocorreu**, e de onde vem essa informação.

## Três instantes que não se confundem

| Instante | Onde fica | Quem escreve | Observação |
|---|---|---|---|
| Quando a mensagem **ocorreu na origem** | `messages.origin_time_at` (novo) | só a função do servidor ou o gatilho do envio humano | nulo = desconhecido |
| Quando a mensagem **chegou ao CRM** | `messages.created_at` (inalterado) | o banco, na inserção | nunca é horário de origem |
| **Qual fonte comprova** o horário | `messages.origin_time_source` (novo) | junto com o horário | lista fechada |

`created_at` continua com o significado de sempre. `conversations.last_message_at` também: segue o
horário do evento (`occurredAt`) com `greatest(...)`, como antes, e nada aqui o altera.

## Onde o horário estava disponível (inspeção)

| Caminho | Campo do horário | O que é | Vira horário de origem? |
|---|---|---|---|
| YCloud, mensagem recebida (`whatsapp.inbound_message.received`) | `whatsappInboundMessage.sendTime` | horário da mensagem informado pelo provedor | **sim** (`provider_send_time`) |
| YCloud, eco do aplicativo (`smb.message.echoes`, `smb.message.created`) | `whatsappMessage.sendTime` | horário da mensagem informado pelo provedor | **sim** (`provider_send_time`) |
| YCloud, eco sem `sendTime` | `whatsappMessage.createTime` | momento em que a YCloud **registrou** a mensagem | **não** (`missing`) |
| YCloud, qualquer evento | `createTime` do envelope | momento em que o **evento** foi criado | **não** |
| YCloud, status (`whatsapp.message.updated`) | `createTime` do envelope (e um `sendTime` no payload) | entrega, leitura, falha | **nunca**: status não é a mensagem |
| Envio humano do CRM (A7 e B3.3) | relógio do banco ao aceitar o envio | o CRM é a origem | **sim** (`crm_accepted`) |
| Simulador da A7 (`simulate_inbound_whatsapp_message`) | parâmetro `p_event_timestamp` | **escolhido por quem chama** | **não** (desconhecido) |
| Provedor simulado da B3 | `occurredAt` do evento montado à mão | escolhido por quem monta o evento | **não** (`missing`) |
| Normalizador de formato Meta (`normalize-event.ts`) | `timestamp` | só alimenta o simulador da A7 | **não** (não foi tocado) |

O adaptador da YCloud já lia o `sendTime`, mas o entregava misturado em `occurredAt`, que cai no
`createTime` do envelope quando falta. `occurredAt` **não mudou** (ordenação e `last_message_at`); o
horário de origem é um campo **novo**, `originTime`, que nunca usa essa reserva.

## Fontes aceitas

| Fonte | Como entra | Quem pode | Por que é verificável |
|---|---|---|---|
| `provider_send_time` | `whatsapp_record_message_origin_time(p_inbox_id, p_origin_at, p_origin_issue)`, chamada pelo despachante logo depois do efeito de mensagem | **só `service_role`** (nem `authenticated`, nem `anon`) | a mensagem vem do **ledger do evento já aplicado** (entrada da inbox com assinatura conferida); quem chama não escolhe a mensagem nem a fonte, e o servidor só chega aqui com um claim emitido pela inbox |
| `crm_accepted` | gatilho `BEFORE INSERT` em `messages` para o envio humano (`origin = crm`, `internal`, com autor) | ninguém informa: é o instante do próprio banco | a inserção **recusa** qualquer origem informada (`origin_time_not_insertable`) |

Nunca são fonte: horário de entrega/leitura/falha, `createTime` (do envelope ou da mensagem), "agora"
no recebimento, o simulador da A7, o texto da mensagem e qualquer coisa vinda de cliente ou de uma
resposta de IA. Nenhuma função chamável por `authenticated` aceita esse horário.

## Colunas

`origin_time_at timestamptz`, `origin_time_source text`, `origin_time_issue text`, todas anuláveis.
Restrição `messages_origin_time_shape`: horário e fonte andam juntos; fonte e motivo de listas fechadas;
só `contradictory` convive com um horário; horário finito e a partir de 2009-01-01.

- horário + fonte + sem motivo = **verificado**;
- sem horário e sem motivo = **desconhecido** (todo dado anterior, o simulador e qualquer caminho não
  instrumentado);
- sem horário + motivo = **inelegível por esse motivo**;
- horário + `contradictory` = **contraditório** (o primeiro horário fica guardado, mas não vale).

**Nada de backfill** (sem backfill, de propósito). Nenhuma mensagem existente muda: o dado legado continua desconhecido, e é assim que
a migration o deixa. Reconstruir a origem de mensagens antigas não é possível sem o evento original.

## Política de elegibilidade e motivos de inelegibilidade

Uma mensagem só pode ser usada pelo aplicador como evidência **temporal** se o horário de origem estiver
verificado. Em qualquer outro caso ela continua **recebida e exibida pelo fluxo existente**; só deixa de
valer como evidência de tempo.

| Motivo | Quando | Exemplo |
|---|---|---|
| origem desconhecida (`origin_unknown`) | colunas nulas | dado legado; simulador; mensagem cujo registro da origem não chegou a ser gravado |
| `missing` | o provedor não informou o horário da mensagem | YCloud sem `sendTime`; provedor simulado |
| `invalid` | horário não finito | `infinity` |
| `too_old` | anterior a 2009-01-01 | epoch zero; **segundos lidos como milissegundos** (1970) |
| `future` | mais de 5 minutos à frente do relógio do banco | **milissegundos lidos como segundos** (ano ~56.000); relógio adiantado |
| `contradictory` | outro evento do **mesmo** provedor trouxe horário diferente para a mesma mensagem | reentrega com outro `sendTime` |
| incoerência com a chegada | origem mais de 5 minutos **depois** de `created_at` | reportada como `origin_future` pelo veredito |

Unidade, formato e fuso: o adaptador só aceita RFC 3339 **com** deslocamento de fuso (`Z` ou `±hh:mm`);
texto livre, data sem horário, horário sem fuso, número em segundos ou em milissegundos (como número ou
como texto) **continuam invalidando o evento inteiro**, como antes desta PR — nada é adivinhado nem
reparado. O banco aplica os limites com o **relógio do banco** (a tolerância de 5 minutos é a mesma da
B3.2d-2b2b3a para eventos da conta).

Um timestamp ausente ou suspeito não impede o recebimento: o efeito da B3 não foi alterado e a mensagem
é gravada e exibida como sempre; só o horário de origem fica sem valer.

## Fluxo de gravação

1. O efeito da B3 (`whatsapp_effect_inbound_message` ou `whatsapp_effect_outbound_observed`) grava a
   mensagem **exatamente como antes**. Nenhum efeito da B3 foi reescrito.
2. Em seguida, o despachante chama `whatsapp_record_message_origin_time` com o **mesmo claim**, só para
   mensagem recebida e saída observada, quando a mensagem existe (aplicada, duplicada ou já processada).
   Status, identidade e conta **nunca** chamam.
3. A função resolve a mensagem pelo **ledger do evento**, julga o horário (limites, com o relógio do banco)
   e aplica por transições fechadas.

A função é idempotente e **o primeiro julgamento prevalece**:

- mensagem de origem desconhecida: só o evento que **criou** a mensagem (mesma transação: o ledger e a
  mensagem nascem com o mesmo `now()`) a preenche, com o horário ou com o motivo. Um evento duplicado, de
  outra entrada, **nunca** preenche origem desconhecida;
- origem já verificada: o mesmo horário **confirma** (sem renovar nada); horário diferente **marca
  `contradictory`** sem escolher o mais recente nem o mais antigo; evento sem horário válido não desfaz
  nem contradiz;
- origem que já tem motivo, ou já é contraditória: nada muda.

**Atomicidade.** A gravação é uma segunda chamada, depois do efeito. Se ela falhar, a mensagem segue
recebida com origem **desconhecida** (inelegível) — o estado seguro. O despachante devolve nova tentativa,
que termina em `already_processed` sem refazer o efeito: uma gravação perdida **não é curada
automaticamente** nesse caso. É a troca assumida para não reescrever os dois efeitos da B3.

## Quem escreve e quem não escreve

- `INSERT` com qualquer coluna de origem preenchida: recusado (`origin_time_not_insertable`).
- `UPDATE` das colunas de origem fora da função do servidor: recusado (`origin_time_immutable`), inclusive
  pelo dono do banco.
- Mesmo dentro da função, as transições são fechadas: desconhecido → verificado ou com motivo (uma vez);
  verificado → contraditório. Horário verificado nunca é trocado nem apagado; contraditório nunca volta a
  verificado; motivo nunca é trocado.
- Nenhuma função chamável por `authenticated` ou `anon` recebe esse horário. Uma futura resposta de IA não
  tem caminho para fornecê-lo.

## Contrato para o aplicador: comparação com `manual_decided_at`

`private.message_origin_time_verdict(...)` (e `message_origin_time_evidence_verdict(message_id, decided_at)`
para uma mensagem gravada) devolve `eligible` ou o motivo. É **uma condição**: horário válido não prova
caso correto, autoridade do remetente, transição permitida, versão lida nem trilha não pausada — isso
continua sendo do aplicador. A regra, na ordem:

1. motivo gravado → `origin_<motivo>` (`origin_missing`, `origin_contradictory`, ...);
2. sem horário → `origin_unknown`; sem `created_at` → `arrival_unknown`;
3. os limites valem de novo no momento da comparação (`origin_too_old`, `origin_future`);
4. origem mais de 5 minutos depois de `created_at` → `origin_future` (incoerente);
5. **sem decisão humana registrada** (`manual_decided_at` nulo) → `eligible` (basta a origem válida);
6. marco da decisão no futuro (mais de 5 minutos) ou infinito → `decision_marker_suspect` (não autoriza);
7. origem **menor ou igual** a `manual_decided_at + 5 segundos` → `not_after_decision`;
8. caso contrário → `eligible`.

- **Empate:** origem igual à decisão não autoriza.
- **Precisão:** a mensagem só é posterior se passar da decisão por **mais de 5 segundos** (a origem do
  provedor pode vir truncada em segundos e os relógios do provedor e do banco diferem um pouco).
  Exatamente 5 s não autoriza; 5 s e 1 ms autoriza. Na dúvida, não autoriza.
- **`created_at` nunca torna a mensagem posterior:** só entra para detectar incoerência.
- **Caso obrigatório:** mensagem enviada às **9h**, decisão manual às **10h**, mensagem recebida às
  **10h30** → `not_after_decision`. A mesma mensagem enviada às 10h20 → `eligible` (só no tempo).

## Exportação e retenção

- **C3a:** a seção `messages` do pacote do titular ganha a chave `origin_time` (`at`, `source`, `issue`);
  mensagem de origem desconhecida exporta nulos. Mesma função e mesma assinatura; as demais seções e
  chaves ficam byte a byte iguais às da última versão publicada (`20261123120000`, com `case_notes` e
  `case_documents`): o teste estático compara o corpo com o dela, e o script de atualização compara a
  exportação real de cada titular antes e depois.
- **C3b:** as colunas moram na própria mensagem; a conversa apagada leva as mensagens em cascata e, com
  elas, a origem. A gravação depois disso devolve `not_found`. As colunas não guardam texto, telefone nem
  identidade.

## Ordem da migration

A migration nasceu como `20261119120000` (18/11) e **nunca foi aplicada** em nenhum ambiente publicado.
Enquanto a #358 esperava, foram publicadas `20261120120000` a `20261123120000` (ledger 124 no hospedado).
Aplicá-la com o timestamp antigo deixaria o histórico fora de ordem (o `db push` recusa ou exige
`--include-all`) e, pior, o `create or replace` de `privacy_export_payload` com o corpo de 18/11 **apagaria**
as seções `case_notes` e `case_documents` da exportação do titular. Por isso:

- foi renumerada para `20261124120000`, logo depois da última publicada; nenhum arquivo ou registro de
  migration já aplicada foi alterado, e o ledger hospedado não precisa de reparo;
- o corpo da exportação parte da versão publicada por `20261123120000` e só acrescenta a chave
  `origin_time` na seção `messages`;
- os testes que fixavam a posição das migrations publicadas como "a última" passaram a conferir só a
  vizinhança delas; o script de atualização desta migration parte da versão publicada (`20261123120000`);
- o script de atualização da etapa B (`check-upgrade-conversas-painel-servico.sh`) passou a ignorar a chave
  `origin_time` das mensagens na comparação da exportação, como já ignorava as seções de migrations
  posteriores.

## Compatibilidade

Recebimento, saída observada, envio pelo CRM, idempotência, status de entrega, custos e isolamento da B3
seguem como estavam: a migration não recria nenhum efeito, o consumidor não muda de disposição e
`list_conversation_messages`, a ordenação do histórico e a paginação não mudam. `messages.updated_at`
avança quando a origem é gravada (a gravação é um `UPDATE` da linha, logo depois da criação).
`occurredAt` e `last_message_at` mantêm o significado.

## Testes

- pgTAP `57_conversas_horario_origem` (102): estrutura e permissões; efeito da B3 inalterado; gravação
  válida, mensagem atrasada e fora de ordem; ausente, futuro, antigo, unidade trocada e inválido;
  duplicata igual (confirma) e contraditória (marca sem escolher); evento que não criou a mensagem não
  preenche; eco; usuário, anon e `UPDATE` direto recusados (inclusive com a chave interna); inserção com
  origem recusada; simulador da A7 desconhecido; envio humano `crm_accepted`; status não toca a origem;
  regra de comparação (9h/10h/10h30, empate, precisão, futuro suspeito, marco suspeito); exportação e
  retenção. O `43_b3_3_saida_humana` ganhou 2 verificações do envio humano pela B3.3 real.
- Unitários `conversas-horario-origem.test.ts`: normalização da origem a partir das fixtures, módulo de
  gravação, checagens estáticas da migration e dos tipos; `b3-2d2b3-*` e `b3-2d2a-*` cobrem a orquestração
  (quando grava, com o quê, e a falha vira nova tentativa).
- Atualização a partir da versão publicada (`20261123120000`): `scripts/check-upgrade-conversas-horario-origem.sh`,
  que também compara a exportação de cada titular com conversa (iguais, salvo `origin_time` nulo). Os scripts
  `check-upgrade-b3-2d2b2b2`, `-2b2b3a` e `-2b2b3b`, que comparam a linha inteira de `messages` antes e
  depois de aplicar todas as migrations pendentes, passaram a ignorar **só** as três colunas novas
  (`origin_time_*`); todo campo que já existia continua comparado byte a byte. O teste `29` exclui da sua
  contagem a função nova (que tem teste próprio, o `57`).
- Verificação de força dos testes (feita localmente, não faz parte do CI): 7 mutações no SQL (evento
  duplicado preenchendo origem desconhecida, comparação sem margem, sem gatilho de proteção, sem limite de
  futuro, duplicata que não marca contradição, `crm_accepted` para qualquer saída, gravação que aceita
  mensagem do CRM) e 2 no servidor (origem caindo no `createTime`, despachante enviando `occurredAt`) —
  cada uma derruba pelo menos uma verificação; todas foram revertidas.

### O que é comprovado por fixtures e o que não é

Tudo acima roda com **fixtures** (eventos fictícios modelados na documentação da YCloud, B3.2a) e banco
local descartável. **Não há comprovação com a YCloud real:** o significado do `sendTime` de mensagem recebida
e de eco segue a especificação registrada na B3.2a e **não foi reconferido com evento real**. A validação
real continua pendente da conta YCloud isolada e do número de teste (B3, prevista até 25/11). Também não foi
exercida a entrega real nem a reentrega real da YCloud (e se a reentrega traz o mesmo `sendTime`).

## Decisões e limites para a próxima etapa

- O aplicador **deve** usar `message_origin_time_verdict` (ou equivalente) e tratar qualquer resultado
  diferente de `eligible` como "nada muda".
- Um `sendTime` presente e malformado continua **recusando o evento inteiro** (comportamento anterior,
  preservado). Degradar isso para "recebe a mensagem e deixa a origem inválida" é uma decisão separada.
- A gravação perdida (queda entre o efeito e a gravação) deixa a mensagem desconhecida e não é refeita
  sozinha. Se isso importar na prática, a cura é uma tarefa de varredura, não uma mudança nos efeitos.
- A margem de 5 segundos e a tolerância de 5 minutos são decisões conservadoras desta PR, revisáveis.
- Mensagens anteriores à migration, e as do simulador, **nunca** valerão como evidência temporal.
- A corrida entre um evento duplicado e o que criou a mensagem, com horários diferentes e a gravação do
  criador ainda não feita, não gera contradição (o duplicado não preenche e nada é marcado). Exige o
  provedor mandar horários diferentes para a mesma mensagem e dois eventos quase simultâneos.
