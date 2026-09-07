"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, FormMessage, FormLabel } from "@/components/ui/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { signInAction, signUpAction, type AuthActionState } from "@/modules/auth/actions";

const INITIAL_STATE: AuthActionState = { ok: false };

/**
 * Login e cadastro na mesma tela, alternando por aba — evita duas rotas
 * quase idênticas. Cada submit chama a Server Action correspondente; o
 * erro mostrado é sempre o texto já sanitizado que a action devolve.
 */
type AuthFormProps = {
  /** Para onde mandar depois de um login bem-sucedido (ex.: de volta para
   * a tela de um convite). Só caminhos internos — validado de novo no
   * servidor, esta prop é só o que preenche o campo escondido. */
  next?: string;
  defaultEmail?: string;
};

export function AuthForm({ next, defaultEmail }: AuthFormProps) {
  const [mode, setMode] = useState<"entrar" | "cadastrar">("entrar");
  const [signInState, signInFormAction, signInPending] = useActionState(
    signInAction,
    INITIAL_STATE,
  );
  const [signUpState, signUpFormAction, signUpPending] = useActionState(
    signUpAction,
    INITIAL_STATE,
  );

  return (
    <div className="flex w-full max-w-[380px] flex-col gap-5">
      <div className="flex rounded-md border border-border bg-app p-1">
        <button
          type="button"
          onClick={() => setMode("entrar")}
          className={
            mode === "entrar"
              ? "flex-1 rounded-[7px] bg-surface py-1.5 text-small font-semibold text-text shadow-card"
              : "flex-1 py-1.5 text-small text-text-tertiary"
          }
        >
          Entrar
        </button>
        <button
          type="button"
          onClick={() => setMode("cadastrar")}
          className={
            mode === "cadastrar"
              ? "flex-1 rounded-[7px] bg-surface py-1.5 text-small font-semibold text-text shadow-card"
              : "flex-1 py-1.5 text-small text-text-tertiary"
          }
        >
          Criar conta
        </button>
      </div>

      {mode === "entrar" ? (
        <form action={signInFormAction} className="flex flex-col gap-4">
          {next ? <input type="hidden" name="next" value={next} /> : null}
          <FormField>
            <FormLabel htmlFor="email">E-mail</FormLabel>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              defaultValue={defaultEmail}
              required
            />
          </FormField>
          <FormField>
            <FormLabel htmlFor="password">Senha</FormLabel>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </FormField>
          {signInState.error ? (
            <Alert variant="danger">
              <AlertDescription>{signInState.error}</AlertDescription>
            </Alert>
          ) : null}
          <Button type="submit" disabled={signInPending} className="w-full">
            {signInPending ? "Entrando…" : "Entrar"}
          </Button>
        </form>
      ) : (
        <form action={signUpFormAction} className="flex flex-col gap-4">
          <FormField>
            <FormLabel htmlFor="fullName">Nome</FormLabel>
            <Input id="fullName" name="fullName" autoComplete="name" required />
          </FormField>
          <FormField>
            <FormLabel htmlFor="signup-email">E-mail</FormLabel>
            <Input
              id="signup-email"
              name="email"
              type="email"
              autoComplete="email"
              required
            />
          </FormField>
          <FormField>
            <FormLabel htmlFor="signup-password">Senha</FormLabel>
            <Input
              id="signup-password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
            />
            <FormMessage>{null}</FormMessage>
          </FormField>
          {signUpState.error ? (
            <Alert variant="danger">
              <AlertDescription>{signUpState.error}</AlertDescription>
            </Alert>
          ) : null}
          {signUpState.ok ? (
            <Alert variant="success">
              <AlertDescription>
                Cadastro criado. Confira seu e-mail para confirmar a conta antes
                de entrar.
              </AlertDescription>
            </Alert>
          ) : null}
          <Button type="submit" disabled={signUpPending} className="w-full">
            {signUpPending ? "Criando conta…" : "Criar conta"}
          </Button>
        </form>
      )}
    </div>
  );
}
