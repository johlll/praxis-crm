# Assistente — primeira versão (chat interno do escritório)

Frente **independente** do extrator de Conversas (#366): não lê mensagens de WhatsApp, não propõe status e não usa
o portão do aplicador.

## O que entrega

- Item **Assistente** no menu principal (`/assistente`), logo depois da Visão geral, para todos os papéis.
- Conversa com área de mensagens, campo fixo no rodapé e duas sugestões: "O que precisa da minha atenção hoje?" e
  "Cadastre um cliente". Respostas em texto, links para os registros e cartões para conferir e confirmar.
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
mesmo telefone, mesmo e-mail, nome igual ou nome parecido. "Parecido" exige o **mesmo primeiro nome** e semelhança
de grafia (pg_trgm ≥ 0,6, o limiar da A3): só o sobrenome em comum não é aviso. Contatos mesclados e anonimizados
ficam de fora. Havendo resultado, a pessoa escolhe: usar o contato encontrado (só o lead é criado) ou cadastrar
pessoa nova. Sem decisão explícita, a duplicidade é conferida de novo na confirmação. A fila de duplicidades da A3
continua funcionando depois da criação, como em qualquer contato.

**Uma gravação por confirmação.** `assistant_register_client` faz contato (ou usa o existente) e lead numa
transação só, chamando `create_contact` e `create_lead` (auditoria, fila de duplicidades e evento de automação
inclusos). A chave da solicitação (gerada pelo servidor no cartão) fica em `public.assistant_requests` (RLS ligada,
nenhuma policy, sem acesso pela API):

- repetir a confirmação (clique duplo, reenvio, rede instável) devolve o **mesmo** cadastro, marcado como repetição;
- duas chamadas simultâneas com a mesma chave: a segunda espera a primeira e devolve o mesmo cadastro (provado com
  duas conexões);
- a mesma chave com outros dados ou por outra pessoa é recusada;
- tentativa recusada (permissão, contato de outro escritório, dado inválido) não deixa chave reservada.

Sucesso só é mostrado depois da resposta do servidor, com links para o lead e para o contato.

## Fora desta versão

- Provedor de IA, histórico de conversas, outras operações, edição de registros existentes.
- Migration `20261128120000_assistente_cadastro.sql` **não aplicada** no hospedado. Sem ela, o diagnóstico funciona
  e o cadastro mostra a falha do servidor sem gravar nada.
