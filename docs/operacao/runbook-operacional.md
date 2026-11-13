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

## Onde consultar cada coisa

| Peça | O que faz | Onde ver as execuções |
|---|---|---|
| Aplicação (Vercel) | Serve o CRM. Production: `https://praxis-crm-eight.vercel.app` | [Deployments do projeto](https://vercel.com/johllls-projects/praxis-crm/deployments) |
| Banco e login (Supabase) | Dados e autenticação (projeto `rgoeppjwnltcbeqipovh`) | [Painel do projeto](https://supabase.com/dashboard/project/rgoeppjwnltcbeqipovh) · [Logs](https://supabase.com/dashboard/project/rgoeppjwnltcbeqipovh/logs/explorer) · [Migrations](https://supabase.com/dashboard/project/rgoeppjwnltcbeqipovh/database/migrations) |
| Rotinas (Inngest) | App `praxis-crm`, três funções: `c1-automations-scheduler` (a cada 2 min), `c3b-privacy-retention-scheduler` (06:17 UTC = 03:17 em Brasília) e `a11-process-form-submission` (só quando há envio de formulário) | [Painel do Inngest](https://app.inngest.com) → app `praxis-crm` → Runs |
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
3. **Rotinas.** No Inngest, `c1-automations-scheduler` tem execuções recentes e verdes (uma a cada 2 minutos) e a
   `c3b-privacy-retention-scheduler` do dia (06:17 UTC) está verde.
4. **Automações no CRM** (tela Automações): nenhuma falha nova no histórico.

## O que verificar toda semana

- **Backup:** há um artefato por dia nos últimos 7 dias, e o tamanho do pacote não mudou de forma brusca (hoje
  fica perto de 0,6 MB). Todo **mês**, a restauração de teste descrita no runbook do backup.
- **CI:** o último CI da `main` está verde; a reconciliação da captação de formulários não tem falhas repetidas.
- **Supabase:** o projeto não foi **pausado** e o uso de banco e armazenamento do plano gratuito está longe do
  limite.
- **Inngest:** o uso de execuções do mês está dentro da franquia (50.000). Só a rotina de 2 minutos já consome
  cerca de 21.600 por mês: não encurte esse intervalo sem reavaliar o plano.
- **Auditoria do CRM** (Configurações → Auditoria): olhe convites, mudanças de papel, exportações e
  anonimizações. Algo que ninguém reconhece é motivo para o procedimento de incidente.
- **Equipe:** quem saiu do escritório foi removido; os papéis estão certos.

## Como reconhecer falha

| Peça | Como aparece | Primeira ação segura |
|---|---|---|
| **Vercel** | O CRM não abre ou mostra erro de servidor; o último deployment de Production está **Error** ou não está **Ready**; o CI da `main` está vermelho | Ler o log do deployment. Não disparar vários deploys seguidos. Voltar para o deployment anterior que estava bom é decisão do João |
| **Supabase** | Ninguém consegue entrar; as telas dizem que não foi possível carregar; o projeto aparece **Paused**; incidente na página de status | Conferir a página de status. **Não** pausar, reiniciar ou restaurar o projeto por conta própria. **Não redefinir a senha do banco**: isso quebra o backup (o secret do repositório privado guarda a conexão) |
| **Inngest** | Execuções vermelhas; `c1-automations-scheduler` sem execução nos últimos minutos; no CRM, atividades automáticas deixam de aparecer e o histórico de Automações acumula falhas | Ler só o **código de erro** da execução. A rotina de automações se recupera sozinha na rodada seguinte (2 minutos). A rotina LGPD diária, se falhar, se recupera no dia seguinte (veja "Quando não repetir") |
| **Backup** | Execução do dia ausente depois das 04:45 de Brasília, vermelha, ou sem artefato; pacote com tamanho muito diferente do normal | Anotar o horário e o endereço da execução, conferir a página de status do GitHub e **avisar o João**. Não disparar backup manual sem ordem dele. Se o backup mais recente passar de **24 horas**, o ponto de recuperação (RPO) estourou: trate como incidente |

Observação sobre o agendamento: o GitHub **não garante o horário** das execuções agendadas. Em 13/11/2026, o
workflow de reconciliação da captação de formulários, marcado para rodar a cada 10 minutos, rodou com intervalos de
4 a 8 horas. Por isso a conferência diária do artefato do backup é obrigatória e a primeira execução natural do
backup ainda precisa ser comprovada.

## Quando não repetir uma operação

| Operação | Por que não repetir às cegas | O que fazer |
|---|---|---|
| **Backup manual** | Gasta minutos do plano gratuito, cria mais um pacote e não corrige a causa de um agendamento que falhou | Só com ordem do João, depois de entender o motivo |
| **Exportação do titular** | Cada geração fica registrada na auditoria, e o arquivo tem dado pessoal | Se falhar, ler a mensagem e tentar **uma** vez; se repetir, parar |
| **Anonimização** | É irreversível. Uma recusa mostra o motivo (por exemplo, cliente, caso em andamento, preservação legal) | Ler os motivos. Nunca insistir ou tentar contornar |
| **Rotina LGPD diária** | O banco já desfaz sozinho qualquer anonimização que falhou, e a rotina do dia seguinte retoma | Não rodar à mão para "adiantar" |
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
