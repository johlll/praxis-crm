"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ResultForm } from "@/components/feedback/result-form";
import { addPhoneAction, removePhoneAction } from "@/modules/contacts/actions";

type Phone = { id: string; value: string; isPrimary: boolean };

export function ContactPhonesList({ contactId, phones }: { contactId: string; phones: Phone[] }) {
  // Remonta o formulário só depois de salvar: numa recusa, o valor digitado
  // continua lá para corrigir.
  const [addFormKey, setAddFormKey] = useState(0);

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
              <ResultForm action={removePhoneAction}>
                <input type="hidden" name="phoneId" value={phone.id} />
                <input type="hidden" name="contactId" value={contactId} />
                <Button type="submit" variant="ghost" size="sm" aria-label="Remover telefone">
                  <Trash2 size={14} aria-hidden />
                </Button>
              </ResultForm>
            </li>
          ))}
        </ul>
      )}

      <ResultForm
        key={addFormKey}
        action={addPhoneAction}
        onSuccess={() => setAddFormKey((k) => k + 1)}
        className="flex gap-2"
      >
        <input type="hidden" name="contactId" value={contactId} />
        <Input name="value" placeholder="(11) 99999-9999" className="max-w-[220px]" />
        <Button type="submit" variant="secondary" size="sm">
          Adicionar
        </Button>
      </ResultForm>
    </div>
  );
}
