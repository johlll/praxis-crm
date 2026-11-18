# Conversas + IA — PR 2: interface de Conversas

Interface da Central de Conversas sobre a fundação das trilhas de status
([conversas-ia-fundacao.md](conversas-ia-fundacao.md), PR #356). Esta PR é **só interface e a leitura que
ela precisa**: não há extrator de IA, aplicador automático, escolha de provedor, mudança na Vitória,
ativação de integração nem envio automático de mensagem.

Migration nova (aditiva): `20261118120000_conversas_interface_inbox.sql` — **não aplicada no hospedado**.
Sem ela, a lista de Conversas mostra o erro tratado de carregamento (ver "Ordem de publicação").

## Referência e o que foi adotado

A imagem de referência é a **planta da organização**: lista à esquerda, mensagens no centro, contexto do
atendimento e do caso à direita. Foi adotada só a organização, com o tema, a tipografia, a barra lateral e
os componentes do Praxis publicado. Não foram copiados cores, marcas nem os dados fictícios dela.

O que a imagem mostra e **não existe aqui, de propósito**, por não haver fonte confiável no sistema:

| Na imagem | Aqui |
|---|---|
| Fotos dos contatos | Iniciais (avatar). |
| Contador de não lidas e filtro "Para humano" | Não existem. Sem fonte de leitura/atendimento humano. |
| "IA ativa" / "Humano ativo" | Não existe. Sem contrato de integração que comprove o estado. |
| Mensagens com nome do bot e selo "IA" | Autoria só pelo que o banco comprovou (tabela abaixo); nunca nome do bot nem de pessoa. |
| Caso `#IM-0428`, imóvel, tipo, processo, protocolo, sentença | Não existe módulo de processos. Mostra a oportunidade (área, etapa, situação, responsável, valor, próxima ação). |
| Abas Tarefas e Documentos, Próximas ações, Observações | Não são inventadas. Há o histórico real das alterações e o link para a linha do tempo do lead. |
| Botões de emoji, anexo e gravação de áudio | Não existem. Conteúdo sem visualização é identificado com honestidade. |
| Balão "Status do caso alterado" dentro da conversa | Não existe; a alteração fica no histórico do painel. |

## Estado da tela na URL

Tudo que muda a tela está na URL, então links, abrir direto, recarregar, Voltar e Avançar funcionam.

| Parâmetro | Significado | Padrão (omitido) |
|---|---|---|
| `q` | Busca por contato, telefone ou área do caso (até 80 caracteres) | vazio |
| `situacao` | Filtro: `nao_informado`, `novo`, `aguardando_escritorio`, `aguardando_cliente`, `encerrado` | todas |
| `page` | Página da lista (20 por página) | 1 |
| `caso` | Oportunidade **em foco** no painel (o servidor valida) | decidida pelo servidor |
| `sel` | Conversa só **destacada** na lista, sem abrir (é o que o Voltar do celular leva de volta) | nenhuma |

Valor inválido volta ao padrão, sem erro. As rotas são as mesmas: `/conversas` e `/conversas/<id>`.

## Lista: busca, filtro e contagens no servidor

`list_conversations` (usada pela aba Conversas do Perfil 360 e pelas conferências de atualização da B3) **não
foi tocada**. A lista nova usa uma função própria, `list_conversation_inbox(workspace, page, page_size, status,
search)`, que devolve numa leitura:

- a **página** pedida, já filtrada e buscada;
- o **total** do filtro e da busca;
- a **contagem por situação sobre todo o conjunto** que o papel alcança, respeitando a busca e **ignorando** o
  filtro de situação (as abas continuam mostrando quanto há em cada uma).

Regras: mesmos papéis de leitura (inclusive visualizador) e **mesmo alcance por papel** da `list_conversations`
(`private.conversation_accessible_to_role`; o pgTAP compara os conjuntos de ids dos cinco papéis). Conversa sem
registro de situação é `nao_informado` — nunca "novo". A busca não trata `%`, `_` e `\` do usuário como curinga.
A última mensagem vem com o **tipo**, então uma mídia sem texto aparece como "Áudio", não como "sem mensagens".
Página além da última volta para a última que existe.

## Mensagens

- **Autoria exibida** (de `origin` + `sender_classification`, via `messageAuthorKind`):

  | Comprovado | Rótulo |
  |---|---|
  | entrada de cliente externo | Cliente |
  | saída do CRM por usuário | Equipe · pelo CRM |
  | saída pelo aplicativo do celular | Escritório · pelo celular |
  | origem interna de entrada | Interno |
  | classificação `automation` (correlação comprovada) | Automação |
  | o resto, inclusive `chatbot` sem correlação e importação de histórico | Autoria não identificada |

  Nunca vira "Vitória" nem o nome de alguém. A regra mora em módulo puro (`message-author.ts`) para os
  componentes de cliente poderem usá-la.
- **Mensagem recém-enviada** pelo CRM: o retorno do envio não traz a origem, mas `sent_by` preenchido só existe em
  saída do CRM (restrição `messages_sent_by_only_crm`); por isso a origem é preenchida a partir dele. Sem `sent_by`,
  nada é suposto.
- **Tipo sem visualização** (áudio, imagem, documento…): mostra o nome do tipo e "visualização indisponível nesta
  tela". Legenda, quando existe, aparece.
- Dados que o banco aceita nulos e a tela agora tolera: `conversations.wa_id` (o telefone fica na identidade) e
  `messages.body_text` (mídia sem legenda).
- Preservados: paginação do histórico, envio, simulador de status, aviso de simulação, revisão de vínculo,
  consentimento. A conversa abre na mensagem mais recente.

## Painel de contexto

Contato; **situação do atendimento** (pertence à conversa); **caso em foco** (etapa comercial; **andamento só se a
oportunidade foi ganha**); **histórico** das alterações com as referências de evidência; consentimento.

- **Foco.** Quem decide: o pedido da URL (validado por `get_conversation_case`), senão o vínculo persistido da
  conversa, senão a **única** oportunidade do lead a que a conversa está ligada, senão o único caso do contato.
  Com vários casos e nenhuma ligação inequívoca, **nada é escolhido por palpite** e a tela pede a escolha. O foco é
  só da interface: `conversations.opportunity_id` **nunca é escrito**, e escolher um caso **não transfere mensagens
  nem evidência**. Caso de outro contato, fora do alcance ou inexistente: aviso e foco padrão (não é erro).
- **Permissões** (na interface e, de novo, no banco):

  | Controle | Permissão | Papéis |
  |---|---|---|
  | Corrigir situação / pausar a dela | `conversation.attendance_edit` | owner, admin, manager, lawyer, sales |
  | Corrigir andamento / pausar o dele | `case.progress_edit` | owner, admin, manager, lawyer |
  | Pausar a etapa comercial | `opportunity.edit` | owner, admin, manager, lawyer, sales |

  Visualizador não recebe controle de escrita (nem enviar mensagem). Atendimento não altera andamento jurídico.
  Enviar mensagem não implica corrigir andamento.
- **Versão e conflito.** Cada escrita leva a versão lida. Se o registro mudou, o servidor recusa (`track_conflict`)
  e a tela diz que **o registro mudou** e oferece **Atualizar**; nunca sobrescreve em silêncio nem repete a
  alteração. Depois de salvar, o controle fica desabilitado até a tela atualizar (a versão antiga já não vale).
  Cada tentativa leva uma chave de idempotência.
- **"Não informado"** é estado de leitura: não é opção de correção.
- **Evidência é opcional** e pertence só à correção em que foi escolhida; vão só os ids (nunca o texto), com o
  limite e as regras da fundação (validadas no servidor). O histórico mostra a referência (autoria comprovada, data,
  tipo), conta o que está fora do alcance de quem lê e o que foi removido pela retenção.
- **Pausa e retomada** são das **alterações automáticas de status**, por trilha e alvo. O texto da tela diz que
  **não** pausam nem retomam o bot de atendimento (a Vitória) e que **não** impedem a correção manual. Um aviso
  discreto informa que a automação de status **ainda não foi ativada**.
- A movimentação da etapa comercial continua no Pipeline e na linha do tempo do lead (`stage_transitions` segue a
  fonte canônica); o painel não duplica esse histórico — mostra só as pausas dessa trilha.

## Layout e acessibilidade

A barra lateral só existe a partir de 1024 px (breakpoints próprios do projeto).

| Largura | Formato |
|---|---|
| ≥ 1400 px | três colunas: lista, mensagens e contexto fixo |
| 768–1399 px | lista + mensagens; contexto é uma **gaveta** (botão "Contexto") |
| < 768 px | uma coluna por vez: lista → conversa → contexto (tela cheia); o Voltar leva à lista com a mesma busca, filtro e página, **destacando a conversa que estava aberta** |

Abrir e fechar o contexto só troca classes CSS: a conversa e o compositor continuam montados, então **a mensagem
digitada não se perde**. A gaveta leva o foco para dentro, prende o Tab, fecha com Esc e devolve o foco ao botão.
O aviso de "sem consentimento" ganhou o botão "Abrir contexto". Sem rolagem horizontal da página, texto longo
quebra, e a lista e o histórico rolam sozinhos com o compositor fixo embaixo.

Estados: lista vazia, sem resultado (com "Limpar busca e filtro"), carregando (esqueleto), erro da lista (erro
tratado, nunca "sem conversas"), erro das mensagens (erro tratado da rota), conversa sem mensagens, sem contato
resolvido (aponta para a revisão de vínculo), falha **só do contexto** (a conversa e o envio continuam; o painel mostra
"Tentar novamente") e sem permissão (ausência de controles, com a explicação).

## Testes

- pgTAP `56_conversas_interface_inbox` (52): superfície, autenticação e papel, "não informado" para o legado,
  contagens sobre o conjunto, filtro, paginação com total estável, busca sem curinga, alcance **igual** ao da
  `list_conversations` nos cinco papéis, isolamento entre escritórios e leitura que não escreve.
- Unitários `conversas-interface.test.ts`: estado da URL (ida e volta), filtros e contagens, a leitura, prévia e hora,
  autoria e tipos, regra do foco, texto do histórico, ações (conflito sinalizado, histórico paginado), permissões,
  a migration (aditiva, estável, sem curinga) e "promessas que a tela não faz" (nada de IA ativa, Vitória, botões
  fictícios; componente de cliente nunca importa valor de módulo de servidor).
- e2e `conversations.spec.ts`: a jornada da A7 foi adaptada à tela nova e ganhou três jornadas (lista com filtro e
  busca; correção, pausa e retomada; visualizador sem controles).
- Validação visual e funcional local com dados sintéticos (ambiente descartável): ver a descrição da PR.

## Ordem de publicação e limites

- A migration é **pré-requisito**: aplicar no hospedado **antes** do merge. O Preview usa o banco hospedado e, sem a
  migration, `/conversas` mostra o erro tratado; por isso o Preview **não** é prova visual desta PR.
- Esta PR não ativa nada automático. O horário de origem das mensagens (hoje só `created_at`) continua pendente
  para o aplicador.
- Não existe contador de não lidas nem "Para humano"; se vierem, precisam de uma fonte própria.
