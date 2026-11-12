/**
 * C3b — aviso das telas de lead e oportunidade quando o contato foi anonimizado.
 *
 * O histórico fica só para consulta: o banco recusa qualquer escrita (reativar o lead, mover a
 * oportunidade, concluir atividade, mudar proposta) e a tela esconde as ações. Texto genérico —
 * sem nome, telefone ou qualquer dado do titular.
 */
export function AnonymizedRecordNotice() {
  return (
    <section role="note" className="rounded-lg border border-border bg-surface p-4">
      <h2 className="mb-2 text-body font-semibold text-text">Contato anonimizado</h2>
      <p className="text-small text-text-secondary">
        Este atendimento pertence a um contato anonimizado. O histórico fica só para consulta e não pode ser alterado nem
        reaproveitado. Para um novo atendimento, cadastre um contato novo.
      </p>
    </section>
  );
}
