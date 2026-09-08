"use client";

import { useRef } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addPhoneAction, removePhoneAction } from "@/modules/contacts/actions";

type Phone = { id: string; value: string; isPrimary: boolean };

export function ContactPhonesList({ contactId, phones }: { contactId: string; phones: Phone[] }) {
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <div className="flex flex-col gap-3">
      {phones.length === 0 ? (
        <p className="text-meta text-text-tertiary">Nenhum telefone cadastrado.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {phones.map((phone) => (
            <li key={phone.id} className="flex items-center justify-between gap-2">
              <span className="font-mono text-body tabular-nums text-text">
                {phone.value}
                {phone.isPrimary ? <span className="ml-2 text-meta text-text-tertiary">principal</span> : null}
              </span>
              <form action={removePhoneAction}>
                <input type="hidden" name="phoneId" value={phone.id} />
                <input type="hidden" name="contactId" value={contactId} />
                <Button type="submit" variant="ghost" size="sm" aria-label="Remover telefone">
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
          await addPhoneAction(formData);
          formRef.current?.reset();
        }}
        className="flex gap-2"
      >
        <input type="hidden" name="contactId" value={contactId} />
        <Input name="value" placeholder="(11) 99999-9999" className="max-w-[220px]" />
        <Button type="submit" variant="secondary" size="sm">
          Adicionar
        </Button>
      </form>
    </div>
  );
}
