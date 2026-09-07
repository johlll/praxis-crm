import * as React from "react";

import { cn } from "@/lib/cn";
import { Label } from "./label";

/**
 * Não é o "Form" do shadcn — aquele embrulha react-hook-form, que não está
 * entre as dependências desta fase (nossos formulários são Server Actions
 * com FormData + Zod, sem estado de formulário no cliente). Isto é só o
 * agrupamento visual label + campo + erro que os formulários da A2
 * precisam, na mesma paleta dos outros componentes ui/.
 */
function FormField({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="form-field" className={cn("flex flex-col gap-1.5", className)} {...props} />;
}

function FormMessage({
  className,
  children,
  ...props
}: React.ComponentProps<"p">) {
  if (!children) return null;
  return (
    <p
      data-slot="form-message"
      role="alert"
      className={cn("text-small text-danger", className)}
      {...props}
    >
      {children}
    </p>
  );
}

export { FormField, FormMessage, Label as FormLabel };
