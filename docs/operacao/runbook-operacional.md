# Runbook operacional mínimo

Para o João e para quem operar o Praxis CRM no dia a dia. É curto de propósito: o que olhar, como reconhecer que
algo quebrou, o que **não** fazer e quando parar e pedir ajuda. Não traz comando destrutivo nem credencial, e não
deve passar a trazer.

Atualizado em 13/11/2026. Ver também: `docs/decisoes/b6c-backup-restauracao.md` (backup e restauração) e
`docs/operacao/checklist-de-lancamento.md`.

## Regras que valem sempre

1. **Olhe antes de agir.** A primeira ação diante de qualquer falha é ler, não repetir.
2. **Uma operação por vez**, e só depois de entender o resultado da anterior.
3. **Nunca cole senha, chave ou dado pessoal** em chamado, e-mail, chat ou issue (detalhes na seção "Chamados").
4. **Nada de alterar Production "para ver se resolve".** Correção entra por PR, passa pelo CI e é revisada.
5. Preview e Production **hoje usam o mesmo projeto Supabase**. Até a separação do Preview (checklist), um teste
   feito em Preview grava no mesmo banco de Production: use só dados fictícios.

## Pendências obrigatórias conhecidas

Estas quatro coisas **não estão resolvidas**. Ficam registradas aqui para ninguém assumir que estão cobertas.

### 1. PDFs das propostas não estão protegidos pelo backup atual

- O bucket `proposal-documents` (Supabase Storage) está **em uso** e fica **fora do backup lógico atual**. Os dados
  da proposta e os metadados dos documentos voltam com o banco; **os arquivos PDF não**.
- Uma proposta já aceita ou recusada não aceita PDF novo, então o arquivo enviado **não pode ser refeito**.
- É uma **pendência obrigatória antes do uso real com documentos importantes**. Não é melhoria opcional.
- A **rotina separada e gratuita** para o Storage (C5a.1) está **implementada, mas NÃO ativada**: o Storage continua
  desprotegido até a ativação. Usará uma chave S3 dedicada ao backup, revogável e guardada só no repositório privado;
  ela tem acesso total ao Storage, então vazamento exige revogar a chave na hora. A restauração real será validada
  antes de remover o bloqueio de lançamento. Detalhes em `docs/decisoes/b6c-backup-restauracao.md`.
- Até lá, o CRM não pode ser o único lugar onde um documento importante existe.

### 2. A11: a reconciliação não cumpre a frequência configurada

- O workflow de reconciliação da A11 está configurado para rodar a cada **10 minutos** (`*/10 * * * *`).
- Nas 39 execuções agendadas de 3 a 13/11/2026, os intervalos reais variaram de **3,4 a 10,6 horas** (mediana de
  6,5 horas), e 28 dos 38 intervalos ficaram **entre 4 e 8 horas**. Nas 24 horas até a execução de 13/11 às
  12:09 UTC houve **4 execuções, contra 144 esperadas**. As que ocorreram terminaram com sucesso: o problema é a
  frequência, não o resultado.
- A frequência esperada **não está sendo cumprida**. Isso é um **bloqueio operacional para considerar a A11
  plenamente ativa**: com a captação de formulários ligada, um envio cuja publicação inicial falhar poderia esperar
  horas para ser reprocessado.
- A conferência diária **não substitui** uma execução confiável: ela só mostra que algo está atrasado, não faz o
  trabalho da reconciliação.
- **Correção ATIVADA em 13/11/2026 — as DUAS rotinas do workflow têm substituta no Inngest** (concorrência 1, sem nova
  tentativa), cada uma rodando **a mesma operação** da rota correspondente (uma só implementação de cada):
  - `a11-reconciler-scheduler` ← `/api/cron/outbox`, **a cada 10 minutos** (republicar a captação de formulários que
    não chegou ao Inngest; `src/server/ingest/outbox-reconciler.ts`);
  - `a11-retention-scheduler` ← `/api/cron/retention`, **uma vez por hora, no minuto 23** (retenção e alertas dos
    eventos recebidos: eventos travados, aviso antecipado de vencimento e a expiração dos 30 dias;
    `src/server/ingest/retention-maintenance.ts`). A retenção trabalha em escala de dias (aviso 7 dias antes, expiração
    aos 30), então a verificação horária basta; o minuto 23 evita a hora cheia e não coincide com a C3b (06:17 UTC).
  São funções **separadas**: falha em uma não impede a outra, e cada uma aparece à parte no Inngest. O app foi
  sincronizado em 13/11/2026 às 22:15 (Brasília) e, na observação natural, **65 de 65 execuções de cada uma terminaram
  sem falha, sem nova tentativa e sem duplicação** (retornos só com zeros: não havia nada pendente).
- **A retenção estava a cada 10 minutos e passou a uma vez por hora para caber na franquia gratuita** (veja "Consumo do
  Inngest" abaixo): a mudança só vale depois do deploy e de um **novo Resync** do app `praxis-crm`.
- **O workflow antigo continua em funcionamento** e **não foi alterado**. Falta, nesta ordem: (1) Resync depois do
  deploy; (2) observar a C1 no novo intervalo (10 minutos), a retenção no próximo minuto 23 e o reconciliador a cada 10
  minutos; (3) conferir o consumo no painel do Inngest; (4) confirmar que o workflow antigo rodando junto não duplica
  efeito (o banco reserva cada linha uma só vez; há teste de concorrência real no CI, com as três pontas largando
  juntas; **ainda não houve coincidência real** no Inngest: a única execução do workflow na janela observada, 06:57
  UTC de 14/11, ficou a 149 s do run mais próximo); (5) **só depois**, em PR separada, retirar o `schedule` do GitHub e
  manter o `workflow_dispatch` como contingência para as duas operações. Até lá o bloqueio acima continua valendo.

### 3. Rotina LGPD diária (C3b/B6b)

- O agendador `c3b-privacy-retention-scheduler` está **configurado e sincronizado** no Inngest (cron às 06:17 UTC,
  que são 03:17 em Brasília).
- Uma **execução manual controlada foi aprovada** (12/11/2026, sem nenhum contato vencido: nada foi processado).
- A **primeira execução natural do cron ainda não foi comprovada.** Até ser observada de verdade, a rotina diária
  não deve ser tratada como comprovada. Quando a execução das 06:17 UTC aparecer verde no Inngest pela primeira
  vez, avise o João para registrar.

### 4. Backup: primeira execução natural não comprovada

A janela de 13/11 não gerou execução; a prova que falta é a de 14/11 às 07:30 UTC. Detalhes em
`docs/decisoes/b6c-backup-restauracao.md`.

## Onde consultar cada coisa

| Peça | O que faz | Onde ver as execuções |
|---|---|---|
| Aplicação (Vercel) | Serve o CRM. Production: `https://praxis-crm-eight.vercel.app` | [Deployments do projeto](https://vercel.com/johllls-projects/praxis-crm/deployments) |
| Banco e login (Supabase) | Dados e autenticação (projeto `rgoeppjwnltcbeqipovh`) | [Painel do projeto](https://supabase.com/dashboard/project/rgoeppjwnltcbeqipovh) · [Logs](https://supabase.com/dashboard/project/rgoeppjwnltcbeqipovh/logs/explorer) · [Migrations](https://supabase.com/dashboard/project/rgoeppjwnltcbeqipovh/database/migrations) |
| Rotinas (Inngest) | App `praxis-crm`, cinco funções sincronizadas: `c1-automations-scheduler` (a cada 10 min a partir desta mudança; era a cada 2 min), `a11-reconciler-scheduler` (a cada 10 min), `a11-retention-scheduler` (uma vez por hora, minuto 23; sincronizada a cada 10 min até o próximo Resync), `c3b-privacy-retention-scheduler` (06:17 UTC = 03:17 em Brasília) e `a11-process-form-submission` (só quando há envio de formulário) | [Painel do Inngest](https://app.inngest.com) → app `praxis-crm` → Runs |
| CI e reconciliação (GitHub) | Testes de cada PR; reconciliação agendada da captação de formulários | [Actions do repositório](https://github.com/johlll/praxis-crm/actions) |
| Backup (GitHub, repositório **privado**) | Backup diário às 07:30 UTC (04:30 em Brasília) | [Actions dos backups](https://github.com/johlll/praxis-crm-backups/actions) (só quem tem acesso ao repositório privado) |

Status dos serviços, para separar "é conosco" de "é do provedor":
[Vercel](https://www.vercel-status.com) · [Supabase](https://status.supabase.com) ·
[GitHub](https://www.githubstatus.com) · [Inngest](https://status.inngest.com).

## O que verificar todo dia (5 minutos)

Faça depois das **04:45 de Brasília**, quando o backup do dia já deveria ter terminado.

1. **Backup.** Nas Actions do repositório privado, a execução mais recente é a de hoje, está **verde** e tem o
   **artefato** `praxis-backup-…` anexado. Execução ausente, vermelha ou sem artefato = alerta (seção abaixo).
2. **Aplicação.** O último deployment de **Production** está **Ready** e o CRM abre e deixa entrar.
3. **Rotinas.** No Inngest, `c1-automations-scheduler` tem execuções recentes e verdes (uma a cada 10 minutos) e a
   `c3b-privacy-retention-scheduler` do dia (06:17 UTC) aparece verde. Enquanto a primeira execução natural da rotina
   LGPD não for comprovada (veja as pendências), anote o que vir e avise o João.
4. **Automações no CRM** (tela Automações): nenhuma falha nova no histórico.

## O que verificar toda semana

- **Backup:** há um artefato por dia nos últimos 7 dias, e o tamanho do pacote não mudou de forma brusca (hoje
  fica perto de 0,6 MB). Todo **mês**, a restauração de teste descrita no runbook do backup.
- **CI:** o último CI da `main` está verde. A reconciliação da A11 segue com o bloqueio conhecido (frequência não
  cumprida, veja as pendências): anote se piorar ou se alguma execução ficar vermelha.
- **Supabase:** o projeto não foi **pausado** e o uso de banco e armazenamento do plano gratuito está longe do
  limite.
- **Inngest:** o uso de execuções do mês no painel (Billing → Usage) está dentro da franquia gratuita de 50.000,
  conforme a seção "Consumo do Inngest" logo abaixo. Nenhum plano pago foi habilitado e o limite de gastos não foi
  alterado.
- **Auditoria do CRM** (Configurações → Auditoria): olhe convites, mudanças de papel, exportações e
  anonimizações. Algo que ninguém reconhece é motivo para o procedimento de incidente.
- **Equipe:** quem saiu do escritório foi removido; os papéis estão certos.

## Consumo do Inngest (plano Hobby gratuito: 50.000 execuções por mês)

O Inngest cobra **3 execuções por run de um passo** (o run, o passo e a finalização). Conferido no painel de uso em
12/11/2026: 721 runs, 721 passos e **2.163 execuções** no dia. Todas as rotinas periódicas do app têm um único passo.
Com as frequências finais (30 dias):

| Rotina | Frequência | Runs/mês | Execuções/mês |
|---|---|---:|---:|
| `c1-automations-scheduler` | a cada 10 min | 4.320 | 12.960 |
| `a11-reconciler-scheduler` | a cada 10 min | 4.320 | 12.960 |
| `a11-retention-scheduler` | de hora em hora, minuto 23 | 720 | 2.160 |
| `c3b-privacy-retention-scheduler` | diária, 06:17 UTC | 30 | 90 |
| **Total periódico** | | **9.390** | **28.170** |

- **Margem para os eventos:** cerca de **21.830** execuções por mês (50.000 − 28.170). Os eventos da A11
  (`a11-process-form-submission`: um run, um passo e a finalização, mais as novas tentativas) saem dessa margem.
- **A Agenda e o WhatsApp NÃO podem ser ativados sem um novo cálculo** do consumo, nem nenhuma rotina periódica nova
  ou frequência maior.
- **Atingir o limite PAUSA as funções no Hobby** ([inngest.com/pricing](https://www.inngest.com/pricing)) — inclusive
  a A11 por evento. **Nenhuma garantia de gratuidade depende de cobrança automática:** nenhum plano pago foi
  contratado e o limite de gastos não foi alterado.
- **Correção da estimativa anterior:** os números anteriores (C1 ~21.600, A11 ~4.320 cada, total ~30.271 por mês)
  estavam **errados**, porque contavam **runs**, não execuções faturáveis. Com a C1 a cada 2 minutos o consumo real era
  de cerca de 64.800 execuções por mês só nessa rotina (mais que a franquia). Em 14/11/2026 o acumulado do mês era de
  10.121 execuções.
- A mudança de frequência (C1 de 2 para 10 minutos; retenção da A11 de 10 minutos para o minuto 23 de cada hora) só
  vale depois do deploy e de um **novo Resync** do app. Depois dele, conferir o consumo no painel (Billing → Usage).

## Como reconhecer falha

| Peça | Como aparece | Primeira ação segura |
|---|---|---|
| **Vercel** | O CRM não abre ou mostra erro de servidor; o último deployment de Production está **Error** ou não está **Ready**; o CI da `main` está vermelho | Ler o log do deployment. Não disparar vários deploys seguidos. Voltar para o deployment anterior que estava bom é decisão do João |
| **Supabase** | Ninguém consegue entrar; as telas dizem que não foi possível carregar; o projeto aparece **Paused**; incidente na página de status | Conferir a página de status. **Não** pausar, reiniciar ou restaurar o projeto por conta própria. **Não redefinir a senha do banco**: isso quebra o backup (o secret do repositório privado guarda a conexão) |
| **Inngest** | Execuções vermelhas; `c1-automations-scheduler` sem execução nos últimos 30 minutos; no CRM, atividades automáticas deixam de aparecer e o histórico de Automações acumula falhas | Ler só o **código de erro** da execução. A rotina de automações se recupera sozinha na rodada seguinte (10 minutos). A rotina LGPD diária, se falhar, se recupera no dia seguinte (veja "Quando não repetir") |
| **Backup** | Execução do dia ausente depois das 04:45 de Brasília, vermelha, ou sem artefato; pacote com tamanho muito diferente do normal | Anotar o horário e o endereço da execução, conferir a página de status do GitHub e **avisar o João**. Não disparar backup manual sem ordem dele. Se o backup mais recente passar de **24 horas**, o ponto de recuperação (RPO) estourou: trate como incidente |

Observação sobre o agendamento: o GitHub **não garante o horário** das execuções agendadas (os números da
reconciliação da A11 estão na pendência 2). Por isso a conferência diária do artefato do backup é obrigatória, e a
primeira execução natural do backup ainda precisa ser comprovada.

## Quando não repetir uma operação

| Operação | Por que não repetir às cegas | O que fazer |
|---|---|---|
| **Backup manual** | Gasta minutos do plano gratuito, cria mais um pacote e não corrige a causa de um agendamento que falhou | Só com ordem do João, depois de entender o motivo |
| **Exportação do titular** | Cada geração fica registrada na auditoria, e o arquivo tem dado pessoal | Se falhar, ler a mensagem e tentar **uma** vez; se repetir, parar |
| **Anonimização** | É irreversível. Uma recusa mostra o motivo (por exemplo, cliente, caso em andamento, preservação legal) | Ler os motivos. Nunca insistir ou tentar contornar |
| **Rotina LGPD diária** | Pelo desenho, o banco desfaz sozinho qualquer anonimização que falhou e a rotina do dia seguinte retoma (a primeira execução natural ainda não foi comprovada) | Não rodar à mão para "adiantar" |
| **Envio de proposta por e-mail** | Um novo clique envia **outro** e-mail ao cliente | Conferir o histórico de envios da proposta antes de clicar de novo |
| **Convite de equipe** | Convites repetidos confundem quem recebe | Conferir os convites pendentes antes de reenviar |
| **Migrations do banco** | Alteram o banco de Production | Só o João aplica, com o procedimento aprovado, uma execução por vez |
| **Troca de senha ou chave** | Quebra o backup e as integrações | Só com plano e ordem do João; nunca "para testar" |

## Quando parar e pedir suporte

**Pare e avise o João** (que aciona quem desenvolve) se:

- aparecer dado de **um escritório para outro**, ou alguém acessar o que não devia;
- houver suspeita de **vazamento** de senha, chave ou dado de cliente;
- o **backup** faltar ou falhar por 2 dias seguidos, ou o último passar de 24 horas;
- o mesmo erro **repetir** depois de uma nova tentativa;
- alguém propuser **copiar dado real** de Production para teste ou Preview;
- surgir **cobrança** ou aviso de limite em qualquer serviço;
- uma **migration** ou alteração aparecer sem que ninguém a tenha pedido, ou o banco parecer diferente do esperado;
- qualquer correção exigir **alterar Production** diretamente.

## Chamados e mensagens de suporte

**Nunca cole:** senhas; chaves de qualquer tipo (chave de backup, chaves de API, `service role`); endereços de
conexão do banco; tokens e secrets; CPF, CNPJ, telefone, e-mail ou nome de cliente; conteúdo de mensagens e
propostas; arquivos de exportação do titular.

**Pode e deve informar:** o horário (com o fuso), o nome da tela, a ação que estava fazendo, o **código** do erro,
o endereço da execução ou do deployment (Vercel, GitHub, Inngest) e prints **sem dados pessoais** (cubra o que
aparecer).

Se algo sensível for colado por engano, **trate como vazamento**: avise o João na hora. Ele decide a troca do
segredo; quem colou não tenta resolver sozinho.

## Procedimento geral de incidente

1. **Conter.** Pare e **não repita** a operação. Anote o horário (UTC e Brasília), o que estava sendo feito e o
   erro (só o código).
2. **Classificar.** Fora do ar · dado errado · suspeita de acesso indevido · backup ausente ou falho · cobrança.
3. **Preservar.** Guarde os endereços das execuções e prints sem dado pessoal. Não apague logs, deployments nem
   execuções.
4. **Avisar o João.** Ele decide os próximos passos e quem mais precisa saber.
5. **Corrigir pela via normal:** PR, CI verde e revisão. Voltar ao deployment anterior (rollback) é decisão do
   João. Nada de editar Production à mão.
6. **Verificar.** Refaça a verificação diária. Se houve dado afetado, a **Auditoria** mostra quem fez o quê e quando.
   Restaurar um backup só em ambiente **novo ou descartável** e só com ordem expressa do João: nunca por cima de
   Production.
7. **Registrar.** Escreva o que aconteceu, a causa, a correção e o que muda neste runbook. Se envolver dado
   pessoal de clientes, o João avalia com o Dr. Henrique a comunicação aos titulares e à ANPD.
