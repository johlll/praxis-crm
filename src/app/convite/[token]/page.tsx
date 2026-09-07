import Link from "next/link";
import type { Metadata } from "next";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { ROLE_LABEL } from "@/server/authz/permissions";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AcceptInvitationForm } from "@/components/team/accept-invitation-form";

export const metadata: Metadata = {
  title: "Convite — Praxis CRM Jurídico",
};

type ConvitePageProps = {
  params: Promise<{ token: string }>;
};

const STATUS_MESSAGE: Record<string, string> = {
  expired: "Este convite expirou.",
  cancelled: "Este convite foi cancelado.",
  accepted: "Este convite já foi aceito.",
};

export default async function ConvitePage({ params }: ConvitePageProps) {
  const { token } = await params;

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.rpc("preview_workspace_invitation", {
    p_token: token,
  });

  const invite = data?.[0];

  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <div className="flex w-full max-w-[420px] flex-col gap-6 rounded-lg border border-border bg-surface p-6 shadow-raised">
        {!invite ? (
          <Alert variant="danger">
            <AlertDescription>Convite não encontrado ou link inválido.</AlertDescription>
          </Alert>
        ) : invite.status !== "pending" ? (
          <Alert variant="warning">
            <AlertDescription>
              {STATUS_MESSAGE[invite.status] ?? "Este convite não está mais disponível."}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <h1 className="text-lead font-semibold text-text">
                Convite para {invite.workspace_name}
              </h1>
              <p className="text-small text-text-tertiary">
                {invite.invited_by_name ?? "Alguém do escritório"} convidou{" "}
                <strong className="text-text">{invite.email}</strong> como{" "}
                <strong className="text-text">{ROLE_LABEL[invite.role]}</strong>.
              </p>
            </div>

            {user ? (
              user.email?.toLowerCase() === invite.email.toLowerCase() ? (
                <AcceptInvitationForm token={token} />
              ) : (
                <Alert variant="warning">
                  <AlertDescription>
                    Você está entrando como <strong>{user.email}</strong>, mas este
                    convite é para <strong>{invite.email}</strong>. Saia e entre com
                    o e-mail correto para aceitar.
                  </AlertDescription>
                </Alert>
              )
            ) : (
              <div className="flex flex-col gap-3">
                <p className="text-small text-text-tertiary">
                  Entre ou crie uma conta com {invite.email} para aceitar.
                </p>
                <Button asChild>
                  <Link
                    href={{
                      pathname: "/entrar",
                      query: { next: `/convite/${token}`, email: invite.email },
                    }}
                  >
                    Entrar para aceitar
                  </Link>
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
