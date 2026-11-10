# C3a — exportação dos dados do titular (LGPD operacional)

Migration: `20261112120000_c3a_exportacao_titular.sql` (forward-only; **só vale depois
de aplicada no hospedado** — sem ela o botão responde com a falha tratada, sem arquivo).
Entrada: tela do contato → seção `Privacidade e LGPD` → `Exportar dados do titular`.

## O que a exportação traz

Um único JSON UTF-8, `praxis_data_subject_export_v1`, com versão do formato, horário de
geração, id interno do titular e **uma seção por categoria** (`has_data: false` quando a
categoria não tem nada):

contato · telefones · e-mails · identificadores · CPF/CNPJ (decifrado só no servidor, pelo
mecanismo existente) · consentimentos e evidências · leads e valor estimado · oportunidades
(etapa, valor, datas, requisitos, histórico de etapas) · atividades · cliente e handoffs ·
propostas, metadados dos documentos e histórico de envio · notas e verificações de conflito
(só a existência) · conversas, mensagens, status e custos do WhatsApp · identidade do
WhatsApp (telefone) · atribuição (touchpoints, vínculos, continuidade) · campos
personalizados da C4 dos quatro tipos de registro (seleção única pelo **rótulo**; valores de
campos arquivados incluídos; texto incluído, pois é dado definido expressamente do registro).

### Texto livre interno e dado de terceiro: fora do arquivo automático

O arquivo é preparado para chegar ao titular, então **não leva** conteúdo livre que pode ser
estratégia do escritório ou dado de outra pessoa. Campos retirados (as categorias continuam
existindo, só com metadados: ids, tipo, estado, datas e valores estruturados):

`leads.summary` · `leads.tags` · `opportunities.lost_note` · `opportunity_requirements.value_text`
· `activities.title` · `activities.notes` · `proposals.decision_note` · `lead_notes.body` ·
`conflict_checks.note` · `proposal_email_sends.to_email` (o endereço do destinatário; os
e-mails do próprio titular já estão na seção de e-mails do contato).

Esses textos **continuam preservados no CRM**. Fornecê-los ao titular depende de **revisão
humana e jurídica**. Isto **não é anonimização nem retenção** — isso é a C3b.

**Também fora:** chaves, segredos, tokens, hashes e blind indexes, ciphertext (o do CPF só
atravessa banco→servidor), payload bruto de inbox e de formulário, ids de provedor, chaves de
idempotência, erros técnicos, caminhos de armazenamento e checksum dos PDFs, usuários
internos, listas de candidatos de vínculo (apontam para **outros** contatos), auditorias
administrativas. **PDFs não entram** (só metadados; o download segue pelas permissões já
aprovadas). Sem ZIP.

## Permissão, isolamento e quem chama o banco

- `privacy.manage`: **owner e admin**.
- As três RPCs (`request_privacy_export`, `get_privacy_export_payload`,
  `finish_privacy_export`) executam **somente para `service_role`** (além do dono):
  `anon`, `authenticated` e PUBLIC não executam. Nenhum cliente com sessão obtém payload,
  ciphertext, registro ou conclusão chamando o banco direto.
- O servidor autoriza pela sessão (`requirePermissionSafe("privacy.manage")`), extrai o
  **ator do contexto confiável** (nunca de formulário, URL ou corpo) e o envia como
  `p_actor_user_id`, usando o cliente administrativo próprio da feature
  (`src/server/privacy/admin/supabase.ts`, protegido por lint como os da B1/B2/B3).
- O banco confere **de novo**, em cada RPC: ator existente, membership ativa, papel
  owner/admin no workspace **do contato**, registro do próprio ator e ainda aberto. O
  workspace é sempre derivado do contato. Contato inexistente, de outro workspace ou
  **mesclado** responde “não encontrado”; membro sem a faixa recebe permissão negada.
- Os dados saem de **uma só leitura** (`STABLE`, uma instrução) — um único instantâneo.

## Entrega

`POST` com **origem exata** (esquema + host + porta, comparada com a URL da própria rota;
`Origin` ausente, malformado ou diferente = 403; cabeçalhos como `x-forwarded-host` não
entram na decisão), anexo, `Cache-Control: no-store`, `nosniff`, nome
`titular-<id>-<data>.json` (sem PII). **Nada é guardado** (sem bucket, banco, disco, e-mail
ou serviço externo) e **nada vai para log**. Exceções de transporte em qualquer etapa viram
o código fechado `export_failed`; nunca mensagem, stack ou conteúdo.

## Registro e auditoria

Tabela fechada `privacy_exports` (RLS forçada, sem grant/policy): workspace, contato, ator,
horário, estado (`requested`/`completed`/`failed`), código de falha **fechado**
(`data_unavailable`, `decryption_failed`, `internal_error`) e versão do formato. Nunca o
conteúdo. Auditoria: `privacy.export_requested`, `privacy.export_generated`,
`privacy.export_failed` — só ids, versão e código. A leitura do CPF/CNPJ também entra na
trilha de dado sensível existente (`sensitive_data_access`, sem o valor).

Falha em qualquer ponto — resposta com erro **ou** Promise rejeitada — fecha o registro como
**falha** (se o próprio fechamento falhar, segue falhando fechado) e **não entrega arquivo**;
o registro só vira “concluído” com confirmação do banco imediatamente antes da entrega. Tentativa
**recusada** (sem permissão, contato inexistente) não deixa registro nem auditoria: a exceção
desfaz a chamada.

## Sessões

`signOutAction` usa `signOut({ scope: "global" })` de forma explícita: encerra as sessões de
atualização do usuário em todos os dispositivos. **Tokens de acesso já emitidos continuam
válidos até expirar.** Não há tabela, painel ou revogação administrativa de sessões de outro
usuário.

## Adiado para a C3b

Anonimização, exclusão, retenção automática, preservação legal e prazo de leads perdidos —
dependem da política jurídica a definir com o Dr. Henrique. Nada disso existe nesta etapa.
