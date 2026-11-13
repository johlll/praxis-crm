# Guia de uso do Praxis CRM Jurídico

Para o Dr. Henrique e a equipe do escritório. Descreve só o que o sistema **já faz hoje**. O que ainda não existe
está na última seção, para ninguém procurar uma tela que não está lá.

Atualizado em 13/11/2026.

## Em um minuto

- Tudo fica dentro do **workspace** do escritório: outros escritórios nunca veem nada daqui.
- A barra lateral tem: **Visão geral, Contatos, Leads, Pipeline, Atividades, Agenda, Conversas, Clientes,
  Automações, Relatórios e Configurações**.
- O caminho de um caso: **contato → lead → oportunidade (no Pipeline) → ganho → cliente**.
- O que cada pessoa vê e pode fazer depende do **papel** dela (tabela no fim). Se um botão não aparece para você,
  é porque o seu papel não tem essa permissão, não é defeito.
- Dúvida ou problema: fale com o João. **Nunca mande senha, chave ou dado de cliente por mensagem ou chamado**
  (veja "Quando algo der errado").

## 1. Entrar e escolher o workspace

- Na tela de entrada, use **Entrar** (e-mail e senha) ou **Criar conta**.
- Quem recebeu um **convite** abre o link do convite, entra na própria conta e aceita. O link vale uma vez: se
  aparecer "expirou", "cancelado" ou "já foi aceito", peça um convite novo a quem administra a equipe.
- Quem entra pela primeira vez, sem workspace, é levado a **criar o workspace do escritório**.
- No alto da barra lateral fica o nome do workspace e o seu papel. Clique para **trocar de workspace** (se você
  participa de mais de um) ou **criar um novo**.
- **Sair** fica no menu do seu perfil, no canto superior. Sair encerra a sessão em todos os seus aparelhos.

## 2. Visão geral

O painel do escritório. Escolha o período (7, 30 ou 90 dias) e, se quiser, filtre por **responsável** ou **área
jurídica**. Ele separa o que aconteceu **no período** (leads recebidos, consultas realizadas, propostas enviadas,
oportunidades ganhas, tempo até o ganho, conversão) do que está **agora** (oportunidades abertas, paradas há mais
de 5 dias, sem responsável, com atividade atrasada, agenda de hoje). Valores em reais só aparecem para quem tem
permissão para vê-los. Se não conseguir carregar, a tela diz isso e oferece "Tentar novamente": nunca mostra zero
no lugar de um erro.

## 3. Contatos

- **Novo contato:** nome, telefones, e-mails, cidade e UF, CPF ou CNPJ. Dá para buscar e abrir a ficha de cada um.
- **CPF/CNPJ** aparece protegido. Para ver, use **Revelar**: para alguns papéis o sistema pede o **motivo da
  consulta**, e toda revelação fica registrada (sem gravar o número).
- **Duplicidades** (botão na lista de contatos): o sistema **sugere** pares que podem ser a mesma pessoa e mostra o
  motivo por extenso (mesmo CPF/CNPJ, mesmo telefone ou e-mail, nome parecido na mesma cidade). **Quem decide é
  uma pessoa**: nada é mesclado sozinho. Mesclar fica restrito a proprietário, administrador e gestor, e há
  **Desfazer mesclagem** no histórico.
- **Consentimento:** registre se o contato autorizou receber mensagens. Sem consentimento, o sistema não deixa
  enviar.
- Contato **anonimizado** vira somente leitura (veja a seção 13).

## 4. Leads

- **Lead** é uma demanda de um contato. Para criar, escolha o contato e informe área jurídica, resumo, etiquetas,
  prioridade (baixa, média ou alta) e responsável.
- A ficha do lead tem sete abas: **Visão geral, Conversas, Atividades, Arquivos, Propostas, Origem e Histórico**.
  (A aba Arquivos ainda não recebe envio de arquivos; a aba Origem só tem dados quando houver captação automática,
  veja a última seção.)
- **Anotações** e a **verificação de conflito** ficam na ficha. A verificação é um **registro manual** (status,
  responsável, data e nota): o sistema não pesquisa sozinho se há conflito de interesses.
- **Arquivar lead** tira o lead da lista ativa; **Reabrir lead** devolve. Arquivar também inicia a contagem de
  12 meses da retenção de dados (seção 13).
- O **Advogado** vê os leads **dele e os que ainda não têm responsável**; os demais papéis veem todos.

## 5. Oportunidades e Pipeline

- Um lead pode ter **várias oportunidades** (por exemplo, uma nova consulta depois de uma perda). Elas aparecem na
  ficha do lead, cada uma com seu status.
- O **Pipeline** mostra as oportunidades por etapa em **Kanban** ou em **Tabela**. O funil padrão tem 8 etapas.
- **Mover de etapa:** a etapa pode exigir itens antes de avançar (um texto, uma data, uma confirmação). O sistema
  avisa o que falta e não deixa avançar sem eles.
- No painel da oportunidade ficam **Ganhou** e **Perdeu**. **Perdeu** exige o **motivo** (escolhido de uma lista).
  **Ganhou** pede o **valor final** e o **modelo de honorários** (a data da assinatura é opcional), cria o
  **cliente** e abre uma **passagem** pendente.
- **Quem vê valores:** proprietário, administrador, gestor e advogado veem o valor exato; **atendimento/comercial**
  vê só uma **faixa**; **visualizador** não vê valor.
- **Configurar o funil** (etapas, itens exigidos, motivos de perda) fica em Configurações → **Pipelines**, para
  proprietário, administrador e gestor.

## 6. Atividades e Agenda

- **Atividade** é uma tarefa com prazo ligada a um lead: **Ligação, Reunião, Tarefa, E-mail ou Prazo**. Pode ter
  hora marcada ou ser só de data (vale até o fim do dia).
- Filtros da lista: **Atrasadas, Hoje, Amanhã, Esta semana, Sem responsável**. O número de atrasadas aparece na
  barra lateral.
- Ações: **concluir, reagendar, transferir o responsável, editar e excluir**. Só dá para atribuir a alguém que já
  tem acesso àquele lead.
- Em Configurações → **Pipelines** dá para definir **uma atividade criada automaticamente** quando uma
  oportunidade chega a certa etapa.
- **Agenda** mostra, em visão semanal, as atividades com data. A ligação com o Google Agenda ainda não está ligada
  (última seção).

## 7. Clientes

- O cliente **nasce quando uma oportunidade é marcada como ganha**. A lista mostra cada cliente e abre o
  **histórico das negociações** dele.
- Status: **Ativo** ou **Encerrado**. Mudar o status e **transferir o responsável** é permitido a proprietário,
  administrador e gestor.
- A **passagem** do cliente fica como **"Aguardando integração"**: ainda não existe integração automática com
  outro sistema, então a passagem não é concluída sozinha.

## 8. Propostas

As propostas ficam na aba **Propostas** da ficha do lead.

- **Nova proposta:** informe o valor e o **modelo de honorários**. O número da proposta é automático.
- **Gerar PDF** cria o documento, com os dados do escritório no cabeçalho (preencha antes em Configurações →
  **Escritório**, que é de proprietário e administrador). Cada geração é uma **versão**; gerar de novo nunca altera
  uma versão já enviada.
- **Enviar por e-mail** manda a versão pronta (a tela mostra qual versão sairá). Se o envio por e-mail não estiver
  configurado, a tela avisa. **Registrar envio manual** serve para quando você enviou por fora do sistema.
- Quando o cliente responder, marque **Aceita** ou **Recusada**. Depois de decidida, não nasce PDF novo: uma
  revisão comercial é uma **proposta nova**.
- **Atendimento/comercial** cria e edita propostas, mas **não gera nem baixa o PDF** (o PDF traz o valor exato).

## 9. Conversas

- A lista de **Conversas** mostra as conversas por contato e abre o histórico de mensagens, com o estado de cada
  uma (enviada, entregue, lida ou falha).
- **Hoje o WhatsApp real ainda não está ligado.** O que existe é um **simulador** (Configurações → Simulador de
  WhatsApp, só proprietário e administrador) para testar o fluxo sem enviar nada de verdade.
- Quando o sistema não sabe de quem é uma conversa, ela aparece como **Vínculo pendente**; proprietário,
  administrador e gestor resolvem. O sistema não adivinha.
- Regra do WhatsApp: com a janela de 24 horas fechada, só é possível enviar um **template aprovado**.

## 10. Automações

- Uma **regra** diz: "quando acontecer X, crie esta atividade". Os gatilhos são **lead criado** e **oportunidade
  mudou de etapa**; a ação é **criar uma atividade de acompanhamento** (título, prazo em dias, prioridade e
  responsável). **Não enviam** WhatsApp, e-mail nem notificação.
- Para **ativar**, a regra precisa ter sido **simulada** (a simulação só lê e mostra quantos casos dos últimos
  30 dias teriam disparado). **Mudar a regra pausa e exige simular de novo.**
- Estados: rascunho, ativa, pausada, arquivada. O histórico mostra as últimas 50 execuções; uma execução que falha
  é tentada de novo algumas vezes e, se não der, fica marcada como falha. **Processar agora** roda uma rodada
  manual.
- Criar e mudar regras é de proprietário e administrador; o gestor só consulta.

## 11. Campos personalizados

- Em Configurações → **Campos personalizados** (proprietário e administrador), você cria campos próprios para
  **contatos, leads, oportunidades e clientes**.
- Tipos: **texto curto, número, data, sim ou não e seleção única**. Cada tipo de registro aceita até 50 campos
  ativos. O tipo de um campo não muda depois de criado.
- Depois de criado, o campo aparece numa seção "Campos personalizados" dentro de cada registro, e quem pode editar
  o registro preenche. **Arquivar** esconde o campo sem apagar os valores; **Restaurar** devolve.
- **Não use campos personalizados para CPF, senhas ou segredos.** Ainda não dá para buscar ou filtrar por eles.

## 12. Auditoria e exportação LGPD

- **Auditoria** (Configurações → Auditoria, proprietário e administrador) mostra **quem fez o quê e quando**, com
  filtros por ação, pessoa e período. É **somente leitura** e nunca mostra dado pessoal (nome, telefone, e-mail,
  texto de mensagem).
- **Exportar dados do titular** (na ficha do contato, seção **Privacidade e LGPD**; proprietário e administrador):
  gera um arquivo com os dados pessoais da pessoa, para atender uma solicitação dela.
  - O sistema pede confirmação e **registra a exportação** na auditoria.
  - Nada fica guardado no sistema: o arquivo só é baixado. **Guarde e compartilhe com segurança.**
  - **Textos internos ficam de fora** do arquivo automático (anotações, resumos, títulos e observações de
    atividades e outros textos livres): podem ser estratégia do escritório ou dado de terceiros. Entregá-los ao
    titular depende de **revisão humana e jurídica**. Os PDFs das propostas também não entram.

## 13. Anonimização e preservação legal

Fica na ficha do contato, em **Privacidade e LGPD → Retenção e anonimização** (proprietário e administrador).

- **Prazo:** o contato só pode ser anonimizado quando **todos os leads dele estão arquivados** e o último
  arquivamento completou **12 meses**. O prazo é fixo no sistema.
- **Automático:** uma rotina diária, de madrugada, está **configurada** para anonimizar sozinha os contatos que já
  cumprem o prazo e não têm nenhum bloqueio. Ela já foi testada uma vez de forma manual e controlada, mas a
  **primeira execução natural, pelo relógio, ainda não foi comprovada**. Até isso acontecer, não conte com ela.
- **Manual:** a tela mostra uma prévia do que bloqueia. Para confirmar, é preciso **digitar ANONIMIZAR**. A
  confirmação confere tudo de novo no momento do clique.
- **É irreversível.** Telefones, e-mails, CPF/CNPJ, notas, conversas e textos livres são removidos; o nome vira
  "Contato anonimizado". Ficam só os números e as etapas, sem identificar a pessoa.
- **O sistema recusa (e pede revisão humana) quando há:** cliente, caso em andamento (oportunidade aberta ou
  ganha, proposta enviada ou aceita), **preservação legal ativa**, proposta com PDF ou e-mail enviado,
  mesclagem de contatos, evento ligado à agenda, mensagem em envio ou conversa de WhatsApp que só se acha pelo
  telefone. Nunca anonimiza "pela metade".
- **Preservação legal:** protege um contato de ser anonimizado, manual ou automaticamente. O motivo é escolhido de
  uma lista (processo judicial, obrigação legal, caso em andamento, consulta de órgão regulador, outro motivo
  legal) e ela é **encerrada** quando deixa de valer. Criar e encerrar ficam registrados.
- Contato anonimizado fica **somente leitura**, junto com o lead, a oportunidade e o histórico dele. Se a pessoa
  voltar, **cadastre um contato novo**.

## 14. Quem pode o quê

Papéis: **Proprietário, Administrador, Gestor, Advogado, Atendimento/comercial, Visualizador.**

| O que | Prop. | Adm. | Gestor | Advogado | Atend. | Visual. |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Ver contatos, leads, oportunidades, atividades, conversas, clientes e propostas | sim | sim | sim | sim¹ | sim | sim |
| Criar e editar contatos, leads, oportunidades e atividades; anotações; consentimento; enviar mensagem; criar e editar propostas | sim | sim | sim | sim¹ | sim | não |
| Revelar CPF/CNPJ | sim | sim | sim | sim | sim² | não |
| Ver valor exato dos honorários | sim | sim | sim | sim | só faixa | não |
| Registrar verificação de conflito | sim | sim | sim | sim | não | não |
| Gerar/baixar PDF e enviar proposta por e-mail | sim | sim | sim | sim | não | não |
| Mesclar contatos; resolver vínculo de conversa; corrigir origem | sim | sim | sim | não | não | não |
| Configurar pipelines e atividade automática; mudar status e responsável de cliente | sim | sim | sim | não | não | não |
| Consultar automações e histórico | sim | sim | sim | não | não | não |
| Criar e mudar regras de automação | sim | sim | não | não | não | não |
| Campos personalizados (criar e editar os campos) | sim | sim | não | não | não | não |
| Gerenciar equipe e convites; editar dados do escritório; ver a Auditoria | sim | sim | não | não | não | não |
| Exportar dados do titular; anonimizar; preservação legal | sim | sim | não | não | não | não |
| Simulador de WhatsApp; canais | sim | sim | não | não | não | não |
| **Passar a posse do workspace** | **sim** | não | não | não | não | não |

¹ O **Advogado** vê e edita só os leads (e as oportunidades e atividades deles) que são **dele ou ainda não têm
responsável**. ² O Atendimento precisa informar o **motivo** ao revelar.

**Equipe** (Configurações → Equipe): todos veem quem está no workspace; proprietário e administrador convidam,
mudam papéis e removem. O workspace
**nunca fica sem proprietário**. Só o **proprietário** pode passar a posse (em "Posse do workspace"): quem recebe
vira Proprietário e quem passou vira Administrador.

## Quando algo der errado

- Uma mensagem de erro com "Nada foi alterado; tente novamente" significa exatamente isso: pode tentar de novo.
- Se o erro **repetir** ou algo parecer fora do normal, **pare** e avise o João. Não tente "dar um jeito" repetindo a
  operação várias vezes (especialmente exportação, anonimização e envio de proposta).
- **Ao pedir ajuda, descreva o que viu e o que clicou, sem colar senha, chave, CPF, telefone ou qualquer dado de
  cliente.** Se precisar identificar um registro, use só o endereço da página, que não traz dado pessoal.

## O que ainda não existe ou não está ligado

- **Relatórios:** a tela existe, mas ainda não tem relatórios. Os números do escritório estão na Visão geral.
- **WhatsApp real:** hoje só o simulador (seção 9).
- **Google Agenda:** pronto no código, ainda não ligado para o escritório. A Agenda mostra só as atividades do
  sistema.
- **Formulários do site e origem automática dos leads:** previstos, ainda não entregues para uso. A aba Origem do
  lead fica vazia enquanto isso.
- **Envio de arquivos** na ficha do lead (aba Arquivos).
- **Integração da passagem do cliente** com outro sistema (aparece como "Aguardando integração").
- **Importação em massa** de contatos e leads.
