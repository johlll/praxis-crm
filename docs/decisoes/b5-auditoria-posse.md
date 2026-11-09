# B5 mínima — auditoria somente leitura e transferência de posse

Entregue em 09/11/2026. Migration: `20261109140000_b5_auditoria_e_posse.sql`
(aditiva; **só vale depois de aplicada no hospedado** — sem ela a tela mostra
erro tratado e a transferência recusa com mensagem genérica, nada mais).

## Comportamento final

**Auditoria** — `Configurações → Auditoria` (`/configuracoes/auditoria`).
- Quem vê: `audit_log.view` (owner e admin). Outro papel recebe "não encontrado"
  e nenhuma consulta roda. O workspace é sempre o da sessão, nunca o da URL.
- Mostra: quando (fuso de São Paulo), quem, qual ação (rótulo em português) e
  detalhes sanitizados. Filtros por **ação**, **pessoa** e **período** (dias
  inteiros, inclusivos), todos no servidor; paginação por cursor
  (`created_at`, `id`) — "Registros mais antigos" / "Voltar ao início".
- Nunca mostra: `metadata` cru, e-mail de convidado, nome de contato, rótulo,
  telefone, texto de mensagem, token, chave, id de provedor. Dos detalhes só
  passam papéis, ambiente e provedor, com valor de vocabulário fechado, e o
  nome da pessoa-alvo de duas ações (posse transferida, membro removido).

**Transferência de posse** — `Configurações → Equipe → Posse do workspace`.
- Só o **proprietário ativo**. Escolhe um outro membro **ativo do mesmo
  workspace**, lê as consequências e marca a confirmação (a Server Action
  recusa sem ela).
- Num único `UPDATE`: o destinatário vira **Proprietário** e quem transferiu vira
  **Administrador**. O workspace nunca fica sem owner; falha em qualquer ponto
  desfaz tudo. Recusa: o próprio usuário, membro suspenso, membership de outro
  workspace (igual a inexistente), quem não é owner ativo.
- Grava **uma** linha `workspace.ownership_transferred` (ids e papéis; sem
  e-mail nem nome). Transferir para quem já é owner deixa uma só owner.

## Decisões

- `audit_logs` continua **sem grant de tabela** para `authenticated`. A leitura
  é a RPC `list_audit_log` (SECURITY DEFINER), que devolve só a projeção
  sanitizada feita no banco (`private.audit_log_safe_details`); a interface
  repete a lista de permissão. Os testes 01 e 04 da A2 seguem valendo.
- Workspace alheio e workspace inexistente dão o mesmo erro
  (`insufficient_permission`); o destinatário da posse é procurado **dentro** do
  workspace da sessão.
- Uma permissão nova e específica, `workspace.transfer_ownership` (só owner). A
  matriz existente não mudou. Papéis, convites, troca de papel e remoção de
  membros ficaram como estavam.

## Limites conhecidos (não são bloqueios)

- O filtro "Pessoa" lista os membros atuais; registros de quem já saiu aparecem na
  trilha, mas não dá para filtrar por essa pessoa.
- Sem índice próprio para filtro por ação em trilhas muito grandes (o volume do
  piloto não precisa); sem registro de "quem consultou a auditoria".
- Exportação, anonimização e exclusão de workspace ficam para a C3.
