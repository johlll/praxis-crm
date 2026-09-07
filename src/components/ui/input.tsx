import * as React from "react";

import { cn } from "@/lib/cn";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-9 w-full rounded-input border border-border-input bg-surface px-3 text-body text-text placeholder:text-text-muted transition-colors",
        "focus-visible:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-danger aria-invalid:focus-visible:ring-danger/30",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
