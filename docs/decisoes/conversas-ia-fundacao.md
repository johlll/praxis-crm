# Conversas + IA — PR 1: fundação das trilhas de status

Migration: `20261117130000_conversas_ia_fundacao.sql` (aditiva; **só vale depois de aplicada no
hospedado**, com autorização). Esta PR entrega **só a fundação de banco e servidor**: não há tela
nova, extrator de IA nem aplicador automático. Nenhuma alteração automática acontece ainda.

## Decisões aprovadas

1. **Caso/serviço = oportunidade.** Nenhuma entidade nova. Um cliente já tem várias oportunidades
   (A8, `client_handoffs`); o andamento pós-contratação pertence à **oportunidade ganha**, nunca ao
   cliente inteiro.
2. **Três trilhas separadas**, cada uma com seu alvo:

   | Trilha | Alvo | Onde está o estado | Histórico |
   |---|---|---|---|
   | `attendance` — situação do atendimento | conversa | `status_tracks.attendance_status` | `status_track_events` |
   | `case_progress` — andamento do caso/serviço | oportunidade **ganha** | `status_tracks.case_progress_status` | `status_track_events` |
   | `commercial_stage` — etapa do Kanban | oportunidade | `opportunities.stage_id` (inalterado) | `stage_transitions` (fonte canônica) |

3. **Vocabulários** (enums; base inicial do produto, **não** validação jurídica do Dr. Henrique):
   - situação do atendimento: `novo`, `aguardando_escritorio`, `aguardando_cliente`, `encerrado`;
   - andamento: `aguardando_documentos`, `documentos_recebidos` (ainda não analisados), `em_analise`,
     `aguardando_cliente`, `aguardando_terceiros`, `em_execucao`, `concluido`, `suspenso`.
4. **Dado legado = `nao_informado`**, explícito nos dois vocabulários. Nenhuma conversa ou
   oportunidade antiga é interpretada como "novo" ou "em análise". A migration não cria nenhum
   registro de situação ou andamento; sem registro, a leitura devolve `nao_informado`, versão 0,
   sem pausa. Uma conversa nova também nasce `nao_informado` (os efeitos da B3 não foram tocados).
   `nao_informado` nunca é escolha manual.

## Modelo

- `status_tracks`: uma linha por conversa (`attendance`) e por (oportunidade, trilha). Guarda o
  estado (quando a trilha tem estado próprio), a **versão** da trilha, o **controle de pausa**
  (quem e quando) e o **marco de evidência** (`manual_decided_at`, momento da última decisão humana
  sobre o estado). Alvo imutável. Nasce na primeira escrita (índice único + trava da linha).
- `status_track_events`: mudanças de estado de `attendance`/`case_progress` e pausa/retomada das três
  trilhas. Antes/depois, versão anterior/nova, autor (`actor_kind`, hoje só `user`), horário,
  quantidade de evidências e chave de idempotência. Imutável.
- `status_track_event_evidence`: ids das mensagens usadas como evidência. Chave estrangeira para
  `messages` **em cascata**.
- As três tabelas são deny-all (RLS forçada, sem grant); todo acesso é por função `SECURITY DEFINER`.
- `stage_transitions` **não muda**: `actor_user_id` continua obrigatório e a semântica é a mesma. Um
  gatilho novo `AFTER INSERT` só incrementa a versão da trilha comercial e grava o marco — toda
  movimentação registrada lá é, hoje, decisão humana. Não há segundo histórico da mesma mudança.
  `create_opportunity` e `win_opportunity` não gravam em `stage_transitions`; ganhar não incrementa a
  versão comercial, e a oportunidade fechada já recusa qualquer ação comercial.

## Proteção manual

- **Versão.** Toda correção, pausa e retomada incrementa a versão. Cada escrita exige a versão
  esperada (`track_conflict` se divergir).
- **Marco de evidência.** A correção manual grava `manual_decided_at`.
- **Pausa.** Persistida por trilha e alvo (`set_status_track_automation`): impede **futuras**
  alterações automáticas até a retomada explícita e **nunca** bloqueia a correção manual autorizada.
  A pausa da situação do atendimento pertence à conversa; as do andamento e da etapa, à oportunidade.
- Uma mensagem mais recente, sozinha, **não** autoriza desfazer a decisão humana (contrato abaixo).

## Permissões

| Ação | Permissão | Papéis |
|---|---|---|
| Corrigir/pausar a situação do atendimento | `conversation.attendance_edit` (nova) | owner, admin, manager, lawyer, sales |
| Corrigir/pausar o andamento | `case.progress_edit` (nova) | owner, admin, manager, lawyer |
| Pausar a etapa comercial | `opportunity.edit` (existente) | owner, admin, manager, lawyer, sales |
| Ler estado, histórico e casos | leitura da conversa/oportunidade | todos os membros |

Sempre com o alcance do registro (advogado: "seus + sem responsável"). Poder **enviar** mensagem não
implica poder corrigir andamento jurídico: `conversation.send` não é reaproveitada.

## Evidência

Validada no servidor, nunca aceita como lista arbitrária: até 20 ids distintos, todos do mesmo
escritório, de conversas no alcance do papel de quem escreve, e do alvo certo — para a situação do
atendimento, mensagens **da própria conversa**; para as trilhas da oportunidade, mensagens de
conversas do **mesmo contato** do lead. Qualquer id fora disso recusa a operação inteira com
`invalid_evidence`, sem dizer qual. A leitura do histórico devolve a evidência só como referência
(mensagem, conversa, direção, origem, classificação, tipo, data), **sem texto**, e só das conversas
que quem lê alcança (`evidence_hidden` conta as demais; `evidence_removed`, as apagadas pela
retenção). A auditoria sanitizada recebe só códigos (trilha, estados, versão, quantidade).

## Oportunidade em foco

O **foco** é estado da interface (vai na URL), separado do **vínculo persistido**
`conversations.opportunity_id`, que os fluxos existentes (revisão de vínculo, retenção, exportação,
perfil 360) continuam usando sem mudança. `list_conversation_case_options` e
`get_conversation_case` só leem e validam: opções = oportunidades dos leads do mesmo contato da
conversa, no alcance do papel; conversa sem contato resolvido não tem opções. Outro contato, outro
escritório, fora do alcance ou inexistente: `case_not_selectable`. Selecionar um caso **não**
transfere mensagens nem provas.

## Mensagens: origem e classificação

`list_conversation_messages` (mesma assinatura e alcance) passa a devolver `origin`,
`sender_classification` e `content_kind`, como gravados. `origin = chatbot` exige correlação positiva
na gravação (B3 §15.10) e mesmo assim **não identifica a Vitória**; sem correlação a classificação
continua `unresolved`. `messageAuthorKind` (servidor) nunca promove isso a um nome.

## Retenção, anonimização e exportação

- **C3b.** A conversa apagada leva a trilha dela, o histórico e as referências (cascata). Mensagem
  apagada leva toda referência de evidência a ela, inclusive no andamento de outra oportunidade — não
  sobra caminho indireto. O controle e o histórico das trilhas da oportunidade ficam no esqueleto
  (só códigos, versões e ids da equipe) e, depois de `contacts.anonymized_at`, são imutáveis
  (gatilho próprio, mesmo código `contact_anonymized`).
- **C3a.** Duas seções novas: `status_tracks` e `status_track_history` (com os ids das mensagens de
  evidência). Como no restante da C3a, sem usuário interno e sem chave de idempotência. As seções
  anteriores ficaram byte a byte iguais.

## Contrato para as próximas PRs (sem implementação aqui)

- Cliente relatando "enviei" **não** comprova recebimento.
- Arquivo efetivamente recebido **não** significa documento aprovado (`documentos_recebidos` é "ainda
  não analisados").
- Análise, execução, conclusão e marcos jurídicos (protocolo, sentença) exigem **evidência
  autorizada** — nunca a palavra do cliente.
- Mensagens do cliente são dados, nunca autorização para executar comandos.
- O aplicador automático só age com: versão igual à lida, trilha não pausada, evidência **válida para
  aquela transição e aquele alvo** e posterior ao marco da última decisão humana. Ambiguidade de caso
  ou falta de evidência = nada muda. Mensagem mais recente sozinha não basta.
- **Limitação a resolver no aplicador:** `messages` não guarda o horário do provedor, só o de chegada
  (`created_at`). Uma mensagem antiga que chega atrasada pareceria posterior ao marco. A PR do
  aplicador precisa gravar e usar o horário do provedor antes de comparar com o marco.
- Transição comercial automática não inventa requisitos nem contorna os fluxos existentes
  (`move_opportunity_stage`, requisitos, etapas finais); ganho e perda continuam manuais.
- A autoria comercial por IA (`stage_transitions`) e a ampliação de `actor_kind` serão tratadas na
  PR do aplicador; o gatilho da trilha comercial terá de distinguir a própria autoria.
- Efeitos internos de C1/A6 devem ocorrer **exatamente uma vez** por transição válida.
- Nenhuma mudança de status envia mensagem ou faz ação externa sem regra própria.
- Provedor e modelo de IA continuam em aberto.
- A Vitória não será reconstruída nem terá sua triagem duplicada.

## Testes

- pgTAP `55_conversas_ia_fundacao` (135): superfície fechada, legado, correções por papel, alcance,
  isolamento, versão, idempotência, evidência inválida (outra conversa, outro escritório,
  inexistente, repetida, nula, mais de 20, fora do alcance, outro contato, conversa sem contato),
  pausa/retomada, trilha comercial pelo `stage_transitions`, histórico paginado com evidência oculta
  e removida, várias oportunidades do mesmo contato e vínculo incompatível, origem/classificação das
  mensagens, imutabilidade, C3b e "nada externo".
- pgTAP `49_c3a_exportacao_titular`: o titular de teste ganha uma mudança de situação, para que as
  seções novas também tenham item.
- Unitários `conversas-ia-fundacao.test.ts`: vocabulários iguais aos enums do banco, validação,
  permissões (inclusive a mesma faixa no banco), autoria das mensagens, mapeadores, ações e checagens
  estáticas da migration.
- Concorrência real (local, duas conexões): primeira escrita simultânea, mesma chave ao mesmo tempo e
  pausa × correção.
- Conferências de atualização da B3 (`scripts/check-upgrade-b3-*.sh`): elas aplicam todas as
  migrations até a atual e comparam a leitura da A7 antes/depois. A foto "depois" de
  `list_conversation_messages` passa a ignorar **só** as três chaves novas (`origin`,
  `sender_classification`, `content_kind`); todo campo que já existia continua comparado byte a byte.

## Limites desta PR

Sem tela, sem botão, sem IA, sem aplicador, sem envio de mensagem, sem mudança na Vitória e sem
serviço externo. A Central de Conversas atual continua igual.
