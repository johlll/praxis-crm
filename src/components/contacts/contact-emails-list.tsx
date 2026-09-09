"use client";

import { useRef } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addEmailAction, removeEmailAction } from "@/modules/contacts/actions";

type Email = { id: string; value: string; isPrimary: boolean };

export function ContactEmailsList({ contactId, emails }: { contactId: string; emails: Email[] }) {
  const formRef = useRef<HTMLFormElement>(null);

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
              <form action={removeEmailAction}>
                <input type="hidden" name="emailId" value={email.id} />
                <input type="hidden" name="contactId" value={contactId} />
                <Button type="submit" variant="ghost" size="sm" aria-label="Remover e-mail">
                  <Trash2 size={14} aria-hidden />
                </Button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <form
        ref={formRef}
        action={async (formData) => {
          await addEmailAction(formData);
          formRef.current?.reset();
        }}
        className="flex gap-2"
      >
        <input type="hidden" name="contactId" value={contactId} />
        <Input name="value" type="email" placeholder="contato@exemplo.com" className="max-w-[280px]" />
        <Button type="submit" variant="secondary" size="sm">
          Adicionar
        </Button>
      </form>
    </div>
  );
}
