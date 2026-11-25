import * as React from "react";
import { cn } from "./utils.js";
import { Switch as SwitchPrimitive } from "radix-ui";

function Switch({ className, size = "default", ...props }) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "qd:peer qd:group/switch qd:relative qd:inline-flex qd:shrink-0 qd:items-center qd:rounded-full qd:border-2 qd:transition-all qd:outline-none qd:group-has-[:focus-visible]/field-label:ring-0 qd:after:absolute qd:after:-inset-x-3 qd:after:-inset-y-2 qd:focus-visible:border-ring qd:focus-visible:ring-3 qd:focus-visible:ring-ring/30 qd:aria-invalid:border-destructive qd:aria-invalid:ring-3 qd:aria-invalid:ring-destructive/20 qd:data-[size=default]:h-5 qd:data-[size=default]:w-11 qd:data-[size=sm]:h-4 qd:data-[size=sm]:w-7 qd:dark:aria-invalid:border-destructive/50 qd:dark:aria-invalid:ring-destructive/40 qd:data-checked:border-primary qd:data-checked:bg-primary qd:group-has-[:focus-visible]/field-label:data-checked:border-primary qd:data-unchecked:border-transparent qd:data-unchecked:bg-input/90 qd:group-has-[:focus-visible]/field-label:data-unchecked:border-transparent qd:data-disabled:cursor-not-allowed qd:data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="qd:pointer-events-none qd:block qd:rounded-full qd:bg-background qd:shadow-sm qd:ring-0 qd:transition-transform qd:not-dark:bg-clip-padding qd:group-data-[size=default]/switch:h-4 qd:group-data-[size=default]/switch:w-6 qd:group-data-[size=sm]/switch:h-3 qd:group-data-[size=sm]/switch:w-4 qd:data-checked:translate-x-[calc(100%-8px)] qd:dark:data-checked:bg-primary-foreground qd:data-unchecked:translate-x-0 qd:dark:data-unchecked:bg-foreground"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
