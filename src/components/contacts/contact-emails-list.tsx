"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ResultForm } from "@/components/feedback/result-form";
import { addEmailAction, removeEmailAction } from "@/modules/contacts/actions";

type Email = { id: string; value: string; isPrimary: boolean };

export function ContactEmailsList({ contactId, emails }: { contactId: string; emails: Email[] }) {
  // Remonta o formulário só depois de salvar: numa recusa, o valor digitado
  // continua lá para corrigir.
  const [addFormKey, setAddFormKey] = useState(0);

  return (
    <div className="flex flex-col gap-3">
      {emails.length === 0 ? (
        <p className="text-meta text-text-tertiary">Nenhum e-mail cadastrado.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {emails.map((email) => (
            <li key={email.id} className="flex items-center justify-between gap-2">
              <span className="text-body text-text">
                {email.value}
                {email.isPrimary ? <span className="ml-2 text-meta text-text-tertiary">principal</span> : null}
              </span>
              <ResultForm action={removeEmailAction}>
                <input type="hidden" name="emailId" value={email.id} />
                <input type="hidden" name="contactId" value={contactId} />
                <Button type="submit" variant="ghost" size="sm" aria-label="Remover e-mail">
                  <Trash2 size={14} aria-hidden />
                </Button>
              </ResultForm>
            </li>
          ))}
        </ul>
      )}

      <ResultForm
        key={addFormKey}
        action={addEmailAction}
        onSuccess={() => setAddFormKey((k) => k + 1)}
        className="flex gap-2"
      >
        <input type="hidden" name="contactId" value={contactId} />
        <Input name="value" type="email" placeholder="contato@exemplo.com" className="max-w-[280px]" />
        <Button type="submit" variant="secondary" size="sm">
          Adicionar
        </Button>
      </ResultForm>
    </div>
  );
}
