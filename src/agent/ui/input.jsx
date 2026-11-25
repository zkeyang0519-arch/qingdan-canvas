import * as React from "react";
import { cn } from "./utils.js";

function Input({ className, type, ...props }) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "qd:h-9 qd:w-full qd:min-w-0 qd:rounded-3xl qd:border qd:border-transparent qd:bg-input/50 qd:px-3 qd:py-1 qd:text-base qd:transition-[color,box-shadow,background-color] qd:outline-none qd:file:inline-flex qd:file:h-7 qd:file:border-0 qd:file:bg-transparent qd:file:text-sm qd:file:font-medium qd:file:text-foreground qd:placeholder:text-muted-foreground qd:disabled:pointer-events-none qd:disabled:cursor-not-allowed qd:disabled:opacity-50 qd:aria-invalid:border-destructive qd:aria-invalid:ring-3 qd:aria-invalid:ring-destructive/20 qd:md:text-sm qd:dark:aria-invalid:border-destructive/50 qd:dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
