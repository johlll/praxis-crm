# C1 mínima — automações internas

Migration: `20261110120000_c1_automacoes_minimas.sql` (forward-only; **só vale
depois de aplicada no hospedado** — sem ela a tela mostra o erro tratado da
rota). Tela: `Automações` (`/automacoes`).

## O que existe

- **Regras** (owner e admin criam, editam, simulam, ativam, pausam e arquivam;
  manager só consulta regras e histórico). Estados: rascunho, ativa, pausada,
  arquivada (terminal).
- **Gatilhos**: lead criado; oportunidade mudou de etapa.
- **Condições** (campos padrão, colunas fechadas): lead criado → prioridade e
  área jurídica; mudança de etapa → etapa de destino (obrigatória, não terminal)
  e etapa de origem (opcional). Não há SQL, expressão, JSON livre nem campo
  personalizado.
- **Ação** (uma): criar atividade de acompanhamento — título, prazo em dias
  (0 a 90, atividade só de data, fim do dia em São Paulo), prioridade e
  responsável (pessoa específica ou responsável atual do lead). Nada de
  WhatsApp, e-mail ou notificação.

## Como funciona

- **Simulação obrigatória.** Só lê (janela de 30 dias): devolve a contagem e uma
  prévia sem identificação (data, prioridade, área, prazo e se o responsável
  seria válido). Único efeito: carimbar a versão simulada na regra. Mudar
  gatilho, condição ou ação sobe a `version`, invalida a simulação e **pausa** a
  regra que estava ativa. Ativar exige simulação da versão atual (também um
  CHECK na tabela).
- **Evento transacional.** Trigger `AFTER INSERT` em `leads` e em
  `stage_transitions` grava `automation_events` na mesma transação da operação
  (só quando há regra ativa para o gatilho). Operação desfeita = evento desfeito.
- **Execução idempotente.** O processador transforma cada evento em uma
  execução por regra compatível; `unique (evento, regra)` impede duplicar a
  atividade, mesmo reprocessando ou com processadores simultâneos
  (`for update skip locked`). Evento anterior à ativação da regra nunca a
  dispara; execução de regra pausada, arquivada ou alterada é cancelada.
- **Falha e recuperação.** Responsável inativo, fora do workspace ou sem acesso
  ao lead falha de forma controlada. Até 4 tentativas (espera de 1, 5 e 30
  minutos); depois `dead_letter`, terminal e consultável. Só **códigos
  fechados** são gravados (CHECK na coluna) — nunca payload, dado pessoal ou
  mensagem do banco. A falha de uma regra não desfaz a operação original nem
  outra execução.
- **Origem da atividade.** A atividade criada por uma regra tem
  `source = 'automation'` (valor novo de `activity_source`, adicionado nesta
  mesma migration; a CHECK `activities_source_consistency` ganhou o ramo
  correspondente e os quatro anteriores ficaram iguais). O vínculo com a
  execução fica em `automation_executions.activity_id`.
- **Quem processa.** As telas pedem uma rodada do próprio workspace logo depois
  de criar um lead ou mover uma etapa (`after()`, melhor esforço); há o botão
  "Processar agora" e a rota `/api/cron/automations` (segredo `CRON_SECRET`,
  todos os workspaces). **Nenhum agendador foi configurado nesta PR.**

## Agendamento periódico: obrigatório antes do uso real

- O agendamento periódico da rota `/api/cron/automations` é **obrigatório antes
  do uso real** e será fechado na **B6**. Sem ele, a primeira tentativa continua
  em melhor esforço (logo depois da operação) e as novas tentativas só
  acontecem numa nova rodada manual ("Processar agora") ou incidental (outra
  criação de lead ou mudança de etapa).
- Isso não impede o merge do código, mas **impede considerar a C1 operacional
  em Production** enquanto o agendamento não existir. O cron também depende da
  configuração de serviço da A11, ausente em Production.

## Limites conhecidos

- O histórico mostra as últimas 50 execuções, sem paginação; não há expurgo de
  eventos e execuções antigos.
- Sem campos personalizados, outras ações, condições compostas ou reexecução
  manual de dead-letter.
