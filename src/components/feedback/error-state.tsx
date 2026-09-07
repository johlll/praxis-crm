import { AlertTriangle } from "lucide-react";

type ErrorStateProps = {
  title?: string;
  /**
   * Mensagem exibida ao usuário. Nunca receba aqui o erro cru do servidor:
   * detalhe interno não vai para a tela (checklist §14).
   */
  description?: string;
  onRetry?: () => void;
};

export function ErrorState({
  title = "Não foi possível carregar",
  description = "Tente novamente em instantes. Se continuar, avise o responsável pelo sistema.",
  onRetry,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-3 rounded-card border border-danger/25 bg-danger-bg px-6 py-10 text-center"
    >
      <div
        className="flex size-10 items-center justify-center rounded-card bg-white text-danger"
        aria-hidden
      >
        <AlertTriangle size={18} />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-body font-semibold text-text">{title}</p>
        <p className="max-w-[420px] text-meta text-text-secondary">
          {description}
        </p>
      </div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="h-8 rounded-md border border-danger/30 bg-white px-3 text-body font-semibold text-danger transition-colors hover:bg-danger-bg"
        >
          Tentar novamente
        </button>
      ) : null}
    </div>
  );
}
