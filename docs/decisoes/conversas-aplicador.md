# Conversas + IA — aplicador determinístico de status

Migration: `20261125120000_conversas_aplicador_automatico.sql` (aditiva; **só vale depois de aplicada no
hospedado**, com autorização). Depende de `20261124120000_conversas_horario_origem.sql` (PR #358): sem o
horário de origem das mensagens não há como saber se uma mensagem é posterior à decisão humana.

**Ordem de merge:** primeiro a #358 (horário de origem), depois esta PR. As migrations seguem a mesma ordem
(`20261124120000` → `20261125120000`), ambas posteriores à última publicada (`20261123120000`, ledger 124).

Esta PR entrega **só o mecanismo**: recebe uma proposta estruturada de mudança, confere tudo de novo no banco
e aplica ou recusa. **Não há** extrator de IA, contratação de modelo, rota, tela de operação, agendamento nem
ativação: o portão nasce fechado em todos os ambientes.

## O que entra

- `public.apply_status_track_automation(...)` — **só `service_role`** (anônimo e usuário autenticado não
  executam), `SECURITY DEFINER`, `search_path` vazio. Uma proposta muda **uma** coisa de **uma** trilha.
- `public.status_track_automation_gate` — portão global, nasce **fechado**. Abrir exige `activation_ref` e só
  se faz por comando direto no banco; não existe função de API para isso. Fechado = toda chamada termina em
  `automation_disabled`, sem gravar nada.
- `public.status_track_automation_decisions` + `..._decision_evidence` — uma linha por proposta processada
  (aplicada ou recusada): trilha, alvo, mudança, versão esperada e vista, resultado, motivo em código,
  evidências referenciadas (ids) com a classificação e o veredito temporal calculados pelo banco, referência
  opaca do extrator (`^[A-Za-z0-9._:-]{1,120}$`, nunca texto livre) e impressão do pedido. **Nenhum texto de
  mensagem.** Imutável; some com a conversa (retenção/anonimização) e com o escritório.
- `src/server/status-automation/apply.ts` — validação **estrita** da proposta (campo extra é recusado antes
  do banco) e repasse da resposta em códigos. Recebe o cliente de quem chamar; nenhuma rota o usa.
- Histórico: `status_track_events` e `case_service_events` aceitam `actor_kind = 'automation'`.

## A proposta

```
workspaceId, conversationId, change, track, opportunityId?, toStatus?, stepId?,
expectedVersion, evidenceMessageIds (1–20, distintas), idempotencyKey, extractorRef?
```

`change`: `set_status` (situação do atendimento ou andamento), `set_current_step` (roteiro),
`complete_step`, `commercial_stage`, `commercial_outcome` (as três últimas existem só para serem
**recusadas** com motivo). A proposta **não** informa horário, remetente, autoridade, papel, permissão nem
decisão humana: esses fatos vêm das mensagens gravadas (origem, classificação do remetente, horário de origem
da #358) e das trilhas. O módulo do servidor recusa qualquer campo além desses (`invalid_proposal`).

## O que o banco confere, no momento da gravação

Na ordem:

1. Portão aberto (`automation_disabled`) e forma da proposta (`invalid_proposal`).
2. Conversa e caso **deste escritório** — outro escritório é inexistente (`target_not_found`); contato ou
   caso anonimizado (`contact_anonymized`). Estes três são **erros**: não há alvo válido onde registrar.
3. Repetição pela chave (abaixo).
4. Sempre humanos: etapa comercial, ganho e perda (`commercial_manual_only`); concluir etapa do roteiro
   (`step_completion_manual_only`).
5. Evidências: todas **desta conversa** (`evidence_invalid`).
6. Andamento e roteiro: conversa vinculada ao contato do caso, sem revisão de vínculo pendente
   (`conversation_link_unresolved`); caso **inequívoco** — vínculo persistido da conversa ou caso único do
   contato, pela regra `private.conversation_case_resolution` (`ambiguous_case`; o palpite "único do lead"
   com outros casos no contato não basta); o caso proposto é esse (`target_mismatch`); caso ganho
   (`opportunity_not_won`).
7. **Trava a linha da trilha** — a mesma trava da correção manual e do roteiro.
8. Pausa ativa (`automation_paused`); versão diferente da esperada (`version_stale`).
9. Cada evidência: `private.message_origin_time_evidence_verdict(mensagem, manual_decided_at da trilha)` tem
   de ser `eligible` (`evidence_not_eligible`; o veredito de cada uma fica registrado). Isso traz as regras da
   #358 sem reescrevê-las: origem desconhecida, contraditória, futura ou antiga não serve; **anterior à
   decisão humana ou dentro da margem de 5 s não serve**; `created_at` nunca torna uma mensagem posterior.
10. Mensagem atrasada × aplicação automática: toda evidência tem de ser **posterior** à evidência mais nova
    da última aplicação automática da mesma trilha (`evidence_superseded`). Sem isso, uma mensagem antiga que
    chega tarde desfaria o que já foi aplicado com evidência mais nova.
11. Estado igual ao atual (`status_unchanged`) e catálogo fechado (`transition_not_automatable`).
12. Autoridade e tipo da evidência: mensagem recebida que não é do cliente (equipe ou remetente
    indeterminado) é `sender_not_authorized`; evidência fora do tipo exigido é `evidence_kind_insufficient`.

Toda recusa a partir do passo 4 é **registrada** com o motivo; o aplicador devolve
`{outcome, reason, decision_id, track, track_id, version_seen, event_source, event_id, replayed}`.

### Quem é cliente e quem é escritório (fatos gravados)

- **Cliente**: mensagem recebida (`origin = inbound`) com remetente classificado `external` pela B3 (não
  bate com identidade interna do canal). Arquivo do cliente = isso com `content_kind` `document` ou `image`.
- **Escritório**: envio humano pelo CRM (`origin = crm`, `internal`, com autor) ou eco do aplicativo do
  escritório (`business_app`).
- Chatbot, API externa, histórico importado e simulador **não** são evidência válida (e o simulador nunca
  tem horário de origem).

### Catálogo fechado

| Trilha | Para | A partir de | Evidência exigida (todas) |
| --- | --- | --- | --- |
| Situação do atendimento | `aguardando_escritorio` | `nao_informado`, `novo`, `aguardando_cliente` | do cliente |
| Situação do atendimento | `aguardando_cliente` | `nao_informado`, `novo`, `aguardando_escritorio` | do escritório |
| Andamento do serviço | `aguardando_documentos` | `nao_informado`, `em_analise`, `aguardando_cliente`, `em_execucao` | do escritório |
| Andamento do serviço | `aguardando_cliente` | `nao_informado`, `em_analise`, `em_execucao`, `aguardando_terceiros` | do escritório |
| Andamento do serviço | `documentos_recebidos` | só `aguardando_documentos` | **arquivo** do cliente |
| Roteiro | etapa atual → etapa pendente **posterior** | roteiro ativo | do cliente ou do escritório |

Fora da tabela, **sempre humano**: `novo` e `encerrado` (inclusive reabrir conversa encerrada por pessoa),
`em_analise`, `em_execucao`, `aguardando_terceiros`, `suspenso`, `concluido`; concluir, reabrir ou voltar
etapa; trocar ou remover roteiro; etapa comercial, ganho e perda.

- **"Enviei" não comprova recebimento**: texto do cliente nunca leva a `documentos_recebidos`; só um arquivo
  efetivamente recebido na conversa.
- **Arquivo recebido não é conferido nem aprovado**: nada leva automaticamente a `em_analise` ou além.
- **Protocolo e sentença não se presumem**: o aplicador não conclui etapa nenhuma (o nome da etapa é texto
  livre do escritório; não há fato gravado que prove a conclusão).
- **Roteiro**: avançar a etapa atual não conclui as anteriores (as puladas continuam pendentes); serviço
  concluído exige todas as etapas (regra I1 da etapa B, conferida de novo pelo `case_service_assert`).

## Decisão humana, autoria e disputa

- A aplicação automática **não grava `manual_decided_at`**: o marco continua sendo só da decisão humana.
  Ela incrementa a versão da trilha como qualquer mudança (propostas feitas sobre a versão antiga ficam
  inválidas).
- Autoria: `actor_kind = 'automation'`, `actor_user_id` **nulo** e `automation_decision_id` preenchido;
  `actor_kind = 'user'` continua **exigindo** o usuário (restrição `*_actor_shape` nas duas tabelas de
  histórico). Um gatilho recusa evento automático que não venha da função do aplicador
  (`automation_event_requires_decision`). Nenhum usuário é inventado; a auditoria de usuário (`audit_logs`)
  não recebe linha automática — o registro é a tabela de decisões.
- A interface mostra **"Aplicação automática"** como autor desses eventos, nunca "Alguém da equipe".
- Disputa com a correção manual: as duas travam a mesma linha da trilha. Quem chega depois vê a versão nova:
  o aplicador é recusado (`version_stale`); a correção manual recebe `track_conflict` (a pessoa recarrega e
  decide). Nada é sobrescrito em silêncio. A pausa nunca bloqueia a correção manual.

## Alvo estável até a gravação (correção posterior, `20261126120000`)

Depois da publicação, a revisão confirmou com sessões reais que a conversa, o caso e a resolução do vínculo eram
lidos antes da trava da trilha e não eram reconferidos depois de esperar: uma troca de vínculo ou um segundo caso
criado nesse intervalo levava a aplicação ao caso antigo. A correção trava o alvo (conversa, contato, leads e
oportunidades do contato) antes de ler e antes da trava da trilha, sem espera (`target_busy`), e enfileira
aplicadores do mesmo contato. Detalhes e regressão em [conversas-extrator.md](conversas-extrator.md).

## Idempotência

- A chave da proposta entra no **registro único compartilhado** `status_track_idempotency_keys` (fonte nova
  `status_track_automation_decisions`), o mesmo das trilhas e do roteiro.
- A mesma chave com o mesmo pedido (impressão de todos os campos) devolve **a mesma decisão** — aplicada ou
  recusada — com `replayed = true`, sem evento, versão ou linha nova (resposta perdida, reenvio, sessões
  simultâneas). Com outro pedido: `idempotency_conflict`.
- Uma chave usada pela correção manual ou pelo roteiro nunca vale no aplicador, e vice-versa; a gravação
  simultânea é decidida pelo índice do registro (quem chega depois espera e recebe `idempotency_conflict`).
- O evento gravado pelo aplicador não leva chave (`idempotency_key` nulo): a chave fica na decisão.

## Privacidade

- Exportação do titular (C3a): seção nova `status_track_automation_decisions` com id, conversa, trilha, caso,
  mudança, estado proposto, resultado, motivo, horário e ids das evidências. Sem chave, impressão do pedido
  nem referência do extrator. As demais seções ficam byte a byte iguais às de `20261124120000`.
- Retenção/anonimização (C3b): as decisões caem com a conversa; as evidências caem com a mensagem; nada novo
  entra para contato ou caso anonimizado. Os eventos de histórico do caso (esqueleto) guardam só o id opaco
  da decisão, sem chave estrangeira, porque o histórico é imutável.

## Testes

- pgTAP `62_conversas_aplicador` (105): superfície e portão; forma e isolamento entre escritórios; aplicação,
  autoria, registro e repetição; versão desatualizada; catálogo; remetente sem autoridade; decisão humana ×
  mensagem anterior, dentro da margem, desconhecida e atrasada; mensagem atrasada × aplicação automática mais
  nova; pausa e retomada; dois casos do mesmo contato (ambíguo e caso errado); vínculo pendente; caso não
  ganho; "enviei" × arquivo; roteiro (avança sem concluir, não volta, não conclui); a correção manual depois
  continua livre; autoria sem usuário inventado; registro sem texto; exportação; cascata. O `49` (C3a)
  ganhou uma decisão no titular de teste.
- Concorrência real: `scripts/aplicador-concurrency-check.sh` (6 cenários: manual × aplicador nas duas
  ordens, mesma proposta ×3, mesma chave com pedidos diferentes, mesma chave entre aplicador e manual nas duas
  ordens, recusa repetida antes da trava). Abre o portão só durante o script e o fecha no fim.
- Atualização: `scripts/check-upgrade-conversas-aplicador.sh` (linhas antigas intactas, exportação igual, portão
  fechado, manual exige usuário, chave antiga não vale). Os scripts de atualização anteriores (#358, etapa B,
  observações, documentos) passaram a ignorar a seção nova da exportação, como já ignoravam as de migrations
  posteriores.
- Unitários `conversas-aplicador.test.ts`: proposta estrita (horário, remetente, autoridade, papel, usuário,
  permissão e texto declarados são recusados sem chamar o banco), repasse exato, códigos de recusa e de erro,
  resposta fora do contrato, checagens estáticas da migration e rótulo de autoria.
- Força dos testes (local, fora do CI): 22 mutações no SQL do aplicador (sem veredito temporal, gravar o marco
  humano, sem versão, sem pausa, sem a regra da mensagem atrasada, aceitar o palpite do lead, caso errado,
  catálogo aberto, "enviei" valendo arquivo, sem tipo de evidência, sem autoridade, equipe valendo cliente,
  roteiro voltando, concluir etapa, etapa comercial, evidência de outra conversa, outro escritório, sem portão,
  usuário executando, caso não ganho…). 21 derrubam o pgTAP 62; a que sobrevive (tirar a consulta de repetição
  ANTES da trava) é equivalente: a consulta depois da trava e o índice único devolvem a mesma decisão.

### O que é comprovado por fixtures e o que não é

Tudo acima roda com **dados sintéticos** e banco local descartável: as mensagens são inseridas como o efeito
da B3 as gravaria e o horário de origem é gravado pelo caminho interno da #358. **Nada foi comprovado com a
YCloud real**: a classificação `external`, o `content_kind` de arquivo e o `sendTime` dependem da validação
real da B3 (conta YCloud isolada e número de teste, ainda pendente). Também não há extrator: ninguém produz
propostas hoje.

## Limites e lista para depois (não bloqueiam esta etapa)

- Ativar exige: extrator escolhido e avaliado, validação real da YCloud, decisão de quais escritórios entram,
  `activation_ref` registrada e, se for o caso, uma leitura das decisões na interface (hoje só no banco e na
  exportação).
- O portão é global; ativação por escritório, se necessária, é uma decisão separada.
- O catálogo é deliberadamente pequeno. Ampliar (por exemplo, `aguardando_terceiros`) exige critério de
  evidência verificável no banco.
- `audit_logs` não recebe a aplicação automática (a tabela de decisões é o registro); se a tela de auditoria
  precisar mostrá-la, isso é uma etapa própria.
- A ordem de prioridade dos motivos de recusa é fixa (o primeiro que falha); uma proposta com vários defeitos
  devolve só um motivo.
