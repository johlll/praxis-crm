# Checklist de lançamento

Para o João e o Dr. Henrique acompanharem o que falta até a entrega final, prevista para **05/12/2026**.
Atualizado em 13/11/2026. Só registra o que já foi comprovado; o que não foi está como pendente.

## Como ler

| Rótulo | Significa |
|---|---|
| **CONCLUÍDO** | feito e comprovado |
| **PENDENTE** | ainda não feito (ou feito, mas sem a prova que falta) |
| **DEPENDE DO JOÃO** | só destrava com uma ação, decisão ou autorização dele |
| **DEPENDÊNCIA EXTERNA** | depende de um terceiro (conta, aprovação, serviço) |

Um item pode ter dois rótulos: por exemplo, **PENDENTE** e **DEPENDE DO JOÃO**.

## Resumo

| # | Item | Estado | Destrava com |
|---|---|---|---|
| 1 | Separação do Preview | **PENDENTE** (não iniciada) | **DEPENDE DO JOÃO** · **DEPENDÊNCIA EXTERNA** (Supabase) |
| 2 | A11 (formulários do site e origem dos leads) | **PENDENTE** em Production · **bloqueio operacional**: a reconciliação não cumpre a frequência configurada | **DEPENDE DO JOÃO** · **DEPENDÊNCIA EXTERNA** (Cloudflare, Upstash, site) · tarefa técnica separada |
| 3 | Google Agenda | **PENDENTE** em Production | **DEPENDE DO JOÃO** · **DEPENDÊNCIA EXTERNA** (Google) |
| 4 | YCloud e número de teste | **PENDENTE** | **DEPENDE DO JOÃO** · **DEPENDÊNCIA EXTERNA** (YCloud/Meta) |
| 5 | Integração da Vitória, sem reconstrução | **PENDENTE** | **DEPENDE DO JOÃO** |
| 6 | Treinamento | **PENDENTE** (material escrito, aguarda revisão) | **DEPENDE DO JOÃO** |
| 7 | Backup | **CONCLUÍDO** (ativado) · **PENDENTE** (execução natural não comprovada) · **PENDÊNCIA OBRIGATÓRIA**: PDFs das propostas fora do backup | **DEPENDÊNCIA EXTERNA** (agendador do GitHub) · tarefa técnica separada (Storage) |
| 8 | Restauração | **CONCLUÍDO** (local) · **PENDENTE** (projeto Supabase novo) | **DEPENDE DO JOÃO** (chave privada) |
| 9 | Permissões | **CONCLUÍDO** (sistema) · **PENDENTE** (papéis reais) | **DEPENDE DO JOÃO** |
| 10 | Teste ponta a ponta | **PENDENTE** | depende do item 1 |
| 11 | Aprovação final | **PENDENTE** | **DEPENDE DO JOÃO** |

## 1. Separação do Preview

Hoje Preview e Production usam o **mesmo** projeto Supabase (`praxis-crm-dev`, que na prática é o de Production).
Foi uma decisão temporária, aceita enquanto só existiam dados fictícios, com a ressalva de separar **antes da
entrada de dados reais** (`A11-HANDOFF.md` §18).

- **PENDENTE:** a ordem de separação foi recebida e **não foi iniciada**. Está pausada até a execução natural do
  backup de 14/11 ser comprovada (item 7).
- **PENDENTE:** confirmar o custo zero (vaga para um segundo projeto no plano gratuito, sem cartão, plano pago ou
  teste que vire cobrança) **antes** de criar o projeto. **DEPENDÊNCIA EXTERNA:** limite do plano Free do Supabase.
- **PENDENTE:** criar um projeto Supabase exclusivo de Preview, com senha própria. **DEPENDE DO JOÃO:** o login e a
  verificação em duas etapas da conta.
- **PENDENTE:** aplicar no projeto novo as 117 migrations da `main` (a última é `20261113120000`), com dados
  **só fictícios** e nenhuma cópia de dado real.
- **PENDENTE:** apontar **só** as variáveis do escopo Preview da Vercel para o projeto novo, sem tocar nas de
  Production, e fazer um deployment de Preview de teste.
- **PENDENTE:** provar o isolamento (o que se escreve no Preview não aparece em Production).

## 2. A11 — formulários do site e origem dos leads

- **CONCLUÍDO:** o código, as migrations e a validação em Preview (`A11-HANDOFF.md`).
- **PENDENTE — bloqueio operacional:** o workflow de reconciliação está configurado para rodar a cada **10
  minutos**, mas nas 39 execuções agendadas de 3 a 13/11/2026 os intervalos reais variaram de **3,4 a 10,6 horas**
  (28 de 38 entre 4 e 8 horas; 4 execuções nas 24 horas até 13/11 às 12:09 UTC, contra 144 esperadas). As execuções
  que ocorreram terminaram com sucesso: o problema é a frequência. A frequência esperada **não está sendo
  cumprida**, e isso impede considerar a A11 **plenamente ativa**. A conferência diária **não substitui** uma
  execução confiável. A correção técnica é uma **tarefa separada**; o workflow não foi alterado nesta PR.
- **PENDENTE:** ligar a captação pública em Production. A matriz de prontidão da A11 (`A11-HANDOFF.md` §18) lista o
  que é preciso: verificação anti-robô (Turnstile) com o domínio real, limitador de requisições (Upstash), chaves
  de cifra do conteúdo recebido, o endpoint de formulário cadastrado e o domínio do site autorizado. Confira o que
  já existe antes de configurar. **DEPENDE DO JOÃO:** decidir ligar e fornecer os acessos.
  **DEPENDÊNCIA EXTERNA:** contas da Cloudflare e da Upstash, e quem mantém o site do escritório (o formulário do
  site precisa seguir o contrato de `docs/decisoes/a11-exemplo-integracao.md`).

## 3. Google Agenda

- **CONCLUÍDO:** desenvolvimento e validação controlada em Preview (`docs/decisoes/b2-google-agenda.md`).
- **PENDENTE:** ativação em Production, pelo checklist da seção 13.8 desse documento. Production **não** tem
  configuração de Google. A decisão registrada é começar com **conta e agenda de teste**; a agenda real do Dr.
  Henrique entra numa etapa posterior.
- **DEPENDE DO JOÃO** (e do Dr. Henrique): autorizar a conta Google e escolher a agenda.
  **DEPENDÊNCIA EXTERNA:** configuração e eventual verificação do aplicativo no Google.

## 4. YCloud e número de teste

- **CONCLUÍDO:** a base do WhatsApp no código e no banco. O adaptador de envio da YCloud está implementado, mas
  **não foi validado com a YCloud real**. Production está desligada, sem nenhuma credencial `WHATSAPP_*`
  (`docs/decisoes/b3-whatsapp-real.md`).
- **PENDENTE:** validação real do webhook e do envio. Prazo previsto: **até 25/11/2026**.
- **DEPENDE DO JOÃO:** abrir uma conta YCloud **isolada** com um **número novo, dedicado a testes**.
  **DEPENDÊNCIA EXTERNA:** cadastro, aprovação de templates e verificação na YCloud/Meta.

## 5. Integração da Vitória, sem reconstrução

- **CONCLUÍDO:** a decisão de arquitetura: a Vitória (chatbot) continua independente, em produção e **intocada**.
  É **integrada**, não reconstruída: nada do código, do banco ou dos prompts dela entra no Praxis.
- **PENDENTE:** o contrato autenticado de passagem entre o Praxis e a Vitória (`docs/decisoes/b3-whatsapp-real.md`
  §5.2): estado durável de "humano assumiu", canal autenticado, idempotência, confirmação, expiração e falha
  fechada. Só é exigido **antes de enviar pelo número da Vitória**, que hoje continua **proibido**.
- **DEPENDE DO JOÃO:** autorizar a implantação (qualquer mudança no chatbot depende de nova autorização). Nenhuma
  mudança na Vitória faz parte desta PR.

## 6. Treinamento

- **PENDENTE:** `docs/operacao/guia-de-uso.md` e `docs/operacao/runbook-operacional.md` estão escritos e aguardam
  revisão e merge.
- **PENDENTE:** a sessão de treinamento com o Dr. Henrique e a equipe. **DEPENDE DO JOÃO:** data e participantes.
  Recomendação: treinar no Preview separado, com dados fictícios, depois do item 1.
- **PENDENTE:** o Dr. Henrique conferir o guia (principalmente as seções 12 e 13, de LGPD, e a tabela de papéis).

## 7. Backup

- **CONCLUÍDO:** backup diário criptografado ativado (repositório privado, dois secrets, 07:30 UTC, retenção de
  30 dias). Primeiro backup manual e um backup manual de proteção, ambos com sucesso. RPO de cerca de 24 horas.
  Storage do Supabase fora do backup.
- **PENDENTE:** a **primeira execução natural** (disparada pelo próprio agendamento) **não foi comprovada**. A
  janela de 13/11 não gerou execução; a próxima é **14/11 às 07:30 UTC**. Só depois dela o agendamento pode ser
  tratado como confiável. **DEPENDÊNCIA EXTERNA:** o agendador do GitHub é de melhor esforço.
- **PENDENTE — obrigatório antes do uso real com documentos importantes:** os PDFs das propostas (bucket
  `proposal-documents`, no Storage) **não estão protegidos pelo backup atual**. Os dados da proposta voltam com o
  banco, mas os arquivos PDF não, e uma proposta já decidida nem aceita PDF novo. Será necessária uma **rotina
  separada e gratuita** para o Storage. Ela **não está implementada** e é uma tarefa técnica separada. Não é
  melhoria opcional (`docs/decisoes/b6c-backup-restauracao.md`).

## 8. Restauração

- **CONCLUÍDO:** restauração **local** de um backup real aprovada em 13/11/2026 (estrutura e contagens por tabela
  idênticas às de Production). O pacote criptografado e o checksum foram preservados.
- **PENDENTE:** restauração em um **projeto Supabase novo** (migrations primeiro, dados do pacote depois). Entra
  junto do item 1.
- **PENDENTE:** rotina mensal de teste de restauração. **DEPENDE DO JOÃO:** a **chave privada** do backup é só
  dele, então toda restauração precisa dele.

## 9. Permissões

- **CONCLUÍDO:** os seis papéis (Proprietário, Administrador, Gestor, Advogado, Atendimento/comercial,
  Visualizador), a matriz de permissões repetida no banco, o isolamento entre workspaces, a tela de Equipe, a
  transferência de posse e a garantia de que o workspace nunca fica sem proprietário. A tabela está no guia
  (seção 14).
- **PENDENTE:** definir as **pessoas reais** e o papel de cada uma. **DEPENDE DO JOÃO** (com o Dr. Henrique).
- **PENDENTE:** conferir, no Preview, com **um usuário de cada papel**, que cada um vê e faz só o que a tabela diz.
  Permissões mais finas que a matriz atual não fazem parte do mínimo.

## 10. Teste ponta a ponta

**PENDENTE** (depende do item 1). Roteiro, no Preview separado, com dados fictícios e um usuário por papel:

1. Entrar, escolher o workspace, conferir o painel da Visão geral.
2. Criar contato (com CPF fictício) → lead → atividade → oportunidade.
3. Mover a oportunidade pelas etapas, cumprindo os itens exigidos; marcar **Perdeu** em uma e **Ganhou** em outra.
4. Conferir o cliente criado e a passagem "Aguardando integração".
5. Criar proposta, gerar o PDF, registrar envio, marcar como aceita.
6. Criar um campo personalizado e preenchê-lo.
7. Criar uma regra de automação, simular, ativar e ver a atividade criada.
8. Pelo simulador de WhatsApp (só proprietário e administrador), receber uma mensagem e ver a conversa.
9. Exportar os dados de um contato fictício e conferir o registro na Auditoria.
10. Arquivar leads de um contato fictício elegível, anonimizá-lo e conferir que ficou somente leitura; testar
    também a preservação legal.
11. Confirmar na Auditoria que cada passo deixou rastro e que nada apareceu em Production.

## 11. Aprovação final

**PENDENTE. DEPENDE DO JOÃO** e do Dr. Henrique. Antes de aprovar:

- os itens 1 a 10 estão **concluídos** ou têm uma **decisão registrada de adiar** (com data);
- a execução natural do backup foi comprovada e a primeira restauração em projeto novo foi feita;
- a rotina separada e gratuita que protege os **PDFs de propostas** (Storage) está implementada e comprovada;
- foi decidido o que fazer com a tela de **Relatórios**, que hoje não tem relatórios;
- a reconciliação da A11 cumpre a frequência configurada, se a captação de formulários for usada;
- a primeira execução natural da rotina LGPD diária foi comprovada;
- ninguém usa dado real de clientes antes da separação do Preview.

Registrar por escrito a data e quem aprovou.

## Já concluído e em operação

Para não se perder de vista o que não precisa de nova ação:

- Acesso, workspaces, equipe, convites e posse; contatos, duplicidades e dados sensíveis; leads e Perfil 360;
  pipeline e oportunidades; atividades e agenda interna; clientes; propostas em PDF; Visão geral;
  conversas com simulador; auditoria.
- Automações internas: operacionais em Production (rotina a cada 2 minutos). Na última conferência
  (9/11/2026) ainda não havia regra criada.
- Campos personalizados: instalados. Na última conferência (10/11/2026) ainda não havia campo criado.
- Exportação do titular e anonimização com preservação legal: instaladas.

## Rotina LGPD diária (C3b/B6b)

Não está na lista dos 11 itens, mas precisa constar:

- **CONCLUÍDO:** scheduler `c3b-privacy-retention-scheduler` **configurado e sincronizado** no Inngest (cron às
  06:17 UTC, que são 03:17 em Brasília).
- **CONCLUÍDO:** **execução manual controlada aprovada** (12/11/2026, sem nenhum contato vencido: nada foi
  processado).
- **PENDENTE:** a **primeira execução natural do cron ainda não foi comprovada**. A rotina diária **não** deve ser
  tratada como comprovada antes dessa observação real.
