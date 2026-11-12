# C3b — retenção de 12 meses e anonimização de contato (LGPD operacional)

Migration: `20261113120000_c3b_retencao_anonimizacao.sql` (forward-only; **só vale depois de aplicada
no hospedado**). Entrada: tela do contato → seção `Privacidade e LGPD` → `Retenção e anonimização`
(só owner/admin, `privacy.manage`). A C3a (exportação) não foi alterada.

## Regra dos 12 meses

- Prazo **fixo de 12 meses**, sem tela para trocá-lo.
- A contagem começa no instante **explícito** em que o lead passa de ativo para arquivado:
  `leads.archived_at`, gravado e limpo **só** por um gatilho (`leads_retention_mark`). Reativar o lead
  limpa o marco; editar o lead não o move; nem `updated_at` nem um UPDATE direto o substituem. Uma
  constraint garante `status = 'arquivado'` ⇔ marco preenchido.
- Leads **já arquivados antes da migration** recebem como marco o momento da migration (a contagem
  começa ali; ninguém vence por inferência retroativa). Seus `updated_at` não mudam.
- O contato só vence quando **todos** os leads estão arquivados e o marco **mais recente** completou
  12 meses (`now() >= marco + 12 meses`; um segundo antes ainda não vale).

## Quem pode anonimizar (elegibilidade)

Avaliada **no banco, dentro da transação**, sob a trava do contato, dos leads e das oportunidades:
contato existente, não mesclado, do workspace ativo (confiável, vindo da sessão); ao menos um lead e
todos arquivados com o prazo cumprido; **nenhum** destes bloqueios (códigos fechados):

| código | significado |
|---|---|
| `no_lead` / `active_lead` / `retention_period_open` | sem prazo em andamento, lead ativo, prazo ainda aberto |
| `client_present` | qualquer cliente (clientes nunca são anonimizados automaticamente) |
| `open_or_won_opportunity` / `open_proposal` | caso em andamento (oportunidade aberta/ganha, proposta enviada/aceita) |
| `legal_hold_active` | preservação legal ativa |
| `merge_history_present` | contato absorveu outro ou tem histórico de mesclagem (o outro contato guarda dado pessoal que a operação não trata) |
| `proposal_document_present` | proposta com PDF ou e-mail enviado: armazenamento externo, **sem exclusão distribuída** nesta PR |
| `calendar_link_present` | atividade ligada a evento da agenda externa |
| `pending_outbound_message` | mensagem de saída do WhatsApp ainda em andamento |
| `unlinked_whatsapp_conversation` | existe conversa ou identidade de WhatsApp que só se acha pelo **telefone** do contato (`wa_id`, telefone da identidade ou o identificador `whatsapp` da B3), sem vínculo com o contato, lead ou oportunidade: **nada é apagado por inferência**; precisa ser vinculada ou revisada antes |

Se qualquer dependência não puder ser tratada com atomicidade, a operação é **recusada com o código** —
nunca há anonimização parcial. Outro workspace responde “não encontrado”.

## Preservação legal

`privacy_legal_holds`: workspace + contato, estado `ativa`/`encerrada`, **motivo em código fechado**
(`judicial_process`, `legal_obligation`, `case_in_progress`, `regulatory_inquiry`, `other_legal`), sem
texto livre, documento ou parecer. Só owner/admin cria e encerra; ambos auditados. Contato com
preservação ativa **nunca** entra no processamento manual nem no lote. Repetir o mesmo motivo ativo é
idempotente.

## O que a anonimização faz (tudo numa transação, irreversível)

- **Remove**: telefones, e-mails, identificadores externos, CPF/CNPJ (cifrado e índice cego), notas do
  lead, conversas do WhatsApp (mensagens, status, fila de saída) e as identidades (telefone/BSUID),
  referências de continuidade, valores de **campos personalizados** do contato, dos leads e das
  oportunidades, sugestões de duplicidade.
- **Esvazia/substitui**: nome (`Contato anonimizado`), cidade, UF e canal preferido; texto aceito,
  fonte, versão, hash, HMAC de IP e evidência bruta dos consentimentos; resumo e tags do lead; nota de
  perda e texto de requisito da oportunidade; título (`Atividade anonimizada`) e observação da
  atividade; nota de decisão da proposta; nota de verificação de conflito; gclid/fbclid/URLs/referência/
  termo/conteúdo e o motivo do vínculo de atribuição; payload de formulário ainda não expurgado.
- **Auditoria**: as linhas ficam (ação, ator, data, ids), mas o `metadata` dos registros do titular é
  esvaziado (a criação do contato gravava o nome).
- **Fica** (esqueleto): ids e relações, estado/etapas/histórico, valores e datas estruturados (métricas),
  canal/origem/mídia/campanha, o ledger técnico do WhatsApp (sem referência à mensagem), definições dos
  campos personalizados, `sensitive_data_access` (sem valor) e `privacy_exports`.
- Uma **conferência final** desfaz tudo se algo previsto continuar acessível.
- Idempotente: repetir devolve `already_anonymized` sem auditoria nova.
- **Conversa só pelo telefone**: os telefones originais são lidos **antes** de qualquer exclusão, a busca da conversa solta se repete sob as travas da execução e a conferência final a prova de novo **com os telefones originais** — se uma conversa assim aparecer no meio, tudo é desfeito.

**Conservador por escolha:** contatos com PDF/e-mail de proposta, mesclagem, evento de agenda, cliente
ou preservação **não** são anonimizados — exigem revisão humana. O payload bruto da inbox do WhatsApp
não é ligado ao contato; ele já é limitado a 30 dias por constraint e expurgado pelo mecanismo da B3.

## Contato anonimizado e o esqueleto que ele preservou são imutáveis

Depois de `contacts.anonymized_at`, **o banco** recusa (`contact_anonymized`, código fechado, sem detalhe nem dado
algum) **todo INSERT e todo UPDATE** no contato e nos registros ligados a ele: telefone, e-mail, identificador e
CPF/CNPJ; consentimentos e evidências; lead, nota, verificação de conflito, valor estimado; oportunidade,
requisito, histórico de etapas; atividade; proposta e seus documentos/e-mails; cliente; atribuição e vínculos de
demanda; continuidade; campos personalizados; conversas; sugestões de duplicidade; eventos de automação; e
mesclagem em qualquer dos lados. **Não há exceção “técnica”**: reativar um lead, trocar responsável ou
prioridade, mover/reabrir/ganhar uma oportunidade, concluir/reatribuir/reagendar uma atividade, enviar ou
decidir uma proposta, mudar `updated_at` ou a versão — tudo é recusado, porque reaproveitaria o histórico de
uma pessoa que já não pode ser identificada. Em UPDATE, o dono **antigo** também conta (ninguém tira um
registro do esqueleto nem o troca de dono). Só o **DELETE** (exclusão administrativa, em cascata) segue
permitido. A anonimização em si grava **antes** da marca (a marca é a última escrita) e por isso não esbarra
nos gatilhos `*_anonymized_guard`. Uma escrita que chega **enquanto a anonimização ainda não confirmou** (a
pessoa voltou a escrever no mesmo instante) trava o contato com `FOR KEY SHARE`, espera o commit, relê o contato
já anonimizado e é recusada — nada novo entra no esqueleto nessa janela.

Na aplicação: as telas do contato, do lead e da oportunidade ficam **somente leitura** e explicam o motivo; o
seletor de “novo lead” não oferece contato anonimizado; qualquer tentativa que chegue ao banco volta como
mensagem genérica e clara (“cadastre um contato novo”). Processos técnicos que não usam o esqueleto (expurgo
de payload, ledger do WhatsApp, B3, agenda) não precisaram de exceção: os dados que eles tocariam já saem na
anonimização; a automação (C1) que tente criar tarefa para um lead anonimizado falha dentro da própria
subtransação e vai para o ciclo normal de tentativas.

**Novo atendimento exige contato novo**: se a pessoa voltar, cadastre outro contato; o anonimizado não é
ressuscitado (o novo pode até usar o mesmo telefone). Quem vem de outro workspace recebe a mesma resposta que
receberia para qualquer registro comum — nunca “anonimizado”.

## Prévia e confirmação manual

A prévia (`get_privacy_retention_status`) devolve estado, vencimento, preservações e **só códigos**.
A confirmação **reavalia** tudo sob trava: se mudou entre a prévia e o clique (preservação criada, lead
reativado...), é **recusada** com os códigos. Na tela, a confirmação é forte: texto irreversível e
`ANONIMIZAR` digitado (o servidor repete a checagem). Depois de anonimizar, a tela só mostra o aviso.

## Lote do sistema

`run_privacy_retention_batch(p_limit)` — só `service_role`, sem ator humano, limite de 1 a 200
(padrão 50). **O limite vale para os candidatos avaliados** (`processed + blocked + failed` nunca passa de
`p_limit`), não só para as conclusões; os que sobram ficam para a rodada seguinte por uma **rotação**
(`privacy_retention_checks`: quem foi avaliado há mais tempo, ou nunca, vem primeiro), para que contatos
bloqueados para sempre não ocupem todas as vagas e escondam os demais. Seleciona contatos vencidos sem preservação com `for update … skip locked` (dois
processadores nunca pegam o mesmo; quem recebe a trava de um já concluído o relê e o ignora), confirma
cada um sob trava e roda cada contato em **subtransação**: uma falha desfaz só ele e o lote segue.
Devolve `{processed, blocked, failed}`; audita cada conclusão/falha (sem PII) e um resumo por workspace
(só contagens). **Não há agendador**: a chamada periódica entra na B6/C5. “Processar agora” na tela não
foi criado (a tela de privacidade é por contato; não há padrão de ação em lote por workspace).

## Segurança e auditoria

RPCs `SECURITY DEFINER` com `search_path` vazio, EXECUTE **só para `service_role`**; ator e workspace
ativo vêm do contexto confiável (`requirePermissionSafe`) e o banco os confere de novo; tabelas
fechadas (RLS forçada, sem grant/policy). Auditoria: `privacy.legal_hold_created|released`,
`privacy.anonymization_requested|completed|refused|failed`, `privacy.retention_processed` — só ids,
códigos fechados e contagens. Falha e recusa viram resultado (a auditoria persiste); permissão negada
e contato inexistente desfazem a chamada sem rastro. O texto de erro do banco nunca é guardado.

## Limites conhecidos

- Conversa de WhatsApp ligada **a outro contato** que só casa pelo telefone também bloqueia (revisão humana).
- Anonimização de clientes, PDFs/armazenamento externo, mesclagens e agenda: fora desta PR.
