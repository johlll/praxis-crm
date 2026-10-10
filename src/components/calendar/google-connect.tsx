import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { oauthOutcomeMessage } from "@/modules/calendar/oauth-messages";

/**
 * "Conectar com Google" (B2, etapa 4): um link comum para o início da
 * autorização — o servidor cria o state e redireciona ao Google. Sem
 * JavaScript de cliente, sem dado nenhum na URL.
 */
export function GoogleConnectButton({ label = "Conectar com Google" }: { label?: string }) {
  return (
    <Button asChild>
      <a href="/api/calendar/oauth/start" rel="nofollow">
        {label}
      </a>
    </Button>
  );
}

/** Desfecho do retorno da autorização (`?agenda=`): só mensagens fixas. */
export function GoogleOAuthOutcome({ outcome }: { outcome: string | undefined }) {
  const message = oauthOutcomeMessage(outcome);
  if (!message) return null;
  return (
    <Alert variant={message.level === "success" ? "success" : message.level === "warning" ? "warning" : "danger"}>
      <AlertDescription>{message.text}</AlertDescription>
    </Alert>
  );
}
