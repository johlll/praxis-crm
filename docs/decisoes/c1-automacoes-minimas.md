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
  todos os workspaces). O agendador periódico é a B6a (abaixo).

## Agendamento periódico (B6a)

- **O que existe.** Uma função própria do Inngest, `c1-automations-scheduler`, no
  app geral `praxis-crm` (`/api/inngest`), isolada do worker da A11. Cron
  `*/10 * * * *` (a cada 10 minutos; era `*/2`, reduzido em 14/11/2026 por causa
  da franquia do Inngest, veja "Custo"), concorrência 1 e `retries: 0`. Chama só
  `process_automation_events_system`, com lote máximo de 100 por rodada (a sobra
  fica para o ciclo seguinte), e devolve só `{ events, executions }`. Código em
  `src/app/api/inngest/automations-scheduler.ts`.
- **Tentativas ficam no banco.** O banco controla as 4 tentativas e a espera
  (1, 5 e 30 minutos) e o dead-letter. Se uma execução da função falhar (a
  falha sai só com código, sem mensagem do banco), **a próxima rodada de 10
  minutos é a recuperação**: ela retoma tudo o que estiver vencido. O
  processamento continua sendo pedido **na hora** pelas operações de lead e de
  mudança de etapa (`scheduleAutomationRun`), pelo botão "Processar agora" e
  pela rota de contingência; o relógio só recupera e processa as novas
  tentativas. Um atraso máximo de 10 minutos é suficiente para o MVP.
- **Custo.** O Inngest cobra 3 execuções por run de um passo. A cada 10 minutos
  são 144 runs por dia, 4.320 por mês e **12.960 execuções por mês**, dentro da
  franquia do plano Hobby (50.000 execuções por mês) junto com a A11 (28.170 por
  mês no total periódico do app; margem de cerca de 21.830 para os eventos). A
  estimativa original desta seção (~21.600 por mês a cada 2 minutos) contava
  runs, não execuções: o consumo real era de ~64.800 por mês. Não encurtar o
  intervalo sem recalcular o consumo (veja o runbook, "Consumo do Inngest").
- **Contingência.** `/api/cron/automations` continua como rodada manual
  (`CRON_SECRET`), com o mesmo contrato.
- **Ainda não operacional.** (Superado: o app foi sincronizado em 9/11/2026 e a
  C1 é operacional em Production.) A função só passa a rodar depois que o app
  `praxis-crm` for **sincronizado no Inngest** (etapa externa, não feita nesta
  PR). Enquanto isso, a C1 não é operacional em Production: a primeira tentativa
  segue em melhor esforço e os retries dependem de nova rodada manual ou
  incidental. O app geral exige as variáveis da ingestão da A11
  (`getIngestConfig`) e o cliente administrativo do Supabase.

## Limites conhecidos

- O histórico mostra as últimas 50 execuções, sem paginação; não há expurgo de
  eventos e execuções antigos.
- Sem campos personalizados, outras ações, condições compostas ou reexecução
  manual de dead-letter.
