"use client";

import { Link2, PlugZap } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { PLATFORMS, type Platform } from "@/modules/traffic/schema";
import { PlatformMark } from "./platform-mark";

const ACCOUNT: Record<Platform, { name: string; detail: string }> = {
  meta: { name: "Meta Ads", detail: "Campanhas de Instagram e Facebook" },
  google: { name: "Google Ads", detail: "Campanhas do Google, como a pesquisa" },
};

/**
 * Só APRESENTAÇÃO da conexão: não há OAuth, token, campo de segredo nem estado "conectado". O diálogo explica o
 * que virá; nada aqui simula sucesso.
 */
export function ConnectionDialog({ trigger }: { trigger: React.ReactNode }) {
  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Conexão ainda não disponível</DialogTitle>
          <DialogDescription>
            O Praxis ainda não se conecta ao Meta Ads nem ao Google Ads. A integração será configurada em uma próxima etapa.
          </DialogDescription>
        </DialogHeader>
        <ul className="m-0 flex list-disc flex-col gap-1.5 pl-4 text-small text-text-secondary">
          <li>Começará somente para leitura dos resultados.</li>
          <li>O Praxis não criará, pausará nem alterará campanhas ou orçamento.</li>
          <li>Nenhuma conta, senha ou chave é pedida agora.</li>
        </ul>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="secondary">
              Entendi
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ConnectAccountsButton() {
  return (
    <ConnectionDialog
      trigger={
        <Button type="button" variant="secondary" size="sm">
          <Link2 size={13} aria-hidden />
          Conectar contas
        </Button>
      }
    />
  );
}

/** Estado de um escritório real: sem conta, sem número nenhum. */
export function NoConnectionState() {
  return (
    <section aria-labelledby="sem-conexao-titulo" className="flex flex-col items-center gap-5 rounded-lg border border-border bg-surface px-5 py-10 text-center">
      <span aria-hidden className="flex size-12 items-center justify-center rounded-[12px] border border-accent-border bg-accent-tint text-accent">
        <PlugZap size={22} strokeWidth={1.6} />
      </span>
      <div className="flex max-w-[520px] flex-col gap-1.5">
        <h2 id="sem-conexao-titulo" className="m-0 text-display font-bold text-text">
          Nenhuma conta conectada
        </h2>
        <p className="m-0 text-body text-text-secondary">
          Os resultados dos anúncios deste escritório aparecerão aqui depois que uma conta for conectada. Sem conexão, não há números
          para mostrar — isso é diferente de resultado zero.
        </p>
      </div>
      <ul className="m-0 grid w-full max-w-[560px] list-none grid-cols-1 gap-3 p-0 @min-[520px]:grid-cols-2">
        {PLATFORMS.map((platform) => (
          <li key={platform} className="flex flex-col items-start gap-2 rounded-md border border-border bg-surface-subtle p-3.5 text-left">
            <p className="m-0 flex items-center gap-2 text-body font-bold text-text">
              <PlatformMark platform={platform} />
              {ACCOUNT[platform].name}
            </p>
            <p className="m-0 text-meta text-text-muted">{ACCOUNT[platform].detail} · não conectado</p>
            <ConnectionDialog
              trigger={
                <Button type="button" variant="secondary" size="sm" aria-label={`Conectar ${ACCOUNT[platform].name}`}>
                  Conectar
                </Button>
              }
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
