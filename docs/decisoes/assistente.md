# Assistente — primeira versão (chat interno do escritório)

Frente **independente** do extrator de Conversas (#366): não lê mensagens de WhatsApp, não propõe status e não usa
o portão do aplicador.

## O que entrega

- Item **Assistente** no menu principal (`/assistente`), logo depois da Visão geral, para todos os papéis.
- Conversa com área de mensagens, campo fixo no rodapé e duas sugestões: "O que precisa da minha atenção hoje?" e
  "Cadastre um cliente". Respostas em texto, links para os registros e cartões para conferir e confirmar.
- **Abertura antes da primeira mensagem** (proporção inspirada em ChatGPT e Gemini, visual do Praxis): "Como posso
  ajudar, [nome]?", o campo de mensagem como peça principal e as duas sugestões logo abaixo, nessa ordem,
  centralizados na área do Assistente (sem a barra lateral e o cabeçalho), com largura máxima de 740 px e um pouco
  acima do meio (espaços acima e abaixo na proporção 2:3). O aviso de interpretação simulada fica compacto, no
  topo, fora do conjunto. No celular, o conjunto segue centralizado com margens e as sugestões quebram de linha;
  se a altura não couber (teclado aberto), a área rola em vez de cortar.
- **Primeiro envio** (digitado ou por sugestão): o MESMO campo desce para o rodapé e a conversa aparece acima, com
  transição curta (sem animação para quem pediu menos movimento). Por ser o mesmo elemento, o foco continua no
  campo ao enviar pelo teclado; sugestão acionada pelo teclado também deixa o foco no campo, e por toque não
  (para não abrir o teclado do celular sem pedido).
- **Onde a resposta aparece:** a pergunta enviada desce até o fim da conversa. A resposta nova fica à vista pelo
  INÍCIO, com o fim da pergunta acima quando há espaço: resposta curta aparece inteira; resposta longa, como o
  diagnóstico, mostra o resumo e o começo de "Atividades atrasadas", e o resto fica abaixo para rolar. Em área
  pequena (celular com teclado aberto) a resposta começa no topo. A primeira resposta é posicionada depois que o
  campo termina de descer. Cartões trocados no lugar não mexem na rolagem.
- A conversa vive só na tela (não é gravada). Trocar de escritório começa uma conversa nova.

## Quem interpreta e quem executa

- O **intérprete** lê a mensagem e só **propõe** uma operação, com parâmetros. Neste ciclo ele é **simulado**
  (`src/modules/assistant/interpreter.ts`, `simulado-v1`): regras fixas de texto, sem provedor de IA, sem chamada
  externa. A tela mostra "Interpretação simulada" e cada resposta do servidor informa o intérprete usado.
- O **servidor** (`src/modules/assistant/actions.ts`) confere se a operação está na lista explícita
  (`ASSISTANT_OPERATIONS` em `operations.ts`: `diagnose_attention`, `propose_client_registration`,
  `cancel_registration`), valida os parâmetros com o esquema dela, confere sessão e permissões e executa pelos
  caminhos oficiais. O escritório **nunca** é parâmetro: vem da sessão. Parâmetro desconhecido é descartado.
- A **gravação** não é proposta pelo intérprete: só acontece no clique de confirmação do cartão
  (`confirmRegistrationAction`), com permissões conferidas de novo naquele momento.
- **Cartão ligado a quem o abriu.** Cada cartão de duplicidade ou de confirmação sai do servidor com um
  comprovante assinado (`src/server/assistant/card-ticket.ts`, HMAC-SHA256) que amarra a chave da solicitação
  à pessoa e ao escritório ativos naquele momento. Na confirmação, o comprovante é conferido contra a sessão
  ATUAL, antes de qualquer consulta: se o escritório ativo mudou (inclusive por outra aba) o cartão é
  encerrado com "O escritório ativo mudou…" e nada é gravado, nem no escritório antigo nem no novo; se o
  comprovante é de outra pessoa, de outra chave ou foi alterado, também é recusado. A chave de assinatura é
  derivada do segredo do cookie de escritório ativo, com rótulo próprio (sem configuração nova).
- Um adaptador de IA real entra depois implementando a mesma interface (`AssistantInterpreter`), sem mudar quem
  valida e executa. Conexão com provedor, custos e dados reais ficam para etapa própria.

## Diagnóstico ("O que precisa da minha atenção hoje?")

Três consultas que o CRM já usa, cada uma com o alcance do papel aplicado no banco:

| Parte | Fonte | Regra |
| --- | --- | --- |
| Atividades atrasadas | `list_activities` (filtro `overdue`) | pendentes com prazo vencido |
| Agenda de hoje | `list_activities` (filtro `today`) | pendentes de hoje, no fuso do escritório |
| Oportunidades que exigem atenção | `get_dashboard` (bloco de atenção) | paradas há mais de N dias, sem responsável ou com atividade atrasada |

- Até cinco itens por parte, com o total real e "Ver todas". Cada item tem o motivo e o link do registro (lead ou
  oportunidade). Datas no fuso de São Paulo.
- Uma consulta que falha aparece como **indisponível**, nunca como zero. "Nada precisa da sua atenção" só é dito
  quando as três responderam vazias.

## Cadastro por conversa

**Fluxo oficial reaproveitado.** No Praxis, o registro "cliente" só nasce quando uma oportunidade é ganha
(`docs/decisoes/a8-clientes.md`). Cadastrar uma pessoa com um caso é: **contato** (`create_contact`) + **lead**
(`create_lead`), como as telas de novo contato e novo lead. O Assistente usa exatamente isso:

- Campos validados com os mesmos esquemas (`createContactSchema` e `createLeadSchema`): nome (obrigatório),
  área jurídica (obrigatória), assunto, telefone e e-mail (opcionais). O contato é pessoa física; CPF não é pedido.
- Permissões: as do cadastro oficial (`contact.edit` e `lead.edit`; visualizador não cadastra), conferidas na
  proposta, na confirmação e de novo no banco.
- Falta informação obrigatória: o Assistente pergunta **só o que falta** e guarda o rascunho na tela; o servidor
  valida o rascunho de novo a cada mensagem.

**Possível duplicidade antes de gravar.** `assistant_find_contact_matches` (só leitura) procura no escritório:
mesmo telefone, mesmo e-mail, nome igual ou nome parecido. A resposta traz só dados do contato (nome, data de
cadastro e motivos), que todo membro do escritório já vê; **não traz contagem de leads**, porque o alcance dos
leads muda por perfil (advogado e atendimento veem os seus e os sem responsável) e decidir qual contato usar
não depende dela. Provado com um contato que tem leads de dois responsáveis: proprietária e advogado recebem
exatamente a mesma resposta. "Parecido" exige o **mesmo primeiro nome** e semelhança
de grafia (pg_trgm ≥ 0,6, o limiar da A3): só o sobrenome em comum não é aviso. Contatos mesclados e anonimizados
ficam de fora. Havendo resultado, a pessoa escolhe: usar o contato encontrado (só o lead é criado) ou cadastrar
pessoa nova. Sem decisão explícita, a duplicidade é conferida de novo na confirmação. A fila de duplicidades da A3
continua funcionando depois da criação, como em qualquer contato.

**Uma gravação por confirmação.** `assistant_register_client` faz contato (ou usa o existente) e lead numa
transação só, chamando `create_contact` e `create_lead` (auditoria, fila de duplicidades e evento de automação
inclusos). A chave da solicitação (gerada pelo servidor no cartão) fica em `public.assistant_requests` (RLS ligada,
nenhuma policy, sem acesso pela API):

- antes de conferir duplicidade, o servidor consulta `assistant_find_registration` (só leitura): se a mesma
  pessoa já gravou esta chave com os mesmos dados, devolve aquele cadastro. Assim, quando a resposta da
  primeira gravação se perde, a nova tentativa mostra os mesmos links do contato e do lead, sem apontar o
  contato recém-criado como possível duplicidade;
- repetir a confirmação (clique duplo, reenvio, rede instável) devolve o **mesmo** cadastro, marcado como repetição;
- duas chamadas simultâneas com a mesma chave: a segunda espera a primeira e devolve o mesmo cadastro (provado com
  duas conexões);
- a mesma chave com outros dados ou por outra pessoa é recusada;
- tentativa recusada (permissão, contato de outro escritório, dado inválido) não deixa chave reservada.

Sucesso só é mostrado depois da resposta do servidor, com links para o lead e para o contato.

**Resultado incerto é dito como incerto.** Recusa com código do banco ou da API significa transação desfeita:
a mensagem diz "Nada foi gravado". Já sem resposta (rede caiu, tempo esgotado, resposta perdida no caminho), a
mensagem diz que não foi possível confirmar se o cadastro foi gravado, mantém o cartão com a mesma chave e o
botão vira "Confirmar de novo": se ele já existir, volta o mesmo cadastro, sem criar outro.

## Fora desta versão

- Provedor de IA, histórico de conversas, outras operações, edição de registros existentes.
- Migration `20261128120000_assistente_cadastro.sql` **não aplicada** no hospedado. Sem ela, o diagnóstico funciona
  e o cadastro mostra a falha do servidor sem gravar nada.
