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
(etapa, requisitos, histórico de etapas) · atividades · cliente e handoffs · propostas,
metadados dos documentos e histórico de envio · notas · verificações de conflito ·
conversas, mensagens, status e custos do WhatsApp · identidade do WhatsApp (telefone) ·
atribuição (touchpoints, vínculos, continuidade) · campos personalizados da C4 dos quatro
tipos de registro (seleção única pelo **rótulo**; valores de campos arquivados incluídos).

**Deliberadamente fora:** chaves, segredos, tokens, hashes e blind indexes, ciphertext (o
do CPF só atravessa servidor→servidor), payload bruto de inbox e de formulário, ids de
provedor, chaves de idempotência, erros técnicos, caminhos de armazenamento e checksum dos
PDFs, usuários internos, listas de candidatos de vínculo (apontam para **outros** contatos),
auditorias administrativas. **PDFs não entram** (só metadados; o download segue pelas
permissões já aprovadas). Sem ZIP.

## Permissão, isolamento e entrega

- `privacy.manage`: **owner e admin**. O banco repete a faixa na abertura e de novo na
  leitura (se o papel mudar entre as duas, nada sai).
- O workspace vem do **contato**, no banco. Contato inexistente, de outro workspace ou
  **mesclado** responde “não encontrado”; membro sem a faixa recebe permissão negada.
- Os dados saem de **uma só leitura** (`STABLE`, uma instrução) — um único instantâneo.
- Entrega: `POST` com checagem de origem, anexo, `Cache-Control: no-store`,
  `nosniff`, nome `titular-<id>-<data>.json` (sem PII). **Nada é guardado** (sem bucket,
  banco, disco, e-mail ou serviço externo) e **nada vai para log**.

## Registro e auditoria

Tabela fechada `privacy_exports` (RLS forçada, sem grant/policy): workspace, contato, ator,
horário, estado (`requested`/`completed`/`failed`), código de falha **fechado**
(`data_unavailable`, `decryption_failed`, `internal_error`) e versão do formato. Nunca o
conteúdo. Auditoria: `privacy.export_requested`, `privacy.export_generated`,
`privacy.export_failed` — só ids, versão e código. A leitura do CPF/CNPJ também entra na
trilha de dado sensível existente (`sensitive_data_access`, sem o valor).

Falha em qualquer ponto fecha o registro como **falha** e **não entrega arquivo**; o
registro só vira “concluído” imediatamente antes da entrega e, se esse fechamento falhar, o
arquivo é descartado. Tentativa **recusada** (sem permissão, contato inexistente) não deixa
registro nem auditoria: a exceção desfaz a chamada.

## Sessões

`signOutAction` agora usa `signOut({ scope: "global" })` de forma explícita: encerra as
sessões de atualização do usuário em todos os dispositivos. **Tokens de acesso já emitidos
continuam válidos até expirar.** Não há tabela, painel ou revogação administrativa de
sessões de outro usuário.

## Adiado para a C3b

Anonimização, exclusão, retenção automática, preservação legal e prazo de leads perdidos —
dependem da política jurídica a definir com o Dr. Henrique. Nada disso existe nesta etapa.
